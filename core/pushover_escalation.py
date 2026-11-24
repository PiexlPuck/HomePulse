"""Pushover Priority 2 Emergency Escalation & Receipt Tracking."""

import asyncio
from datetime import datetime, timezone
import json
import logging
from typing import Any, Callable, Dict, List, Optional
import urllib.parse
import urllib.request

logger = logging.getLogger("homepulse-pushover")


class PushoverEscalator:
    """Dispatches Priority 2 emergency alerts for critical CVEs and tracks ack receipts."""

    def __init__(
        self,
        pool_getter: Optional[Callable[[], Any]] = None,
        api_base_url: str = "https://api.pushover.net/1",
    ):
        self._pool_getter = pool_getter
        self._api_base_url = api_base_url.rstrip("/")
        self._ephemeral_channels: List[Dict[str, Any]] = []
        self._receipts: Dict[str, Dict[str, Any]] = {}

    def _pool(self):
        return self._pool_getter() if self._pool_getter else None

    @staticmethod
    def compute_priority(severity: str, max_cvss: float = 0.0, has_kev: bool = False) -> int:
        sev = str(severity or "").strip().lower()
        if has_kev or max_cvss >= 9.0 or sev == "critical":
            return 2
        if max_cvss >= 7.0 or sev == "high":
            return 1
        return 0

    def register_ephemeral_channel(
        self,
        name: str,
        user_key: str,
        api_token: str,
        retry: int = 60,
        expire: int = 3600,
        sound: str = "siren",
    ) -> Dict[str, Any]:
        """Register a Pushover channel in memory (used in DB-less repeater/test modes)."""
        rec = {
            "name": str(name or "Pushover Emergency").strip(),
            "user_key": str(user_key).strip(),
            "api_token": str(api_token).strip(),
            "retry": max(30, int(retry)),
            "expire": min(10800, max(60, int(expire))),
            "sound": str(sound or "siren").strip(),
        }
        # Deduplicate by (user_key, api_token)
        self._ephemeral_channels = [
            c for c in self._ephemeral_channels
            if not (c["user_key"] == rec["user_key"] and c["api_token"] == rec["api_token"])
        ]
        self._ephemeral_channels.append(rec)
        return {
            "name": rec["name"],
            "retry": rec["retry"],
            "expire": rec["expire"],
            "sound": rec["sound"],
            "configured": True,
        }

    async def load_from_db(self) -> None:
        pool = self._pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """SELECT receipt_id, host_uid, hostname, channel_name, api_token,
                              priority, status, acknowledged, acknowledged_at, expired, created_at
                       FROM pushover_receipts ORDER BY created_at DESC LIMIT 200;"""
                )
                for r in rows:
                    self._receipts[r["receipt_id"]] = {
                        "receipt_id": r["receipt_id"],
                        "host_uid": r["host_uid"],
                        "hostname": r["hostname"],
                        "channel_name": r["channel_name"],
                        "api_token": r["api_token"],
                        "priority": int(r["priority"]),
                        "status": r["status"],
                        "acknowledged": bool(r["acknowledged"]),
                        "acknowledged_at": r["acknowledged_at"],
                        "expired": bool(r["expired"]),
                        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                    }
        except Exception as exc:
            logger.error(f"Failed loading Pushover receipts from DB: {exc}")

    async def _resolve_pushover_channels(self) -> List[Dict[str, Any]]:
        channels: List[Dict[str, Any]] = list(self._ephemeral_channels)
        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    rows = await conn.fetch("SELECT name, config FROM notification_channels WHERE type = 'pushover';")
                    for r in rows:
                        cfg = json.loads(r["config"]) if isinstance(r["config"], str) else (r["config"] or {})
                        if cfg.get("user_key") and cfg.get("api_token"):
                            channels.append({
                                "name": r["name"],
                                "user_key": cfg["user_key"],
                                "api_token": cfg["api_token"],
                                "retry": max(30, int(cfg.get("retry", 60))),
                                "expire": min(10800, max(60, int(cfg.get("expire", 3600)))),
                                "sound": cfg.get("sound", "siren"),
                            })
            except Exception as exc:
                logger.error(f"Failed resolving DB Pushover channels: {exc}")
        return channels

    def _post_message_sync(self, cfg: Dict[str, Any], title: str, message: str) -> Dict[str, Any]:
        payload = {
            "token": cfg["api_token"],
            "user": cfg["user_key"],
            "title": title,
            "message": message,
            "priority": 2,
            "retry": max(30, int(cfg.get("retry", 60))),
            "expire": min(10800, max(60, int(cfg.get("expire", 3600)))),
            "sound": cfg.get("sound", "siren"),
        }
        req = urllib.request.Request(
            f"{self._api_base_url}/messages.json",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _get_receipt_sync(self, receipt_id: str, api_token: str) -> Dict[str, Any]:
        qs = urllib.parse.urlencode({"token": api_token})
        req = urllib.request.Request(
            f"{self._api_base_url}/receipts/{urllib.parse.quote(receipt_id)}.json?{qs}",
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def _sanitize_receipt(rec: Dict[str, Any]) -> Dict[str, Any]:
        copy_r = dict(rec)
        copy_r.pop("api_token", None)
        return copy_r

    async def dispatch_emergency_cve_alert(
        self,
        host_uid: str,
        hostname: str,
        critical_cves: List[Dict[str, Any]],
        inner_payload: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        channels = await self._resolve_pushover_channels()
        if not channels:
            return []

        cve_lines = []
        for c in critical_cves[:10]:
            kev_tag = " [CISA KEV]" if c.get("cisa_kev") else ""
            cve_lines.append(
                f"- {c.get('cve_id', 'UNKNOWN')} (pkg={c.get('package', '?')}, CVSS={c.get('cvss_v3', '?')}){kev_tag}"
            )
        title = f"CRITICAL CVE ALERT: {hostname} ({len(critical_cves)} critical)"
        message = (
            f"Host: {hostname} ({host_uid})\n"
            + "\n".join(cve_lines)
            + "\nAutomated update blocked pending explicit approval."
        )

        dispatched: List[Dict[str, Any]] = []
        now_iso = datetime.now(timezone.utc).isoformat()
        for ch in channels:
            try:
                res = await asyncio.to_thread(self._post_message_sync, ch, title, message)
                receipt_id = str(res.get("receipt") or f"local-{host_uid}-{int(datetime.now().timestamp())}")
                rec = {
                    "receipt_id": receipt_id,
                    "host_uid": host_uid,
                    "hostname": hostname,
                    "channel_name": ch["name"],
                    "api_token": ch["api_token"],
                    "priority": 2,
                    "status": "pending_ack",
                    "acknowledged": False,
                    "acknowledged_at": None,
                    "expired": False,
                    "created_at": now_iso,
                }
                self._receipts[receipt_id] = rec

                pool = self._pool()
                if pool:
                    try:
                        async with pool.acquire() as conn:
                            await conn.execute(
                                """INSERT INTO pushover_receipts (
                                       receipt_id, host_uid, hostname, channel_name, api_token,
                                       priority, status, acknowledged, expired
                                   ) VALUES ($1, $2, $3, $4, $5, 2, 'pending_ack', FALSE, FALSE)
                                   ON CONFLICT (receipt_id) DO NOTHING;""",
                                receipt_id,
                                host_uid,
                                hostname,
                                ch["name"],
                                ch["api_token"],
                            )
                    except Exception as exc:
                        logger.error(f"DB insert pushover_receipts error: {exc}")

                dispatched.append(self._sanitize_receipt(rec))
            except Exception as exc:
                logger.error(f"Pushover Priority 2 dispatch error on channel '{ch['name']}': {exc}")
        return dispatched

    async def poll_receipt(self, receipt_id: str) -> Dict[str, Any]:
        rec = self._receipts.get(receipt_id)
        if not rec:
            raise KeyError(f"Pushover receipt '{receipt_id}' not found")

        data = await asyncio.to_thread(self._get_receipt_sync, receipt_id, rec["api_token"])
        acked = bool(data.get("acknowledged", 0))
        expired = bool(data.get("expired", 0))
        ack_at = data.get("acknowledged_at") or None

        rec["acknowledged"] = acked
        rec["acknowledged_at"] = ack_at
        rec["expired"] = expired
        rec["status"] = "acknowledged" if acked else ("expired" if expired else "pending_ack")

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """UPDATE pushover_receipts
                           SET acknowledged = $1, acknowledged_at = $2, expired = $3, status = $4
                           WHERE receipt_id = $5;""",
                        acked,
                        ack_at,
                        expired,
                        rec["status"],
                        receipt_id,
                    )
            except Exception as exc:
                logger.error(f"DB update pushover_receipts error: {exc}")

        return self._sanitize_receipt(rec)

    def list_receipts(self) -> List[Dict[str, Any]]:
        return [self._sanitize_receipt(v) for v in self._receipts.values()]
