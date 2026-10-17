"""While MAX_ACTIVE_SANDBOXES is set, a new app-owned sandbox needs a live control-plane lease."""

import ast
import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import modal
import pytest
from fastapi import HTTPException

from sandbox_runtime.modal_image_build_start import MODAL_IMAGE_BUILD_START_PROTOCOL
from src import web_api
from src.sandbox import launch as launch_module
from src.sandbox.build_session import LAUNCH_PROTOCOL_TAG, ModalBuildSessionService
from src.sandbox.capacity import (
    ADMISSION_LEASE_EXPIRES_AT_MS_KEY,
    ADMISSION_LEASE_TOKEN_KEY,
    CAPACITY_MISCONFIGURED_DETAIL,
    CAPACITY_UNVERIFIED_DETAIL,
    MAX_ACTIVE_SANDBOXES_ENV_VAR,
    SandboxCapacityUnavailable,
    admission_lease_env,
    capacity_health,
    read_max_active_sandboxes,
    require_creation_allowed,
)
from src.sandbox.launch import BaseImageSource, SandboxLauncher, SandboxLaunchSpec
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls

APP_ID = "ap-capacity"


@pytest.fixture(autouse=True)
def modal_app(monkeypatch):
    monkeypatch.setattr(launch_module, "app", SimpleNamespace(app_id=APP_ID))
    monkeypatch.setattr(SandboxTunnels, "resolve", AsyncMock(return_value=TunnelUrls()))


@pytest.fixture
def creates(monkeypatch) -> list[SimpleNamespace]:
    """Record every Modal sandbox create; each call returns a new sandbox handle."""
    recorded: list[SimpleNamespace] = []

    async def create_aio(*_args, **kwargs) -> SimpleNamespace:
        box = SimpleNamespace(object_id=f"sb-{len(recorded)}", kwargs=kwargs)
        recorded.append(box)
        return box

    monkeypatch.setattr(modal.Sandbox, "create", SimpleNamespace(aio=create_aio))
    return recorded


@pytest.fixture
def set_cap(monkeypatch):
    def set_cap(value: str | None) -> None:
        if value is None:
            monkeypatch.delenv(MAX_ACTIVE_SANDBOXES_ENV_VAR, raising=False)
        else:
            monkeypatch.setenv(MAX_ACTIVE_SANDBOXES_ENV_VAR, value)

    return set_cap


def _lease_env(token: str = "lease-1", expires_at: str | None = None) -> dict[str, str]:
    """The lease env the control plane sends; by default its expiry is in the future."""
    if expires_at is None:
        expires_at = str(int(time.time() * 1000) + 60_000)
    return {ADMISSION_LEASE_TOKEN_KEY: token, ADMISSION_LEASE_EXPIRES_AT_MS_KEY: expires_at}


def _spec(
    sandbox_id: str = "sb-new",
    backend: str = "modal",
    retire_sandbox_id: str | None = None,
) -> SandboxLaunchSpec:
    return SandboxLaunchSpec(
        config=SandboxConfig(
            repo_owner=None,
            repo_name=None,
            clone_host="github.com",
            clone_username="x-access-token",
            sandbox_id=sandbox_id,
            sandbox_backend=backend,
            retire_sandbox_id=retire_sandbox_id,
        ),
        source=BaseImageSource(),
    )


async def _launch(sandbox_id: str = "sb-new"):
    return await SandboxLauncher().launch(_spec(sandbox_id))


async def _create_build(build_id: str = "build-1"):
    return await ModalBuildSessionService().create(
        build_id=build_id,
        scope_kind="repo",
        scope_id="repo-1",
        repositories=[{"repo_owner": "acme", "repo_name": "app", "branch": "main"}],
        callback_url="https://control-plane.example/callback",
        failure_callback_url="https://control-plane.example/failure",
        clone_host="github.com",
        clone_username="x-access-token",
    )


def _health() -> tuple[int, dict]:
    response = web_api.api_health.get_raw_f()()
    return response.status_code, json.loads(response.body)


