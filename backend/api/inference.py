"""Inference API endpoints."""

import asyncio
import json
import logging
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models.inference import InferenceRequest, InferenceResponse
from backend.models.system import ProcessStatus
from backend.services.camera_scanner import CameraScannerService
from backend.services.config_manager import ConfigManager
from backend.services.port_lock_manager import PortInUseError, port_lock_manager
from backend.services.process_manager import process_manager

router = APIRouter()
config_manager = ConfigManager()
camera_scanner = CameraScannerService()
logger = logging.getLogger(__name__)


def build_inference_command(config, request: InferenceRequest) -> list[str]:
    """Build inference command from config and request.

    Inference uses lerobot-record with --policy.path and NO --teleop.* flags.
    The policy replaces the teleoperator and controls the robot autonomously.
    """
    cameras_dict = {}
    if config.mode == "bimanual":
        for cam in config.bimanual.cameras:
            cameras_dict[cam.name] = {
                "type": "opencv",
                "index_or_path": cam.index,
                "width": cam.width,
                "height": cam.height,
                "fps": cam.fps,
            }

        bi = config.bimanual
        return [
            "lerobot-record",
            "--robot.type=bi_so101_follower",
            f"--robot.left_arm_port={bi.left_follower_port}",
            f"--robot.right_arm_port={bi.right_follower_port}",
            f"--robot.id={bi.follower_id or 'bimanual_follower'}",
            f"--robot.cameras={json.dumps(cameras_dict)}",
            f"--dataset.repo_id={request.repo_id}",
            f"--dataset.single_task={request.single_task}",
            f"--dataset.num_episodes={request.num_episodes}",
            f"--dataset.episode_time_s={request.episode_time_s}",
            f"--display_data={str(request.display_data).lower()}",
            f"--policy.path={request.policy_path}",
        ]
    else:
        for cam in config.single_arm.cameras:
            cameras_dict[cam.name] = {
                "type": "opencv",
                "index_or_path": cam.index,
                "width": cam.width,
                "height": cam.height,
                "fps": cam.fps,
            }

        sa = config.single_arm
        return [
            "lerobot-record",
            "--robot.type=so101_follower",
            f"--robot.port={sa.follower_port}",
            f"--robot.id={sa.follower_id or 'single_follower'}",
            f"--robot.cameras={json.dumps(cameras_dict)}",
            f"--dataset.repo_id={request.repo_id}",
            f"--dataset.single_task={request.single_task}",
            f"--dataset.num_episodes={request.num_episodes}",
            f"--dataset.episode_time_s={request.episode_time_s}",
            f"--display_data={str(request.display_data).lower()}",
            f"--policy.path={request.policy_path}",
        ]


def _configured_cameras(config) -> list:
    """Return the list of configured camera entries for the active mode."""
    if config.mode == "bimanual":
        return list(config.bimanual.cameras)
    return list(config.single_arm.cameras)


async def _preflight_cameras(config) -> None:
    """Stop MJPEG previews and verify each configured camera can be opened.

    Raises HTTPException(503) if any camera fails verification, with a message
    that names the offending camera (e.g. "side_cam") so the user can act.
    """
    # Stop any MJPEG preview workers still running on the backend before we
    # try to claim the cameras for the lerobot subprocess. The frontend also
    # calls stopCameraStreams(), but doing it here too closes a race where a
    # stream re-opens between the two calls.
    from backend.api.setup import _stop_all_streams

    await asyncio.to_thread(_stop_all_streams)

    cameras = _configured_cameras(config)
    indices = [cam.index for cam in cameras]
    if not indices:
        return

    failure = await asyncio.to_thread(camera_scanner.verify_indices, indices)
    if failure is None:
        return

    failing_index, _reason = failure
    cam_name = next(
        (cam.name for cam in cameras if cam.index == failing_index),
        f"index {failing_index}",
    )
    raise HTTPException(
        status_code=503,
        detail=(
            f"Camera '{cam_name}' (index {failing_index}) is not accessible. "
            "Try unplugging and replugging it, or wait a few seconds and try again."
        ),
    )


