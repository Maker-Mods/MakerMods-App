"""Port scanning service wrapping lerobot_find_port logic."""

import platform
from pathlib import Path
from typing import List

from backend.models.setup import PortInfo


def _list_windows_ports() -> List[PortInfo]:
    """Enumerate Windows COM ports via pyserial."""
    from serial.tools.list_ports import comports

    return [
        PortInfo(
            port=p.device,
            description=p.description or "Serial Port",
            hwid=p.hwid,
        )
        for p in comports()
    ]


def _list_unix_ports(globs: List[str]) -> List[PortInfo]:
    """Enumerate POSIX serial ports by globbing /dev.

    - macOS:
        - /dev/cu.usbmodem*   — native USB-CDC boards (e.g. Waveshare SO-ARM driver board)
        - /dev/cu.usbserial-* — FTDI USB-to-UART bridge boards
    - Linux: USB serial adapters as /dev/ttyUSB*, USB CDC ACM as /dev/ttyACM*
    """
    dev = Path("/dev")
    ports = sorted({str(p) for pattern in globs for p in dev.glob(pattern) if p.exists()})
    return [
        PortInfo(port=p, description="Feetech Motor Controller", hwid=None)
        for p in ports
    ]


class PortScannerService:
    """Service for scanning and detecting serial ports."""

    def list_ports(self) -> List[PortInfo]:
        """List available serial ports (Feetech motor controllers / SO101 leader/follower).

        On Windows returns COM* ports via pyserial; on macOS returns
        /dev/cu.usbmodem* and /dev/cu.usbserial-*; on Linux returns
        /dev/ttyUSB* and /dev/ttyACM*.

        Returns:
            List of PortInfo objects.
        """
        system = platform.system()
        if system == "Windows":
            return _list_windows_ports()
        if system == "Darwin":
            return _list_unix_ports(["cu.usbmodem*", "cu.usbserial-*"])
        if system == "Linux":
            return _list_unix_ports(["ttyUSB*", "ttyACM*"])
        return []

    def detect_port_change(self, ports_before: List[str], ports_after: List[str]) -> tuple[List[str], List[str]]:
        """Detect which ports were added or removed.

        Args:
            ports_before: List of ports before change.
            ports_after: List of ports after change.

        Returns:
            Tuple of (removed_ports, added_ports).
        """
        removed = [p for p in ports_before if p not in ports_after]
        added = [p for p in ports_after if p not in ports_before]

        return removed, added
