"""Scoped plugin token registry and ACL-enforced cross-plugin IPC broker."""

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import secrets
from typing import Any, Deque, Dict, Iterable, List, Optional, Set
import uuid


class IPCPermissionError(PermissionError):
    """Raised when a plugin attempts an undeclared IPC or telemetry action."""


@dataclass(frozen=True)
class PluginSession:
    """Authenticated identity and capability envelope for a running plugin."""

    plugin_id: str
    permissions: Set[str]
    publishes: Set[str]
    subscribes: Set[str]
    issued_at: str


class PluginTokenRegistry:
    """Issues and authenticates scoped per-plugin bearer/header tokens."""

    def __init__(self):
        self._tokens_by_hash: Dict[str, PluginSession] = {}
        self._hash_by_plugin: Dict[str, str] = {}

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def mint_token(
        self,
        plugin_id: str,
        permissions: Optional[Iterable[str]] = None,
        publishes: Optional[Iterable[str]] = None,
        subscribes: Optional[Iterable[str]] = None,
    ) -> str:
        """Mint a fresh scoped token for plugin_id, revoking any previous token."""
        pid = str(plugin_id).strip()
        self.revoke_token(pid)
        raw_token = "hp_plug_" + secrets.token_hex(20)
        digest = self._hash_token(raw_token)
        session = PluginSession(
            plugin_id=pid,
            permissions=set(permissions or ()),
            publishes=set(publishes or ()),
            subscribes=set(subscribes or ()),
            issued_at=datetime.now(timezone.utc).isoformat(),
        )
        self._tokens_by_hash[digest] = session
        self._hash_by_plugin[pid] = digest
        return raw_token

    def revoke_token(self, plugin_id: str) -> None:
        pid = str(plugin_id).strip()
        old_hash = self._hash_by_plugin.pop(pid, None)
        if old_hash:
            self._tokens_by_hash.pop(old_hash, None)

    def has_active_token(self, plugin_id: str) -> bool:
        return str(plugin_id).strip() in self._hash_by_plugin

    def authenticate(self, token: Optional[str]) -> Optional[PluginSession]:
        if not token or not isinstance(token, str):
            return None
        candidate_hash = self._hash_token(token.strip())
        for stored_hash, session in self._tokens_by_hash.items():
            if hmac.compare_digest(candidate_hash, stored_hash):
                return session
        return None


class PluginIPCBroker:
    """Topic-scoped message broker mediating cross-plugin and core-to-plugin IPC."""

    def __init__(self, max_per_topic: int = 200):
        self._max_per_topic = max(10, int(max_per_topic))
        self._topics: Dict[str, Deque[Dict[str, Any]]] = {}
        self._seq: int = 0

    @staticmethod
    def _topic_allowed(topic: str, patterns: Set[str]) -> bool:
        if not topic:
            return False
        for pat in patterns:
            if pat == "*" or pat == topic:
                return True
            if pat.endswith(".*") and topic.startswith(pat[:-1]):
                return True
        return False

    def _append_message(self, topic: str, sender_plugin_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._seq += 1
        msg = {
            "seq": self._seq,
            "message_id": str(uuid.uuid4()),
            "topic": topic,
            "sender_plugin_id": sender_plugin_id,
            "published_at": datetime.now(timezone.utc).isoformat(),
            "payload": dict(payload or {}),
        }
        buf = self._topics.get(topic)
        if buf is None:
            buf = deque(maxlen=self._max_per_topic)
            self._topics[topic] = buf
        buf.append(msg)
        return dict(msg)

    def publish(self, session: PluginSession, topic: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Publish an IPC message under the authenticated plugin's non-spoofable identity."""
        clean_topic = str(topic or "").strip()
        if "ipc:publish" not in session.permissions:
            raise IPCPermissionError(f"Plugin '{session.plugin_id}' lacks 'ipc:publish' permission")
        if not self._topic_allowed(clean_topic, session.publishes):
            raise IPCPermissionError(
                f"Plugin '{session.plugin_id}' is not authorized to publish to topic '{clean_topic}'"
            )
        return self._append_message(clean_topic, session.plugin_id, payload)

    def poll_messages(self, session: PluginSession, topic: str, since_seq: int = 0) -> List[Dict[str, Any]]:
        """Poll messages for a subscribed topic newer than since_seq."""
        clean_topic = str(topic or "").strip()
        if "ipc:subscribe" not in session.permissions:
            raise IPCPermissionError(f"Plugin '{session.plugin_id}' lacks 'ipc:subscribe' permission")
        if not self._topic_allowed(clean_topic, session.subscribes):
            raise IPCPermissionError(
                f"Plugin '{session.plugin_id}' is not authorized to subscribe to topic '{clean_topic}'"
            )
        buf = self._topics.get(clean_topic)
        if not buf:
            return []
        return [dict(m) for m in buf if m["seq"] > since_seq]

    def publish_system(self, topic: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Publish a core-originated IPC message."""
        return self._append_message(str(topic or "").strip(), "core", payload)
