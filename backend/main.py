"""FastAPI main application for LeRobot Web UI."""

import os
import sys
from pathlib import Path

# 默认后端启动即设置 PYTHONPATH（等价于命令行 PYTHONPATH=src），子进程与导入均生效
_lerobot_pkg = Path(__file__).resolve().parent.parent.parent  # webui/backend -> webui -> lerobot
_src_root = _lerobot_pkg.parent  # src
if _src_root.exists():
    _path = str(_src_root)
    if _path not in sys.path:
        sys.path.insert(0, _path)
    os.environ.setdefault("PYTHONPATH", _path)

import logging
import traceback

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from backend.services.config_manager import ConfigManager
from backend.services.process_manager import process_manager

logger = logging.getLogger(__name__)

# Initialize FastAPI app（lifespan 替代已弃用的 on_event）
from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    print("LeRobot Web UI starting...")
    yield
    print("LeRobot Web UI shutting down...")
    await process_manager.cleanup()


app = FastAPI(
    title="LeRobot Web UI",
    description="Modern web interface for xLeRobot teleoperation and data recording",
    version="1.0.0",
    lifespan=_lifespan,
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
repo_root = Path(__file__).parent.parent.parent.parent.parent
outputs_dir = repo_root / "outputs"
try:
    outputs_dir.mkdir(parents=True, exist_ok=True)
except PermissionError:
    pass

if outputs_dir.exists():
    app.mount("/outputs", StaticFiles(directory=str(outputs_dir)), name="outputs")


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "message": "LeRobot Web UI is running"}


# Import and include routers
from backend.api import (
    calibration,
    config,
    huggingface,
    recording,
    setup,
    system,
    teleoperation,
)

app.include_router(setup.router, prefix="/api/setup", tags=["setup"])
app.include_router(calibration.router, prefix="/api/calibration", tags=["calibration"])
app.include_router(teleoperation.router, prefix="/api/teleoperation", tags=["teleoperation"])
app.include_router(recording.router, prefix="/api/recording", tags=["recording"])
app.include_router(config.router, prefix="/api/config", tags=["config"])
app.include_router(huggingface.router, prefix="/api/huggingface", tags=["huggingface"])
app.include_router(system.router, prefix="/api/system", tags=["system"])

# WebSocket endpoint
from backend.websockets.logs import router as websocket_router

app.include_router(websocket_router)


# 全局异常处理：未捕获异常统一返回 500 + JSON（detail.message），便于前端显示
# 注意：HTTPException 仍由 FastAPI 默认处理，此处只兜底非 HTTP 异常
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    from fastapi import HTTPException
    if isinstance(exc, HTTPException):
        raise exc
    logger.exception("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"detail": {"message": str(exc), "traceback": traceback.format_exc()}},
    )


def run_server(host: str = "0.0.0.0", port: int | None = None):
    """Run the FastAPI server.

    Args:
        host: Host to bind to.
        port: Port to bind to；未传时从环境变量 LEROBOT_WEBUI_PORT 读取，默认 8000。
    """
    if port is None:
        port = int(os.environ.get("LEROBOT_WEBUI_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
