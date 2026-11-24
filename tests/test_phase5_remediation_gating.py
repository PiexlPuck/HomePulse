"""Phase 5 verification suite: Tiered remediation gating, RBAC, approval tokens, TTL expiry, and IPC dispatch."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Phase5RemediationGatingTest(unittest.TestCase):
    API_KEY = "phase5-api-key-333"

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
        raise RuntimeError("Timed out waiting for Phase 5 server to start")

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

    def test_1_tier1_routine_executes_immediately_and_blocks_observer(self):
        obs_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "viewer-1", "X-Actor-Role": "observer"}
        st_obs, _ = self._request(
            "/api/v1/remediation/propose",
            method="POST",
            headers=obs_hdrs,
            body={"action_type": "plugin_restart", "target_plugin_id": "p1", "target_node_uid": "node-1"},
        )
        self.assertEqual(st_obs, 403)

        ctrl_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "ops-1", "X-Actor-Role": "controller"}
        st_ok, res = self._request(
            "/api/v1/remediation/propose",
            method="POST",
            headers=ctrl_hdrs,
            body={"action_type": "plugin_restart", "target_plugin_id": "p1", "target_node_uid": "node-1"},
        )
        self.assertEqual(st_ok, 200)
        self.assertEqual(res["tier"], "tier1_routine")
        self.assertEqual(res["status"], "executed")

        st_aud, audits = self._request("/api/v1/remediation/audits", headers=ctrl_hdrs)
        self.assertEqual(st_aud, 200)
        self.assertTrue(any(a["request_id"] == res["request_id"] for a in audits))

    def test_2_tier2_remote_upgrade_halts_until_architect_approves_and_dispatches_ipc(self):
        import asyncio
        from core.ipc import PluginIPCBroker, PluginTokenRegistry
        from core.remediation import (
            RemediationAuthError,
            RemediationEngine,
            RemediationRBACError,
        )

        reg = PluginTokenRegistry()
        broker = PluginIPCBroker()
        agent_tok = reg.mint_token(
            "update-agent",
            permissions=["ipc:subscribe"],
            subscribes=["core.remediation.approved.update-agent"],
        )
        agent_sess = reg.authenticate(agent_tok)

        engine = RemediationEngine(pool_getter=None, ipc_broker_getter=lambda: broker)

        async def _flow():
            prop = await engine.propose_action(
                action_type="remote_pkg_upgrade",
                target_plugin_id="update-agent",
                target_node_uid="host:linux:node-01",
                parameters={"packages": ["openssl"]},
                requested_by="flow-1",
                requester_role="system_flow",
            )
            self.assertEqual(prop["tier"], "tier2_endpoint")
            self.assertEqual(prop["status"], "pending_approval")
            tok = prop["approval_token"]

            # Zero IPC commands dispatched before explicit architect approval
            self.assertEqual(broker.poll_messages(agent_sess, "core.remediation.approved.update-agent", 0), [])

            # Controller cannot approve gated remediation
            with self.assertRaises(RemediationRBACError):
                await engine.approve_action(prop["request_id"], "ops-1", "controller", tok)

            # Wrong token cannot approve
            with self.assertRaises(RemediationAuthError):
                await engine.approve_action(prop["request_id"], "arch-1", "architect", "hp_apr_wrong")

            # Still zero IPC messages
            self.assertEqual(broker.poll_messages(agent_sess, "core.remediation.approved.update-agent", 0), [])

            # Architect + valid one-time token dispatches certified IPC command
            done = await engine.approve_action(prop["request_id"], "arch-1", "architect", tok)
            self.assertEqual(done["status"], "executed")
            msgs = broker.poll_messages(agent_sess, "core.remediation.approved.update-agent", 0)
            self.assertEqual(len(msgs), 1)
            self.assertEqual(msgs[0]["sender_plugin_id"], "core")
            self.assertEqual(msgs[0]["payload"]["action_type"], "remote_pkg_upgrade")

        asyncio.run(_flow())

    def test_3_tier3_hypervisor_action_rejected_never_executes(self):
        ctrl_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "ops-1", "X-Actor-Role": "controller"}
        arch_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "arch-1", "X-Actor-Role": "architect"}

        st_prop, prop = self._request(
            "/api/v1/remediation/propose",
            method="POST",
            headers=ctrl_hdrs,
            body={
                "action_type": "hypervisor_vm_power",
                "target_plugin_id": "hv-pack",
                "target_node_uid": "guest:pve:lab:101",
                "parameters": {"state": "stop"},
            },
        )
        self.assertEqual(st_prop, 202)
        self.assertEqual(prop["tier"], "tier3_cluster")
        self.assertEqual(prop["status"], "pending_approval")
        rid = prop["request_id"]
        tok = prop["approval_token"]

        st_rej, rej = self._request(
            f"/api/v1/remediation/approvals/{rid}/reject",
            method="POST",
            headers=arch_hdrs,
            body={"reason": "unsafe maintenance window"},
        )
        self.assertEqual(st_rej, 200)
        self.assertEqual(rej["status"], "rejected")

        # Cannot approve an already rejected request -> 409 Conflict
        st_app, _ = self._request(
            f"/api/v1/remediation/approvals/{rid}/approve",
            method="POST",
            headers=arch_hdrs,
            body={"approval_token": tok},
        )
        self.assertEqual(st_app, 409)

    def test_4_expired_approval_token_returns_410_and_never_executes(self):
        arch_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "arch-1", "X-Actor-Role": "architect"}
        st_prop, prop = self._request(
            "/api/v1/remediation/propose",
            method="POST",
            headers=arch_hdrs,
            body={
                "action_type": "cluster_remediation",
                "target_plugin_id": "hv-pack",
                "target_node_uid": "hv:lab:cluster",
                "ttl_seconds": 1,
            },
        )
        self.assertEqual(st_prop, 202)
        time.sleep(1.25)

        st_exp, _ = self._request(
            f"/api/v1/remediation/approvals/{prop['request_id']}/approve",
            method="POST",
            headers=arch_hdrs,
            body={"approval_token": prop["approval_token"]},
        )
        self.assertEqual(st_exp, 410)

        st_list, items = self._request("/api/v1/remediation/approvals?status=expired", headers=arch_hdrs)
        self.assertEqual(st_list, 200)
        self.assertTrue(any(i["request_id"] == prop["request_id"] for i in items))

    def test_5_dry_run_preview_and_gated_entity_control(self):
        obs_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "viewer-1", "X-Actor-Role": "observer"}
        ctrl_hdrs = {"X-API-Key": self.API_KEY, "X-Actor-Id": "ops-1", "X-Actor-Role": "controller"}

        # Dry-run preview works without mutating or gating
        st_dry, dry = self._request(
            "/api/v1/entities/control/hv:lab:101/power",
            method="POST",
            headers=ctrl_hdrs,
            body={"value": "off", "action_type": "hypervisor_vm_power", "target_plugin_id": "hv-pack", "dry_run": True},
        )
        self.assertEqual(st_dry, 200)
        self.assertEqual(dry["status"], "dry_run")
        self.assertTrue(dry["requires_approval"])

        # Observer cannot execute control
        st_obs, _ = self._request(
            "/api/v1/entities/control/core-mon/relay",
            method="POST",
            headers=obs_hdrs,
            body={"value": True, "action_type": "local_control"},
        )
        self.assertEqual(st_obs, 403)

        # Tier-1 local control executes immediately (200)
        st_loc, loc = self._request(
            "/api/v1/entities/control/core-mon/relay",
            method="POST",
            headers=ctrl_hdrs,
            body={"value": True, "action_type": "local_control"},
        )
        self.assertEqual(st_loc, 200)
        self.assertEqual(loc["status"], "executed")

        # Tier-3 hypervisor power control halts at 202 pending_approval
        st_hv, hv = self._request(
            "/api/v1/entities/control/guest:pve:lab:101/power",
            method="POST",
            headers=ctrl_hdrs,
            body={"value": "stop", "action_type": "hypervisor_vm_power", "target_plugin_id": "hv-pack"},
        )
        self.assertEqual(st_hv, 202)
        self.assertEqual(hv["status"], "pending_approval")

    def test_6_flow_canvas_ui_nodes_present(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, "src", "09-flow-canvas.ts"), "r", encoding="utf-8") as fh:
            ts_src = fh.read()
        with open(os.path.join(root, "index.html"), "r", encoding="utf-8") as fh:
            html_src = fh.read()

        for token in ("approval_gate", "remediation_action"):
            self.assertIn(token, ts_src)
            self.assertIn(token, html_src)

    def test_7_core_purity_check(self):
        core_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core")
        forbidden_vendors = ("proxmox", "truenas", "plex", "tuya", "unraid")
        for fname in os.listdir(core_dir):
            if fname.endswith(".py"):
                with open(os.path.join(core_dir, fname), "r", encoding="utf-8") as fh:
                    content = fh.read().lower()
                for vendor in forbidden_vendors:
                    self.assertNotIn(vendor, content, f"Vendor '{vendor}' leaked into core/{fname}")


if __name__ == "__main__":
    unittest.main()
