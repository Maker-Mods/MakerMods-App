"""Setup API endpoints for ports and cameras."""

import asyncio
import logging
import multiprocessing as mp
import threading
import time
import traceback as tb
from typing import Dict, List, Optional

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
        await asyncio.to_thread(_stop_all_streams)
        # Pass as kwarg — passing positional makes exclude_builtin become
        # max_cameras (its first positional param), which silently degrades to
        # 0 on Windows where system_profiler doesn't apply, returning [].
        return await asyncio.to_thread(
            lambda: camera_scanner.list_cameras(exclude_builtin=exclude_builtin)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list cameras: {e}")


@router.post("/cameras/preview", response_model=Dict[int, CameraPreview])
async def capture_camera_previews(camera_indices: List[int] = None):
    """Capture preview images from cameras.

    Args:
        camera_indices: Optional list of camera indices to capture. If None, captures all.
    """
    try:
        return await asyncio.to_thread(
            camera_scanner.capture_preview, camera_indices
        )
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

        if current - offset < 0 or current + offset > 4095:
            raise ValueError(
                f"Gripper position ({current}) is too close to the edge of its range. "
                "Please unplug and replug the power to the arm, then try again."
            )

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
    from backend.services.port_lock_manager import PortInUseError, port_lock_manager

    try:
        async with port_lock_manager.hold([request.port], owner="wiggle"):
            await asyncio.wait_for(
                asyncio.to_thread(_wiggle_gripper_sync, request.port),
                timeout=15.0,
            )
        return {"message": f"Wiggled gripper on {request.port}"}
    except PortInUseError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(e),
                "owner": e.owner,
                "port": e.port,
            },
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "Wiggle gripper timed out after 15 seconds",
                "hint": "The arm may not be powered on or responding.",
            },
        )
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


# ---------------------------------------------------------------------------
# MJPEG camera streaming
# ---------------------------------------------------------------------------


def _camera_worker(index: int, queue: mp.Queue, stop_event: mp.Event) -> None:
    """Capture frames in a separate process to avoid macOS AVFoundation cache."""
    import cv2
    import time

    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        # Camera unavailable (e.g. held by teleoperation subprocess) — exit cleanly
        return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    while not stop_event.is_set():
        ret, frame = cap.read()
        if ret:
            _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            data = jpeg.tobytes()
            # Keep only the latest frame
            while not queue.empty():
                try:
                    queue.get_nowait()
                except Exception:
                    break
            try:
                queue.put_nowait(data)
            except Exception:
                pass
        else:
            # Camera read failed — exit
            break
        time.sleep(1 / 15)
    cap.release()


class _CameraStream:
    """Manages a camera capture subprocess shared across MJPEG clients."""

    def __init__(self, index: int):
        self.index = index
        self._lock = threading.Lock()
        self._clients = 0
        self._frame: bytes | None = None
        self._running = False
        self._process: mp.Process | None = None
        self._queue: mp.Queue | None = None
        self._stop_event: mp.Event | None = None
        self._reader_thread: threading.Thread | None = None

    def _reader_loop(self) -> None:
        """Pull frames from the subprocess queue into self._frame."""
        while self._running:
            try:
                frame = self._queue.get(timeout=0.1)
                self._frame = frame
            except Exception:
                pass

    def add_client(self) -> None:
        with self._lock:
            self._clients += 1
            if not self._running:
                self._running = True
                self._frame = None
                self._stop_event = mp.Event()
                self._queue = mp.Queue()
                self._process = mp.Process(
                    target=_camera_worker,
                    args=(self.index, self._queue, self._stop_event),
                    daemon=True,
                )
                self._process.start()
                self._reader_thread = threading.Thread(
                    target=self._reader_loop, daemon=True
                )
                self._reader_thread.start()

    def remove_client(self) -> None:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0:
                self._stop()

    def _stop(self) -> None:
        self._running = False
        if self._stop_event is not None:
            self._stop_event.set()
        if self._process is not None:
            # Give the process a brief moment to exit cleanly, then kill it.
            # Use a short timeout (0.5s) to avoid blocking threads/event loop.
            self._process.join(timeout=0.5)
            if self._process.is_alive():
                self._process.kill()
                self._process.join(timeout=1)
            self._process = None
        self._frame = None

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
    """Stop all active MJPEG streams and wait for subprocesses to release cameras."""
    # Collect and clear under the lock, but stop outside it to avoid
    # holding _streams_lock for seconds while process.join() blocks.
    with _streams_lock:
        streams = list(_camera_streams.values())
        _camera_streams.clear()
    for stream in streams:
        stream._stop()


def _stop_single_stream(index: int) -> None:
    """Stop a single camera stream by index."""
    with _streams_lock:
        stream = _camera_streams.pop(index, None)
    if stream:
        stream._stop()


@router.post("/cameras/streams/stop")
async def stop_all_camera_streams():
    """Stop all active MJPEG camera streams.

    Must be called before starting recording or teleoperation so the subprocess
    can access the cameras without conflict.
    """
    await asyncio.to_thread(_stop_all_streams)
    return {"message": "All camera streams stopped"}


@router.post("/cameras/stream/{camera_index}/stop")
async def stop_camera_stream(camera_index: int):
    """Stop a single camera MJPEG stream.

    Called by the frontend when a camera feed component unmounts to ensure the
    capture subprocess is cleaned up even if the proxy doesn't propagate the
    HTTP disconnect.
    """
    await asyncio.to_thread(_stop_single_stream, camera_index)
    return {"message": f"Camera stream {camera_index} stopped"}


@router.get("/cameras/stream/{camera_index}")
async def stream_camera(camera_index: int):
    """MJPEG stream for a camera. The browser renders this natively via <img src=...>."""
    stream = await asyncio.to_thread(_get_camera_stream, camera_index)
    await asyncio.to_thread(stream.add_client)

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
            await asyncio.to_thread(stream.remove_client)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
