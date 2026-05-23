"""Provider abstraction: cost estimation + test_connection pings.

Speaks OpenAI-compatible chat completions for ``qwen`` / ``openai`` / ``custom``
and Anthropic Messages API for ``anthropic``. Used both by the
``/api/qc/providers/test`` endpoint and (later) by the QC pipeline runner.
"""

from __future__ import annotations

import math
import time
from typing import Optional

import httpx

from backend.models.qc import ProviderConfig, ProviderRole

# Tiny 1x1 transparent PNG used for VLM connectivity ping.
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4"
    "2mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)

# USD per 1k tokens (in/out) and per image. Heuristic numbers — tune later.
_COST_TABLE: dict[str, dict[str, float]] = {
    "qwen3-vl-32b-instruct": {"in": 0.0008, "out": 0.0024, "image": 0.002},
    "qwen3-vl-7b-instruct":  {"in": 0.0004, "out": 0.0012, "image": 0.001},
    "qwen3-max":             {"in": 0.0020, "out": 0.0080, "image": 0.0},
    "qwen3-72b-instruct":    {"in": 0.0012, "out": 0.0048, "image": 0.0},
    "gpt-5-vision":          {"in": 0.0050, "out": 0.0150, "image": 0.005},
    "gpt-5.3":               {"in": 0.0030, "out": 0.0120, "image": 0.0},
    "gpt-5.3-mini":          {"in": 0.0010, "out": 0.0040, "image": 0.0},
    "claude-opus-4-7":       {"in": 0.0150, "out": 0.0750, "image": 0.008},
    "claude-sonnet-4-6":     {"in": 0.0030, "out": 0.0150, "image": 0.005},
}


class ProviderError(RuntimeError):
    """Raised when a provider HTTP call fails."""


def _row(model: str) -> dict[str, float]:
    return _COST_TABLE.get(model, {"in": 0.0, "out": 0.0, "image": 0.0})


def estimate_per_episode_usd(
    vlm: ProviderConfig,
    llm: ProviderConfig,
    *,
    episode_sec: float = 15.0,
    cameras: int = 2,
    stride_sec: float = 0.2,
    chunk_size: int = 5,
) -> tuple[float, dict]:
    """Static cost estimate, no network. Used by the Settings page footer."""

    frames_per_cam = math.ceil(episode_sec / stride_sec)
    chunks_per_cam = math.ceil(frames_per_cam / chunk_size)
    total_images = chunks_per_cam * cameras * chunk_size

    vlm_r = _row(vlm.model)
    llm_r = _row(llm.model)

    vlm_cost = (
        vlm_r["image"] * total_images
        + vlm_r["in"] * chunks_per_cam * cameras * 0.4    # ~400 tok in / chunk
        + vlm_r["out"] * chunks_per_cam * cameras * 0.15  # ~150 tok out / chunk
    )
    llm_cost = llm_r["in"] * 3.0 + llm_r["out"] * 0.5     # ~3k in, ~0.5k out

    total = round(vlm_cost + llm_cost, 4)
    return total, {
        "episode_sec": episode_sec,
        "cameras": cameras,
        "stride_sec": stride_sec,
        "chunk_size": chunk_size,
        "chunks_per_camera": chunks_per_cam,
        "vlm_cost": round(vlm_cost, 4),
        "llm_cost": round(llm_cost, 4),
    }


# ---- HTTP pings ------------------------------------------------------------


async def _ping_openai_compat(
    cfg: ProviderConfig, raw_key: str, role: ProviderRole
) -> tuple[float, str]:
    if role == "vlm":
        user = [
            {"type": "text", "text": "ok?"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{_TINY_PNG_B64}"},
            },
        ]
    else:
        user = "ok?"
    body = {
        "model": cfg.model,
        "max_tokens": 8,
        "messages": [
            {"role": "system", "content": "Reply with the single word: ok"},
            {"role": "user", "content": user},
        ],
    }
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{(cfg.base_url or '').rstrip('/')}/chat/completions",
            headers={"authorization": f"Bearer {raw_key}"},
            json=body,
        )
    latency = (time.monotonic() - t0) * 1000
    if resp.status_code >= 400:
        raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    return latency, data.get("model", cfg.model)


async def _ping_anthropic(cfg: ProviderConfig, raw_key: str) -> tuple[float, str]:
    body = {
        "model": cfg.model,
        "max_tokens": 8,
        "messages": [{"role": "user", "content": "ok?"}],
    }
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{(cfg.base_url or '').rstrip('/')}/v1/messages",
            headers={
                "x-api-key": raw_key,
                "anthropic-version": "2023-06-01",
            },
            json=body,
        )
    latency = (time.monotonic() - t0) * 1000
    if resp.status_code >= 400:
        raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    return latency, data.get("model", cfg.model)


async def ping_provider(
    cfg: ProviderConfig, raw_key: Optional[str], role: ProviderRole
) -> dict:
    """Connectivity ping for a provider. Returns a plain dict matching
    ``ProviderTestResponse``. Never raises; all errors are surfaced via
    ``ok=False`` + ``error``."""

    if not raw_key:
        return {"ok": False, "error": "No API key configured."}
    if not cfg.base_url:
        return {"ok": False, "error": "API base URL is empty."}

    try:
        if cfg.provider == "anthropic":
            latency, model_echo = await _ping_anthropic(cfg, raw_key)
        else:
            latency, model_echo = await _ping_openai_compat(cfg, raw_key, role)
    except ProviderError as e:
        return {"ok": False, "error": str(e)}
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"network: {e!s}"}
    except Exception as e:  # last-resort guard
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    return {
        "ok": True,
        "latency_ms": round(latency, 1),
        "model_echo": model_echo,
    }
