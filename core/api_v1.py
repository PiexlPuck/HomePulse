"""Versioned /api/v1 REST and WebSocket endpoints for headless & repeater core."""

import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core import CORE_API_VERSION
from core.daemon_ingest import DaemonAuthError, DaemonPayloadError, DaemonReplayError
from core.ipc import IPCPermissionError
from core.remediation import (
    RemediationAuthError,
    RemediationExpiredError,
    RemediationRBACError,
    RemediationStateError,
)
from core.manifest_validator import (
    scan_python_source_ast,
    validate_manifest_dict,
    validate_plugin_directory,
    validate_registry_index,
    validate_requirements_text,
)
from core.topology import TopologyCycleError, TopologyNotFoundError

logger = logging.getLogger("homepulse-api-v1")

UI_PRESENTATION_KEYS = ("icon", "color", "graphic", "tags")
ALLOWED_PROBE_TYPES = ("http", "https", "websocket", "ping", "port", "dns", "ssl")


def strip_ui_fields(ent: Dict[str, Any]) -> Dict[str, Any]:
    """Return a pure machine-telemetry copy without UI presentation metadata."""
    return {k: v for k, v in ent.items() if k not in UI_PRESENTATION_KEYS}


class ProbeCreatePayload(BaseModel):
    name: str
    type: str
    target: str
    check_interval: int = Field(default=30, ge=1)
    timeout: int = Field(default=5, ge=1)
    enabled: bool = True
    category: Optional[str] = "General"


class RepeaterTargetPayload(BaseModel):
    id: str
    name: Optional[str] = None
    url: str
    secret: Optional[str] = ""
    headers: Optional[Dict[str, Any]] = None
    enabled: bool = True


class TopologyNodePayload(BaseModel):
    node_uid: str
    node_kind: str = "service"
    display_name: Optional[str] = None
    external_ref: Optional[Dict[str, Any]] = None
    liveness_entity_key: Optional[str] = None
    health_state: str = "unknown"
    metadata: Optional[Dict[str, Any]] = None


class TopologyEdgePayload(BaseModel):
    parent_uid: str
    child_uid: str
    relation: str = "depends_on"
    source: str = "manual"


class MigrationStartPayload(BaseModel):
    child_uid: str
    to_parent_uid: Optional[str] = None
    lease_seconds: int = Field(default=120, ge=1, le=3600)
    source: str = "manual"


class MigrationRebindPayload(BaseModel):
    child_uid: str
    to_parent_uid: str
    relation: str = "hosts"
    reason: str = "live_migration"
    source: str = "manual"


class AlertEvalPayload(BaseModel):
    target_key: str
    is_firing: bool = True


class RepositoryRegisterPayload(BaseModel):
    id: str
    name: Optional[str] = None
    registry_url: str
    trusted: bool = False
    enabled: bool = True


class ManifestValidatePayload(BaseModel):
    manifest: Optional[Dict[str, Any]] = None
    requirements_text: Optional[str] = None
    source_files: Optional[Dict[str, str]] = None
    plugin_dir: Optional[str] = None


class RegistryIndexValidatePayload(BaseModel):
    index: Dict[str, Any]


class IPCPublishPayload(BaseModel):
    topic: str
    payload: Dict[str, Any] = Field(default_factory=dict)


class IPCTelemetryPayload(BaseModel):
    entity_key: str
    name: Optional[str] = None
    type: str = "sensor"
    value: Any
    value_type: str = "string"
    attributes: Optional[Dict[str, Any]] = None


class DaemonEnrollPayload(BaseModel):
    agent_id: str
    hostname: str
    ed25519_public_key_b64: str
    kid: Optional[str] = None
    aes_key_b64: Optional[str] = None


class PushoverChannelRegisterPayload(BaseModel):
    name: str = "Pushover Emergency"
    user_key: str
    api_token: str
    retry: int = Field(default=60, ge=30)
    expire: int = Field(default=3600, ge=60, le=10800)
    sound: str = "siren"


class RemediationProposePayload(BaseModel):
    action_type: str
    target_plugin_id: str
    target_node_uid: str
    parameters: Optional[Dict[str, Any]] = None
    dry_run: bool = False
    ttl_seconds: Optional[int] = Field(default=None, ge=1, le=86400)
    force_approval: bool = False


