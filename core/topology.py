"""Typed, cycle-safe Hierarchy Graph (DAG) with DB-optional mirror and HA migration rebinding."""

from collections import deque
from datetime import datetime, timedelta, timezone
import json
import logging
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("homepulse-topology")

VALID_NODE_KINDS = (
    "network_core",
    "host",
    "hypervisor",
    "vm",
    "lxc",
    "container",
    "service",
    "plugin",
)
VALID_HEALTH_STATES = ("up", "degraded", "down", "migrating", "maintenance", "unknown")
VALID_RELATIONS = ("hosts", "runs_on", "depends_on", "uplink_of")
DOWN_ENTITY_VALUES = {
    "OFF",
    "OFFLINE",
    "STOPPED",
    "CRASHED",
    "DOWN",
    "CRITICAL",
    "FAILED",
    "FALSE",
    "0",
    "TIMEOUT",
    "CONN_REFUSED",
    "PING_FAIL",
    "500",
    "502",
    "503",
    "404",
}


class TopologyCycleError(ValueError):
    """Raised when an edge insertion or rebind would introduce a cycle in the DAG."""


class TopologyNotFoundError(KeyError):
    """Raised when a referenced topology node does not exist."""


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


class TopologyGraph:
    """In-memory DAG mirror of infrastructure hierarchy backed optionally by PostgreSQL."""

    def __init__(self, pool_getter: Optional[Callable[[], Any]] = None):
        self._pool_getter = pool_getter
        self._nodes: Dict[str, Dict[str, Any]] = {}
        self._edges: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        self._migrations: Deque[Dict[str, Any]] = deque(maxlen=200)

    def _pool(self):
        return self._pool_getter() if self._pool_getter else None

    async def load_from_db(self) -> None:
        """Hydrate graph mirror from PostgreSQL topology tables and legacy node_dependencies."""
        pool = self._pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                node_rows = await conn.fetch(
                    """SELECT node_uid, node_kind, display_name, external_ref,
                              liveness_entity_key, health_state, migration_lease_until, metadata
                       FROM topology_nodes;"""
                )
                for r in node_rows:
                    ext_ref = r["external_ref"]
                    if isinstance(ext_ref, str):
                        ext_ref = json.loads(ext_ref)
                    meta = r["metadata"]
                    if isinstance(meta, str):
                        meta = json.loads(meta)
                    lease_dt = _parse_iso_dt(r["migration_lease_until"])
                    self._nodes[r["node_uid"]] = {
                        "node_uid": r["node_uid"],
                        "node_kind": r["node_kind"],
                        "display_name": r["display_name"],
                        "external_ref": ext_ref or {},
                        "liveness_entity_key": r["liveness_entity_key"],
                        "health_state": r["health_state"] or "unknown",
                        "migration_lease_until": lease_dt.isoformat() if lease_dt else None,
                        "metadata": meta or {},
                    }

                edge_rows = await conn.fetch(
                    "SELECT parent_uid, child_uid, relation, source, version FROM topology_edges;"
                )
                for r in edge_rows:
                    key = (r["parent_uid"], r["child_uid"], r["relation"])
                    self._edges[key] = {
                        "parent_uid": r["parent_uid"],
                        "child_uid": r["child_uid"],
                        "relation": r["relation"],
                        "source": r["source"],
                        "version": int(r["version"] or 1),
                    }

                mig_rows = await conn.fetch(
                    """SELECT child_uid, from_parent_uid, to_parent_uid, reason, source, migrated_at
                       FROM topology_migration_events
                       ORDER BY id DESC LIMIT 50;"""
                )
                for r in reversed(mig_rows):
                    self._migrations.append({
                        "child_uid": r["child_uid"],
                        "from_parent_uid": r["from_parent_uid"],
                        "to_parent_uid": r["to_parent_uid"],
                        "reason": r["reason"],
                        "source": r["source"],
                        "migrated_at": r["migrated_at"].isoformat() if r["migrated_at"] else None,
                    })

                # Import legacy node_dependencies rows if not already represented
                legacy_rows = await conn.fetch("SELECT parent_target, child_target FROM node_dependencies;")
                for r in legacy_rows:
                    p_uid = r["parent_target"]
                    c_uid = r["child_target"]
                    if p_uid == c_uid:
                        continue
                    if p_uid not in self._nodes:
                        await self.upsert_node(
                            p_uid,
                            self._infer_kind(p_uid),
                            p_uid,
                            liveness_entity_key=self._infer_liveness_key(p_uid),
                        )
                    if c_uid not in self._nodes:
                        await self.upsert_node(
                            c_uid,
                            self._infer_kind(c_uid),
                            c_uid,
                            liveness_entity_key=self._infer_liveness_key(c_uid),
                        )
                    if (p_uid, c_uid, "depends_on") not in self._edges and not self._would_create_cycle(p_uid, c_uid):
                        await self.add_edge(p_uid, c_uid, relation="depends_on", source="legacy_import")
        except Exception as exc:
            logger.error(f"Failed loading topology graph from DB: {exc}")

    @staticmethod
    def _infer_kind(target_key: str) -> str:
        if target_key.startswith("host-"):
            return "host"
        if target_key.startswith("plugin-"):
            return "plugin"
        return "service"

    @staticmethod
    def _infer_liveness_key(target_key: str) -> Optional[str]:
        if target_key.startswith("monitor-"):
            return f"{target_key}-status" if not target_key.endswith("-status") else target_key
        if target_key.startswith("plugin-"):
            return target_key if target_key.endswith("-status") else f"{target_key}-status"
        return None

    async def upsert_node(
        self,
        node_uid: str,
        node_kind: str,
        display_name: str,
        external_ref: Optional[Dict[str, Any]] = None,
        liveness_entity_key: Optional[str] = None,
        health_state: str = "unknown",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        uid = str(node_uid).strip()
        if not uid:
            raise ValueError("node_uid is required")
        kind = str(node_kind or "service").strip().lower()
        if kind not in VALID_NODE_KINDS:
            raise ValueError(f"Invalid node_kind '{kind}'. Must be one of {VALID_NODE_KINDS}")
        state = str(health_state or "unknown").strip().lower()
        if state not in VALID_HEALTH_STATES:
            raise ValueError(f"Invalid health_state '{state}'. Must be one of {VALID_HEALTH_STATES}")

        existing = self._nodes.get(uid, {})
        ext_ref = external_ref if external_ref is not None else existing.get("external_ref", {})
        meta = metadata if metadata is not None else existing.get("metadata", {})
        liveness = liveness_entity_key if liveness_entity_key is not None else existing.get("liveness_entity_key")
        lease_until = existing.get("migration_lease_until") if state == "migrating" else None

        rec = {
            "node_uid": uid,
            "node_kind": kind,
            "display_name": str(display_name or uid).strip(),
            "external_ref": dict(ext_ref),
            "liveness_entity_key": liveness,
            "health_state": state,
            "migration_lease_until": lease_until,
            "metadata": dict(meta),
        }
        self._nodes[uid] = rec

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    lease_dt = _parse_iso_dt(lease_until)
                    await conn.execute(
                        """INSERT INTO topology_nodes (
                               node_uid, node_kind, display_name, external_ref,
                               liveness_entity_key, health_state, migration_lease_until, metadata, updated_at
                           )
                           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, NOW())
                           ON CONFLICT (node_uid) DO UPDATE SET
                               node_kind = EXCLUDED.node_kind,
                               display_name = EXCLUDED.display_name,
                               external_ref = EXCLUDED.external_ref,
                               liveness_entity_key = COALESCE(EXCLUDED.liveness_entity_key, topology_nodes.liveness_entity_key),
                               health_state = EXCLUDED.health_state,
                               migration_lease_until = EXCLUDED.migration_lease_until,
                               metadata = EXCLUDED.metadata,
                               updated_at = NOW();""",
                        uid,
                        kind,
                        rec["display_name"],
                        json.dumps(rec["external_ref"]),
                        rec["liveness_entity_key"],
                        state,
                        lease_dt.replace(tzinfo=None) if lease_dt else None,
                        json.dumps(rec["metadata"]),
                    )
            except Exception as exc:
                logger.error(f"DB upsert_node error for {uid}: {exc}")

        return dict(rec)

    async def delete_node(self, node_uid: str) -> bool:
        uid = str(node_uid).strip()
        existed = self._nodes.pop(uid, None) is not None
        for key in [k for k in self._edges if k[0] == uid or k[1] == uid]:
            self._edges.pop(key, None)

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    res = await conn.execute("DELETE FROM topology_nodes WHERE node_uid = $1;", uid)
                    existed = existed or res.endswith("1")
            except Exception as exc:
                logger.error(f"DB delete_node error for {uid}: {exc}")
        return existed

    def _children_of(self, parent_uid: str) -> List[str]:
        return [k[1] for k in self._edges if k[0] == parent_uid]

    def _parents_of(self, child_uid: str) -> List[str]:
        return [k[0] for k in self._edges if k[1] == child_uid]

    def _would_create_cycle(self, parent_uid: str, child_uid: str) -> bool:
        if parent_uid == child_uid:
            return True
        visited: Set[str] = set()
        stack: List[str] = [child_uid]
        while stack:
            curr = stack.pop()
            if curr == parent_uid:
                return True
            if curr in visited:
                continue
            visited.add(curr)
            stack.extend(self._children_of(curr))
        return False

    async def add_edge(
        self,
        parent_uid: str,
        child_uid: str,
        relation: str = "depends_on",
        source: str = "manual",
    ) -> Dict[str, Any]:
        p_uid = str(parent_uid).strip()
        c_uid = str(child_uid).strip()
        rel = str(relation or "depends_on").strip().lower()
        if rel not in VALID_RELATIONS:
            raise ValueError(f"Invalid relation '{rel}'. Must be one of {VALID_RELATIONS}")
        if p_uid not in self._nodes:
            raise TopologyNotFoundError(f"Parent node '{p_uid}' not found")
        if c_uid not in self._nodes:
            raise TopologyNotFoundError(f"Child node '{c_uid}' not found")
        if self._would_create_cycle(p_uid, c_uid):
            raise TopologyCycleError(f"Adding edge '{p_uid}' -> '{c_uid}' would create a cycle in topology DAG")

        key = (p_uid, c_uid, rel)
        prev = self._edges.get(key)
        version = int(prev["version"]) + 1 if prev else 1
        rec = {
            "parent_uid": p_uid,
            "child_uid": c_uid,
            "relation": rel,
            "source": str(source or "manual"),
            "version": version,
        }
        self._edges[key] = rec

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """INSERT INTO topology_edges (parent_uid, child_uid, relation, source, version, updated_at)
                           VALUES ($1, $2, $3, $4, $5, NOW())
                           ON CONFLICT (parent_uid, child_uid, relation) DO UPDATE SET
                               source = EXCLUDED.source,
                               version = topology_edges.version + 1,
                               updated_at = NOW();""",
                        p_uid,
                        c_uid,
                        rel,
                        rec["source"],
                        version,
                    )
            except Exception as exc:
                logger.error(f"DB add_edge error ({p_uid} -> {c_uid}): {exc}")

        return dict(rec)

    async def delete_edge(self, parent_uid: str, child_uid: str, relation: str = "depends_on") -> bool:
        key = (str(parent_uid).strip(), str(child_uid).strip(), str(relation or "depends_on").strip().lower())
        removed = self._edges.pop(key, None) is not None

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    res = await conn.execute(
                        "DELETE FROM topology_edges WHERE parent_uid = $1 AND child_uid = $2 AND relation = $3;",
                        key[0],
                        key[1],
                        key[2],
                    )
                    removed = removed or res.endswith("1")
            except Exception as exc:
                logger.error(f"DB delete_edge error: {exc}")
        return removed

    async def start_migration(
        self,
        child_uid: str,
        to_parent_uid: Optional[str] = None,
        lease_seconds: int = 120,
        source: str = "manual",
    ) -> Dict[str, Any]:
        c_uid = str(child_uid).strip()
        if c_uid not in self._nodes:
            raise TopologyNotFoundError(f"Child node '{c_uid}' not found")
        if to_parent_uid and to_parent_uid in self._nodes:
            if self._would_create_cycle(to_parent_uid, c_uid):
                raise TopologyCycleError(f"Migration target '{to_parent_uid}' -> '{c_uid}' would create a cycle")

        lease_dt = datetime.now(timezone.utc) + timedelta(seconds=max(1, int(lease_seconds)))
        node = self._nodes[c_uid]
        node["health_state"] = "migrating"
        node["migration_lease_until"] = lease_dt.isoformat()

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """UPDATE topology_nodes
                           SET health_state = 'migrating', migration_lease_until = $1, updated_at = NOW()
                           WHERE node_uid = $2;""",
                        lease_dt.replace(tzinfo=None),
                        c_uid,
                    )
            except Exception as exc:
                logger.error(f"DB start_migration error for {c_uid}: {exc}")

        return dict(node)

    async def rebind_parent(
        self,
        child_uid: str,
        to_parent_uid: str,
        relation: str = "hosts",
        reason: str = "live_migration",
        source: str = "manual",
    ) -> Dict[str, Any]:
        c_uid = str(child_uid).strip()
        p_uid = str(to_parent_uid).strip()
        rel = str(relation or "hosts").strip().lower()

        if c_uid not in self._nodes:
            raise TopologyNotFoundError(f"Child node '{c_uid}' not found")
        if p_uid not in self._nodes:
            raise TopologyNotFoundError(f"Target parent node '{p_uid}' not found")
        if rel not in VALID_RELATIONS:
            raise ValueError(f"Invalid relation '{rel}'")
        if self._would_create_cycle(p_uid, c_uid):
            raise TopologyCycleError(f"Rebinding '{p_uid}' -> '{c_uid}' would create a cycle")

        old_keys = [k for k in self._edges if k[1] == c_uid and k[2] == rel]
        from_parent_uid = old_keys[0][0] if old_keys else None

        for k in old_keys:
            if k[0] != p_uid:
                self._edges.pop(k, None)

        edge_key = (p_uid, c_uid, rel)
        prev_edge = self._edges.get(edge_key)
        version = int(prev_edge["version"]) + 1 if prev_edge else 1
        self._edges[edge_key] = {
            "parent_uid": p_uid,
            "child_uid": c_uid,
            "relation": rel,
            "source": str(source or "manual"),
            "version": version,
        }

        node = self._nodes[c_uid]
        node["migration_lease_until"] = None
        if node.get("health_state") == "migrating":
            node["health_state"] = "up"

        now_dt = datetime.now(timezone.utc)
        event = {
            "child_uid": c_uid,
            "from_parent_uid": from_parent_uid,
            "to_parent_uid": p_uid,
            "reason": str(reason or "live_migration"),
            "source": str(source or "manual"),
            "migrated_at": now_dt.isoformat(),
        }
        self._migrations.append(event)

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.execute(
                            "DELETE FROM topology_edges WHERE child_uid = $1 AND relation = $2 AND parent_uid <> $3;",
                            c_uid,
                            rel,
                            p_uid,
                        )
                        await conn.execute(
                            """INSERT INTO topology_edges (parent_uid, child_uid, relation, source, version, updated_at)
                               VALUES ($1, $2, $3, $4, $5, NOW())
                               ON CONFLICT (parent_uid, child_uid, relation) DO UPDATE SET
                                   source = EXCLUDED.source,
                                   version = topology_edges.version + 1,
                                   updated_at = NOW();""",
                            p_uid,
                            c_uid,
                            rel,
                            str(source or "manual"),
                            version,
                        )
                        await conn.execute(
                            """UPDATE topology_nodes
                               SET migration_lease_until = NULL,
                                   health_state = CASE WHEN health_state = 'migrating' THEN 'up' ELSE health_state END,
                                   updated_at = NOW()
                               WHERE node_uid = $1;""",
                            c_uid,
                        )
                        await conn.execute(
                            """INSERT INTO topology_migration_events (child_uid, from_parent_uid, to_parent_uid, reason, source, migrated_at)
                               VALUES ($1, $2, $3, $4, $5, $6);""",
                            c_uid,
                            from_parent_uid,
                            p_uid,
                            event["reason"],
                            event["source"],
                            now_dt.replace(tzinfo=None),
                        )
            except Exception as exc:
                logger.error(f"DB rebind_parent error ({c_uid} -> {p_uid}): {exc}")

        return event

    def resolve_node_uid(self, target_key: str) -> Optional[str]:
        if not target_key:
            return None
        tk = str(target_key).strip()
        if tk in self._nodes:
            return tk
        candidates = [f"svc:{tk}"]
        if tk.startswith("monitor-"):
            candidates.append(f"svc:monitor:{tk.split('-', 1)[1]}")
        for cand in candidates:
            if cand in self._nodes:
                return cand
        for uid, node in self._nodes.items():
            if node.get("liveness_entity_key") == tk:
                return uid
        return None

    def is_node_down(self, node_uid: str, entity_states: Optional[Dict[str, Any]] = None) -> bool:
        node = self._nodes.get(node_uid)
        if not node:
            return False
        if node.get("health_state") == "down":
            return True
        liveness_key = node.get("liveness_entity_key")
        if liveness_key and entity_states:
            ent = entity_states.get(liveness_key)
            if ent:
                val_str = str(ent.get("value", "")).strip().upper()
                attr_status = str((ent.get("attributes") or {}).get("status", "")).strip().lower()
                if val_str in DOWN_ENTITY_VALUES or attr_status in ("stopped", "crashed", "down", "offline"):
                    return True
        return False

    def is_under_migration_lease(self, node_uid: str, now_dt: Optional[datetime] = None) -> bool:
        now = now_dt or datetime.now(timezone.utc)
        visited: Set[str] = set()
        queue: Deque[str] = deque([node_uid])
        while queue:
            curr = queue.popleft()
            if curr in visited:
                continue
            visited.add(curr)
            node = self._nodes.get(curr)
            if node and node.get("health_state") == "migrating":
                lease_dt = _parse_iso_dt(node.get("migration_lease_until"))
                if lease_dt is not None and lease_dt > now:
                    return True
            for parent_uid in self._parents_of(curr):
                if parent_uid not in visited:
                    queue.append(parent_uid)
        return False

    def get_descendants(self, root_uid: str) -> List[Dict[str, Any]]:
        descendants: List[Dict[str, Any]] = []
        visited: Set[str] = {root_uid}
        queue: Deque[Tuple[str, int]] = deque([(root_uid, 0)])
        while queue:
            curr_uid, depth = queue.popleft()
            for (p_uid, c_uid, rel) in self._edges:
                if p_uid != curr_uid or c_uid in visited:
                    continue
                visited.add(c_uid)
                c_node = self._nodes.get(c_uid)
                if c_node:
                    descendants.append({
                        "node_uid": c_uid,
                        "display_name": c_node["display_name"],
                        "node_kind": c_node["node_kind"],
                        "depth": depth + 1,
                        "relation": rel,
                    })
                queue.append((c_uid, depth + 1))
        return descendants

    def find_down_root_ancestor(
        self,
        node_uid: str,
        entity_states: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Walk upstream and return the farthest (root-most) DOWN ancestor, or None."""
        visited: Set[str] = {node_uid}
        queue: Deque[Tuple[str, int]] = deque([(p, 1) for p in self._parents_of(node_uid)])
        down_ancestors: List[Tuple[int, Dict[str, Any]]] = []

        while queue:
            anc_uid, dist = queue.popleft()
            if anc_uid in visited:
                continue
            visited.add(anc_uid)
            if self.is_node_down(anc_uid, entity_states):
                node = self._nodes.get(anc_uid)
                if node:
                    down_ancestors.append((dist, dict(node)))
            for p_uid in self._parents_of(anc_uid):
                if p_uid not in visited:
                    queue.append((p_uid, dist + 1))

        if not down_ancestors:
            return None
        down_ancestors.sort(key=lambda item: (-item[0], item[1]["node_uid"]))
        return down_ancestors[0][1]

    def build_consolidated_impact_summary(
        self,
        root_uid: str,
        entity_states: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        root_node = self._nodes.get(root_uid, {"node_uid": root_uid, "display_name": root_uid, "node_kind": "node"})
        descendants = self.get_descendants(root_uid)
        by_kind: Dict[str, int] = {}
        for d in descendants:
            kind = d["node_kind"]
            by_kind[kind] = by_kind.get(kind, 0) + 1

        kind_breakdown = ", ".join(f"{cnt} {k}" for k, cnt in sorted(by_kind.items()))
        names_preview = ", ".join(d["display_name"] for d in descendants[:15])
        if len(descendants) > 15:
            names_preview += f", +{len(descendants) - 15} more"

        if descendants:
            summary_text = (
                f"Root Cause: {root_node['display_name']} ({root_node['node_kind']}) is DOWN. "
                f"Downstream Impact ({len(descendants)} suppressed: {kind_breakdown}): {names_preview}"
            )
        else:
            summary_text = f"Root Cause: {root_node['display_name']} ({root_node['node_kind']}) is DOWN."

        return {
            "root_uid": root_uid,
            "root_name": root_node["display_name"],
            "root_kind": root_node["node_kind"],
            "impacted_count": len(descendants),
            "by_kind": by_kind,
            "descendants": descendants,
            "summary_text": summary_text,
        }

    def snapshot(self) -> Dict[str, Any]:
        return {
            "nodes": [dict(self._nodes[k]) for k in sorted(self._nodes.keys())],
            "edges": [dict(self._edges[k]) for k in sorted(self._edges.keys())],
            "recent_migrations": list(self._migrations),
        }
