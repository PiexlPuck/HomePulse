"""Tiered remediation execution gating, RBAC, approval tokens, and certified IPC dispatch."""

from collections import deque
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import secrets
from typing import Any, Callable, Deque, Dict, List, Optional

logger = logging.getLogger("homepulse-remediation")

TIER_1_ROUTINE = "tier1_routine"
TIER_2_ENDPOINT = "tier2_endpoint"
TIER_3_CLUSTER = "tier3_cluster"

VALID_ROLES = ("observer", "controller", "architect", "system_flow")
TIER_1_ACTIONS = {"plugin_restart", "cache_clear", "webhook_notify", "local_control"}
TIER_2_ACTIONS = {"remote_pkg_upgrade", "remote_service_restart", "remote_reboot", "remote_config_update"}
TIER_3_ACTIONS = {"hypervisor_reconfigure", "hypervisor_vm_power", "hypervisor_vm_migrate", "cluster_remediation"}


class RemediationRBACError(PermissionError):
    """Raised when an actor role lacks authority for the requested action."""


class RemediationAuthError(PermissionError):
    """Raised when an approval token is invalid."""


class RemediationStateError(ValueError):
    """Raised when an approval request is not in pending_approval state."""


class RemediationExpiredError(ValueError):
    """Raised when an approval request TTL has elapsed."""


def classify_action_tier(action_type: str) -> str:
    """Classify remediation action into Tier 1 (routine), Tier 2 (endpoint), or Tier 3 (cluster/hypervisor)."""
    act = str(action_type or "").strip().lower()
    if act in TIER_1_ACTIONS:
        return TIER_1_ROUTINE
    if act in TIER_2_ACTIONS or act.startswith("remote_"):
        return TIER_2_ENDPOINT
    if act in TIER_3_ACTIONS or act.startswith("hypervisor_") or act.startswith("cluster_"):
        return TIER_3_CLUSTER
    return TIER_3_CLUSTER


def _parse_iso_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


