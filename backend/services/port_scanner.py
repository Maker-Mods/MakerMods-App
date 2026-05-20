"""Port scanning service wrapping lerobot_find_port logic."""

import platform
from pathlib import Path
from typing import List

from backend.models.setup import PortInfo


def _get_serial_port_globs() -> List[str]:
    """Return glob patterns for serial ports under /dev, per platform.

    - macOS:
        - /dev/cu.usbmodem*   — native USB-CDC boards (e.g. Waveshare SO-ARM driver board)
        - /dev/cu.usbserial-* — FTDI USB-to-UART bridge boards
    - Linux: USB serial adapters as /dev/ttyUSB*, USB CDC ACM as /dev/ttyACM*
    """
    system = platform.system()
    if system == "Darwin":
        return ["cu.usbmodem*", "cu.usbserial-*"]
    if system == "Linux":
        return ["ttyUSB*", "ttyACM*"]
    return []


class PortScannerService:
    """Service for scanning and detecting serial ports."""

    def list_ports(self) -> List[PortInfo]:
        """List available serial ports (Feetech motor controllers / SO101 leader/follower).

        Windows: enumerate COM* via pyserial (returns description + hwid for serial-number ID).
        macOS:   /dev/cu.usbmodem* and /dev/cu.usbserial-*
        Linux:   /dev/ttyUSB* and /dev/ttyACM*
        """
        if platform.system() == "Windows":
            from serial.tools import list_ports as _serial_list_ports
            return [
                PortInfo(
                    port=p.device,
                    description=p.description or "Serial Port",
                    hwid=p.hwid,
                )
                for p in _serial_list_ports.comports()
            ]

        dev = Path("/dev")
        ports: List[str] = []
        for pattern in _get_serial_port_globs():
            ports.extend(str(p) for p in dev.glob(pattern) if p.exists())
        ports = sorted(set(ports))

        return [
            PortInfo(
                port=port,
                description="Feetech Motor Controller",
                hwid=None,
            )
            for port in ports
        ]

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
