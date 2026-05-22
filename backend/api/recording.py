"""Recording API endpoints."""

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models.recording import RecordingActionRequest, RecordingRequest, RecordingResponse
from backend.models.system import ProcessState, ProcessStatus
from backend.services.config_manager import ConfigManager
from backend.services.port_lock_manager import PortInUseError, port_lock_manager
from backend.services.process_manager import process_manager

router = APIRouter()
config_manager = ConfigManager()


def build_recording_command(config, request: RecordingRequest) -> list[str]:
    """Build recording command from config and request."""
    # Build cameras JSON
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
            "--teleop.type=bi_so101_leader",
            f"--teleop.left_arm_port={bi.left_leader_port}",
            f"--teleop.right_arm_port={bi.right_leader_port}",
            f"--teleop.id={bi.leader_id or 'bimanual_leader'}",
            f"--dataset.repo_id={request.repo_id}",
            f"--dataset.single_task={request.single_task}",
            f"--dataset.num_episodes={request.num_episodes}",
            f"--dataset.episode_time_s={request.episode_time_s}",
            f"--dataset.reset_time_s={request.reset_time_s}",
            f"--display_data={str(request.display_data).lower()}",
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
            "--teleop.type=so101_leader",
            f"--teleop.port={sa.leader_port}",
            f"--teleop.id={sa.leader_id or 'single_leader'}",
            f"--dataset.repo_id={request.repo_id}",
            f"--dataset.single_task={request.single_task}",
            f"--dataset.num_episodes={request.num_episodes}",
            f"--dataset.episode_time_s={request.episode_time_s}",
            f"--dataset.reset_time_s={request.reset_time_s}",
            f"--display_data={str(request.display_data).lower()}",
        ]


def _extract_recording_ports(config) -> list[str]:
    """Extract all serial ports used by recording."""
    if config.mode == "bimanual":
        bi = config.bimanual
        return [p for p in [
            bi.left_follower_port, bi.right_follower_port,
            bi.left_leader_port, bi.right_leader_port,
        ] if p]
    else:
        sa = config.single_arm
        return [p for p in [sa.follower_port, sa.leader_port] if p]


@router.post("/start", response_model=RecordingResponse)
async def start_recording(request: RecordingRequest):
    """Start dataset recording."""
    ports = []
    try:
        config = config_manager.load_config()

        # Validate config
        if config.mode == "bimanual":
            if not all(
                [
                    config.bimanual.left_follower_port,
                    config.bimanual.left_leader_port,
                    config.bimanual.right_follower_port,
                    config.bimanual.right_leader_port,
                ]
            ):
                raise HTTPException(
                    status_code=400, detail="Bimanual mode requires all four ports to be configured"
                )

            if not config.bimanual.cameras:
                raise HTTPException(status_code=400, detail="No cameras configured for recording")

        else:
            if not all([config.single_arm.follower_port, config.single_arm.leader_port]):
                raise HTTPException(
                    status_code=400, detail="Single arm mode requires both follower and leader ports"
                )

            if not config.single_arm.cameras:
                raise HTTPException(status_code=400, detail="No cameras configured for recording")

        # Acquire port locks
        ports = _extract_recording_ports(config)
        try:
            await port_lock_manager.acquire(ports, owner="recording", mode="subprocess")
        except PortInUseError as e:
            raise HTTPException(status_code=409, detail={"message": str(e), "owner": e.owner, "port": e.port})

        # Build and start command
        command = build_recording_command(config, request)
        process_id = await process_manager.start_process(command, "recording")

        # Register process→ports mapping for release on stop
        await port_lock_manager.register_process(process_id, ports)

        # Update last recording config
        config.last_recording.repo_id = request.repo_id
        config.last_recording.task = request.single_task
        config.last_recording.num_episodes = request.num_episodes
        config.last_recording.episode_time_s = request.episode_time_s
        config_manager.save_config(config)

        return RecordingResponse(process_id=process_id, message="Recording started successfully")

    except HTTPException:
        raise
    except Exception as e:
        if ports:
            await port_lock_manager.release(ports)
        raise HTTPException(status_code=500, detail=f"Failed to start recording: {e}")


@router.post("/stop/{process_id}")
async def stop_recording(process_id: str):
    """Stop recording."""
    try:
        success = await process_manager.stop_process(process_id)

        if not success:
            raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

        # Wait for OS to release ports, then release locks
        await asyncio.sleep(0.5)
        await port_lock_manager.release_for_process(process_id)

        return {"message": "Recording stopped successfully"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop recording: {e}")


_ALLOWED_ACTIONS = {"rerecord", "save", "stop"}


@router.post("/action/{process_id}")
async def send_recording_action(process_id: str, request: RecordingActionRequest):
    """Send a keyboard-equivalent control action to a running recording.

    Actions map to lerobot record-loop events:
      - "rerecord": discard current episode, reset, re-record (left arrow)
      - "save":     end current phase early and save the episode (right arrow)
      - "stop":     stop the whole recording session (escape)
    """
    if request.action not in _ALLOWED_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action '{request.action}'. Allowed: {sorted(_ALLOWED_ACTIONS)}",
        )

    status = await process_manager.get_status(process_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Process {process_id} not found")
    if status.state != ProcessState.RUNNING:
        raise HTTPException(status_code=409, detail=f"Process {process_id} is not running")

    # Note: if the process exits between the status check above and this
    # write, send_stdin returns False and we surface a 500. This is a rare
    # race; the alternative (re-querying status) is not worth the complexity.
    ok = await process_manager.send_stdin(process_id, request.action)
    if not ok:
        raise HTTPException(
            status_code=500, detail="Failed to deliver action to recording process"
        )

    return {"message": f"Action '{request.action}' sent"}


@router.get("/status/{process_id}", response_model=ProcessStatus)
async def get_recording_status(process_id: str):
    """Get recording process status."""
    try:
        status = await process_manager.get_status(process_id)

        if not status:
            raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

        return status

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {e}")


@router.delete("/cache")
async def clear_cache(repo_id: str):
    """Clear dataset cache for a specific repo.

    Args:
        repo_id: HuggingFace repo ID (username/dataset_name).
    """
    try:
        cache_dir = Path.home() / ".cache" / "huggingface" / "lerobot" / repo_id

        if cache_dir.exists():
            shutil.rmtree(cache_dir)
            return {"message": f"Cache cleared for {repo_id}"}
        else:
            return {"message": f"No cache found for {repo_id}"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {e}")


@router.post("/open-folder")
async def open_data_folder():
    """Open the HuggingFace lerobot data folder in the system file manager."""
    try:
        folder = Path.home() / ".cache" / "huggingface" / "lerobot"
        folder.mkdir(parents=True, exist_ok=True)

        if sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        elif sys.platform.startswith("linux"):
            subprocess.Popen(["xdg-open", str(folder)])
        else:
            subprocess.Popen(["explorer", str(folder)])

        return {"message": f"Opened {folder}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open folder: {e}")
