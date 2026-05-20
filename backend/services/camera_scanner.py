"""Camera scanning service wrapping lerobot_find_cameras logic."""

import json
import platform
import shutil
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2

from backend.models.setup import CameraInfo, CameraPreview


def _cv2_backend() -> int:
    """OpenCV capture backend hint per platform.

    On Windows, MSMF (the OS default) mis-decodes some virtual webcam streams
    (e.g. phone-as-webcam apps deliver YUV variants that MSMF reads as garbage).
    DirectShow handles those correctly.
    """
    if platform.system() == "Windows":
        return cv2.CAP_DSHOW
    return cv2.CAP_ANY


class CameraScannerService:
    """Service for scanning and detecting cameras."""

    def __init__(self, output_dir: Optional[Path] = None):
        """Initialize CameraScannerService.

        Args:
            output_dir: Directory for storing preview images. Defaults to outputs/camera_previews.
        """
        if output_dir is None:
            # backend/services/camera_scanner.py -> services/ -> backend/ -> repo root
            repo_root = Path(__file__).parent.parent.parent
            output_dir = repo_root / "outputs" / "camera_previews"

        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _is_external_camera(camera: dict) -> bool:
        """Determine if a camera from system_profiler is an external USB camera.

        Built-in/non-external cameras include:
        - MacBook built-in cameras (FaceTime, MacBook Pro Camera, etc.)
        - iPhone Continuity cameras (model ID contains "iPhone")
        - iPad Continuity cameras (model ID contains "iPad")

        Args:
            camera: A camera dict from system_profiler SPCameraDataType JSON output.

        Returns:
            True if the camera is an external USB camera, False otherwise.
        """
        name = camera.get("_name", "").lower()
        model_id = camera.get("spcamera_model-id", "").lower()

        # Explicit built-in flag (some macOS versions)
        if camera.get("_is_builtin", "") == "yes":
            return False

        # MacBook built-in cameras
        if "macbook" in name or "facetime" in name or "built-in" in name:
            return False
        if "macbook" in model_id or "facetime" in model_id:
            return False

        # iPhone/iPad Continuity Camera
        if "iphone" in model_id or "ipad" in model_id:
            return False

        return True

    def _get_system_camera_info(self) -> List[dict]:
        """Get ordered camera list from macOS system_profiler.

        The order matches OpenCV camera indices.

        Returns:
            List of camera dicts from system_profiler, or empty list on non-macOS / errors.
        """
        if platform.system() != "Darwin":
            return []

        try:
            result = subprocess.run(
                ["system_profiler", "SPCameraDataType", "-json"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            data = json.loads(result.stdout)

            for camera_list in data.values():
                if isinstance(camera_list, list):
                    return camera_list

            return []
        except Exception:
            return []

    def list_cameras(self, max_cameras: int = 10, exclude_builtin: bool = False) -> List[CameraInfo]:
        """List all available OpenCV cameras.

        Uses system_profiler only to know the total camera count (to avoid noisy
        "out of bound" errors from OpenCV), but does NOT rely on its ordering
        for naming or filtering — system_profiler order does not always match
        OpenCV index order.

        Args:
            max_cameras: Maximum number of camera indices to check.
            exclude_builtin: Ignored (kept for API compat). Filtering is done
                by the user in the frontend via MJPEG previews.

        Returns:
            List of CameraInfo objects for detected cameras.
        """
        # Use system_profiler count to limit scan range (avoids "out of bound" errors)
        system_cameras = self._get_system_camera_info()
        scan_limit = len(system_cameras) if system_cameras else max_cameras

        cameras = []

        for index in range(scan_limit):
            cap = cv2.VideoCapture(index, _cv2_backend())

            if cap.isOpened():
                cap.release()
                cameras.append(
                    CameraInfo(
                        index=index,
                        name=f"Camera {index}",
                        backend="opencv",
                        is_builtin=False,
                    )
                )

        return cameras

    def verify_indices(
        self, indices: List[int], retries: int = 3, delay_s: float = 0.7
    ) -> Optional[Tuple[int, str]]:
        """Verify that each camera index can be opened.

        On Windows DSHOW, killing an MJPEG worker subprocess can leave the
        camera's COM handle stuck for ~1-2 seconds. We retry to ride that out
        before giving up.

        Args:
            indices: Camera indices to check.
            retries: Max attempts per index (Windows). Non-Windows fails fast.
            delay_s: Sleep between retries on Windows.

        Returns:
            None if all indices opened successfully. Otherwise (index, reason)
            for the first index that could not be opened.
        """
        is_windows = platform.system() == "Windows"
        attempts = retries if is_windows else 1

        for index in indices:
            opened = False
            for attempt in range(attempts):
                cap = cv2.VideoCapture(index, _cv2_backend())
                if cap.isOpened():
                    cap.release()
                    opened = True
                    break
                cap.release()
                if attempt < attempts - 1:
                    time.sleep(delay_s)

            if not opened:
                return (index, "Camera could not be opened")

        return None

    def capture_preview(
        self, camera_indices: Optional[List[int]] = None, record_time_s: float = 2.0
    ) -> Dict[int, CameraPreview]:
        """Capture preview images from cameras.

        Args:
            camera_indices: List of camera indices to capture. If None, captures all detected cameras.
            record_time_s: Time to wait before capturing image (for camera to warm up).

        Returns:
            Dictionary mapping camera index to CameraPreview.
        """
        import time

        # Clear old previews
        if self.output_dir.exists():
            shutil.rmtree(self.output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Detect cameras if not specified
        if camera_indices is None:
            detected = self.list_cameras()
            camera_indices = [cam.index for cam in detected]

        previews = {}

        for index in camera_indices:
            cap = cv2.VideoCapture(index, _cv2_backend())

            if not cap.isOpened():
                continue

            # Wait for camera to warm up
            time.sleep(record_time_s)

            # Capture frame
            ret, frame = cap.read()

            if ret:
                image_path = self.output_dir / f"camera_{index}.jpg"
                cv2.imwrite(str(image_path), frame)

                previews[index] = CameraPreview(
                    index=index,
                    image_path=str(image_path),
                    image_url=f"/api/setup/cameras/preview/{index}",  # Relative URL
                )

            cap.release()

        return previews
