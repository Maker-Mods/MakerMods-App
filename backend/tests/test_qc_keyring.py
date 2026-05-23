"""Tests for the keychain-backed secret store with file fallback."""

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _force_fallback(monkeypatch, tmp_path: Path):
    """Pin the fallback dir into tmp_path and disable keyring backend so we
    exercise the encrypted-file path deterministically on CI."""
    from backend.services import qc_keyring

    monkeypatch.setattr(qc_keyring, "_FALLBACK_DIR", tmp_path / "qc-secrets")
    monkeypatch.setattr(
        qc_keyring, "_FALLBACK_KEY_FILE", tmp_path / "qc-secrets" / "secret.key"
    )
    monkeypatch.setattr(qc_keyring, "_has_keyring", lambda: False)
    yield


def test_set_get_delete_roundtrip():
    from backend.services.qc_keyring import delete_key, get_key, set_key

    ref = set_key("vlm", "sk-test-1234567890abcdef")
    assert ref.startswith("file://")
    assert get_key(ref) == "sk-test-1234567890abcdef"

    delete_key(ref)
    assert get_key(ref) is None


def test_get_returns_none_for_unknown_ref():
    from backend.services.qc_keyring import get_key

    assert get_key(None) is None
    assert get_key("garbage://nope/nope") is None


def test_keys_are_not_stored_in_plaintext(tmp_path):
    from backend.services import qc_keyring
    from backend.services.qc_keyring import set_key

    raw = "sk-this-should-not-appear-on-disk-1234"
    set_key("llm", raw)

    for path in qc_keyring._FALLBACK_DIR.rglob("*.bin"):
        assert raw.encode() not in path.read_bytes()