@pytest.mark.parametrize("value", [None, "", "   "])
def test_unset_cap_is_disabled(set_cap, value):
    set_cap(value)
    assert read_max_active_sandboxes() is None
    require_creation_allowed()
    assert capacity_health() == (
        200,
        {"max_active_sandboxes": None, "capacity_enforcement": "disabled"},
    )


@pytest.mark.parametrize(("value", "expected"), [("1", 1), ("2", 2), (" 3 ", 3), ("02", 2)])
def test_cap_is_a_positive_integer(set_cap, value, expected):
    set_cap(value)
    assert read_max_active_sandboxes() == expected


@pytest.mark.parametrize("value", ["0", "-1", "2.5", "+2", "abc", "²"])
async def test_invalid_cap_fails_closed_before_any_create(set_cap, creates, value):
    set_cap(value)
    with pytest.raises(SandboxCapacityUnavailable) as refused:
        await _launch()
    assert refused.value.detail == CAPACITY_MISCONFIGURED_DETAIL
    assert creates == []


async def test_invalid_cap_refuses_vm_adoption_before_lookup(set_cap, creates, monkeypatch):
    set_cap("0")
    find_owned_vm = AsyncMock()
    monkeypatch.setattr(launch_module, "find_owned_vm", find_owned_vm)
    with pytest.raises(SandboxCapacityUnavailable) as refused:
        await SandboxLauncher().launch(_spec("sb-vm", backend="modal-vm"))
    assert refused.value.detail == CAPACITY_MISCONFIGURED_DETAIL
    find_owned_vm.assert_not_awaited()
    assert creates == []


async def test_unset_cap_creates_as_before(set_cap, creates):
    set_cap(None)
    handle = await _launch()
    assert len(creates) == 1
    assert handle.modal_object_id == creates[0].object_id


async def test_set_cap_admits_creation_under_a_live_lease(set_cap, creates):
    set_cap("2")
    with admission_lease_env(_lease_env()):
        handle = await _launch()
    assert len(creates) == 1
    assert handle.modal_object_id == creates[0].object_id
    # The lease gates the create. It is not passed on to the sandbox's environment.
    assert ADMISSION_LEASE_TOKEN_KEY not in creates[0].kwargs["env"]
    assert ADMISSION_LEASE_EXPIRES_AT_MS_KEY not in creates[0].kwargs["env"]


@pytest.mark.parametrize(
    ("lease", "reason"),
    [
        (None, "missing"),
        ({}, "missing"),
        (_lease_env(token=""), "missing"),
        (_lease_env(token="   "), "missing"),
        (_lease_env(expires_at=""), "missing"),
        (_lease_env(expires_at="soon"), "malformed"),
        (_lease_env(expires_at="0"), "malformed"),
        (_lease_env(expires_at="2.5"), "malformed"),
        (_lease_env(expires_at="1"), "expired"),
    ],
)
async def test_set_cap_refuses_creation_without_a_live_lease(set_cap, creates, lease, reason):
    set_cap("2")
    with admission_lease_env(lease), pytest.raises(SandboxCapacityUnavailable) as refused:
        await _launch()
    assert refused.value.detail == CAPACITY_UNVERIFIED_DETAIL
    assert reason in str(refused.value)
    assert creates == []


async def test_lease_does_not_outlive_its_request(set_cap, creates):
    set_cap("2")
    with admission_lease_env(_lease_env()):
        pass
    with pytest.raises(SandboxCapacityUnavailable):
        await _launch()
    assert creates == []


async def test_simultaneous_launches_under_cap_create_nothing(set_cap, creates):
    set_cap("2")
    results = await asyncio.gather(
        *(_launch(f"sb-{index}") for index in range(8)), return_exceptions=True
    )
    assert all(isinstance(result, SandboxCapacityUnavailable) for result in results)
    assert creates == []