class RemediationApprovePayload(BaseModel):
    approval_token: str


class RemediationRejectPayload(BaseModel):
    reason: Optional[str] = "rejected_by_operator"


class EntityControlV1Payload(BaseModel):
    value: Any
    action_type: str = "local_control"
    target_plugin_id: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None
    dry_run: bool = False
    force_approval: bool = False


def _extract_token(x_api_key: Optional[str], authorization: Optional[str], query_key: Optional[str] = None) -> Optional[str]:
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    if query_key:
        return query_key.strip()
    return None


def create_v1_router(
    get_runtime_config: Callable[[], Any],
    get_storage_repo: Callable[[], Any],
    get_repeater_engine: Callable[[], Any],
    get_entity_states: Callable[[], Dict[str, Dict[str, Any]]],
    verify_api_key_fn: Callable[[Optional[str]], Awaitable[bool]],
    ws_manager: Any,
    register_monitor_state_fn: Callable[[int, str], None],
    remove_monitor_state_fn: Callable[[int], None],
    get_topology_graph: Optional[Callable[[], Any]] = None,
    get_cascade_suppressor: Optional[Callable[[], Any]] = None,
    get_plugin_token_registry: Optional[Callable[[], Any]] = None,
    get_plugin_ipc_broker: Optional[Callable[[], Any]] = None,
    get_plugin_registry_store: Optional[Callable[[], Any]] = None,
    plugin_telemetry_ingest_fn: Optional[Callable[[str, Dict[str, Any]], Awaitable[Dict[str, Any]]]] = None,
    get_daemon_ingest_engine: Optional[Callable[[], Any]] = None,
    get_pushover_escalator: Optional[Callable[[], Any]] = None,
    get_remediation_engine: Optional[Callable[[], Any]] = None,
) -> APIRouter:
    """Construct the versioned /api/v1 router with strict auth and storage abstraction."""
    router = APIRouter(prefix="/api/v1", tags=["Core v1"])

    async def require_v1_auth(
        request: Request,
        x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
        authorization: Optional[str] = Header(default=None, alias="Authorization"),
    ) -> None:
        token = _extract_token(x_api_key, authorization, request.query_params.get("api_key"))
        if not await verify_api_key_fn(token):
            raise HTTPException(status_code=401, detail="Valid API key required.")

    @router.get("/health")
    async def v1_health():
        cfg = get_runtime_config()
        repo = get_storage_repo()
        repeater = get_repeater_engine()

        if repo is None or not repo.is_persistent():
            storage_state = "disabled"
        elif repo.is_connected():
            storage_state = "connected"
        else:
            storage_state = "disconnected"

        if cfg.mode == "storage" and storage_state == "disconnected":
            raise HTTPException(
                status_code=503,
                detail={
                    "status": "unhealthy",
                    "mode": cfg.mode,
                    "headless": cfg.headless,
                    "storage": storage_state,
                    "core_api_version": CORE_API_VERSION,
                },
            )

        return {
            "status": "healthy",
            "mode": cfg.mode,
            "headless": cfg.headless,
            "storage": storage_state,
            "core_api_version": CORE_API_VERSION,
            "repeater": repeater.get_status() if repeater else None,
        }

    @router.get("/telemetry/snapshot", dependencies=[Depends(require_v1_auth)])
    async def v1_telemetry_snapshot(node_id: Optional[str] = None, type: Optional[str] = None):
        states = get_entity_states()
        out: Dict[str, Dict[str, Any]] = {}
        for k, ent in list(states.items()):
            if node_id and ent.get("node_id") != node_id:
                continue
            if type and ent.get("type") != type:
                continue
            out[k] = strip_ui_fields(ent)
        return out

    @router.get("/probes", dependencies=[Depends(require_v1_auth)])
    async def v1_list_probes():
        repo = get_storage_repo()
        if repo is None:
            return []
        return await repo.list_monitors()

    @router.post("/probes", dependencies=[Depends(require_v1_auth)])
    async def v1_create_probe(payload: ProbeCreatePayload):
        if payload.type not in ALLOWED_PROBE_TYPES:
            raise HTTPException(status_code=400, detail=f"Invalid probe type '{payload.type}'.")
        if not payload.name.strip() or not payload.target.strip():
            raise HTTPException(status_code=400, detail="Both name and target are required.")
        repo = get_storage_repo()
        if repo is None or (repo.is_persistent() and not repo.is_connected()):
            raise HTTPException(status_code=503, detail="Storage repository unavailable.")

        created = await repo.create_monitor(payload.model_dump())
        register_monitor_state_fn(created["id"], created["name"])
        return {"status": "created", "probe": created}

    @router.put("/probes/{probe_id}", dependencies=[Depends(require_v1_auth)])
    async def v1_update_probe(probe_id: int, payload: ProbeCreatePayload):
        if payload.type not in ALLOWED_PROBE_TYPES:
            raise HTTPException(status_code=400, detail=f"Invalid probe type '{payload.type}'.")
        if not payload.name.strip() or not payload.target.strip():
            raise HTTPException(status_code=400, detail="Both name and target are required.")
        repo = get_storage_repo()
        if repo is None or (repo.is_persistent() and not repo.is_connected()):
            raise HTTPException(status_code=503, detail="Storage repository unavailable.")

        updated = await repo.update_monitor(probe_id, payload.model_dump())
        if not updated:
            raise HTTPException(status_code=404, detail="Probe not found.")
        register_monitor_state_fn(updated["id"], updated["name"])
        return {"status": "updated", "probe": updated}

    @router.delete("/probes/{probe_id}", dependencies=[Depends(require_v1_auth)])
    async def v1_delete_probe(probe_id: int):
        repo = get_storage_repo()
        if repo is None or (repo.is_persistent() and not repo.is_connected()):
            raise HTTPException(status_code=503, detail="Storage repository unavailable.")
        deleted = await repo.delete_monitor(probe_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Probe not found.")
        remove_monitor_state_fn(probe_id)
        return {"status": "deleted", "probe_id": probe_id}

    @router.get("/repeater/status", dependencies=[Depends(require_v1_auth)])
    async def v1_repeater_status():
        repeater = get_repeater_engine()
        if repeater is None:
            raise HTTPException(status_code=503, detail="Repeater engine unavailable.")
        return repeater.get_status()

    @router.get("/repeater/targets", dependencies=[Depends(require_v1_auth)])
    async def v1_list_repeater_targets():
        repo = get_storage_repo()
        if repo is None:
            return []
        targets = await repo.list_repeater_targets()
        # Mask secrets on read
        sanitized: List[Dict[str, Any]] = []
        for t in targets:
            copy_t = dict(t)
            copy_t["has_secret"] = bool(copy_t.pop("secret", ""))
            sanitized.append(copy_t)
        return sanitized

    @router.post("/repeater/targets", dependencies=[Depends(require_v1_auth)])
    async def v1_upsert_repeater_target(payload: RepeaterTargetPayload):
        if not payload.id.strip() or not payload.url.strip():
            raise HTTPException(status_code=400, detail="Target id and url are required.")
        repo = get_storage_repo()
        if repo is None or (repo.is_persistent() and not repo.is_connected()):
            raise HTTPException(status_code=503, detail="Storage repository unavailable.")
        saved = await repo.upsert_repeater_target(payload.model_dump())
        resp = dict(saved)
        resp["has_secret"] = bool(resp.pop("secret", ""))
        return {"status": "saved", "target": resp}

    @router.delete("/repeater/targets/{target_id}", dependencies=[Depends(require_v1_auth)])
    async def v1_delete_repeater_target(target_id: str):
        repo = get_storage_repo()
        if repo is None or (repo.is_persistent() and not repo.is_connected()):
            raise HTTPException(status_code=503, detail="Storage repository unavailable.")
        deleted = await repo.delete_repeater_target(target_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Repeater target not found.")
        return {"status": "deleted", "target_id": target_id}

    @router.post("/repeater/flush", dependencies=[Depends(require_v1_auth)])
    async def v1_repeater_flush():
        repeater = get_repeater_engine()
        if repeater is None:
            raise HTTPException(status_code=503, detail="Repeater engine unavailable.")
        return await repeater.flush_once()

    @router.get("/topology/graph", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_graph():
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        return graph.snapshot()

    @router.post("/topology/nodes", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_upsert_node(payload: TopologyNodePayload):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        try:
            node = await graph.upsert_node(
                node_uid=payload.node_uid,
                node_kind=payload.node_kind,
                display_name=payload.display_name or payload.node_uid,
                external_ref=payload.external_ref,
                liveness_entity_key=payload.liveness_entity_key,
                health_state=payload.health_state,
                metadata=payload.metadata,
            )
            return {"status": "saved", "node": node}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.delete("/topology/nodes/{node_uid}", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_delete_node(node_uid: str):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        deleted = await graph.delete_node(node_uid)
        if not deleted:
            raise HTTPException(status_code=404, detail="Topology node not found.")
        return {"status": "deleted", "node_uid": node_uid}

    @router.post("/topology/edges", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_add_edge(payload: TopologyEdgePayload):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        try:
            edge = await graph.add_edge(
                parent_uid=payload.parent_uid,
                child_uid=payload.child_uid,
                relation=payload.relation,
                source=payload.source,
            )
            return {"status": "saved", "edge": edge}
        except TopologyNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except TopologyCycleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.delete("/topology/edges", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_delete_edge(parent_uid: str, child_uid: str, relation: str = "depends_on"):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        deleted = await graph.delete_edge(parent_uid, child_uid, relation)
        if not deleted:
            raise HTTPException(status_code=404, detail="Topology edge not found.")
        return {"status": "deleted", "parent_uid": parent_uid, "child_uid": child_uid, "relation": relation}

    @router.post("/topology/migrations/start", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_start_migration(payload: MigrationStartPayload):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        try:
            node = await graph.start_migration(
                child_uid=payload.child_uid,
                to_parent_uid=payload.to_parent_uid,
                lease_seconds=payload.lease_seconds,
                source=payload.source,
            )
            return {"status": "migrating", "node": node}
        except TopologyNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except TopologyCycleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.post("/topology/migrations/rebind", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_rebind_parent(payload: MigrationRebindPayload):
        graph = get_topology_graph() if get_topology_graph else None
        if graph is None:
            raise HTTPException(status_code=503, detail="Topology graph unavailable.")
        try:
            ev = await graph.rebind_parent(
                child_uid=payload.child_uid,
                to_parent_uid=payload.to_parent_uid,
                relation=payload.relation,
                reason=payload.reason,
                source=payload.source,
            )
            return {"status": "rebound", "migration": ev}
        except TopologyNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except TopologyCycleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.post("/topology/evaluate-alert", dependencies=[Depends(require_v1_auth)])
    async def v1_topology_evaluate_alert(payload: AlertEvalPayload):
        suppressor = get_cascade_suppressor() if get_cascade_suppressor else None
        if suppressor is None:
            raise HTTPException(status_code=503, detail="Cascade suppressor unavailable.")
        return suppressor.evaluate_dispatch(
            target_key=payload.target_key,
            is_firing=payload.is_firing,
            entity_states=get_entity_states(),
        )

    @router.get("/plugins/repositories", dependencies=[Depends(require_v1_auth)])
    async def v1_list_plugin_repositories():
        store = get_plugin_registry_store() if get_plugin_registry_store else None
        if store is None:
            return []
        return await store.list_repositories()

    @router.post("/plugins/repositories", dependencies=[Depends(require_v1_auth)])
    async def v1_register_plugin_repository(payload: RepositoryRegisterPayload):
        store = get_plugin_registry_store() if get_plugin_registry_store else None
        if store is None:
            raise HTTPException(status_code=503, detail="Plugin registry store unavailable.")
        try:
            repo = await store.register_repository(
                repo_id=payload.id,
                name=payload.name or payload.id,
                registry_url=payload.registry_url,
                trusted=payload.trusted,
                enabled=payload.enabled,
            )
            return {"status": "saved", "repository": repo}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.delete("/plugins/repositories/{repo_id}", dependencies=[Depends(require_v1_auth)])
    async def v1_delete_plugin_repository(repo_id: str):
        store = get_plugin_registry_store() if get_plugin_registry_store else None
        if store is None:
            raise HTTPException(status_code=503, detail="Plugin registry store unavailable.")
        deleted = await store.delete_repository(repo_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Repository not found.")
        return {"status": "deleted", "id": repo_id}

    @router.post("/plugins/validate", dependencies=[Depends(require_v1_auth)])
    async def v1_validate_plugin(payload: ManifestValidatePayload):
        if payload.plugin_dir:
            res = validate_plugin_directory(payload.plugin_dir, manifest=payload.manifest)
        elif payload.manifest is not None:
            res = validate_manifest_dict(payload.manifest)
            errors = list(res["errors"])
            if payload.requirements_text is not None:
                errors.extend(validate_requirements_text(payload.requirements_text))
            if payload.source_files:
                for fname, src in payload.source_files.items():
                    errors.extend(scan_python_source_ast(src, filename=fname))
            res["errors"] = errors
            res["valid"] = len(errors) == 0
            if not res["valid"]:
                res["normalized_manifest"] = None
        else:
            raise HTTPException(status_code=400, detail="Either manifest or plugin_dir must be provided.")

        if not res["valid"]:
            raise HTTPException(status_code=422, detail=res)
        return res

    @router.post("/plugins/validate-registry", dependencies=[Depends(require_v1_auth)])
    async def v1_validate_registry(payload: RegistryIndexValidatePayload):
        res = validate_registry_index(payload.index)
        if not res["valid"]:
            raise HTTPException(status_code=422, detail=res)
        return res

    async def require_plugin_session(
        x_plugin_token: Optional[str] = Header(default=None, alias="X-Plugin-Token"),
        authorization: Optional[str] = Header(default=None, alias="Authorization"),
    ):
        registry = get_plugin_token_registry() if get_plugin_token_registry else None
        if registry is None:
            raise HTTPException(status_code=503, detail="Plugin token registry unavailable.")
        tok = _extract_token(x_plugin_token, authorization, None)
        session = registry.authenticate(tok)
        if session is None:
            raise HTTPException(status_code=401, detail="Valid plugin token required.")
        return session

    @router.post("/ipc/publish")
    async def v1_ipc_publish(payload: IPCPublishPayload, session=Depends(require_plugin_session)):
        broker = get_plugin_ipc_broker() if get_plugin_ipc_broker else None
        if broker is None:
            raise HTTPException(status_code=503, detail="IPC broker unavailable.")
        try:
            msg = broker.publish(session, payload.topic, payload.payload)
            return {"status": "published", "message": msg}
        except IPCPermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.get("/ipc/messages")
    async def v1_ipc_poll_messages(topic: str, since_seq: int = 0, session=Depends(require_plugin_session)):
        broker = get_plugin_ipc_broker() if get_plugin_ipc_broker else None
        if broker is None:
            raise HTTPException(status_code=503, detail="IPC broker unavailable.")
        try:
            msgs = broker.poll_messages(session, topic, since_seq=since_seq)
            return {"topic": topic, "messages": msgs}
        except IPCPermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.post("/ipc/telemetry")
    async def v1_ipc_telemetry(payload: IPCTelemetryPayload, session=Depends(require_plugin_session)):
        if "telemetry:publish" not in session.permissions:
            raise HTTPException(status_code=403, detail=f"Plugin '{session.plugin_id}' lacks 'telemetry:publish' permission.")
        if plugin_telemetry_ingest_fn is None:
            raise HTTPException(status_code=503, detail="Plugin telemetry ingest unavailable.")
        return await plugin_telemetry_ingest_fn(session.plugin_id, payload.model_dump())

    @router.post("/daemon/enroll", dependencies=[Depends(require_v1_auth)])
    async def v1_daemon_enroll(payload: DaemonEnrollPayload):
        engine = get_daemon_ingest_engine() if get_daemon_ingest_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Daemon ingest engine unavailable.")
        try:
            return await engine.enroll_agent(
                agent_id=payload.agent_id,
                hostname=payload.hostname,
                ed25519_public_key_b64=payload.ed25519_public_key_b64,
                kid=payload.kid,
                aes_key_b64=payload.aes_key_b64,
            )
        except DaemonPayloadError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @router.get("/daemon/agents", dependencies=[Depends(require_v1_auth)])
    async def v1_daemon_list_agents():
        engine = get_daemon_ingest_engine() if get_daemon_ingest_engine else None
        if engine is None:
            return []
        return await engine.list_agents()

    @router.delete("/daemon/agents/{agent_id}", dependencies=[Depends(require_v1_auth)])
    async def v1_daemon_revoke_agent(agent_id: str):
        engine = get_daemon_ingest_engine() if get_daemon_ingest_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Daemon ingest engine unavailable.")
        if not await engine.revoke_agent(agent_id):
            raise HTTPException(status_code=404, detail="Enrolled agent not found.")
        return {"status": "revoked", "agent_id": agent_id}

    @router.get("/daemon/posture", dependencies=[Depends(require_v1_auth)])
    async def v1_daemon_posture():
        engine = get_daemon_ingest_engine() if get_daemon_ingest_engine else None
        if engine is None:
            return {}
        return engine.list_posture()

    @router.post("/daemon/ingest")
    async def v1_daemon_ingest(request: Request, envelope: Dict[str, Any]):
        engine = get_daemon_ingest_engine() if get_daemon_ingest_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Daemon ingest engine unavailable.")
        try:
            return await engine.ingest_envelope(envelope=envelope, headers=dict(request.headers))
        except DaemonAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
        except DaemonReplayError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except DaemonPayloadError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @router.post("/alerts/pushover/channels", dependencies=[Depends(require_v1_auth)])
    async def v1_pushover_register_channel(payload: PushoverChannelRegisterPayload):
        escalator = get_pushover_escalator() if get_pushover_escalator else None
        if escalator is None:
            raise HTTPException(status_code=503, detail="Pushover escalator unavailable.")
        ch = escalator.register_ephemeral_channel(
            name=payload.name,
            user_key=payload.user_key,
            api_token=payload.api_token,
            retry=payload.retry,
            expire=payload.expire,
            sound=payload.sound,
        )
        return {"status": "saved", "channel": ch}

    @router.get("/alerts/pushover/receipts", dependencies=[Depends(require_v1_auth)])
    async def v1_pushover_list_receipts():
        escalator = get_pushover_escalator() if get_pushover_escalator else None
        if escalator is None:
            return []
        return escalator.list_receipts()

    @router.post("/alerts/pushover/receipts/{receipt_id}/poll", dependencies=[Depends(require_v1_auth)])
    async def v1_pushover_poll_receipt(receipt_id: str):
        escalator = get_pushover_escalator() if get_pushover_escalator else None
        if escalator is None:
            raise HTTPException(status_code=503, detail="Pushover escalator unavailable.")
        try:
            return await escalator.poll_receipt(receipt_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    def _extract_actor(request: Request):
        actor_id = (request.headers.get("X-Actor-Id") or "api-operator").strip() or "api-operator"
        actor_role = (request.headers.get("X-Actor-Role") or "architect").strip().lower()
        return actor_id, actor_role

    @router.post("/remediation/propose", dependencies=[Depends(require_v1_auth)])
    async def v1_remediation_propose(request: Request, payload: RemediationProposePayload):
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Remediation engine unavailable.")
        actor_id, actor_role = _extract_actor(request)
        try:
            res = await engine.propose_action(
                action_type=payload.action_type,
                target_plugin_id=payload.target_plugin_id,
                target_node_uid=payload.target_node_uid,
                parameters=payload.parameters,
                requested_by=actor_id,
                requester_role=actor_role,
                dry_run=payload.dry_run,
                ttl_seconds=payload.ttl_seconds,
                force_approval=payload.force_approval,
            )
            if res.get("status") == "pending_approval":
                return JSONResponse(status_code=202, content=res)
            return res
        except RemediationRBACError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.get("/remediation/approvals", dependencies=[Depends(require_v1_auth)])
    async def v1_remediation_list_approvals(status: Optional[str] = None):
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            return []
        return engine.list_requests(status=status)

    @router.post("/remediation/approvals/{request_id}/approve", dependencies=[Depends(require_v1_auth)])
    async def v1_remediation_approve(request_id: str, request: Request, payload: RemediationApprovePayload):
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Remediation engine unavailable.")
        actor_id, actor_role = _extract_actor(request)
        try:
            return await engine.approve_action(
                request_id=request_id,
                approver_id=actor_id,
                approver_role=actor_role,
                approval_token=payload.approval_token,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except RemediationRBACError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        except RemediationAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
        except RemediationStateError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except RemediationExpiredError as exc:
            raise HTTPException(status_code=410, detail=str(exc))

    @router.post("/remediation/approvals/{request_id}/reject", dependencies=[Depends(require_v1_auth)])
    async def v1_remediation_reject(request_id: str, request: Request, payload: RemediationRejectPayload):
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Remediation engine unavailable.")
        actor_id, actor_role = _extract_actor(request)
        try:
            return await engine.reject_action(
                request_id=request_id,
                rejector_id=actor_id,
                rejector_role=actor_role,
                reason=payload.reason or "rejected_by_operator",
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except RemediationRBACError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        except RemediationStateError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.get("/remediation/audits", dependencies=[Depends(require_v1_auth)])
    async def v1_remediation_audits():
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            return []
        return engine.list_audits()

    @router.post("/entities/control/{node_uid}/{entity_key}", dependencies=[Depends(require_v1_auth)])
    async def v1_entity_control(node_uid: str, entity_key: str, request: Request, payload: EntityControlV1Payload):
        engine = get_remediation_engine() if get_remediation_engine else None
        if engine is None:
            raise HTTPException(status_code=503, detail="Remediation engine unavailable.")
        actor_id, actor_role = _extract_actor(request)
        params = {"entity_key": entity_key, "value": payload.value}
        if payload.parameters:
            params.update(payload.parameters)
        try:
            res = await engine.propose_action(
                action_type=payload.action_type,
                target_plugin_id=payload.target_plugin_id or node_uid,
                target_node_uid=node_uid,
                parameters=params,
                requested_by=actor_id,
                requester_role=actor_role,
                dry_run=payload.dry_run,
                force_approval=payload.force_approval,
            )
        except RemediationRBACError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        if res.get("status") == "pending_approval":
            return JSONResponse(status_code=202, content=res)

        if res.get("status") == "executed" and payload.action_type == "local_control":
            states = get_entity_states()
            for _, ent in states.items():
                if ent.get("node_id") == node_uid and ent.get("entity_key") == entity_key:
                    ent["value"] = payload.value
                    break
        return res

    @router.websocket("/ws/stream")
    async def v1_ws_stream(websocket: WebSocket):
        token = _extract_token(
            websocket.headers.get("x-api-key"),
            websocket.headers.get("authorization"),
            websocket.query_params.get("api_key"),
        )
        if not await verify_api_key_fn(token):
            await websocket.close(code=4401)
            return

        await ws_manager.connect_v1(websocket, streams={"telemetry", "alerts", "audits"})
        try:
            while True:
                data = await websocket.receive_json()
                action = data.get("action")
                if action == "subscribe":
                    raw_streams = data.get("streams") or ["telemetry", "alerts", "audits"]
                    streams = {str(s) for s in raw_streams}
                    ws_manager.set_v1_streams(websocket, streams)
                    if "telemetry" in streams:
                        for _, ent in list(get_entity_states().items()):
                            await ws_manager.send_v1_event(
                                websocket,
                                "telemetry",
                                {
                                    "event": "state_changed",
                                    "node_id": ent.get("node_id"),
                                    "entity_id": ent.get("entity_key"),
                                    "value": ent.get("value"),
                                    "status": ent.get("status", "unknown"),
                                    "status_type": ent.get("status_type", "default"),
                                },
                            )
                    if "audits" in streams:
                        await ws_manager.send_v1_event(
                            websocket,
                            "audits",
                            {
                                "event": "audit_logged",
                                "type": "success",
                                "message": "HomePulse Core v1 stream synchronized.",
                            },
                        )
        except WebSocketDisconnect:
            ws_manager.disconnect(websocket)
        except Exception as exc:
            logger.error(f"Core v1 WS error: {exc}")
            ws_manager.disconnect(websocket)

    return router
