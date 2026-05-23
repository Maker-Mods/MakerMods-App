"""Persistence for Quality Check settings.

Mirrors the pattern in ``config_manager.py`` (plain JSON in repo root). Kept
in a separate file ``qc_config.json`` so the existing ``webui_config.json``
schema stays untouched.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from backend.models.qc import QcSettings, QcSettingsPatch


class QcSettingsManager:
    """Load / save QC settings to a JSON file."""

    def __init__(self, config_path: Optional[Path] = None):
        if config_path is None:
            repo_root = Path(__file__).parent.parent.parent
            config_path = repo_root / "qc_config.json"
        self.config_path = config_path

    def load(self) -> QcSettings:
        if not self.config_path.exists():
            return QcSettings()
        try:
            with open(self.config_path) as f:
                return QcSettings(**json.load(f))
        except (json.JSONDecodeError, ValueError) as e:
            print(f"Warning: failed to load QC settings from {self.config_path}: {e}")
            return QcSettings()

    def save(self, settings: QcSettings) -> None:
        tmp = self.config_path.with_suffix(self.config_path.suffix + ".tmp")
        with open(tmp, "w") as f:
            json.dump(settings.model_dump(), f, indent=2)
        tmp.replace(self.config_path)

    def patch(self, patch: QcSettingsPatch) -> QcSettings:
        current = self.load().model_dump()
        updates = patch.model_dump(exclude_unset=True)
        current.update(updates)
        next_settings = QcSettings(**current)
        self.save(next_settings)
        return next_settings


qc_settings_manager = QcSettingsManager()
