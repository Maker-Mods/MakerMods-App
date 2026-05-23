"""Quality Check (QC) configuration models."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

ProviderName = Literal["qwen", "openai", "anthropic", "custom"]
ProviderRole = Literal["vlm", "llm"]
QcTrigger = Literal["after_session", "manual"]


class ProviderConfig(BaseModel):
    """Per-role provider configuration. The raw API key is stored in the OS
    keychain; ``api_key_ref`` is an opaque pointer written to settings.json."""

    provider: ProviderName = "qwen"
    model: str = ""
    base_url: Optional[str] = None
    api_key_ref: Optional[str] = Field(
        default=None,
        description="Opaque keychain reference. NEVER the raw key.",
    )
    last_verified_at: Optional[str] = None


class PrivacyConfig(BaseModel):
    upload_frames: bool = True
    thumbnail_ttl_hours: int = Field(24, ge=1, le=168)
    redact_faces: bool = False


class BudgetConfig(BaseModel):
    max_usd_per_session: float = Field(0.5, ge=0)
    warn_above_usd: float = Field(0.2, ge=0)


class ProvidersConfig(BaseModel):
    vlm: ProviderConfig = Field(
        default_factory=lambda: ProviderConfig(
            provider="qwen",
            model="qwen3-vl-32b-instruct",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
    )
    llm: ProviderConfig = Field(
        default_factory=lambda: ProviderConfig(
            provider="openai",
            model="gpt-5.3",
            base_url="https://api.openai.com/v1",
        )
    )


class QcSettings(BaseModel):
    """Top-level QC settings persisted under ``qc_config.json``."""

    enabled: bool = False
    trigger: QcTrigger = "after_session"
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    budget: BudgetConfig = Field(default_factory=BudgetConfig)
    first_run_dismissed: bool = False
    not_now_until: Optional[str] = None


# ---- API request / response models -----------------------------------------


class QcSettingsPatch(BaseModel):
    """Partial settings update. Any field provided is merged into existing
    settings; nested models are replaced wholesale, not deep-merged."""

    enabled: Optional[bool] = None
    trigger: Optional[QcTrigger] = None
    privacy: Optional[PrivacyConfig] = None
    providers: Optional[ProvidersConfig] = None
    budget: Optional[BudgetConfig] = None
    first_run_dismissed: Optional[bool] = None
    not_now_until: Optional[str] = None


class SetKeyRequest(BaseModel):
    role: ProviderRole
    api_key: str = Field(..., min_length=16)


class ProviderTestRequest(BaseModel):
    role: ProviderRole


class ProviderTestResponse(BaseModel):
    ok: bool
    latency_ms: Optional[float] = None
    model_echo: Optional[str] = None
    est_cost_usd: Optional[float] = None
    error: Optional[str] = None


class CostEstimateResponse(BaseModel):
    per_episode_usd: float
    assumptions: dict


# ---- Static provider presets exposed to the frontend -----------------------


class ProviderPreset(BaseModel):
    provider: ProviderName
    label: str
    base_url: str
    vlm_models: list[str]
    llm_models: list[str]


PROVIDER_PRESETS: list[ProviderPreset] = [
    ProviderPreset(
        provider="qwen",
        label="Qwen",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        vlm_models=["qwen3-vl-32b-instruct", "qwen3-vl-7b-instruct"],
        llm_models=["qwen3-max", "qwen3-72b-instruct"],
    ),
    ProviderPreset(
        provider="openai",
        label="OpenAI",
        base_url="https://api.openai.com/v1",
        vlm_models=["gpt-5-vision"],
        llm_models=["gpt-5.3", "gpt-5.3-mini"],
    ),
    ProviderPreset(
        provider="anthropic",
        label="Anthropic",
        base_url="https://api.anthropic.com",
        vlm_models=["claude-opus-4-7"],
        llm_models=["claude-opus-4-7", "claude-sonnet-4-6"],
    ),
    ProviderPreset(
        provider="custom",
        label="Custom",
        base_url="",
        vlm_models=[],
        llm_models=[],
    ),
]
