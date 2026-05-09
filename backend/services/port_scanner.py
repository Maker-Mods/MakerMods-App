"""Port scanning service — detects real Feetech motor controllers.

Uses pyserial to read each USB port's VID/PID and only reports ports whose
USB-to-serial bridge chip is on a known allowlist. Non-serial USB-CDC devices
(USB-C docks, Billboard descriptors, etc.) enumerate at /dev/cu.usbmodem* on
macOS but are NOT motor controllers — filtering them here prevents the wizard
from offering them to the user and crashing on connect.
"""

import platform
from typing import List

from serial.tools import list_ports

from backend.models.setup import PortInfo

# USB vendor IDs of chips commonly used on Feetech servo controllers and
# similar hobby-robotics serial bridges. Anything outside this set is rejected
# on macOS (where VID/PID is always reliable). On Linux we are more permissive
# because some embedded boards don't populate VID and would otherwise be hidden.
_USB_SERIAL_VIDS = {
    0x1A86,  # WCH (CH340 / CH343 / CH9102) — the chip on stock Feetech boards
    0x0403,  # FTDI (FT232) — older Feetech / DIY boards
    0x10C4,  # Silicon Labs (CP210x)
    0x067B,  # Prolific (PL2303)
    0x303A,  # Espressif native USB CDC (some custom controllers)
    0x2341,  # Arduino
    0x16C0,  # Teensy
}

# Explicit denylist for known-non-serial USB-CDC enumerations seen in the wild.
# USB-C docks / Billboard descriptors enumerate as /dev/cu.usbmodem* but cannot
# carry Feetech traffic. List by (vid, pid) where we have a confirmed sighting.
_DENYLIST_VID_PID = {
    (0x291A, 0x8355),  # "USB BillBoard" — USB-C alt-mode marker, not a serial port
}


def _is_likely_motor_controller(vid: int | None, pid: int | None, description: str | None) -> bool:
    """Return True if this USB device looks like a Feetech-compatible serial bridge."""
    if vid is None:
        # Unknown VID: only trust on Linux, where missing metadata is common.
        return platform.system() == "Linux"
    if (vid, pid) in _DENYLIST_VID_PID:
        return False
    if vid in _USB_SERIAL_VIDS:
        return True
    # Last-resort textual hint: descriptions like "USB BillBoard", "USB Hub",
    # "Display Audio" etc. are clearly not serial bridges.
    if description and any(bad in description.lower() for bad in ("billboard", "hub", "display", "audio")):
        return False
    return False


class PortScannerService:
    """Service for scanning and detecting serial ports."""

    def list_ports(self) -> List[PortInfo]:
        """List serial ports that look like Feetech motor controllers.

        Returns:
            List of PortInfo objects, one per port that passes the VID/PID filter.
            `hwid` carries the raw USB descriptor so the frontend can show it
            in technical-details panels.
        """
        results: List[PortInfo] = []
        for p in list_ports.comports():
            if not _is_likely_motor_controller(p.vid, p.pid, p.description):
                continue
            results.append(
                PortInfo(
                    port=p.device,
                    description="Feetech Motor Controller",
                    hwid=p.hwid,
                )
            )
        results.sort(key=lambda r: r.port)
        return results

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