async def test_independent_replicas_under_cap_each_refuse(set_cap, creates):
    """Separate launchers share no state, so each one refuses on its own."""
    set_cap("2")
    for replica in range(2):
        with pytest.raises(SandboxCapacityUnavailable):
            await SandboxLauncher().launch(_spec(f"sb-replica-{replica}"))
    assert creates == []


async def test_restore_under_cap_is_refused_before_create(set_cap, creates, monkeypatch):
    set_cap("1")
    monkeypatch.setattr(launch_module.modal.Image, "from_id", lambda *_a, **_k: object())
    with pytest.raises(SandboxCapacityUnavailable) as refused:
        await SandboxManager().restore_from_snapshot(
            "im-snapshot",
            {"session_id": "session-1"},
            clone_host="github.com",
            clone_username="x-access-token",
            sandbox_id="sb-restore",
        )
    assert refused.value.detail == CAPACITY_UNVERIFIED_DETAIL
    assert creates == []


async def test_restore_under_cap_with_a_live_lease_creates(set_cap, creates, monkeypatch):
    set_cap("1")
    monkeypatch.setattr(launch_module.modal.Image, "from_id", lambda *_a, **_k: object())
    with admission_lease_env(_lease_env()):
        handle = await SandboxManager().restore_from_snapshot(
            "im-snapshot",
            {"session_id": "session-1"},
            clone_host="github.com",
            clone_username="x-access-token",
            sandbox_id="sb-restore",
        )
    assert len(creates) == 1
    assert handle.modal_object_id == creates[0].object_id


async def test_new_vm_under_cap_is_refused_before_create(set_cap, creates, monkeypatch):
    set_cap("2")
    monkeypatch.setattr(launch_module, "docker_base_image", lambda: object())
    monkeypatch.setattr(launch_module, "find_owned_vm", AsyncMock(return_value=None))
    with pytest.raises(SandboxCapacityUnavailable) as refused:
        await SandboxLauncher().launch(_spec("sb-vm", backend="modal-vm"))
    assert refused.value.detail == CAPACITY_UNVERIFIED_DETAIL
    assert creates == []


async def test_adopting_an_existing_vm_under_cap_creates_nothing(set_cap, creates, monkeypatch):
    set_cap("2")
    existing = SimpleNamespace(object_id="sb-vm-existing")
    monkeypatch.setattr(launch_module, "docker_base_image", lambda: object())
    monkeypatch.setattr(launch_module, "find_owned_vm", AsyncMock(return_value=(existing, {})))
    read_passwords = AsyncMock(return_value={})
    monkeypatch.setattr(SandboxLauncher, "_read_access_passwords", read_passwords)
    handle = await SandboxLauncher().launch(_spec("sb-vm", backend="modal-vm"))
    assert handle.modal_object_id == "sb-vm-existing"
    read_passwords.assert_awaited_once()
    assert creates == []


async def test_replacing_a_vm_under_cap_keeps_the_old_one_running(set_cap, creates, monkeypatch):
    set_cap("2")
    monkeypatch.setattr(launch_module, "docker_base_image", lambda: object())
    retire = AsyncMock()
    monkeypatch.setattr(SandboxLauncher, "_retire_docker_allocation", retire)
    with pytest.raises(SandboxCapacityUnavailable):
        await SandboxLauncher().launch(
            _spec("sb-vm", backend="modal-vm", retire_sandbox_id="sb-old")
        )
    retire.assert_not_awaited()
    assert creates == []


async def test_build_creation_under_cap_is_refused_before_create(set_cap, creates, monkeypatch):
    set_cap("2")
    missing = AsyncMock(side_effect=modal.exception.NotFoundError("missing"))
    monkeypatch.setattr(modal.Sandbox, "from_name", SimpleNamespace(aio=missing))
    with pytest.raises(SandboxCapacityUnavailable) as refused:
        await _create_build()
    assert refused.value.detail == CAPACITY_UNVERIFIED_DETAIL
    assert creates == []


