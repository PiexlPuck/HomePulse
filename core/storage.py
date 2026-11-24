"""Storage repository abstraction supporting PostgreSQL and DB-less YAML/memory modes."""

from collections import deque
from datetime import datetime, timezone
import json
import logging
import os
from typing import Any, Callable, Deque, Dict, List, Optional

import yaml

logger = logging.getLogger("homepulse-storage")


class StorageRepository:
    """Abstract repository interface for core monitors, telemetry, and repeater targets."""

    def is_persistent(self) -> bool:
        raise NotImplementedError

    def is_connected(self) -> bool:
        raise NotImplementedError

    async def list_monitors(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    async def create_monitor(self, data: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    async def update_monitor(self, monitor_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    async def delete_monitor(self, monitor_id: int) -> bool:
        raise NotImplementedError

    async def record_monitor_result(self, monitor_id: int, status: str, latency: float) -> None:
        raise NotImplementedError

    async def append_telemetry(self, node_id: str, entity_key: str, value: Any) -> None:
        raise NotImplementedError

    async def get_telemetry(self, entity_key: str, limit: int = 100) -> List[Dict[str, Any]]:
        raise NotImplementedError

    async def list_repeater_targets(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    async def upsert_repeater_target(self, target: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    async def delete_repeater_target(self, target_id: str) -> bool:
        raise NotImplementedError


class InMemoryYamlRepository(StorageRepository):
    """In-memory repository optionally seeded from a declarative YAML/JSON file."""

    def __init__(self, config_path: str = "", history_maxlen: int = 500):
        self._monitors: Dict[int, Dict[str, Any]] = {}
        self._next_monitor_id: int = 1
        self._targets: Dict[str, Dict[str, Any]] = {}
        self._telemetry: Dict[str, Deque[Dict[str, Any]]] = {}
        self._history_maxlen = history_maxlen
        if config_path:
            self._load_config_file(config_path)

    def _load_config_file(self, config_path: str) -> None:
        if not os.path.isfile(config_path):
            logger.warning(f"Probes config file not found: {config_path}")
            return
        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                raw = fh.read()
            parsed = yaml.safe_load(raw) if raw.strip() else {}
            if not isinstance(parsed, dict):
                return

            raw_probes = parsed.get("probes") or parsed.get("monitors") or []
            if isinstance(raw_probes, list):
                for item in raw_probes:
                    if not isinstance(item, dict):
                        continue
                    mid = item.get("id")
                    if isinstance(mid, int) and mid > 0:
                        self._next_monitor_id = max(self._next_monitor_id, mid + 1)
                    else:
                        mid = self._next_monitor_id
                        self._next_monitor_id += 1
                    self._monitors[mid] = {
                        "id": mid,
                        "name": str(item.get("name") or f"Probe {mid}"),
                        "type": str(item.get("type") or "ping"),
                        "target": str(item.get("target") or ""),
                        "check_interval": int(item.get("check_interval", 30)),
                        "timeout": int(item.get("timeout", 5)),
                        "enabled": bool(item.get("enabled", True)),
                        "category": str(item.get("category") or "General"),
                        "last_status": "unknown",
                        "last_latency": 0.0,
                        "last_checked": None,
                    }

            raw_targets = parsed.get("repeater_targets") or []
            if isinstance(raw_targets, list):
                for tgt in raw_targets:
                    if not isinstance(tgt, dict) or not tgt.get("url"):
                        continue
                    tid = str(tgt.get("id") or f"target-{len(self._targets) + 1}")
                    self._targets[tid] = {
                        "id": tid,
                        "name": str(tgt.get("name") or tid),
                        "url": str(tgt["url"]).strip(),
                        "secret": str(tgt.get("secret") or ""),
                        "headers": dict(tgt.get("headers") or {}),
                        "enabled": bool(tgt.get("enabled", True)),
                    }
        except Exception as exc:
            logger.error(f"Failed loading probes YAML config {config_path}: {exc}")

    def is_persistent(self) -> bool:
        return False

    def is_connected(self) -> bool:
        return True

    async def list_monitors(self) -> List[Dict[str, Any]]:
        return [dict(self._monitors[k]) for k in sorted(self._monitors.keys())]

    async def create_monitor(self, data: Dict[str, Any]) -> Dict[str, Any]:
        mid = self._next_monitor_id
        self._next_monitor_id += 1
        rec = {
            "id": mid,
            "name": str(data["name"]).strip(),
            "type": str(data["type"]).strip(),
            "target": str(data["target"]).strip(),
            "check_interval": int(data.get("check_interval", 30)),
            "timeout": int(data.get("timeout", 5)),
            "enabled": bool(data.get("enabled", True)),
            "category": str(data.get("category") or "General"),
            "last_status": "unknown",
            "last_latency": 0.0,
            "last_checked": None,
        }
        self._monitors[mid] = rec
        return dict(rec)

    async def update_monitor(self, monitor_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        existing = self._monitors.get(monitor_id)
        if not existing:
            return None
        existing.update({
            "name": str(data.get("name", existing["name"])).strip(),
            "type": str(data.get("type", existing["type"])).strip(),
            "target": str(data.get("target", existing["target"])).strip(),
            "check_interval": int(data.get("check_interval", existing["check_interval"])),
            "timeout": int(data.get("timeout", existing["timeout"])),
            "enabled": bool(data.get("enabled", existing["enabled"])),
            "category": str(data.get("category") or existing.get("category") or "General"),
        })
        return dict(existing)

    async def delete_monitor(self, monitor_id: int) -> bool:
        return self._monitors.pop(monitor_id, None) is not None

    async def record_monitor_result(self, monitor_id: int, status: str, latency: float) -> None:
        mon = self._monitors.get(monitor_id)
        if mon is not None:
            mon["last_status"] = status
            mon["last_latency"] = latency
            mon["last_checked"] = datetime.now(timezone.utc).isoformat()

    async def append_telemetry(self, node_id: str, entity_key: str, value: Any) -> None:
        buf = self._telemetry.get(entity_key)
        if buf is None:
            buf = deque(maxlen=self._history_maxlen)
            self._telemetry[entity_key] = buf
        buf.appendleft({
            "node_id": node_id,
            "entity_key": entity_key,
            "value": str(value),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def get_telemetry(self, entity_key: str, limit: int = 100) -> List[Dict[str, Any]]:
        buf = self._telemetry.get(entity_key)
        if not buf:
            return []
        return list(buf)[:limit]

    async def list_repeater_targets(self) -> List[Dict[str, Any]]:
        return [dict(v) for v in self._targets.values()]

    async def upsert_repeater_target(self, target: Dict[str, Any]) -> Dict[str, Any]:
        tid = str(target["id"]).strip()
        rec = {
            "id": tid,
            "name": str(target.get("name") or tid).strip(),
            "url": str(target["url"]).strip(),
            "secret": str(target.get("secret") or ""),
            "headers": dict(target.get("headers") or {}),
            "enabled": bool(target.get("enabled", True)),
        }
        self._targets[tid] = rec
        return dict(rec)

    async def delete_repeater_target(self, target_id: str) -> bool:
        return self._targets.pop(target_id, None) is not None


class PostgresRepository(StorageRepository):
    """PostgreSQL-backed repository wrapping an asyncpg pool getter."""

    def __init__(self, pool_getter: Callable[[], Any]):
        self._pool_getter = pool_getter

    def _pool(self):
        return self._pool_getter()

    def is_persistent(self) -> bool:
        return True

    def is_connected(self) -> bool:
        return self._pool() is not None

    async def list_monitors(self) -> List[Dict[str, Any]]:
        pool = self._pool()
        if not pool:
            return []
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT id, name, type, target, check_interval, timeout,
                          last_status, last_latency, last_checked, enabled, category
                   FROM system_monitors ORDER BY id ASC;"""
            )
            res = []
            for r in rows:
                d = dict(r)
                if d.get("last_checked"):
                    d["last_checked"] = d["last_checked"].isoformat()
                res.append(d)
            return res

    async def create_monitor(self, data: Dict[str, Any]) -> Dict[str, Any]:
        pool = self._pool()
        if not pool:
            raise RuntimeError("Database pool unavailable")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, category)
                   VALUES ($1, $2, $3, $4, $5, 'unknown', $6, $7)
                   RETURNING id, name, type, target, check_interval, timeout, last_status, last_latency, last_checked, enabled, category;""",
                str(data["name"]).strip(),
                str(data["type"]).strip(),
                str(data["target"]).strip(),
                int(data.get("check_interval", 30)),
                int(data.get("timeout", 5)),
                bool(data.get("enabled", True)),
                str(data.get("category") or "General"),
            )
            d = dict(row)
            if d.get("last_checked"):
                d["last_checked"] = d["last_checked"].isoformat()
            return d

    async def update_monitor(self, monitor_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        if not pool:
            raise RuntimeError("Database pool unavailable")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """UPDATE system_monitors
                   SET name = $1, type = $2, target = $3, check_interval = $4, timeout = $5,
                       enabled = COALESCE($6, enabled), category = $7
                   WHERE id = $8
                   RETURNING id, name, type, target, check_interval, timeout, last_status, last_latency, last_checked, enabled, category;""",
                str(data["name"]).strip(),
                str(data["type"]).strip(),
                str(data["target"]).strip(),
                int(data.get("check_interval", 30)),
                int(data.get("timeout", 5)),
                data.get("enabled"),
                str(data.get("category") or "General"),
                monitor_id,
            )
            if not row:
                return None
            d = dict(row)
            if d.get("last_checked"):
                d["last_checked"] = d["last_checked"].isoformat()
            return d

    async def delete_monitor(self, monitor_id: int) -> bool:
        pool = self._pool()
        if not pool:
            raise RuntimeError("Database pool unavailable")
        async with pool.acquire() as conn:
            res = await conn.execute("DELETE FROM system_monitors WHERE id = $1;", monitor_id)
            return res.endswith("1")

    async def record_monitor_result(self, monitor_id: int, status: str, latency: float) -> None:
        pool = self._pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE system_monitors
                   SET last_status = $1, last_latency = $2, last_checked = CURRENT_TIMESTAMP
                   WHERE id = $3;""",
                status,
                latency,
                monitor_id,
            )

    async def append_telemetry(self, node_id: str, entity_key: str, value: Any) -> None:
        pool = self._pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                node_id,
                entity_key,
                str(value),
            )

    async def get_telemetry(self, entity_key: str, limit: int = 100) -> List[Dict[str, Any]]:
        pool = self._pool()
        if not pool:
            return []
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT node_id, entity_key, value, timestamp
                   FROM telemetry_logs
                   WHERE entity_key = $1
                   ORDER BY timestamp DESC LIMIT $2;""",
                entity_key,
                limit,
            )
            return [
                {
                    "node_id": r["node_id"],
                    "entity_key": r["entity_key"],
                    "value": r["value"],
                    "timestamp": r["timestamp"].isoformat(),
                }
                for r in rows
            ]

    async def list_repeater_targets(self) -> List[Dict[str, Any]]:
        pool = self._pool()
        if not pool:
            return []
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, name, url, secret, headers, enabled FROM repeater_targets ORDER BY created_at ASC;"
            )
            res = []
            for r in rows:
                hdrs = r["headers"]
                if isinstance(hdrs, str):
                    try:
                        hdrs = json.loads(hdrs)
                    except Exception:
                        hdrs = {}
                res.append({
                    "id": r["id"],
                    "name": r["name"],
                    "url": r["url"],
                    "secret": r["secret"] or "",
                    "headers": hdrs or {},
                    "enabled": bool(r["enabled"]),
                })
            return res

    async def upsert_repeater_target(self, target: Dict[str, Any]) -> Dict[str, Any]:
        pool = self._pool()
        if not pool:
            raise RuntimeError("Database pool unavailable")
        tid = str(target["id"]).strip()
        hdrs_json = json.dumps(target.get("headers") or {})
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO repeater_targets (id, name, url, secret, headers, enabled)
                   VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                   ON CONFLICT (id) DO UPDATE SET
                       name = EXCLUDED.name,
                       url = EXCLUDED.url,
                       secret = EXCLUDED.secret,
                       headers = EXCLUDED.headers,
                       enabled = EXCLUDED.enabled;""",
                tid,
                str(target.get("name") or tid).strip(),
                str(target["url"]).strip(),
                str(target.get("secret") or ""),
                hdrs_json,
                bool(target.get("enabled", True)),
            )
        return {
            "id": tid,
            "name": str(target.get("name") or tid).strip(),
            "url": str(target["url"]).strip(),
            "secret": str(target.get("secret") or ""),
            "headers": dict(target.get("headers") or {}),
            "enabled": bool(target.get("enabled", True)),
        }

    async def delete_repeater_target(self, target_id: str) -> bool:
        pool = self._pool()
        if not pool:
            raise RuntimeError("Database pool unavailable")
        async with pool.acquire() as conn:
            res = await conn.execute("DELETE FROM repeater_targets WHERE id = $1;", target_id)
            return res.endswith("1")
