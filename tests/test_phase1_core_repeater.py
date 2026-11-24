"""Phase 1 verification suite: headless/repeater mode, v1 auth/API, HMAC batching, WS stream, and core purity."""

import asyncio
from http.server import BaseHTTPRequestHandler, HTTPServer
import hashlib
import hmac
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

import websockets


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _MockRepeaterReceiver:
    def __init__(self, port: int):
        self.port = port
        self.status_code = 200
        self.received = []
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length)
                hdrs = {k.lower(): v for k, v in self.headers.items()}
                parent.received.append({
                    "path": self.path,
                    "headers": hdrs,
                    "raw_body": raw_body,
                    "json": json.loads(raw_body.decode("utf-8")),
                })
                self.send_response(parent.status_code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, format, *args):
                return

        self._server = HTTPServer(("127.0.0.1", port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()


class Phase1CoreRepeaterTest(unittest.TestCase):
    API_KEY = "test-api-key-123"
    HMAC_SECRET = "hmac-secret-xyz"

    @classmethod
    def setUpClass(cls):
        cls.mock_port = _find_free_port()
        cls.app_port = _find_free_port()
        cls.receiver = _MockRepeaterReceiver(cls.mock_port)
        cls.receiver.start()

        cls.probes_file = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
        cls.probes_file.write(
            "probes:\n"
            "  - id: 101\n"
            "    name: YAML Loopback Probe\n"
            "    type: port\n"
            f"    target: 127.0.0.1:{cls.mock_port}\n"
            "    check_interval: 30\n"
            "    timeout: 2\n"
            "    enabled: true\n"
        )
        cls.probes_file.close()

        env = os.environ.copy()
        env.update({
            "HOMEPULSE_MODE": "repeater",
            "HOMEPULSE_HEADLESS": "true",
            "ENABLE_LEGACY_DISCOVERY": "false",
            "DATABASE_URL": "",
            "HOMEPULSE_API_KEY": cls.API_KEY,
            "HOMEPULSE_PROBES_CONFIG": cls.probes_file.name,
            "HOMEPULSE_REPEATER_ID": "test-repeater-01",
            "HOMEPULSE_REPEATER_URL": f"http://127.0.0.1:{cls.mock_port}/ingest",
            "HOMEPULSE_REPEATER_SECRET": cls.HMAC_SECRET,
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
        raise RuntimeError("Timed out waiting for HomePulse repeater server to start")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "proc", None):
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
        if getattr(cls, "receiver", None):
            cls.receiver.stop()
        if getattr(cls, "probes_file", None) and os.path.exists(cls.probes_file.name):
            os.unlink(cls.probes_file.name)

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

    def test_1_headless_repeater_boot_and_health(self):
        status, body = self._request("/api/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "healthy")
        self.assertEqual(body["mode"], "repeater")
        self.assertTrue(body["headless"])
        self.assertEqual(body["storage"], "disabled")

        legacy_status, legacy_body = self._request("/api/health")
        self.assertEqual(legacy_status, 200)
        self.assertEqual(legacy_body["database"], "disabled")

        root_status, root_body = self._request("/")
        self.assertEqual(root_status, 200)
        self.assertTrue(root_body["headless"])

        js_status, _ = self._request("/app.js")
        self.assertEqual(js_status, 404)
        css_status, _ = self._request("/style.css")
        self.assertEqual(css_status, 404)

    def test_2_v1_auth_enforcement(self):
        for path in ("/api/v1/telemetry/snapshot", "/api/v1/probes"):
            s_no, _ = self._request(path)
            self.assertEqual(s_no, 401)
            s_bad, _ = self._request(path, headers={"X-API-Key": "wrong-key"})
            self.assertEqual(s_bad, 401)
            s_hdr, _ = self._request(path, headers={"X-API-Key": self.API_KEY})
            self.assertEqual(s_hdr, 200)
            s_bearer, _ = self._request(path, headers={"Authorization": f"Bearer {self.API_KEY}"})
            self.assertEqual(s_bearer, 200)

    def test_3_dbless_probe_crud_and_pure_snapshot(self):
        auth = {"X-API-Key": self.API_KEY}
        status, probes = self._request("/api/v1/probes", headers=auth)
        self.assertEqual(status, 200)
        names = [p["name"] for p in probes]
        self.assertIn("YAML Loopback Probe", names)

        st_c, created = self._request(
            "/api/v1/probes",
            method="POST",
            headers=auth,
            body={"name": "Dynamic DNS Probe", "type": "dns", "target": "localhost", "check_interval": 15, "timeout": 3},
        )
        self.assertEqual(st_c, 200)
        pid = created["probe"]["id"]

        st_u, updated = self._request(
            f"/api/v1/probes/{pid}",
            method="PUT",
            headers=auth,
            body={"name": "Updated DNS Probe", "type": "dns", "target": "localhost", "check_interval": 20, "timeout": 3},
        )
        self.assertEqual(st_u, 200)
        self.assertEqual(updated["probe"]["name"], "Updated DNS Probe")

        st_snap, snap = self._request("/api/v1/telemetry/snapshot", headers=auth)
        self.assertEqual(st_snap, 200)
        self.assertIn(f"monitor-{pid}-status", snap)
        for ent in snap.values():
            for ui_key in ("icon", "color", "graphic", "tags"):
                self.assertNotIn(ui_key, ent)

        st_d, _ = self._request(f"/api/v1/probes/{pid}", method="DELETE", headers=auth)
        self.assertEqual(st_d, 200)

    def test_4_plugin_gateway_forwards_without_db_and_validates_hmac(self):
        self.receiver.received.clear()
        self.receiver.status_code = 200

        st_gw, _ = self._request(
            "/api/plugins/gateway/state",
            method="POST",
            body={
                "node_id": "test-plugin",
                "entity_key": "test-metric",
                "name": "Test Metric",
                "type": "sensor",
                "value": 42.5,
                "value_type": "float",
            },
        )
        self.assertEqual(st_gw, 200)

        st_fl, flush_res = self._request(
            "/api/v1/repeater/flush",
            method="POST",
            headers={"X-API-Key": self.API_KEY},
        )
        self.assertEqual(st_fl, 200)
        self.assertEqual(flush_res["status"], "delivered")
        self.assertGreaterEqual(flush_res["flushed"], 1)
        self.assertGreaterEqual(len(self.receiver.received), 1)

        msg = self.receiver.received[-1]
        self.assertEqual(msg["json"]["schema_version"], "homepulse.repeater.v1")
        self.assertEqual(msg["json"]["repeater_id"], "test-repeater-01")
        entity_keys = [e["entity_key"] for e in msg["json"]["events"]]
        self.assertIn("test-metric", entity_keys)

        ts = msg["headers"]["x-homepulse-timestamp"]
        sig = msg["headers"]["x-homepulse-signature"]
        expected = "sha256=" + hmac.new(
            self.HMAC_SECRET.encode("utf-8"),
            f"{ts}.".encode("utf-8") + msg["raw_body"],
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(sig, expected)

    def test_5_repeater_retry_backoff_on_outage(self):
        auth = {"X-API-Key": self.API_KEY}
        # Drain anything queued first
        self.receiver.status_code = 200
        self._request("/api/v1/repeater/flush", method="POST", headers=auth)
        self.receiver.received.clear()

        # Simulate upstream 500 outage
        self.receiver.status_code = 500
        self._request(
            "/api/plugins/gateway/state",
            method="POST",
            body={
                "node_id": "test-plugin",
                "entity_key": "buffered-metric",
                "name": "Buffered Metric",
                "type": "sensor",
                "value": 99.1,
                "value_type": "float",
            },
        )
        st_err, err_res = self._request("/api/v1/repeater/flush", method="POST", headers=auth)
        self.assertEqual(st_err, 200)
        self.assertEqual(err_res["status"], "error")
        self.assertGreaterEqual(err_res["queue_depth"], 1)

        _, rep_status = self._request("/api/v1/repeater/status", headers=auth)
        self.assertGreaterEqual(rep_status["failed_batches"], 1)
        self.assertGreaterEqual(rep_status["queue_depth"], 1)

        # Recover upstream and verify buffered event delivers
        self.receiver.status_code = 200
        st_ok, ok_res = self._request("/api/v1/repeater/flush", method="POST", headers=auth)
        self.assertEqual(st_ok, 200)
        self.assertEqual(ok_res["status"], "delivered")
        self.assertEqual(ok_res["queue_depth"], 0)
        delivered_keys = [e["entity_key"] for rec in self.receiver.received for e in rec["json"]["events"]]
        self.assertIn("buffered-metric", delivered_keys)

    def test_6_v1_ws_stream_auth_and_sequence(self):
        async def _run_ws():
            unauth_url = f"ws://127.0.0.1:{self.app_port}/api/v1/ws/stream"
            with self.assertRaises(Exception):
                async with websockets.connect(unauth_url) as ws:
                    await ws.recv()

            auth_url = f"ws://127.0.0.1:{self.app_port}/api/v1/ws/stream?api_key={self.API_KEY}"
            async with websockets.connect(auth_url) as ws:
                await ws.send(json.dumps({"action": "subscribe", "streams": ["telemetry"]}))
                seqs = []
                for _ in range(3):
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    msg = json.loads(raw)
                    self.assertEqual(msg["stream"], "telemetry")
                    seqs.append(msg["seq"])
                self.assertEqual(seqs, sorted(seqs))
                self.assertEqual(len(seqs), len(set(seqs)))

        asyncio.run(_run_ws())

    def test_7_parked_mdns_and_core_purity(self):
        auth = {"X-API-Key": self.API_KEY}
        st_q, _ = self._request("/api/discovery/queue", headers=auth)
        self.assertEqual(st_q, 501)
        st_a, _ = self._request(
            "/api/discovery/approve/test-node",
            method="POST",
            headers=auth,
            body={"preshared_key": "device_pin_12345"},
        )
        self.assertEqual(st_a, 501)

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
