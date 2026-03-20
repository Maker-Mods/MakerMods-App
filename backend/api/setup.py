"""Setup API endpoints for ports and cameras."""

import asyncio
import glob
import logging
import os
import threading
import time
import traceback as tb
from typing import Dict, List, Optional

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.models.setup import CameraInfo, CameraPreview, PortInfo
from backend.services.camera_scanner import CameraScannerService
from backend.services.port_scanner import PortScannerService

logger = logging.getLogger(__name__)

router = APIRouter()
port_scanner = PortScannerService()
camera_scanner = CameraScannerService()


class WiggleRequest(BaseModel):
    """Request to wiggle a gripper on a specific port."""

    port: str


class ChmodSerialRequest(BaseModel):
    """Request to run sudo chmod 777 on /dev/ttyACM* (user enters password in UI)."""

    password: str = ""


def _get_error_hint(e: Exception) -> Optional[str]:
    """Return a human-friendly hint for common SO101/Feetech errors."""
    msg = str(e).lower()
    if "missing motor ids" in msg or "motor check failed" in msg:
        return "Motor not found on this port. Select a different port or check that the correct arm is connected and powered on."
    if "no status packet" in msg or "txrxresult" in msg:
        return "This error usually means the arm is not powered on. Make sure the motor power supply is connected and switched on, then try again."
    if "could not open port" in msg or "serialexception" in msg or "permission denied" in msg:
        return "Port unavailable — it may already be in use by another process."
    return None


@router.get("/ports", response_model=List[PortInfo])
async def list_ports():
    """List all available serial ports."""
    try:
        return port_scanner.list_ports()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list ports: {e}")


@router.get("/cameras", response_model=List[CameraInfo])
async def list_cameras(exclude_builtin: bool = False):
    """List all detected cameras.

    Args:
        exclude_builtin: If True, exclude built-in cameras (macOS only).
    """
    try:
        # Stop any active MJPEG streams first — the scan opens cv2.VideoCapture
        # for each index, which conflicts with streams in the same process.
        _stop_all_streams()
        return camera_scanner.list_cameras(exclude_builtin=exclude_builtin)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list cameras: {e}")


@router.post("/cameras/preview", response_model=Dict[int, CameraPreview])
async def capture_camera_previews(camera_indices: List[int] = None):
    """Capture preview images from cameras.

    Args:
        camera_indices: Optional list of camera indices to capture. If None, captures all.
    """
    try:
        return camera_scanner.capture_preview(camera_indices=camera_indices)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to capture previews: {e}")


@router.get("/cameras/preview/{camera_index}")
async def get_camera_preview(camera_index: int):
    """Get preview image for a specific camera."""
    image_path = camera_scanner.output_dir / f"camera_{camera_index}.jpg"

    if not image_path.exists():
        raise HTTPException(status_code=404, detail=f"Preview for camera {camera_index} not found")

    return FileResponse(str(image_path), media_type="image/jpeg")


def _wiggle_gripper_sync(port: str) -> None:
    """Connect to a Feetech motor bus on the given port and wiggle the gripper.

    Uses raw position values (no calibration needed). Reads current position,
    then moves ±200 steps a few times so the user can visually identify the arm.
    """
    import time

    from lerobot.motors import Motor, MotorNormMode
    from lerobot.motors.feetech import FeetechMotorsBus

    bus = FeetechMotorsBus(
        port=port,
        motors={"gripper": Motor(6, "sts3215", MotorNormMode.RANGE_0_100)},
    )
    try:
        bus.connect()

        # Read current raw position (sync_read returns a dict)
        positions = bus.sync_read("Present_Position", "gripper", normalize=False)
        current = positions["gripper"]
        offset = 200  # ~200 encoder steps is a small but visible movement

        for _ in range(3):
            bus.write("Goal_Position", "gripper", current + offset, normalize=False)
            time.sleep(0.3)
            bus.write("Goal_Position", "gripper", current - offset, normalize=False)
            time.sleep(0.3)

        # Return to original position
        bus.write("Goal_Position", "gripper", current, normalize=False)
        time.sleep(0.3)
    finally:
        bus.disconnect()


@router.post("/wiggle")
async def wiggle_gripper(request: WiggleRequest):
    """Wiggle the gripper on a port so the user can identify which arm it is."""
    try:
        await asyncio.to_thread(_wiggle_gripper_sync, request.port)
        return {"message": f"Wiggled gripper on {request.port}"}
    except Exception as e:
        traceback_str = tb.format_exc()
        logger.exception("Failed to wiggle gripper")
        raise HTTPException(
            status_code=500,
            detail={
                "message": f"Failed to wiggle gripper: {e}",
                "traceback": traceback_str,
                "hint": _get_error_hint(e),
            },
        )