async def test_adopting_an_existing_build_under_cap_creates_nothing(set_cap, creates, monkeypatch):
    set_cap("2")
    tags = {
        "openinspect_kind": "image-build",
        "openinspect_build_id": "build-1",
        "openinspect_scope_kind": "repo",
        "openinspect_scope_id": "repo-1",
        LAUNCH_PROTOCOL_TAG: MODAL_IMAGE_BUILD_START_PROTOCOL,
        "openinspect_backend": "modal",
    }
    existing = SimpleNamespace(
        object_id="sb-build", get_tags=SimpleNamespace(aio=AsyncMock(return_value=tags))
    )
    monkeypatch.setattr(
        modal.Sandbox, "from_name", SimpleNamespace(aio=AsyncMock(return_value=existing))
    )
    launch = await _create_build()
    assert launch.provider_session_id == "sb-build"
    assert creates == []


def test_health_reports_capacity_disabled_when_unset(set_cap):
    set_cap(None)
    status, body = _health()
    assert status == 200
    assert body == {
        "success": True,
        "data": {
            "status": "healthy",
            "service": "open-inspect-modal",
            "max_active_sandboxes": None,
            "capacity_enforcement": "disabled",
        },
    }


def test_health_reports_pre_create_enforcement_for_a_valid_cap(set_cap):
    set_cap("2")
    status, body = _health()
    assert status == 200
    assert body == {
        "success": True,
        "data": {
            "status": "healthy",
            "service": "open-inspect-modal",
            "max_active_sandboxes": 2,
            "capacity_enforcement": "pre-create",
        },
    }


def test_health_is_unavailable_when_the_cap_is_invalid(set_cap):
    set_cap("0")
    status, body = _health()
    assert status == 503
    assert body["data"]["max_active_sandboxes"] is None
    assert body["data"]["capacity_enforcement"] == "unavailable"


def test_health_mounts_the_secret_that_carries_the_cap():
    """The cap lives in internal-api, so api_health must mount that secret to see it."""
    tree = ast.parse((Path(__file__).parents[1] / "src" / "web_api.py").read_text())
    health = next(
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "api_health"
    )
    [app_function] = [
        decorator
        for decorator in health.decorator_list
        if isinstance(decorator, ast.Call) and ast.unparse(decorator.func) == "app.function"
    ]
    secrets = next((kw.value for kw in app_function.keywords if kw.arg == "secrets"), None)
    assert isinstance(secrets, ast.List)
    assert [ast.unparse(item) for item in secrets.elts] == ["internal_api_secret"]


@pytest.mark.parametrize("detail", [CAPACITY_MISCONFIGURED_DETAIL, CAPACITY_UNVERIFIED_DETAIL])
async def test_endpoint_reports_capacity_refusal_as_503_with_detail(monkeypatch, detail):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    with pytest.raises(HTTPException) as mapped:
        async with web_api._execute_endpoint(
            endpoint_name="api_create_sandbox",
            authorization=None,
            trace_id=None,
            request_id=None,
        ):
            raise SandboxCapacityUnavailable(detail, "refused")
    assert mapped.value.status_code == 503
    assert mapped.value.detail == detail


async def test_create_endpoint_hands_the_request_lease_to_the_gate(monkeypatch, set_cap, creates):
    set_cap("2")
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "require_valid_control_plane_url", lambda _url: None)
    request = {
        "clone_host": "github.com",
        "clone_username": "x-access-token",
        "session_id": "session-1",
        "sandbox_id": "sb-endpoint",
        "control_plane_url": "https://control-plane.example",
        "sandbox_auth_token": "sandbox-token",
    }
    headers = {
        "authorization": "Bearer test",
        "x_trace_id": None,
        "x_request_id": None,
        "x_session_id": None,
        "x_sandbox_id": None,
    }
    create = web_api.api_create_sandbox.get_raw_f()
    with pytest.raises(HTTPException) as refused:
        await create(request, **headers)
    assert refused.value.status_code == 503
    assert creates == []

    response = await create({**request, "admission_env": _lease_env()}, **headers)
    assert response["success"] is True
    assert len(creates) == 1
