"""Phase 2 verification suite: Hierarchy DAG, cycle rejection, cascade suppression, HA rebind, and Proxmox cluster sync."""

import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
import types
import unittest
import urllib.error
import urllib.request

from core.alerting import CascadeAlertSuppressor
from core.topology import TopologyCycleError, TopologyGraph, TopologyNotFoundError


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Phase2TopologyUnitTest(unittest.TestCase):
    def _build_lab_graph(self):
        async def _setup():
            g = TopologyGraph(pool_getter=None)
            await g.upsert_node("hv:lab:pve-01", "hypervisor", "PVE-01", health_state="up", liveness_entity_key="pve01-status")
            await g.upsert_node("hv:lab:pve-02", "hypervisor", "PVE-02", health_state="up", liveness_entity_key="pve02-status")
            await g.upsert_node("guest:pve:lab:101", "vm", "vm-101", health_state="up")
            await g.upsert_node("guest:pve:lab:102", "lxc", "lxc-102", health_state="up")
            await g.upsert_node("svc:nginx", "service", "svc-nginx", health_state="up")
            await g.upsert_node("svc:pg", "service", "svc-pg", health_state="up")
            await g.upsert_node("svc:immich", "service", "svc-immich", health_state="up")

            await g.add_edge("hv:lab:pve-01", "guest:pve:lab:101", relation="hosts")
            await g.add_edge("hv:lab:pve-01", "guest:pve:lab:102", relation="hosts")
            await g.add_edge("guest:pve:lab:101", "svc:nginx", relation="runs_on")
            await g.add_edge("guest:pve:lab:101", "svc:pg", relation="runs_on")
            await g.add_edge("guest:pve:lab:102", "svc:immich", relation="runs_on")
            return g

        return asyncio.run(_setup())

    def test_1_dag_cycle_rejection_and_crud(self):
        g = self._build_lab_graph()

        async def _checks():
            with self.assertRaises(TopologyCycleError):
                await g.add_edge("svc:nginx", "hv:lab:pve-01", relation="depends_on")
            with self.assertRaises(TopologyCycleError):
                await g.add_edge("guest:pve:lab:101", "guest:pve:lab:101", relation="depends_on")
            with self.assertRaises(TopologyNotFoundError):
                await g.add_edge("hv:lab:pve-01", "svc:missing", relation="depends_on")

        asyncio.run(_checks())

    def test_2_hypervisor_outage_consolidated_alert_and_child_suppression(self):
        g = self._build_lab_graph()
        sup = CascadeAlertSuppressor(g)

        async def _mark_down():
            await g.upsert_node("hv:lab:pve-01", "hypervisor", "PVE-01", health_state="down", liveness_entity_key="pve01-status")

        asyncio.run(_mark_down())

        parent_decision = sup.evaluate_dispatch("hv:lab:pve-01", is_firing=True)
        self.assertEqual(parent_decision["action"], "emit_consolidated")
        impact = parent_decision["impact"]
        self.assertEqual(impact["impacted_count"], 5)
        for expected in ("vm-101", "lxc-102", "svc-nginx", "svc-pg", "svc-immich"):
            self.assertIn(expected, impact["summary_text"])

        descendants = ("guest:pve:lab:101", "guest:pve:lab:102", "svc:nginx", "svc:pg", "svc:immich")
        for child_uid in descendants:
            d = sup.evaluate_dispatch(child_uid, is_firing=True)
            self.assertEqual(d["action"], "suppress_child")
            self.assertEqual(d["root_cause_uid"], "hv:lab:pve-01")

        # Child recovery while suppressed must also be suppressed (no orphaned recovery noise)
        for child_uid in descendants:
            r = sup.evaluate_dispatch(child_uid, is_firing=False)
            self.assertEqual(r["action"], "suppress_recovery")

    def test_3_live_migration_lease_and_atomic_rebind(self):
        g = self._build_lab_graph()
        sup = CascadeAlertSuppressor(g)

        async def _migrate():
            await g.start_migration("guest:pve:lab:101", to_parent_uid="hv:lab:pve-02", lease_seconds=120)
            d_vm = sup.evaluate_dispatch("guest:pve:lab:101", is_firing=True)
            d_svc = sup.evaluate_dispatch("svc:nginx", is_firing=True)
            self.assertEqual(d_vm["action"], "suppress_migrating")
            self.assertEqual(d_svc["action"], "suppress_migrating")

            ev = await g.rebind_parent("guest:pve:lab:101", "hv:lab:pve-02", relation="hosts", reason="live_migration")
            self.assertEqual(ev["from_parent_uid"], "hv:lab:pve-01")
            self.assertEqual(ev["to_parent_uid"], "hv:lab:pve-02")

            snap = g.snapshot()
            edge_pairs = {(e["parent_uid"], e["child_uid"], e["relation"]) for e in snap["edges"]}
            self.assertNotIn(("hv:lab:pve-01", "guest:pve:lab:101", "hosts"), edge_pairs)
            self.assertIn(("hv:lab:pve-02", "guest:pve:lab:101", "hosts"), edge_pairs)
            # Downstream VM -> Service links preserved intact
            self.assertIn(("guest:pve:lab:101", "svc:nginx", "runs_on"), edge_pairs)
            self.assertIn(("guest:pve:lab:101", "svc:pg", "runs_on"), edge_pairs)
            self.assertEqual(len(snap["recent_migrations"]), 1)

        asyncio.run(_migrate())

    def test_4_ha_failover_detaches_from_failed_hypervisor(self):
        g = self._build_lab_graph()
        sup = CascadeAlertSuppressor(g)

        async def _failover():
            await g.upsert_node("hv:lab:pve-01", "hypervisor", "PVE-01", health_state="down")
            d1 = sup.evaluate_dispatch("svc:nginx", is_firing=True)
            self.assertEqual(d1["action"], "suppress_child")
            self.assertEqual(d1["root_cause_uid"], "hv:lab:pve-01")

            # HA moves vm-101 onto healthy pve-02
            await g.rebind_parent("guest:pve:lab:101", "hv:lab:pve-02", relation="hosts", reason="ha_failover")
            d2 = sup.evaluate_dispatch("svc:nginx", is_firing=True)
            self.assertEqual(d2["action"], "emit_normal")

        asyncio.run(_failover())

    def test_6_proxmox_plugin_cluster_topology_and_ha_migration(self):
        plugin_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "plugins",
            "proxmox-ve-monitor",
            "main.py",
        )
        orig_requests = sys.modules.get("requests")
        if orig_requests is None:
            stub = types.ModuleType("requests")
            stub.exceptions = types.SimpleNamespace(RequestException=Exception)
            stub.get = lambda *a, **kw: None
            stub.post = lambda *a, **kw: None
            sys.modules["requests"] = stub

        try:
            spec = importlib.util.spec_from_file_location("pve_plugin_test", plugin_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod._guest_host_map.clear()

            topo_calls = []
            rebind_calls = []
            mod.send_topology_to_gateway = lambda nodes, edges: topo_calls.append((nodes, edges))
            mod.send_topology_rebind_to_gateway = lambda child_uid, to_parent_uid, reason="live_migration": rebind_calls.append((child_uid, to_parent_uid, reason))

            poll_1 = [
                {"type": "node", "node": "pve-01", "status": "online"},
                {"type": "node", "node": "pve-02", "status": "online"},
                {"type": "qemu", "vmid": 101, "name": "app-vm", "node": "pve-01", "status": "running"},
            ]
            mod.sync_cluster_topology(poll_1)
            self.assertEqual(len(topo_calls), 1)
            self.assertEqual(len(rebind_calls), 0)
            self.assertEqual(mod._guest_host_map["guest:pve:default:101"], "hv:pve:default:pve-01")

            poll_2 = [
                {"type": "node", "node": "pve-01", "status": "offline"},
                {"type": "node", "node": "pve-02", "status": "online"},
                {"type": "qemu", "vmid": 101, "name": "app-vm", "node": "pve-02", "status": "running"},
            ]
            mod.sync_cluster_topology(poll_2)
            self.assertEqual(
                rebind_calls,
                [("guest:pve:default:101", "hv:pve:default:pve-02", "ha_failover")],
            )
            self.assertEqual(mod._guest_host_map["guest:pve:default:101"], "hv:pve:default:pve-02")
        finally:
            if orig_requests is None:
                sys.modules.pop("requests", None)

    def test_7_core_purity_check(self):
        core_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core")
        forbidden_vendors = ("proxmox", "truenas", "plex", "tuya", "unraid")
        for fname in os.listdir(core_dir):
            if fname.endswith(".py"):
                with open(os.path.join(core_dir, fname), "r", encoding="utf-8") as fh:
                    content = fh.read().lower()
                for vendor in forbidden_vendors:
                    self.assertNotIn(vendor, content, f"Vendor '{vendor}' leaked into core/{fname}")


class Phase2HttpIntegrationTest(unittest.TestCase):
    API_KEY = "phase2-api-key-999"

    @classmethod
    def setUpClass(cls):
        cls.app_port = _find_free_port()
        env = os.environ.copy()
        env.update({
            "HOMEPULSE_MODE": "repeater",
            "HOMEPULSE_HEADLESS": "true",
            "ENABLE_LEGACY_DISCOVERY": "false",
            "DATABASE_URL": "",
            "HOMEPULSE_API_KEY": cls.API_KEY,
            "HOMEPULSE_REPEATER_FLUSH_INTERVAL": "60",
        })
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(cls.app_port)],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        cls.base_url = f"http://127.0.0.1:{cls.app_port}"
        deadline = time.time() + 20
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                out = cls.proc.stdout.read() if cls.proc.stdout else ""
                raise RuntimeError(f"uvicorn exited prematurely ({cls.proc.returncode}):\n{out}")
            try:
                with urllib.request.urlopen(f"{cls.base_url}/api/v1/health", timeout=1) as resp:
                    if resp.status == 200:
                        return
            except Exception:
                time.sleep(0.25)
        raise RuntimeError("Timed out waiting for Phase 2 server to start")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "proc", None):
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()

    def _request(self, path: str, method: str = "GET", body=None, headers=None):
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else None
            except Exception:
                parsed = raw
            return err.code, parsed

    def test_5_http_v1_topology_and_plugin_gateway_in_repeater_mode(self):
        auth = {"X-API-Key": self.API_KEY}

        # Plugin pushes initial hypervisor -> vm -> service graph
        st_gw, gw_res = self._request(
            "/api/plugins/gateway/topology",
            method="POST",
            body={
                "plugin_id": "test-hv-plugin",
                "nodes": [
                    {"node_uid": "hv:c1:n1", "node_kind": "hypervisor", "display_name": "HV Node 1", "health_state": "down"},
                    {"node_uid": "hv:c1:n2", "node_kind": "hypervisor", "display_name": "HV Node 2", "health_state": "up"},
                    {"node_uid": "guest:c1:201", "node_kind": "vm", "display_name": "vm-201", "health_state": "up"},
                    {"node_uid": "svc:api", "node_kind": "service", "display_name": "svc-api", "health_state": "up"},
                ],
                "edges": [
                    {"parent_uid": "hv:c1:n1", "child_uid": "guest:c1:201", "relation": "hosts"},
                    {"parent_uid": "guest:c1:201", "child_uid": "svc:api", "relation": "runs_on"},
                ],
            },
        )
        self.assertEqual(st_gw, 200)
        self.assertEqual(gw_res["nodes_saved"], 4)
        self.assertEqual(gw_res["edges_saved"], 2)

        # Cycle attempt via /api/v1/topology/edges must return 409 Conflict
        st_cyc, _ = self._request(
            "/api/v1/topology/edges",
            method="POST",
            headers=auth,
            body={"parent_uid": "svc:api", "child_uid": "hv:c1:n1", "relation": "depends_on"},
        )
        self.assertEqual(st_cyc, 409)

        # Evaluate consolidated parent alert and child suppression over HTTP
        st_p, dec_p = self._request(
            "/api/v1/topology/evaluate-alert",
            method="POST",
            headers=auth,
            body={"target_key": "hv:c1:n1", "is_firing": True},
        )
        self.assertEqual(st_p, 200)
        self.assertEqual(dec_p["action"], "emit_consolidated")
        self.assertEqual(dec_p["impact"]["impacted_count"], 2)

        st_c, dec_c = self._request(
            "/api/v1/topology/evaluate-alert",
            method="POST",
            headers=auth,
            body={"target_key": "svc:api", "is_firing": True},
        )
        self.assertEqual(st_c, 200)
        self.assertEqual(dec_c["action"], "suppress_child")
        self.assertEqual(dec_c["root_cause_uid"], "hv:c1:n1")

        # Rebind guest from dead n1 to healthy n2 via gateway
        st_rb, rb_res = self._request(
            "/api/plugins/gateway/topology/rebind",
            method="POST",
            body={
                "plugin_id": "test-hv-plugin",
                "child_uid": "guest:c1:201",
                "to_parent_uid": "hv:c1:n2",
                "reason": "ha_failover",
            },
        )
        self.assertEqual(st_rb, 200)
        self.assertEqual(rb_res["status"], "rebound")

        # Service is now detached from failed n1 and alerts independently
        st_c2, dec_c2 = self._request(
            "/api/v1/topology/evaluate-alert",
            method="POST",
            headers=auth,
            body={"target_key": "svc:api", "is_firing": True},
        )
        self.assertEqual(st_c2, 200)
        self.assertEqual(dec_c2["action"], "emit_normal")


if __name__ == "__main__":
    unittest.main()
