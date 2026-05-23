"""Tests for QC settings persistence and merge semantics."""

from pathlib import Path

import pytest

from backend.models.qc import (
    PrivacyConfig,
    ProviderConfig,
    ProvidersConfig,
    QcSettingsPatch,
)
from backend.services.qc_settings import QcSettingsManager


@pytest.fixture
def mgr(tmp_path: Path) -> QcSettingsManager:
    return QcSettingsManager(config_path=tmp_path / "qc_config.json")


def test_load_returns_defaults_when_missing(mgr: QcSettingsManager):
    s = mgr.load()
    assert s.enabled is False
    assert s.providers.vlm.provider == "qwen"
    assert s.providers.llm.provider == "openai"
    assert s.privacy.upload_frames is True


def test_patch_toggles_enabled(mgr: QcSettingsManager):
    s = mgr.patch(QcSettingsPatch(enabled=True))
    assert s.enabled is True
    assert mgr.load().enabled is True


def test_patch_replaces_nested_models_wholesale(mgr: QcSettingsManager):
    s = mgr.patch(
        QcSettingsPatch(
            privacy=PrivacyConfig(
                upload_frames=False, thumbnail_ttl_hours=2, redact_faces=True
            )
        )
    )
    assert s.privacy.upload_frames is False
    assert s.privacy.thumbnail_ttl_hours == 2
    assert s.privacy.redact_faces is True


def test_patch_does_not_touch_unset_fields(mgr: QcSettingsManager):
    mgr.patch(QcSettingsPatch(enabled=True))
    s = mgr.patch(QcSettingsPatch(trigger="manual"))
    assert s.enabled is True
    assert s.trigger == "manual"


def test_patch_providers(mgr: QcSettingsManager):
    s = mgr.patch(
        QcSettingsPatch(
            providers=ProvidersConfig(
                vlm=ProviderConfig(
                    provider="qwen",
                    model="qwen3-vl-7b-instruct",
                    base_url="https://example.com/v1",
                ),
                llm=ProviderConfig(
                    provider="anthropic",
                    model="claude-opus-4-7",
                    base_url="https://api.anthropic.com",
                ),
            )
        )
    )
    assert s.providers.vlm.model == "qwen3-vl-7b-instruct"
    assert s.providers.llm.provider == "anthropic"
    assert s.providers.llm.api_key_ref is None
