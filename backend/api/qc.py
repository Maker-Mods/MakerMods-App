"""Quality Check (QC) configuration API.

Endpoints:
    GET    /api/qc/settings            -> QcSettings (api_key_ref only, never raw)
    PATCH  /api/qc/settings            -> QcSettings (after merge)
    POST   /api/qc/providers/key       -> QcSettings (key stored in OS keychain)
    DELETE /api/qc/providers/key/{role}-> QcSettings (key cleared)
    POST   /api/qc/providers/test      -> ProviderTestResponse
    GET    /api/qc/cost-estimate       -> CostEstimateResponse
    GET    /api/qc/presets             -> list[ProviderPreset]
    GET    /api/qc/diagnostics         -> {backend: str}
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from backend.models.qc import (
    CostEstimateResponse,
    PROVIDER_PRESETS,
    ProviderPreset,
    ProviderRole,
    ProviderTestRequest,
    ProviderTestResponse,
    QcSettings,
    QcSettingsPatch,
    SetKeyRequest,
)
from backend.services.qc_keyring import delete_key, get_key, set_key, storage_backend
from backend.services.qc_providers import estimate_per_episode_usd, ping_provider
from backend.services.qc_settings import qc_settings_manager

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@router.get("/settings", response_model=QcSettings)
async def get_settings() -> QcSettings:
    return qc_settings_manager.load()


@router.patch("/settings", response_model=QcSettings)
async def patch_settings(patch: QcSettingsPatch) -> QcSettings:
    return qc_settings_manager.patch(patch)


@router.post("/providers/key", response_model=QcSettings)
async def set_provider_key(req: SetKeyRequest) -> QcSettings:
    raw = req.api_key.strip()
    if len(raw) < 16:
        raise HTTPException(400, detail="API key looks too short.")
    ref = set_key(req.role, raw)

    settings = qc_settings_manager.load()
    role_cfg = getattr(settings.providers, req.role)
    # Delete any previous secret so we don't leak references.
    delete_key(role_cfg.api_key_ref)
    role_cfg.api_key_ref = ref
    role_cfg.last_verified_at = None
    setattr(settings.providers, req.role, role_cfg)
    qc_settings_manager.save(settings)
    return settings


@router.delete("/providers/key/{role}", response_model=QcSettings)
async def clear_provider_key(role: ProviderRole) -> QcSettings:
    settings = qc_settings_manager.load()
    role_cfg = getattr(settings.providers, role)
    delete_key(role_cfg.api_key_ref)
    role_cfg.api_key_ref = None
    role_cfg.last_verified_at = None
    setattr(settings.providers, role, role_cfg)
    qc_settings_manager.save(settings)
    return settings


@router.post("/providers/test", response_model=ProviderTestResponse)
async def test_provider_endpoint(req: ProviderTestRequest) -> ProviderTestResponse:
    settings = qc_settings_manager.load()
    role_cfg = getattr(settings.providers, req.role)
    raw_key = get_key(role_cfg.api_key_ref)

    result = await ping_provider(role_cfg, raw_key, req.role)
    if result.get("ok"):
        role_cfg.last_verified_at = _now_iso()
        setattr(settings.providers, req.role, role_cfg)
        qc_settings_manager.save(settings)

        # Attach a cost estimate so the UI can render "~$0.03 / episode".
        per_episode, _ = estimate_per_episode_usd(
            settings.providers.vlm, settings.providers.llm
        )
        result["est_cost_usd"] = per_episode

    return ProviderTestResponse(**result)


@router.get("/cost-estimate", response_model=CostEstimateResponse)
async def cost_estimate() -> CostEstimateResponse:
    settings = qc_settings_manager.load()
    per_episode, assumptions = estimate_per_episode_usd(
        settings.providers.vlm, settings.providers.llm
    )
    return CostEstimateResponse(per_episode_usd=per_episode, assumptions=assumptions)


@router.get("/presets", response_model=list[ProviderPreset])
async def presets() -> list[ProviderPreset]:
    return PROVIDER_PRESETS


@router.get("/diagnostics")
async def diagnostics() -> dict:
    return {"secret_backend": storage_backend()}
