"""Teleoperation-related models."""

from pydantic import BaseModel, Field


class TeleoperationRequest(BaseModel):
    """Teleoperation start request."""

    display_data: bool = Field(True, description="Whether to show Rerun visualization")


class TeleoperationResponse(BaseModel):
    """Teleoperation start response."""

    process_id: str = Field(..., description="Process identifier for tracking")
    message: str = Field(..., description="Status message")


# ---------- Chassis / Base control (LeKiwi) ----------

BASE_CMD_FILE = "/tmp/lerobot_base_cmd.json"


class BaseStartRequest(BaseModel):
    """Chassis control start request (XLerobot-based)."""

    port: str = Field("/dev/ttyACM0", description="Serial port for base motors (e.g. /dev/ttyACM0)")
    wheel_radius: float = Field(0.05, description="Wheel radius in meters")
    base_radius: float = Field(0.125, description="Distance from base center to wheel center in meters")
    wheel_angles: str = Field("0,240,120", description="Comma-separated wheel angles in degrees")


class BaseStartResponse(BaseModel):
    """Chassis control start response."""

    process_id: str = Field(..., description="Process identifier for base controller")
    message: str = Field(..., description="Status message")


class BaseVelocityRequest(BaseModel):
    """Chassis velocity command (matches run_lekiwi_keyboard_only key semantics)."""

    forward: bool = Field(False, description="Forward")
    backward: bool = Field(False, description="Backward")
    left: bool = Field(False, description="Left")
    right: bool = Field(False, description="Right")
    rotate_left: bool = Field(False, description="Rotate left")
    rotate_right: bool = Field(False, description="Rotate right")
    speed_index: int = Field(0, ge=0, le=2, description="Speed level 0/1/2 (low/medium/high)")