def _extract_inference_ports(config) -> list[str]:
    """Extract follower ports used by inference (no teleop ports needed)."""
    if config.mode == "bimanual":
        bi = config.bimanual
        return [p for p in [bi.left_follower_port, bi.right_follower_port] if p]
    else:
        return [config.single_arm.follower_port] if config.single_arm.follower_port else []


@router.post("/start", response_model=InferenceResponse)
async def start_inference(request: InferenceRequest):
    """Start policy inference (autonomous robot control)."""
    ports = []
    try:
        config = config_manager.load_config()

        # Validate config - only need robot ports and cameras (no teleop needed)
        if config.mode == "bimanual":
            if not all(
                [
                    config.bimanual.left_follower_port,
                    config.bimanual.right_follower_port,
                ]
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Bimanual mode requires both follower arm ports to be configured",
                )

            if not config.bimanual.cameras:
                raise HTTPException(
                    status_code=400, detail="No cameras configured for inference"
                )
        else:
            if not config.single_arm.follower_port:
                raise HTTPException(
                    status_code=400,
                    detail="Single arm mode requires a follower port to be configured",
                )

            if not config.single_arm.cameras:
                raise HTTPException(
                    status_code=400, detail="No cameras configured for inference"
                )

        # Pre-allocate process_id so the port lock can be tagged with it
        # atomically — otherwise a fast-fail subprocess can race the log task's
        # release-on-exit ahead of register_process and strand the lease.
        process_id = str(uuid.uuid4())

        # Acquire port locks
        ports = _extract_inference_ports(config)
        try:
            await port_lock_manager.acquire(
                ports, owner="inference", mode="subprocess", process_id=process_id,
            )
        except PortInUseError as e:
            raise HTTPException(status_code=409, detail={"message": str(e), "owner": e.owner, "port": e.port})

        # Verify cameras are actually openable before we sink time into a 50s
        # policy download just to fail at robot.connect(). This also rides out
        # the Windows DSHOW handle-stuck race after MJPEG workers shut down.
        await _preflight_cameras(config)

        # Clear stale eval dataset cache to prevent conflicts on re-runs
        cache_cleared = False
        cache_dir = Path.home() / ".cache" / "huggingface" / "lerobot" / request.repo_id
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
            cache_cleared = True
            logger.info("Cleared stale eval cache at %s", cache_dir)

        command = build_inference_command(config, request)
        await process_manager.start_process(command, "inference", process_id=process_id)

        msg = "Inference started successfully"
        if cache_cleared:
            msg += " (previous eval cache cleared)"

        return InferenceResponse(process_id=process_id, message=msg)

    except HTTPException:
        # Pre-flight or validation failure after port locks were acquired —
        # don't leak the lock to a process that never started.
        if ports:
            await port_lock_manager.release(ports)
        raise
    except Exception as e:
        if ports:
            await port_lock_manager.release(ports)
        raise HTTPException(status_code=500, detail=f"Failed to start inference: {e}")


@router.post("/stop/{process_id}")
async def stop_inference(process_id: str):
    """Stop inference."""
    try:
        success = await process_manager.stop_process(process_id)

        if not success:
            raise HTTPException(
                status_code=404, detail=f"Process {process_id} not found"
            )

        # Wait for OS to release ports, then release locks
        await asyncio.sleep(0.5)
        await port_lock_manager.release_for_process(process_id)

        return {"message": "Inference stopped successfully"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop inference: {e}")


@router.get("/status/{process_id}", response_model=ProcessStatus)
async def get_inference_status(process_id: str):
    """Get inference process status."""
    try:
        status = await process_manager.get_status(process_id)

        if not status:
            raise HTTPException(
                status_code=404, detail=f"Process {process_id} not found"
            )

        return status

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {e}")