class RemediationEngine:
    """Separates Tier-1 routine tasks from Tier-2/3 gated operations requiring Architect approval."""

    def __init__(
        self,
        pool_getter: Optional[Callable[[], Any]] = None,
        ipc_broker_getter: Optional[Callable[[], Any]] = None,
        default_ttl_seconds: int = 900,
    ):
        self._pool_getter = pool_getter
        self._ipc_broker_getter = ipc_broker_getter
        self._default_ttl = max(1, int(default_ttl_seconds))
        self._requests: Dict[str, Dict[str, Any]] = {}
        self._audits: Deque[Dict[str, Any]] = deque(maxlen=500)

    def _pool(self):
        return self._pool_getter() if self._pool_getter else None

    def _broker(self):
        return self._ipc_broker_getter() if self._ipc_broker_getter else None

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _sanitize_request(rec: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(rec)
        out.pop("approval_token_hash", None)
        return out

    async def load_from_db(self) -> None:
        pool = self._pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """SELECT request_id, action_type, tier, target_plugin_id, target_node_uid,
                              parameters, status, requested_by, requester_role, flow_id, action_node_id,
                              approval_token_hash, expires_at, decided_by, decision_reason,
                              decided_at, ipc_seq, ipc_message_id, created_at
                       FROM remediation_approvals ORDER BY created_at DESC LIMIT 300;"""
                )
                for r in rows:
                    params = r["parameters"]
                    if isinstance(params, str):
                        params = json.loads(params)
                    exp = _parse_iso_dt(r["expires_at"])
                    dec = _parse_iso_dt(r["decided_at"])
                    crt = _parse_iso_dt(r["created_at"])
                    self._requests[r["request_id"]] = {
                        "request_id": r["request_id"],
                        "action_type": r["action_type"],
                        "tier": r["tier"],
                        "target_plugin_id": r["target_plugin_id"],
                        "target_node_uid": r["target_node_uid"],
                        "parameters": params or {},
                        "status": r["status"],
                        "requested_by": r["requested_by"],
                        "requester_role": r["requester_role"],
                        "flow_id": r["flow_id"],
                        "action_node_id": r["action_node_id"],
                        "approval_token_hash": r["approval_token_hash"],
                        "expires_at": exp.isoformat() if exp else None,
                        "decided_by": r["decided_by"],
                        "decision_reason": r["decision_reason"],
                        "decided_at": dec.isoformat() if dec else None,
                        "ipc_seq": r["ipc_seq"],
                        "ipc_message_id": r["ipc_message_id"],
                        "created_at": crt.isoformat() if crt else None,
                    }
        except Exception as exc:
            logger.error(f"Failed loading remediation approvals from DB: {exc}")

    async def _record_audit(self, event_type: str, request_id: str, actor: str, role: str, detail: str) -> None:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "request_id": request_id,
            "actor": actor,
            "role": role,
            "detail": detail,
        }
        self._audits.appendleft(entry)
        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    audit_level = "warning" if event_type in ("rejected", "expired", "rbac_denied", "auth_failed") else "info"
                    await conn.execute(
                        "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                        audit_level,
                        f"[Remediation:{event_type}] {request_id} by {actor} ({role}): {detail}",
                    )
            except Exception as exc:
                logger.error(f"Failed writing remediation audit to DB: {exc}")

    async def _persist_request(self, rec: Dict[str, Any]) -> None:
        pool = self._pool()
        if not pool:
            return
        try:
            exp_dt = _parse_iso_dt(rec.get("expires_at"))
            dec_dt = _parse_iso_dt(rec.get("decided_at"))
            async with pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO remediation_approvals (
                           request_id, action_type, tier, target_plugin_id, target_node_uid,
                           parameters, status, requested_by, requester_role, flow_id, action_node_id,
                           approval_token_hash, expires_at, decided_by, decision_reason,
                           decided_at, ipc_seq, ipc_message_id
                       ) VALUES (
                           $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
                       )
                       ON CONFLICT (request_id) DO UPDATE SET
                           status = EXCLUDED.status,
                           decided_by = EXCLUDED.decided_by,
                           decision_reason = EXCLUDED.decision_reason,
                           decided_at = EXCLUDED.decided_at,
                           ipc_seq = EXCLUDED.ipc_seq,
                           ipc_message_id = EXCLUDED.ipc_message_id;""",
                    rec["request_id"],
                    rec["action_type"],
                    rec["tier"],
                    rec["target_plugin_id"],
                    rec["target_node_uid"],
                    json.dumps(rec.get("parameters") or {}),
                    rec["status"],
                    rec["requested_by"],
                    rec["requester_role"],
                    rec.get("flow_id"),
                    rec.get("action_node_id"),
                    rec.get("approval_token_hash"),
                    exp_dt.replace(tzinfo=None) if exp_dt else None,
                    rec.get("decided_by"),
                    rec.get("decision_reason"),
                    dec_dt.replace(tzinfo=None) if dec_dt else None,
                    rec.get("ipc_seq"),
                    rec.get("ipc_message_id"),
                )
        except Exception as exc:
            logger.error(f"DB persist remediation request error ({rec['request_id']}): {exc}")

    def has_open_pending_request(self, flow_id: str, action_node_id: str, target_node_uid: str) -> bool:
        now = datetime.now(timezone.utc)
        for rec in self._requests.values():
            if (
                rec.get("status") == "pending_approval"
                and rec.get("flow_id") == str(flow_id)
                and rec.get("action_node_id") == str(action_node_id)
                and rec.get("target_node_uid") == str(target_node_uid)
            ):
                exp = _parse_iso_dt(rec.get("expires_at"))
                if exp is None or exp > now:
                    return True
        return False

    async def propose_action(
        self,
        action_type: str,
        target_plugin_id: str,
        target_node_uid: str,
        parameters: Optional[Dict[str, Any]] = None,
        requested_by: str = "operator",
        requester_role: str = "controller",
        flow_id: Optional[str] = None,
        action_node_id: Optional[str] = None,
        dry_run: bool = False,
        ttl_seconds: Optional[int] = None,
        force_approval: bool = False,
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        role = str(requester_role or "").strip().lower()
        if role not in VALID_ROLES:
            raise RemediationRBACError(f"Invalid requester role '{role}'")
        if role == "observer" and not dry_run:
            await self._record_audit("rbac_denied", "none", requested_by, role, f"Observer blocked from {action_type}")
            raise RemediationRBACError("Observer role cannot propose or execute remediation actions")

        act = str(action_type or "").strip()
        pid = str(target_plugin_id or "").strip()
        nuid = str(target_node_uid or "").strip()
        if not act or not pid or not nuid:
            raise ValueError("action_type, target_plugin_id, and target_node_uid are required")

        tier = classify_action_tier(act)
        requires_approval = bool(force_approval or (tier != TIER_1_ROUTINE))
        topic = f"core.remediation.{'approved' if requires_approval else 'routine'}.{pid}"
        preview = {
            "action_type": act,
            "tier": tier,
            "target_plugin_id": pid,
            "target_node_uid": nuid,
            "ipc_topic": topic,
            "parameters": dict(parameters or {}),
        }
        if dry_run:
            return {
                "status": "dry_run",
                "tier": tier,
                "requires_approval": requires_approval,
                "preview": preview,
            }

        now = now_dt or datetime.now(timezone.utc)
        request_id = "rem_" + secrets.token_hex(8)
        broker = self._broker()

        if not requires_approval:
            ipc_msg = None
            if broker is not None:
                ipc_msg = broker.publish_system(topic, {
                    "request_id": request_id,
                    "action_type": act,
                    "tier": tier,
                    "target_node_uid": nuid,
                    "parameters": dict(parameters or {}),
                    "requested_by": requested_by,
                })
            rec = {
                "request_id": request_id,
                "action_type": act,
                "tier": tier,
                "target_plugin_id": pid,
                "target_node_uid": nuid,
                "parameters": dict(parameters or {}),
                "status": "executed",
                "requested_by": requested_by,
                "requester_role": role,
                "flow_id": str(flow_id) if flow_id is not None else None,
                "action_node_id": str(action_node_id) if action_node_id is not None else None,
                "approval_token_hash": None,
                "expires_at": None,
                "decided_by": requested_by,
                "decision_reason": "tier1_auto_executed",
                "decided_at": now.isoformat(),
                "ipc_seq": ipc_msg["seq"] if ipc_msg else None,
                "ipc_message_id": ipc_msg["message_id"] if ipc_msg else None,
                "created_at": now.isoformat(),
            }
            self._requests[request_id] = rec
            await self._persist_request(rec)
            await self._record_audit("executed_tier1", request_id, requested_by, role, f"{act} on {nuid}")
            return self._sanitize_request(rec)

        # Tier 2 / Tier 3 / Force-gated: halt at pending_approval and mint one-time approval token
        approval_token = "hp_apr_" + secrets.token_hex(16)
        ttl = max(1, int(ttl_seconds if ttl_seconds is not None else self._default_ttl))
        expires_at = (now + timedelta(seconds=ttl)).isoformat()

        rec = {
            "request_id": request_id,
            "action_type": act,
            "tier": tier,
            "target_plugin_id": pid,
            "target_node_uid": nuid,
            "parameters": dict(parameters or {}),
            "status": "pending_approval",
            "requested_by": requested_by,
            "requester_role": role,
            "flow_id": str(flow_id) if flow_id is not None else None,
            "action_node_id": str(action_node_id) if action_node_id is not None else None,
            "approval_token_hash": self._hash_token(approval_token),
            "expires_at": expires_at,
            "decided_by": None,
            "decision_reason": None,
            "decided_at": None,
            "ipc_seq": None,
            "ipc_message_id": None,
            "created_at": now.isoformat(),
        }
        self._requests[request_id] = rec
        await self._persist_request(rec)
        await self._record_audit("proposed_gated", request_id, requested_by, role, f"{act} ({tier}) queued for approval")

        out = self._sanitize_request(rec)
        out["approval_token"] = approval_token
        return out

    async def approve_action(
        self,
        request_id: str,
        approver_id: str,
        approver_role: str,
        approval_token: str,
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        role = str(approver_role or "").strip().lower()
        if role != "architect":
            await self._record_audit("rbac_denied", request_id, approver_id, role, "Only architect role may approve gated remediation")
            raise RemediationRBACError("Only 'architect' role can approve gated remediation actions")

        rec = self._requests.get(request_id)
        if not rec:
            raise KeyError(f"Remediation request '{request_id}' not found")
        if rec["status"] != "pending_approval":
            raise RemediationStateError(f"Remediation request '{request_id}' is already '{rec['status']}'")

        now = now_dt or datetime.now(timezone.utc)
        exp_dt = _parse_iso_dt(rec.get("expires_at"))
        if exp_dt is not None and now > exp_dt:
            rec["status"] = "expired"
            rec["decided_by"] = approver_id
            rec["decision_reason"] = "approval_ttl_expired"
            rec["decided_at"] = now.isoformat()
            await self._persist_request(rec)
            await self._record_audit("expired", request_id, approver_id, role, "Approval token TTL expired")
            raise RemediationExpiredError(f"Approval token for '{request_id}' has expired")

        candidate_hash = self._hash_token(str(approval_token or "").strip())
        stored_hash = rec.get("approval_token_hash") or ""
        if not stored_hash or not hmac.compare_digest(candidate_hash, stored_hash):
            await self._record_audit("auth_failed", request_id, approver_id, role, "Invalid approval_token")
            raise RemediationAuthError("Invalid approval_token")

        topic = f"core.remediation.approved.{rec['target_plugin_id']}"
        broker = self._broker()
        ipc_msg = None
        if broker is not None:
            ipc_msg = broker.publish_system(topic, {
                "request_id": request_id,
                "action_type": rec["action_type"],
                "tier": rec["tier"],
                "target_node_uid": rec["target_node_uid"],
                "parameters": dict(rec.get("parameters") or {}),
                "approved_by": approver_id,
                "approved_at": now.isoformat(),
            })

        rec["status"] = "executed"
        rec["decided_by"] = approver_id
        rec["decision_reason"] = "architect_approved"
        rec["decided_at"] = now.isoformat()
        rec["ipc_seq"] = ipc_msg["seq"] if ipc_msg else None
        rec["ipc_message_id"] = ipc_msg["message_id"] if ipc_msg else None

        await self._persist_request(rec)
        await self._record_audit(
            "approved_and_dispatched",
            request_id,
            approver_id,
            role,
            f"Dispatched {rec['action_type']} to {topic}",
        )
        return self._sanitize_request(rec)

    async def reject_action(
        self,
        request_id: str,
        rejector_id: str,
        rejector_role: str,
        reason: str = "",
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        role = str(rejector_role or "").strip().lower()
        if role not in ("architect", "controller"):
            await self._record_audit("rbac_denied", request_id, rejector_id, role, "Role not authorized to reject")
            raise RemediationRBACError("Only 'architect' or 'controller' can reject remediation actions")

        rec = self._requests.get(request_id)
        if not rec:
            raise KeyError(f"Remediation request '{request_id}' not found")
        if rec["status"] != "pending_approval":
            raise RemediationStateError(f"Remediation request '{request_id}' is already '{rec['status']}'")

        now = now_dt or datetime.now(timezone.utc)
        rec["status"] = "rejected"
        rec["decided_by"] = rejector_id
        rec["decision_reason"] = str(reason or "rejected_by_operator").strip()
        rec["decided_at"] = now.isoformat()

        await self._persist_request(rec)
        await self._record_audit("rejected", request_id, rejector_id, role, rec["decision_reason"])
        return self._sanitize_request(rec)

    def list_requests(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        out = []
        for rec in self._requests.values():
            if status and rec.get("status") != status:
                continue
            out.append(self._sanitize_request(rec))
        out.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return out

    def list_audits(self) -> List[Dict[str, Any]]:
        return list(self._audits)
