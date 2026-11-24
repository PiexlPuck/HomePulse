"""Encrypted push daemon ingestion (Ed25519 + AES-256-GCM + anti-replay nonce cache)."""

import base64
from datetime import datetime, timezone
import json
import logging
import os
import secrets
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger("homepulse-daemon-ingest")

ENVELOPE_SCHEMA_VERSION = "homepulse.envelope.v1"
PAYLOAD_SCHEMA_VERSION = "daemon.update_cve.v1"
MAX_CLOCK_SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 300
CRITICAL_CVSS_THRESHOLD = 9.0


class DaemonAuthError(PermissionError):
    """Raised when envelope authentication, signature, key, timestamp, or tag fails."""


class DaemonReplayError(ValueError):
    """Raised when an envelope nonce is replayed within the anti-replay window."""


class DaemonPayloadError(ValueError):
    """Raised when the decrypted inner daemon payload fails schema validation."""


def build_signing_bytes(
    agent_id: str,
    timestamp: str,
    nonce: str,
    kid: str,
    iv_b64: str,
    ciphertext_b64: str,
    tag_b64: str,
) -> bytes:
    """Build canonical Ed25519 signing input covering envelope identity, nonce, and ciphertext."""
    return f"{agent_id}|{timestamp}|{nonce}|{kid}|{iv_b64}|{ciphertext_b64}|{tag_b64}".encode("utf-8")


