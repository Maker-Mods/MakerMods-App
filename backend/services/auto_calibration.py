"""Auto-calibration service for SO101 robot arms.

Wraps the lerobot_auto_calibrate_feetech.py script, running it as a subprocess
via ProcessManager with real-time log streaming. After the script completes,
copies the saved calibration file to the standard so101_follower path so it's
visible to the rest of the UI.
"""

import logging
import shutil
import sys
from pathlib import Path

from backend.services.process_manager import process_manager

logger = logging.getLogger(__name__)

CALIBRATION_BASE = Path.home() / ".cache" / "huggingface" / "lerobot" / "calibration"


class AutoCalibrationService:
    """Service that runs the lerobot auto-calibration script as a subprocess."""

    def build_command(
        self,
        port: str,
        device_id: str,
    ) -> list[str]:
        """Build the command to run the auto-calibration script.

        Args:
            port: Serial port path (e.g. /dev/tty.usbmodem5B140332851)
            device_id: Robot ID for the calibration file name

        Returns:
            Command as list of strings.
        """
        return [
            sys.executable,
            "-m", "lerobot.scripts.lerobot_auto_calibrate_feetech",
            "--port", port,
            "--save",
            "--robot-id", device_id,
        ]

    async def start(
        self, port: str, device_id: str, process_id: str | None = None
    ) -> str:
        """Start auto-calibration as a subprocess.

        Args:
            port: Serial port path
            device_id: Robot ID for the saved calibration file
            process_id: Optional pre-generated process_id so callers can acquire
                the port lock atomically with subprocess launch.

        Returns:
            Process ID for tracking.
        """
        command = self.build_command(port, device_id)
        process_id = await process_manager.start_process(
            command, "auto_calibration", process_id=process_id,
        )
        return process_id

    async def stop(self, process_id: str) -> bool:
        """Stop a running auto-calibration process."""
        return await process_manager.stop_process(process_id)

    def copy_to_so101_path(
        self,
        device_id: str,
        category: str = "robots",
        robot_type: str = "so101_follower",
    ) -> Path | None:
        """Copy the calibration file from so_follower/ to the correct so101 path.

        The lerobot script always saves to robots/so_follower/{device_id}.json
        but the UI and lerobot SO101 wrappers look in {category}/{robot_type}/.
        This copies the file to the correct destination.

        Args:
            device_id: Robot/teleoperator ID
            category: "robots" or "teleoperators"
            robot_type: Target type (e.g. "so101_follower" or "so101_leader")

        Returns:
            Path to the copied file, or None if source doesn't exist.
        """
        src = CALIBRATION_BASE / "robots" / "so_follower" / f"{device_id}.json"
        if not src.exists():
            logger.warning(f"Auto-calibration source file not found: {src}")
            return None

        dst_dir = CALIBRATION_BASE / category / robot_type
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / f"{device_id}.json"
        shutil.copy2(src, dst)
        logger.info(f"Copied calibration: {src} -> {dst}")
        return dst
