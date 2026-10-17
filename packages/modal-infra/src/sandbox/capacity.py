"""Operator cap on live sandboxes for this Modal app. While it is set, creation needs a live lease.

The control plane claims an admission slot in its durable gate before any provider call, then sends
the lease token and its expiry with the create or restore request, as an env mapping. The endpoint
scopes that mapping to its request with admission_lease_env. require_creation_allowed refuses a new
app-owned sandbox unless the lease is present, well formed and unexpired. Adopting an existing
allocation creates nothing, so it stays allowed. Image-build sandboxes carry no lease, so they are
refused while the cap is set.

This is operational, not cryptographic. The token is an opaque string the control plane issues, and
it is not signed. Only its presence, shape and expiry are checked. A create does not consume its
lease, so a replay inside the window passes. A caller with the internal API secret can send any
lease. A direct Modal SDK create bypasses this module, so the cap binds only creations that go
through the control plane's gated endpoints.
"""

import os
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar

from sandbox_runtime.log_config import get_logger

log = get_logger("capacity")

MAX_ACTIVE_SANDBOXES_ENV_VAR = "MAX_ACTIVE_SANDBOXES"
ADMISSION_LEASE_TOKEN_KEY = "SANDBOX_ADMISSION_LEASE_TOKEN"
ADMISSION_LEASE_EXPIRES_AT_MS_KEY = "SANDBOX_ADMISSION_LEASE_EXPIRES_AT_MS"
CAPACITY_MISCONFIGURED_DETAIL = "sandbox_capacity_misconfigured"
CAPACITY_UNVERIFIED_DETAIL = "sandbox_capacity_unverified"

# Task-local, so concurrent requests never see each other's lease.
_request_admission_env: ContextVar[Mapping[str, str] | None] = ContextVar(
    "request_admission_env", default=None
)


class SandboxCapacityUnavailable(RuntimeError):
    """Capacity is misconfigured, or a creation has no live lease; the creation was refused."""

    def __init__(self, detail: str, message: str):
        super().__init__(message)
        self.detail = detail


@contextmanager
def admission_lease_env(env: Mapping[str, str] | None) -> Iterator[None]:
    """Scope the control plane's lease env to the creations made inside this block."""
    token = _request_admission_env.set(env)
    try:
        yield
    finally:
        _request_admission_env.reset(token)


def _positive_int(raw: str) -> int | None:
    # isascii guards against Unicode digits that isdigit accepts but int rejects.
    if not raw.isascii() or not raw.isdigit() or int(raw) < 1:
        return None
    return int(raw)


def read_max_active_sandboxes() -> int | None:
    """Return the configured cap, or None when unset. Invalid values fail closed."""
    raw = os.environ.get(MAX_ACTIVE_SANDBOXES_ENV_VAR, "").strip()
    if not raw:
        return None
    cap = _positive_int(raw)
    if cap is None:
        raise SandboxCapacityUnavailable(
            CAPACITY_MISCONFIGURED_DETAIL,
            f"{MAX_ACTIVE_SANDBOXES_ENV_VAR} must be a positive integer",
        )
    return cap


def _lease_refusal(env: Mapping[str, str] | None, now_ms: int) -> str | None:
    """Name why the lease does not admit a creation, or return None when it does."""
    lease = env or {}
    if not lease.get(ADMISSION_LEASE_TOKEN_KEY, "").strip():
        return "missing"
    raw_expiry = lease.get(ADMISSION_LEASE_EXPIRES_AT_MS_KEY, "").strip()
    if not raw_expiry:
        return "missing"
    expires_at_ms = _positive_int(raw_expiry)
    if expires_at_ms is None:
        return "malformed"
    if expires_at_ms <= now_ms:
        return "expired"
    return None


def require_creation_allowed() -> None:
    """Refuse a new app-owned sandbox while the cap is set and the request's lease is not live.

    Call before any Modal sandbox create. Does nothing while the cap is unset.
    """
    if read_max_active_sandboxes() is None:
        return
    refusal = _lease_refusal(_request_admission_env.get(), int(time.time() * 1000))
    if refusal is None:
        return
    log.warn("sandbox.capacity_creation_refused", reason=refusal)
    raise SandboxCapacityUnavailable(
        CAPACITY_UNVERIFIED_DETAIL,
        f"{MAX_ACTIVE_SANDBOXES_ENV_VAR} is set and the admission lease is {refusal}",
    )


def capacity_health() -> tuple[int, dict[str, object]]:
    """Preflight fields for GET /health: the cap and its enforcement only, no IDs or lists."""
    try:
        max_active = read_max_active_sandboxes()
    except SandboxCapacityUnavailable:
        return 503, {"max_active_sandboxes": None, "capacity_enforcement": "unavailable"}
    if max_active is None:
        return 200, {"max_active_sandboxes": None, "capacity_enforcement": "disabled"}
    return 200, {"max_active_sandboxes": max_active, "capacity_enforcement": "pre-create"}
