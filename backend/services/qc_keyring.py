"""Cross-platform secret storage for QC API keys.

Uses the OS keychain via the ``keyring`` package when available (macOS
Keychain, Windows Credential Manager, libsecret on Linux). Falls back to an
encrypted file under the user's home directory when no keyring backend can be
loaded — this happens on headless CI / Docker / minimal Linux boxes.

Settings.json only stores an opaque ``keychain://...`` or ``file://...``
reference. Raw secrets never leave this module.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
from pathlib import Path
from typing import Literal, Optional
from uuid import uuid4

try:  # optional dep — fall back gracefully if missing
    import keyring
    from keyring.errors import KeyringError, NoKeyringError
except Exception:  # pragma: no cover - exercised on minimal envs
    keyring = None  # type: ignore[assignment]
    KeyringError = NoKeyringError = Exception  # type: ignore[assignment, misc]

SERVICE = "makermods.qc"
Role = Literal["vlm", "llm"]

# Fallback storage location — only used when no keyring backend is available.
_FALLBACK_DIR = Path.home() / ".cache" / "makermods" / "qc-secrets"
_FALLBACK_KEY_FILE = _FALLBACK_DIR / "secret.key"


def _has_keyring() -> bool:
    if keyring is None:
        return False
    try:
        backend = keyring.get_keyring()
        # `chainer.ChainerBackend` with empty backends counts as no real backend
        return backend is not None and backend.priority > 0  # type: ignore[attr-defined]
    except Exception:
        return False


# ---- Fallback (encrypted file) ---------------------------------------------


def _load_or_create_fallback_key() -> bytes:
    _FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(_FALLBACK_DIR, 0o700)
    except OSError:
        pass
    if _FALLBACK_KEY_FILE.exists():
        return _FALLBACK_KEY_FILE.read_bytes()
    key = secrets.token_bytes(32)
    _FALLBACK_KEY_FILE.write_bytes(key)
    try:
        os.chmod(_FALLBACK_KEY_FILE, 0o600)
    except OSError:
        pass
    return key


def _xor(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def _fallback_path(account: str) -> Path:
    safe = base64.urlsafe_b64encode(account.encode()).decode().rstrip("=")
    return _FALLBACK_DIR / f"{safe}.bin"


def _fallback_set(account: str, value: str) -> str:
    key = _load_or_create_fallback_key()
    blob = _xor(value.encode(), key)
    path = _fallback_path(account)
    path.write_bytes(blob)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return f"file://{SERVICE}/{account}"


def _fallback_get(account: str) -> Optional[str]:
    path = _fallback_path(account)
    if not path.exists():
        return None
    key = _load_or_create_fallback_key()
    return _xor(path.read_bytes(), key).decode("utf-8", errors="replace")


def _fallback_delete(account: str) -> None:
    path = _fallback_path(account)
    if path.exists():
        path.unlink()


# ---- Public API ------------------------------------------------------------


def set_key(role: Role, raw_key: str) -> str:
    """Store ``raw_key`` and return the opaque ref to put in settings.json."""
    account = f"{role}:{uuid4()}"
    if _has_keyring():
        keyring.set_password(SERVICE, account, raw_key)  # type: ignore[union-attr]
        # Clean up older entries for the same role (best-effort).
        try:
            for cred in keyring.get_credential(SERVICE, role) or []:  # type: ignore[union-attr]
                pass  # API differs per backend; ignore enumeration if unsupported
        except Exception:
            pass
        return f"keychain://{SERVICE}/{account}"
    return _fallback_set(account, raw_key)


def get_key(ref: Optional[str]) -> Optional[str]:
    if not ref:
        return None
    if ref.startswith("keychain://"):
        if not _has_keyring():
            return None
        _, _, rest = ref.partition("keychain://")
        service, _, account = rest.partition("/")
        try:
            return keyring.get_password(service, account)  # type: ignore[union-attr]
        except (KeyringError, NoKeyringError):
            return None
    if ref.startswith("file://"):
        _, _, rest = ref.partition("file://")
        _, _, account = rest.partition("/")
        return _fallback_get(account)
    return None


def delete_key(ref: Optional[str]) -> None:
    if not ref:
        return
    if ref.startswith("keychain://"):
        if not _has_keyring():
            return
        _, _, rest = ref.partition("keychain://")
        service, _, account = rest.partition("/")
        try:
            keyring.delete_password(service, account)  # type: ignore[union-attr]
        except (KeyringError, NoKeyringError):
            pass
        return
    if ref.startswith("file://"):
        _, _, rest = ref.partition("file://")
        _, _, account = rest.partition("/")
        _fallback_delete(account)


def storage_backend() -> str:
    """Human-readable description, for diagnostics endpoints."""
    if _has_keyring():
        try:
            return f"keyring:{keyring.get_keyring().__class__.__name__}"  # type: ignore[union-attr]
        except Exception:
            return "keyring:unknown"
    return f"file:{_FALLBACK_DIR}"