def encrypt_and_sign_envelope(
    agent_id: str,
    kid: str,
    aes_key_bytes: bytes,
    ed25519_private_key: Ed25519PrivateKey,
    inner_payload: Dict[str, Any],
    timestamp: Optional[str] = None,
    nonce_bytes: Optional[bytes] = None,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Encrypt an inner payload with AES-256-GCM and sign the outer envelope with Ed25519."""
    ts = timestamp or datetime.now(timezone.utc).isoformat()
    n_bytes = nonce_bytes if nonce_bytes is not None else os.urandom(16)
    nonce_b64 = base64.b64encode(n_bytes).decode("ascii")
    iv_bytes = os.urandom(12)
    iv_b64 = base64.b64encode(iv_bytes).decode("ascii")
    aad_str = f"{agent_id}|{ts}|{nonce_b64}|{PAYLOAD_SCHEMA_VERSION}"

    plaintext = json.dumps(inner_payload).encode("utf-8")
    ct_and_tag = AESGCM(aes_key_bytes).encrypt(iv_bytes, plaintext, aad_str.encode("utf-8"))
    ciphertext_b64 = base64.b64encode(ct_and_tag[:-16]).decode("ascii")
    tag_b64 = base64.b64encode(ct_and_tag[-16:]).decode("ascii")

    sig_bytes = ed25519_private_key.sign(
        build_signing_bytes(agent_id, ts, nonce_b64, kid, iv_b64, ciphertext_b64, tag_b64)
    )
    sig_header = "ed25519:" + base64.b64encode(sig_bytes).decode("ascii")

    envelope = {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "alg": "AES-256-GCM",
        "kid": kid,
        "agent_id": agent_id,
        "timestamp": ts,
        "nonce": nonce_b64,
        "iv": iv_b64,
        "aad": aad_str,
        "ciphertext": ciphertext_b64,
        "tag": tag_b64,
    }
    headers = {
        "X-Agent-Id": agent_id,
        "X-Envelope-Timestamp": ts,
        "X-Envelope-Nonce": nonce_b64,
        "X-Envelope-Signature": sig_header,
    }
    return envelope, headers


def _parse_iso_dt(ts_str: str) -> datetime:
    dt = datetime.fromisoformat(ts_str.strip().replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class DaemonIngestEngine:
    """Enrolls remote update/CVE daemons, decrypts signed pushes, and escalates critical CVEs."""

    def __init__(
        self,
        pool_getter: Optional[Callable[[], Any]] = None,
        entity_states_getter: Optional[Callable[[], Dict[str, Dict[str, Any]]]] = None,
        repeater_enqueue_fn: Optional[Callable[..., None]] = None,
        critical_escalation_fn: Optional[Callable[[str, str, List[Dict[str, Any]], Dict[str, Any]], Awaitable[List[Dict[str, Any]]]]] = None,
    ):
        self._pool_getter = pool_getter
        self._entity_states_getter = entity_states_getter
        self._repeater_enqueue_fn = repeater_enqueue_fn
        self._critical_escalation_fn = critical_escalation_fn
        self._agents: Dict[str, Dict[str, Any]] = {}
        self._seen_nonces: Dict[Tuple[str, str], float] = {}
        self._host_posture: Dict[str, Dict[str, Any]] = {}

    def _pool(self):
        return self._pool_getter() if self._pool_getter else None

    async def load_from_db(self) -> None:
        pool = self._pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT agent_id, hostname, kid, ed25519_public_key_b64, aes_key_b64, enrolled_at FROM enrolled_agents;"
                )
                for r in rows:
                    self._agents[r["agent_id"]] = {
                        "agent_id": r["agent_id"],
                        "hostname": r["hostname"],
                        "kid": r["kid"],
                        "ed25519_public_key_b64": r["ed25519_public_key_b64"],
                        "aes_key_b64": r["aes_key_b64"],
                        "enrolled_at": r["enrolled_at"].isoformat() if r["enrolled_at"] else None,
                    }
                rep_rows = await conn.fetch(
                    """SELECT DISTINCT ON (host_uid)
                              host_uid, hostname, collected_at, upgradable_total,
                              security_updates, critical_cve_count, reboot_required, payload_json
                       FROM daemon_cve_reports
                       ORDER BY host_uid, received_at DESC;"""
                )
                for r in rep_rows:
                    payload = r["payload_json"]
                    if isinstance(payload, str):
                        payload = json.loads(payload)
                    self._host_posture[r["host_uid"]] = {
                        "host_uid": r["host_uid"],
                        "hostname": r["hostname"],
                        "collected_at": r["collected_at"],
                        "upgradable_total": int(r["upgradable_total"] or 0),
                        "security_updates": int(r["security_updates"] or 0),
                        "critical_cve_count": int(r["critical_cve_count"] or 0),
                        "reboot_required": bool(r["reboot_required"]),
                        "payload": payload or {},
                    }
        except Exception as exc:
            logger.error(f"Failed loading enrolled daemon agents from DB: {exc}")

    async def enroll_agent(
        self,
        agent_id: str,
        hostname: str,
        ed25519_public_key_b64: str,
        kid: Optional[str] = None,
        aes_key_b64: Optional[str] = None,
    ) -> Dict[str, Any]:
        aid = str(agent_id or "").strip()
        hname = str(hostname or "").strip()
        if not aid or not hname:
            raise DaemonPayloadError("agent_id and hostname are required")

        try:
            pub_raw = base64.b64decode(ed25519_public_key_b64.strip(), validate=True)
            Ed25519PublicKey.from_public_bytes(pub_raw)
        except Exception as exc:
            raise DaemonPayloadError(f"Invalid Ed25519 public key: {exc}")

        if aes_key_b64:
            try:
                aes_raw = base64.b64decode(aes_key_b64.strip(), validate=True)
                if len(aes_raw) != 32:
                    raise ValueError("AES-256 key must be 32 bytes")
                resolved_aes_b64 = base64.b64encode(aes_raw).decode("ascii")
            except Exception as exc:
                raise DaemonPayloadError(f"Invalid AES-256 key: {exc}")
        else:
            resolved_aes_b64 = base64.b64encode(os.urandom(32)).decode("ascii")

        resolved_kid = str(kid or f"key-{secrets.token_hex(6)}").strip()
        now_iso = datetime.now(timezone.utc).isoformat()

        self._agents[aid] = {
            "agent_id": aid,
            "hostname": hname,
            "kid": resolved_kid,
            "ed25519_public_key_b64": ed25519_public_key_b64.strip(),
            "aes_key_b64": resolved_aes_b64,
            "enrolled_at": now_iso,
        }

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """INSERT INTO enrolled_agents (agent_id, hostname, kid, ed25519_public_key_b64, aes_key_b64)
                           VALUES ($1, $2, $3, $4, $5)
                           ON CONFLICT (agent_id) DO UPDATE SET
                               hostname = EXCLUDED.hostname,
                               kid = EXCLUDED.kid,
                               ed25519_public_key_b64 = EXCLUDED.ed25519_public_key_b64,
                               aes_key_b64 = EXCLUDED.aes_key_b64,
                               enrolled_at = CURRENT_TIMESTAMP;""",
                        aid,
                        hname,
                        resolved_kid,
                        ed25519_public_key_b64.strip(),
                        resolved_aes_b64,
                    )
            except Exception as exc:
                logger.error(f"DB enroll_agent error for {aid}: {exc}")

        return {
            "status": "enrolled",
            "agent_id": aid,
            "hostname": hname,
            "kid": resolved_kid,
            "aes_key_b64": resolved_aes_b64,
            "enrolled_at": now_iso,
        }

    async def list_agents(self) -> List[Dict[str, Any]]:
        out = []
        for k in sorted(self._agents.keys()):
            a = self._agents[k]
            out.append({
                "agent_id": a["agent_id"],
                "hostname": a["hostname"],
                "kid": a["kid"],
                "has_key": bool(a.get("aes_key_b64")),
                "enrolled_at": a.get("enrolled_at"),
            })
        return out

    async def revoke_agent(self, agent_id: str) -> bool:
        aid = str(agent_id or "").strip()
        existed = self._agents.pop(aid, None) is not None
        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    res = await conn.execute("DELETE FROM enrolled_agents WHERE agent_id = $1;", aid)
                    existed = existed or res.endswith("1")
            except Exception as exc:
                logger.error(f"DB revoke_agent error for {aid}: {exc}")
        return existed

    def list_posture(self) -> Dict[str, Dict[str, Any]]:
        return {k: dict(v) for k, v in self._host_posture.items()}

    def _prune_nonces(self, mono_now: float) -> None:
        expired = [k for k, exp in self._seen_nonces.items() if exp <= mono_now]
        for k in expired:
            self._seen_nonces.pop(k, None)

    @staticmethod
    def _is_critical_cve(cve: Dict[str, Any]) -> bool:
        if cve.get("cisa_kev") is True:
            return True
        if str(cve.get("severity", "")).strip().lower() == "critical":
            return True
        try:
            if float(cve.get("cvss_v3", 0.0)) >= CRITICAL_CVSS_THRESHOLD:
                return True
        except (TypeError, ValueError):
            pass
        return False

    async def ingest_envelope(
        self,
        envelope: Dict[str, Any],
        headers: Dict[str, str],
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        if not isinstance(envelope, dict):
            raise DaemonPayloadError("Envelope body must be a JSON object")
        if envelope.get("schema_version") != ENVELOPE_SCHEMA_VERSION:
            raise DaemonPayloadError(f"Unsupported envelope schema_version '{envelope.get('schema_version')}'")
        if envelope.get("alg") != "AES-256-GCM":
            raise DaemonPayloadError(f"Unsupported envelope cipher '{envelope.get('alg')}'")

        norm_headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        hdr_agent = norm_headers.get("x-agent-id", "").strip()
        hdr_ts = norm_headers.get("x-envelope-timestamp", "").strip()
        hdr_nonce = norm_headers.get("x-envelope-nonce", "").strip()
        hdr_sig = norm_headers.get("x-envelope-signature", "").strip()

        if not (hdr_agent and hdr_ts and hdr_nonce and hdr_sig):
            raise DaemonAuthError("Missing required X-Envelope-* / X-Agent-Id authentication headers")

        agent_id = str(envelope.get("agent_id") or "")
        ts = str(envelope.get("timestamp") or "")
        nonce = str(envelope.get("nonce") or "")
        kid = str(envelope.get("kid") or "")
        iv_b64 = str(envelope.get("iv") or "")
        ct_b64 = str(envelope.get("ciphertext") or "")
        tag_b64 = str(envelope.get("tag") or "")
        aad_str = str(envelope.get("aad") or "")

        if hdr_agent != agent_id or hdr_ts != ts or hdr_nonce != nonce:
            raise DaemonAuthError("Envelope headers do not match envelope body fields")

        agent = self._agents.get(agent_id)
        if not agent or kid != agent.get("kid"):
            raise DaemonAuthError(f"Unknown agent '{agent_id}' or mismatched key id '{kid}'")

        # Enforce timestamp clock skew
        now = now_dt or datetime.now(timezone.utc)
        try:
            ts_dt = _parse_iso_dt(ts)
        except Exception:
            raise DaemonAuthError("Invalid envelope timestamp format")
        if abs((now - ts_dt).total_seconds()) > MAX_CLOCK_SKEW_SECONDS:
            raise DaemonAuthError("Envelope timestamp outside allowed clock skew window")

        # Verify Ed25519 signature BEFORE recording nonce
        if not hdr_sig.startswith("ed25519:"):
            raise DaemonAuthError("Signature must use ed25519: prefix")
        try:
            sig_bytes = base64.b64decode(hdr_sig[len("ed25519:"):], validate=True)
            pub_bytes = base64.b64decode(agent["ed25519_public_key_b64"], validate=True)
            pub_key = Ed25519PublicKey.from_public_bytes(pub_bytes)
            signing_bytes = build_signing_bytes(agent_id, ts, nonce, kid, iv_b64, ct_b64, tag_b64)
            pub_key.verify(sig_bytes, signing_bytes)
        except (InvalidSignature, ValueError) as exc:
            raise DaemonAuthError(f"Envelope signature verification failed: {exc}")

        # Anti-replay nonce check
        mono_now = time.monotonic()
        self._prune_nonces(mono_now)
        nonce_key = (agent_id, nonce)
        if nonce_key in self._seen_nonces:
            raise DaemonReplayError(f"Replay detected for agent '{agent_id}' nonce")
        self._seen_nonces[nonce_key] = mono_now + NONCE_TTL_SECONDS

        # Verify expected AAD & decrypt AES-256-GCM
        expected_aad = f"{agent_id}|{ts}|{nonce}|{PAYLOAD_SCHEMA_VERSION}"
        if aad_str != expected_aad:
            raise DaemonAuthError("Envelope AAD binding mismatch")
        try:
            aes_key = base64.b64decode(agent["aes_key_b64"], validate=True)
            iv_bytes = base64.b64decode(iv_b64, validate=True)
            ct_bytes = base64.b64decode(ct_b64, validate=True)
            tag_bytes = base64.b64decode(tag_b64, validate=True)
            if len(tag_bytes) != 16:
                raise ValueError("GCM tag must be 16 bytes")
            plaintext = AESGCM(aes_key).decrypt(iv_bytes, ct_bytes + tag_bytes, aad_str.encode("utf-8"))
        except (InvalidTag, ValueError) as exc:
            raise DaemonAuthError(f"Envelope decryption/integrity check failed: {exc}")

        try:
            inner = json.loads(plaintext.decode("utf-8"))
        except Exception as exc:
            raise DaemonPayloadError(f"Decrypted payload is not valid JSON: {exc}")

        if not isinstance(inner, dict) or inner.get("schema_version") != PAYLOAD_SCHEMA_VERSION:
            raise DaemonPayloadError("Invalid inner payload schema_version")
        if inner.get("host_uid") != agent_id:
            raise DaemonAuthError("Inner payload host_uid does not match authenticated agent_id")
        if not isinstance(inner.get("hostname"), str) or not inner["hostname"].strip():
            raise DaemonPayloadError("Inner payload missing hostname")
        if not isinstance(inner.get("os"), dict) or not isinstance(inner.get("packages"), dict):
            raise DaemonPayloadError("Inner payload missing os or packages object")
        cves = inner.get("cves")
        if not isinstance(cves, list):
            raise DaemonPayloadError("Inner payload cves must be a list")

        hostname = inner["hostname"].strip()
        pkgs = inner["packages"]
        os_info = inner["os"]
        upgradable_total = int(pkgs.get("upgradable_total", 0))
        security_updates = int(pkgs.get("security_updates", 0))
        reboot_required = bool(os_info.get("reboot_required", False))
        critical_cves = [c for c in cves if isinstance(c, dict) and self._is_critical_cve(c)]

        posture_rec = {
            "host_uid": agent_id,
            "hostname": hostname,
            "collected_at": inner.get("collected_at") or ts,
            "received_at": now.isoformat(),
            "upgradable_total": upgradable_total,
            "security_updates": security_updates,
            "critical_cve_count": len(critical_cves),
            "reboot_required": reboot_required,
            "payload": inner,
        }
        self._host_posture[agent_id] = posture_rec

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """INSERT INTO daemon_cve_reports (
                               host_uid, hostname, collected_at, upgradable_total,
                               security_updates, critical_cve_count, reboot_required, payload_json
                           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);""",
                        agent_id,
                        hostname,
                        posture_rec["collected_at"],
                        upgradable_total,
                        security_updates,
                        len(critical_cves),
                        reboot_required,
                        json.dumps(inner),
                    )
            except Exception as exc:
                logger.error(f"DB daemon_cve_reports insert error for {agent_id}: {exc}")

        # Emit pure telemetry states & forward through repeater if enabled
        states = self._entity_states_getter() if self._entity_states_getter else None
        metrics = [
            (f"daemon-{agent_id}-updates", f"{hostname} Pending Updates", "sensor", upgradable_total, "integer", "pkgs"),
            (f"daemon-{agent_id}-security-updates", f"{hostname} Security Updates", "sensor", security_updates, "integer", "pkgs"),
            (f"daemon-{agent_id}-critical-cves", f"{hostname} Critical CVEs", "sensor", len(critical_cves), "integer", "cves"),
            (f"daemon-{agent_id}-reboot-required", f"{hostname} Reboot Required", "binary_sensor", reboot_required, "boolean", ""),
        ]
        for ekey, ename, etype, val, vtype, unit in metrics:
            status_lbl = "critical" if (ekey.endswith("critical-cves") and val > 0) else "optimal"
            if states is not None:
                states[ekey] = {
                    "node_id": agent_id,
                    "entity_key": ekey,
                    "name": ename,
                    "type": etype,
                    "value": val,
                    "value_type": vtype,
                    "unit": unit,
                    "status": "Critical" if status_lbl == "critical" else "Optimal",
                    "status_type": status_lbl,
                }
            if self._repeater_enqueue_fn is not None:
                self._repeater_enqueue_fn(
                    "security.posture_updated",
                    "core.daemon_ingest",
                    agent_id,
                    ekey,
                    val,
                    vtype,
                    unit,
                    status_lbl,
                )

        receipts: List[Dict[str, Any]] = []
        if critical_cves and self._critical_escalation_fn is not None:
            receipts = await self._critical_escalation_fn(agent_id, hostname, critical_cves, inner)

        return {
            "status": "ingested",
            "host_uid": agent_id,
            "hostname": hostname,
            "upgradable_total": upgradable_total,
            "security_updates": security_updates,
            "critical_cve_count": len(critical_cves),
            "critical_cves": critical_cves,
            "escalated": bool(receipts),
            "receipts": receipts,
        }
