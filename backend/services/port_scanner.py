"""Port scanning service for serial ports (机械臂/底盘)."""

from pathlib import Path
from typing import List

from backend.models.setup import PortInfo

# macOS: Feetech 等 USB 串口多为 /dev/cu.usbmodem*
# Linux: 多为 /dev/ttyACM*（CDC ACM）、/dev/ttyUSB*（USB 转串口），底盘 LeKiwi 常用 ttyACM*
DEV_GLOBS = ["cu.usbmodem*", "ttyACM*", "ttyUSB*"]


class PortScannerService:
    """Service for scanning and detecting serial ports."""

    def list_ports(self) -> List[PortInfo]:
        """列出可用串口（含 macOS cu.usbmodem* 与 Linux ttyACM* / ttyUSB*）。

        机械臂与 LeKiwi 底盘在 Linux 上通常为 /dev/ttyACM*。
        """
        seen: set[str] = set()
        ports: List[str] = []
        dev = Path("/dev")
        for pattern in DEV_GLOBS:
            for p in dev.glob(pattern):
                path = str(p.resolve())
                if path not in seen:
                    seen.add(path)
                    ports.append(path)
        return [
            PortInfo(
                port=port,
                description="Serial (arm/chassis)",
                hwid=None,
            )
            for port in sorted(ports)
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
