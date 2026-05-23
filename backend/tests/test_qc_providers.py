"""Tests for provider cost estimation and test_provider error paths."""

import pytest

from backend.models.qc import ProviderConfig
from backend.services.qc_providers import (
    estimate_per_episode_usd,
    ping_provider,
)


def test_cost_estimate_known_models_positive():
    vlm = ProviderConfig(
        provider="qwen",
        model="qwen3-vl-32b-instruct",
        base_url="https://example/v1",
    )
    llm = ProviderConfig(
        provider="openai",
        model="gpt-5.3",
        base_url="https://api.openai.com/v1",
    )
    cost, assumptions = estimate_per_episode_usd(vlm, llm)
    assert cost > 0
    assert assumptions["cameras"] == 2
    assert assumptions["chunks_per_camera"] == 15  # 15s @ 0.2s stride, 5/chunk


def test_cost_estimate_unknown_model_returns_zero():
    vlm = ProviderConfig(provider="custom", model="???", base_url="https://x")
    llm = ProviderConfig(provider="custom", model="???", base_url="https://x")
    cost, _ = estimate_per_episode_usd(vlm, llm)
    assert cost == 0.0


@pytest.mark.asyncio
async def test_test_provider_without_key():
    cfg = ProviderConfig(
        provider="qwen",
        model="qwen3-vl-32b-instruct",
        base_url="https://example/v1",
    )
    result = await ping_provider(cfg, None, "vlm")
    assert result["ok"] is False
    assert "No API key" in result["error"]


@pytest.mark.asyncio
async def test_test_provider_empty_base_url():
    cfg = ProviderConfig(provider="qwen", model="x", base_url="")
    result = await ping_provider(cfg, "sk-fake-1234567890abcdef", "vlm")
    assert result["ok"] is False
    assert "base URL" in result["error"]
