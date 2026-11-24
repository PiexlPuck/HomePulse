"""Batched, HMAC-signed repeater forwarder with bounded retry spool."""

import asyncio
from collections import deque
from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import time
from typing import Any, Callable, Deque, Dict, List, Optional
import urllib.error
import urllib.request
import uuid

logger = logging.getLogger("homepulse-repeater")


class RepeaterEngine:
    """Buffers telemetry events and ships signed batches to configured upstream receivers."""

    def __init__(
        self,
        repeater_id: str,
        storage_repo_getter: Callable[[], Any],
        legacy_settings_getter: Optional[Callable[[], Dict[str, Any]]] = None,
        env_url: str = "",
        env_secret: str = "",
        batch_size: int = 25,
        flush_interval: float = 2.0,
        max_queue: int = 1000,
    ):
        self.repeater_id = repeater_id
        self._storage_repo_getter = storage_repo_getter
        self._legacy_settings_getter = legacy_settings_getter
        self._env_url = env_url.strip()
        self._env_secret = env_secret
        self.batch_size = max(1, batch_size)
        self.flush_interval = max(0.1, flush_interval)
        self.max_queue = max(10, max_queue)

        self._queue: Deque[Dict[str, Any]] = deque()
        self._flush_lock = asyncio.Lock()
        self._batch_seq: int = 0
        self._sent_batches: int = 0
        self._failed_batches: int = 0
        self._dropped_events: int = 0
        self._last_error: Optional[str] = None
        self._backoff_seconds: float = 0.0

    def enqueue(
        self,
        event_type: str,
        source: str,
        node_uid: str,
        entity_key: str,
        value: Any,
        value_type: str = "string",
        unit: str = "",
        status: str = "unknown",
        observed_at: Optional[str] = None,
    ) -> None:
        """Append a telemetry event to the bounded outbound queue."""
        if len(self._queue) >= self.max_queue:
            self._queue.popleft()
            self._dropped_events += 1

        self._queue.append({
            "event_id": str(uuid.uuid4()),
            "type": event_type,
            "source": source,
            "node_uid": node_uid,
            "entity_key": entity_key,
            "value": value,
            "value_type": value_type,
            "unit": unit,
            "status": status,
            "observed_at": observed_at or datetime.now(timezone.utc).isoformat(),
        })

    @staticmethod
    def sign_payload(secret: str, timestamp_ms: str, raw_body: bytes) -> str:
        """Compute HMAC-SHA256 signature header value over '<timestamp_ms>.<raw_body>'."""
        mac = hmac.new(
            secret.encode("utf-8"),
            f"{timestamp_ms}.".encode("utf-8") + raw_body,
            hashlib.sha256,
        ).hexdigest()
        return f"sha256={mac}"

    async def _resolve_targets(self) -> List[Dict[str, Any]]:
        targets: List[Dict[str, Any]] = []
        seen = set()

        repo = self._storage_repo_getter() if self._storage_repo_getter else None
        if repo is not None:
            try:
                for t in await repo.list_repeater_targets():
                    if not t.get("enabled", True) or not t.get("url"):
                        continue
                    key = (t.get("id", ""), t["url"])
                    if key not in seen:
                        seen.add(key)
                        targets.append(t)
            except Exception as exc:
                logger.warning(f"Failed listing repeater targets from repository: {exc}")

        if self._env_url:
            key = ("env-default", self._env_url)
            if key not in seen:
                seen.add(key)
                targets.append({
                    "id": "env-default",
                    "name": "Environment Repeater",
                    "url": self._env_url,
                    "secret": self._env_secret,
                    "headers": {},
                    "enabled": True,
                })

        if self._legacy_settings_getter is not None:
            settings = self._legacy_settings_getter() or {}
            if settings.get("gateway_mode") == "true" and settings.get("gateway_webhook_url"):
                gw_url = str(settings["gateway_webhook_url"]).strip()
                hdrs: Dict[str, Any] = {}
                raw_hdrs = settings.get("gateway_webhook_headers", "")
                if raw_hdrs:
                    try:
                        hdrs = json.loads(raw_hdrs)
                    except Exception:
                        hdrs = {}
                key = ("legacy-gateway", gw_url)
                if gw_url and key not in seen:
                    seen.add(key)
                    targets.append({
                        "id": "legacy-gateway",
                        "name": "Legacy Gateway Webhook",
                        "url": gw_url,
                        "secret": "",
                        "headers": hdrs if isinstance(hdrs, dict) else {},
                        "enabled": True,
                    })

        return targets

    def _post_batch_sync(self, target: Dict[str, Any], raw_body: bytes, batch_id: str, timestamp_ms: str) -> None:
        headers = {
            "Content-Type": "application/json",
            "X-HomePulse-Batch-Id": batch_id,
            "X-HomePulse-Timestamp": timestamp_ms,
        }
        for k, v in (target.get("headers") or {}).items():
            headers[str(k)] = str(v)

        secret = target.get("secret") or ""
        if secret:
            headers["X-HomePulse-Signature"] = self.sign_payload(secret, timestamp_ms, raw_body)

        req = urllib.request.Request(
            target["url"],
            data=raw_body,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            status_code = resp.getcode()
            resp.read()
            if status_code >= 400:
                raise RuntimeError(f"Upstream returned HTTP {status_code}")

    async def flush_once(self) -> Dict[str, Any]:
        """Pop up to batch_size events and deliver them to all enabled targets."""
        async with self._flush_lock:
            if not self._queue:
                return {"flushed": 0, "status": "empty", "queue_depth": 0}

            targets = await self._resolve_targets()
            if not targets:
                return {"flushed": 0, "status": "no_targets", "queue_depth": len(self._queue)}

            batch: List[Dict[str, Any]] = []
            while self._queue and len(batch) < self.batch_size:
                batch.append(self._queue.popleft())

            self._batch_seq += 1
            batch_id = str(uuid.uuid4())
            timestamp_ms = str(int(time.time() * 1000))
            envelope = {
                "schema_version": "homepulse.repeater.v1",
                "repeater_id": self.repeater_id,
                "batch_seq": self._batch_seq,
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "events": batch,
            }
            raw_body = json.dumps(envelope).encode("utf-8")

            delivery_error: Optional[str] = None
            for target in targets:
                try:
                    await asyncio.to_thread(self._post_batch_sync, target, raw_body, batch_id, timestamp_ms)
                except Exception as exc:
                    delivery_error = f"{target.get('id', target['url'])}: {exc}"
                    logger.warning(f"Repeater batch {self._batch_seq} delivery failed -> {delivery_error}")
                    break

            if delivery_error is not None:
                # Re-queue unsent events at the front while obeying max_queue
                for item in reversed(batch):
                    if len(self._queue) >= self.max_queue:
                        self._queue.pop()
                        self._dropped_events += 1
                    self._queue.appendleft(item)
                self._failed_batches += 1
                self._last_error = delivery_error
                self._backoff_seconds = 1.0 if self._backoff_seconds <= 0 else min(30.0, self._backoff_seconds * 2.0)
                return {
                    "flushed": 0,
                    "status": "error",
                    "error": delivery_error,
                    "queue_depth": len(self._queue),
                    "backoff_seconds": self._backoff_seconds,
                }

            self._sent_batches += 1
            self._last_error = None
            self._backoff_seconds = 0.0
            return {
                "flushed": len(batch),
                "status": "delivered",
                "batch_seq": self._batch_seq,
                "targets": len(targets),
                "queue_depth": len(self._queue),
            }

    async def run_loop(self) -> None:
        """Background flush loop obeying flush_interval and failure backoff."""
        logger.info(f"Starting RepeaterEngine loop (id={self.repeater_id}, interval={self.flush_interval}s)")
        while True:
            try:
                delay = self._backoff_seconds if self._backoff_seconds > 0 else self.flush_interval
                await asyncio.sleep(delay)
                await self.flush_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error(f"RepeaterEngine loop exception: {exc}")
                await asyncio.sleep(self.flush_interval)

    def get_status(self) -> Dict[str, Any]:
        """Return live repeater diagnostics."""
        return {
            "repeater_id": self.repeater_id,
            "queue_depth": len(self._queue),
            "sent_batches": self._sent_batches,
            "failed_batches": self._failed_batches,
            "dropped_events": self._dropped_events,
            "last_error": self._last_error,
            "backoff_seconds": self._backoff_seconds,
        }
