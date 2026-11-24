"""Unified cascade alert suppressor for both alert rules and automation flows."""

from datetime import datetime
from typing import Any, Dict, Optional

from core.topology import TopologyGraph


class CascadeAlertSuppressor:
    """Suppresses downstream alert storms and consolidates impact onto the root-cause node."""

    def __init__(self, topology_graph: TopologyGraph):
        self.topology = topology_graph
        self._suppressed_children: Dict[str, str] = {}

    def evaluate_dispatch(
        self,
        target_key: str,
        is_firing: bool,
        entity_states: Optional[Dict[str, Any]] = None,
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Determine whether an alert transition should fire, consolidate, or be suppressed."""
        node_uid = self.topology.resolve_node_uid(target_key)
        if node_uid is None:
            return {
                "action": "emit_normal" if is_firing else "emit_recovery",
                "node_uid": None,
            }

        if is_firing:
            if self.topology.is_under_migration_lease(node_uid, now_dt):
                return {
                    "action": "suppress_migrating",
                    "node_uid": node_uid,
                    "reason": "migration_lease_active",
                }

            root_anc = self.topology.find_down_root_ancestor(node_uid, entity_states)
            if root_anc is not None:
                self._suppressed_children[node_uid] = root_anc["node_uid"]
                return {
                    "action": "suppress_child",
                    "node_uid": node_uid,
                    "root_cause_uid": root_anc["node_uid"],
                    "root_cause_name": root_anc["display_name"],
                }

            # Not suppressed under any upstream parent (e.g. root failure or HA-rebound child)
            self._suppressed_children.pop(node_uid, None)
            impact = self.topology.build_consolidated_impact_summary(node_uid, entity_states)
            if impact["impacted_count"] > 0:
                return {
                    "action": "emit_consolidated",
                    "node_uid": node_uid,
                    "impact": impact,
                }
            return {
                "action": "emit_normal",
                "node_uid": node_uid,
                "impact": impact,
            }

        # Recovery transition
        if node_uid in self._suppressed_children:
            root_uid = self._suppressed_children.pop(node_uid)
            return {
                "action": "suppress_recovery",
                "node_uid": node_uid,
                "suppressed_under": root_uid,
            }
        return {
            "action": "emit_recovery",
            "node_uid": node_uid,
        }