async def _run_chmod(devices: list, password: str) -> str:
    """对设备列表执行 chmod 666（phosphobot 风格）。返回成功信息或抛出 HTTPException。
    策略：1) root 直接 chmod；2) sudo -n（NOPASSWD）；3) sudo -S（需密码）。"""
    MODE = "666"

    async def _chmod_direct(d: str) -> tuple[int, str]:
        p = await asyncio.create_subprocess_exec(
            "chmod", MODE, d,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await p.communicate()
        return p.returncode, (err or out or b"").decode("utf-8", errors="replace").strip()

    async def _sudo(no_password: bool, pwd: str) -> tuple[int, str]:
        flags = ["-n"] if no_password else ["-S"]
        p = await asyncio.create_subprocess_exec(
            "sudo", *flags, "chmod", MODE, *devices,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdin_data = b"" if no_password else (pwd.encode("utf-8") + b"\n")
        out, err = await p.communicate(input=stdin_data)
        combined = (err or out or b"").decode("utf-8", errors="replace").strip()
        return p.returncode, combined

    # geteuid 在 Windows 上不存在，用 getattr 兼容
    if getattr(os, "geteuid", lambda: -1)() == 0:
        # 已是 root，直接 chmod（phosphobot 同款，无需 sudo）
        for d in devices:
            rc, err = await _chmod_direct(d)
            if rc != 0:
                raise HTTPException(status_code=500, detail={"message": err or f"chmod {MODE} failed."})
        return f"chmod {MODE} applied to: {', '.join(devices)}"

    # 1. 先试 sudo -n（NOPASSWD 时直接成功，无需输入密码）
    rc, err = await _sudo(no_password=True, pwd="")
    if rc == 0:
        return f"chmod {MODE} applied to: {', '.join(devices)} (no password needed)"

    # 2. 有密码时试 sudo -S
    if password:
        rc, err = await _sudo(no_password=False, pwd=password)
        if rc == 0:
            return f"chmod {MODE} applied to: {', '.join(devices)}"
        if "password" in err.lower() or "sorry" in err.lower():
            raise HTTPException(status_code=403, detail={"message": "Wrong password or sudo not allowed."})
        if "no tty" in err.lower() or "askpass" in err.lower():
            raise HTTPException(
                status_code=500,
                detail={"message": f"sudo requires a TTY. Run in a terminal: sudo chmod {MODE} /dev/ttyACM*"},
            )
        raise HTTPException(status_code=500, detail={"message": err or f"chmod {MODE} failed."})

    # 3. 没有密码且 sudo -n 也失败 → 提示手动执行
    hint = "\n".join([f"  sudo chmod {MODE} {d}" for d in devices])
    raise HTTPException(
        status_code=403,
        detail={"message": f"sudo requires a password. Enter your password above, or run in a terminal:\n{hint}"},
    )


@router.post("/chmod-serial")
async def chmod_serial(request: ChmodSerialRequest):
    """Run sudo chmod 666 /dev/ttyACM* (phosphobot style) so the port can be accessed."""
    try:
        devices = sorted(glob.glob("/dev/ttyACM*"))
        if not devices:
            raise HTTPException(
                status_code=400,
                detail={"message": "No /dev/ttyACM* devices found. Plug in the base and try again."},
            )
        msg = await _run_chmod(devices, (request.password or "").strip())
        return {"message": msg}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("chmod-serial failed")
        raise HTTPException(
            status_code=500,
            detail={"message": str(e), "traceback": tb.format_exc()},
        )


# ---------------------------------------------------------------------------
# MJPEG camera streaming
# ---------------------------------------------------------------------------

class _CameraStream:
    """Manages a single OpenCV camera capture shared across MJPEG clients."""

    def __init__(self, index: int):
        self.index = index
        self._cap: cv2.VideoCapture | None = None
        self._lock = threading.Lock()
        self._clients = 0
        self._frame: bytes | None = None
        self._running = False
        self._thread: threading.Thread | None = None

    def _capture_loop(self) -> None:
        cap = cv2.VideoCapture(self.index)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self._cap = cap
        while self._running:
            ret, frame = cap.read()
            if ret:
                _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                self._frame = jpeg.tobytes()
            time.sleep(1 / 15)  # ~15 fps
        cap.release()
        self._cap = None

    def add_client(self) -> None:
        with self._lock:
            self._clients += 1
            if not self._running:
                self._running = True
                self._thread = threading.Thread(target=self._capture_loop, daemon=True)
                self._thread.start()

    def remove_client(self) -> None:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0:
                self._running = False

    @property
    def frame(self) -> bytes | None:
        return self._frame


_camera_streams: dict[int, _CameraStream] = {}
_streams_lock = threading.Lock()


def _get_camera_stream(index: int) -> _CameraStream:
    with _streams_lock:
        if index not in _camera_streams:
            _camera_streams[index] = _CameraStream(index)
        return _camera_streams[index]


def _stop_all_streams() -> None:
    """Stop all active MJPEG streams and wait for capture threads to release cameras."""
    threads: list[threading.Thread] = []
    with _streams_lock:
        for stream in _camera_streams.values():
            stream._running = False
            if stream._thread is not None:
                threads.append(stream._thread)
        _camera_streams.clear()
    # Wait for capture threads to fully exit and release cameras
    for t in threads:
        t.join(timeout=3)


@router.post("/cameras/streams/stop")
async def stop_all_camera_streams():
    """Stop all active MJPEG camera streams.

    Must be called before starting recording or teleoperation so the subprocess
    can access the cameras without conflict.
    """
    await asyncio.to_thread(_stop_all_streams)
    return {"message": "All camera streams stopped"}


@router.get("/cameras/stream/{camera_index}")
async def stream_camera(camera_index: int):
    """MJPEG stream for a camera. The browser renders this natively via <img src=...>."""
    stream = _get_camera_stream(camera_index)
    stream.add_client()

    async def generate():
        try:
            # Wait briefly for first frame
            for _ in range(30):
                if stream.frame is not None:
                    break
                await asyncio.sleep(0.1)

            while stream._running:
                frame = stream.frame
                if frame is not None:
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                    )
                await asyncio.sleep(1 / 15)
        finally:
            stream.remove_client()

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
