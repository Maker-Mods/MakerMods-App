"""FastAPI main application for LeRobot Web UI."""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from backend.services.config_manager import ConfigManager
from backend.services.process_manager import process_manager

# Initialize FastAPI app
app = FastAPI(
    title="LeRobot Web UI",
    description="Modern web interface for xLeRobot teleoperation and data recording",
    version="1.0.0",
)

# CORS middleware for Next.js dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
config_manager = ConfigManager()

# Mount static directory for camera previews
repo_root = Path(__file__).parent.parent
outputs_dir = repo_root / "outputs"
if not outputs_dir.exists():
    outputs_dir.mkdir(parents=True, exist_ok=True)

app.mount("/outputs", StaticFiles(directory=str(outputs_dir)), name="outputs")


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "message": "LeRobot Web UI is running"}


# Startup and shutdown events
@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    print("LeRobot Web UI starting...")


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown."""
    print("LeRobot Web UI shutting down...")
    from backend.services.base_control import base_control_service
    from backend.services.port_lock_manager import port_lock_manager
    base_control_service.disconnect()
    await process_manager.cleanup()
    await port_lock_manager.release_all()


# Import and include routers
from backend.api import (
    base_control,
    calibration,
    config,
    debug,
    huggingface,
    inference,
    qc,
    recording,
    setup,
    system,
    teleoperation,
    training,
)

app.include_router(base_control.router, prefix="/api/base-control", tags=["base-control"])
app.include_router(setup.router, prefix="/api/setup", tags=["setup"])
app.include_router(calibration.router, prefix="/api/calibration", tags=["calibration"])
app.include_router(teleoperation.router, prefix="/api/teleoperation", tags=["teleoperation"])
app.include_router(recording.router, prefix="/api/recording", tags=["recording"])
app.include_router(inference.router, prefix="/api/inference", tags=["inference"])
app.include_router(config.router, prefix="/api/config", tags=["config"])
app.include_router(huggingface.router, prefix="/api/huggingface", tags=["huggingface"])
app.include_router(system.router, prefix="/api/system", tags=["system"])
app.include_router(debug.router, prefix="/api/debug", tags=["debug"])
app.include_router(training.router, prefix="/api/training", tags=["training"])
app.include_router(qc.router, prefix="/api/qc", tags=["qc"])

# WebSocket endpoints
from backend.websockets.logs import router as websocket_router
from backend.websockets.base_control import router as base_control_ws_router

app.include_router(websocket_router)
app.include_router(base_control_ws_router)


def run_server(host: str = "0.0.0.0", port: int = 8000):
    """Run the FastAPI server.

    Args:
        host: Host to bind to.
        port: Port to bind to.
    """
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
