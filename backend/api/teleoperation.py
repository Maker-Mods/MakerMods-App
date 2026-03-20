"""Teleoperation API endpoints."""

import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models.system import ProcessState, ProcessStatus
from backend.models.teleoperation import (
    BASE_CMD_FILE,
    BaseStartRequest,
    BaseStartResponse,
    BaseVelocityRequest,
    TeleoperationRequest,
    TeleoperationResponse,
)
from backend.services.config_manager import ConfigManager
from backend.services.process_manager import process_manager

router = APIRouter()
config_manager = ConfigManager()


def build_teleoperation_command(config, display_data: bool = True) -> list[str]:
    """Build teleoperation command from config."""
    if config.mode == "bimanual":
        bi = config.bimanual
        return [
            "lerobot-teleoperate",
            "--robot.type=bi_so101_follower",
            f"--robot.left_arm_port={bi.left_follower_port}",
            f"--robot.right_arm_port={bi.right_follower_port}",
            f"--robot.id={bi.left_follower_id or 'bimanual_follower'}",
            "--teleop.type=bi_so101_leader",
            f"--teleop.left_arm_port={bi.left_leader_port}",
            f"--teleop.right_arm_port={bi.right_leader_port}",
            f"--teleop.id={bi.left_leader_id or 'bimanual_leader'}",
            f"--display_data={str(display_data).lower()}",
        ]
    else:
        sa = config.single_arm
        return [
            "lerobot-teleoperate",
            "--robot.type=so101_follower",
            f"--robot.port={sa.follower_port}",
            f"--robot.id={sa.follower_id or 'single_follower'}",
            "--teleop.type=so101_leader",
            f"--teleop.port={sa.leader_port}",
            f"--teleop.id={sa.leader_id or 'single_leader'}",
            f"--display_data={str(display_data).lower()}",
        ]


@router.post("/start", response_model=TeleoperationResponse)
async def start_teleoperation(request: TeleoperationRequest):
    """Start teleoperation."""
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
        else:
            if not all([config.single_arm.follower_port, config.single_arm.leader_port]):
                raise HTTPException(
                    status_code=400, detail="Single arm mode requires both follower and leader ports"
                )

        # Always enable display_data so motor positions are printed to stdout
        # (the WebUI parses them for the live motor panel). Suppress the Rerun
        # viewer by setting RERUN_ENABLED=false — rr.spawn() becomes a no-op.
        command = build_teleoperation_command(config, display_data=True)
        process_id = await process_manager.start_process(
            command, "teleoperation", env={"RERUN": "off"}
        )

        return TeleoperationResponse(process_id=process_id, message="Teleoperation started successfully")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start teleoperation: {e}")


@router.post("/stop/{process_id}")
async def stop_teleoperation(process_id: str):
    """Stop teleoperation."""
    try:
        success = await process_manager.stop_process(process_id)

        if not success:
            raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

        return {"message": "Teleoperation stopped successfully"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop teleoperation: {e}")


@router.get("/status/{process_id}", response_model=ProcessStatus)
async def get_teleoperation_status(process_id: str):
    """Get teleoperation process status."""
    try:
        status = await process_manager.get_status(process_id)

        if not status:
            raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

        return status

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {e}")


# ---------- Chassis / Base control (LeKiwi) ----------


@router.get("/base/ready")
async def base_control_ready():
    """检测底盘接口是否已加载（用于前端判断是否 404 因端口错误）。"""
    return {"ready": True}


def _write_base_cmd(data: dict) -> None:
    """Write base command JSON to the shared file."""
    with open(BASE_CMD_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


@router.post("/base/start", response_model=BaseStartResponse)
async def start_base_control(request: BaseStartRequest):
    """Start the LeKiwi base controller subprocess (reads commands from shared file)."""
    try:
        # 初始化为全零，避免启动瞬间乱动
        try:
            _write_base_cmd({
                "forward": False,
                "backward": False,
                "left": False,
                "right": False,
                "rotate_left": False,
                "rotate_right": False,
                "speed_index": 0,
            })
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail={"message": f"Cannot write command file {BASE_CMD_FILE}: {e!s}. Check /tmp is writable."},
            )
        # 底盘逻辑来源于 lerobot.robots.lekiwi（与 run_lekiwi_keyboard_only 共用）
        command = [
            sys.executable,
            "-m",
            "lerobot.robots.lekiwi.run_lekiwi_base_from_file",
            "--port",
            request.port,
            "--cmd-file",
            BASE_CMD_FILE,
            "--wheel-radius",
            str(request.wheel_radius),
            "--base-radius",
            str(request.base_radius),
            "--wheel-angles",
            request.wheel_angles,
        ]
        base_env = {
            "LEROBOT_BASE_CMD_FILE": BASE_CMD_FILE,
            "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
        }
        process_id = await process_manager.start_process(
            command, "base_control", env=base_env
        )
        # 若子进程立即退出（如串口打不开），把原因返回给前端
        await asyncio.sleep(1.5)
        status = await process_manager.get_status(process_id)
        if status and status.state == ProcessState.ERROR:
            logs = await process_manager.get_logs(process_id, last_n=15)
            err_snippet = "\n".join(logs).strip() if logs else (status.error_message or "Process exited with error.")
            raise HTTPException(
                status_code=500,
                detail={"message": f"Cannot connect to port or base process crashed: {err_snippet}"},
            )
        return BaseStartResponse(
            process_id=process_id,
            message="Base control started. Use POST /api/teleoperation/base/velocity to send commands.",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Failed to start base control: {e!s}"},
        )


@router.post("/base/velocity")
async def set_base_velocity(request: BaseVelocityRequest):
    """Write current chassis velocity command to the file read by the base controller."""
    try:
        _write_base_cmd(request.model_dump())
        return {"ok": True}
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Failed to write base command file: {e!s}"},
        )


@router.post("/base/stop/{process_id}")
async def stop_base_control(process_id: str):
    """Stop the base controller process and write zero velocity."""
    try:
        _write_base_cmd({
            "forward": False,
            "backward": False,
            "left": False,
            "right": False,
            "rotate_left": False,
            "rotate_right": False,
            "speed_index": 0,
        })
        success = await process_manager.stop_process(process_id)
        if not success:
            raise HTTPException(status_code=404, detail={"message": f"Process {process_id} not found"})
        return {"message": "Base control stopped"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Failed to stop base control: {e!s}"},
        )
