"""Phase 4 verification suite: Encrypted push daemon, anti-replay, Pushover Priority 2 & receipt polling."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
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


def _load_daemon_module():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "agents",
        "hp-update-daemon",
        "daemon.py",
    )
    spec = importlib.util.spec_from_file_location("hp_update_daemon", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _MockPushoverServer:
    def __init__(self, port: int):
        self.port = port
        self.sent_messages = []
        self.acknowledged = 1
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                data = json.loads(raw.decode("utf-8"))
                parent.sent_messages.append(data)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": 1, "receipt": "rcpt_test_123"}).encode("utf-8"))

            def do_GET(self):
                if "/receipts/rcpt_test_123.json" in self.path:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps({
                            "status": 1,
                            "acknowledged": parent.acknowledged,
                            "acknowledged_at": 1700000000 if parent.acknowledged else 0,
                            "expired": 0,
                        }).encode("utf-8")
                    )
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, format, *args):
                return

        self._server = HTTPServer(("127.0.0.1", port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()


class Phase4DaemonPushoverTest(unittest.TestCase):
    API_KEY = "phase4-api-key-555"

    @classmethod
    def setUpClass(cls):
        cls.pushover_port = _find_free_port()
        cls.app_port = _find_free_port()
        cls.mock_pushover = _MockPushoverServer(cls.pushover_port)
        cls.mock_pushover.start()
        cls.daemon_mod = _load_daemon_module()

        env = os.environ.copy()
        env.update({
            "HOMEPULSE_MODE": "repeater",
            "HOMEPULSE_HEADLESS": "true",
            "ENABLE_LEGACY_DISCOVERY": "false",
            "DATABASE_URL": "",
            "HOMEPULSE_API_KEY": cls.API_KEY,
            "HOMEPULSE_REPEATER_FLUSH_INTERVAL": "60",
            "HOMEPULSE_PUSHOVER_API_URL": f"http://127.0.0.1:{cls.pushover_port}/1",
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
        raise RuntimeError("Timed out waiting for Phase 4 server to start")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "proc", None):
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
        if getattr(cls, "mock_pushover", None):
            cls.mock_pushover.stop()

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

    def _enroll_and_setup_pushover(self, agent_id="host:linux:node-01"):
        auth = {"X-API-Key": self.API_KEY}
        priv, pub_b64 = self.daemon_mod.generate_ed25519_keypair()
        st, enrolled = self._request(
            "/api/v1/daemon/enroll",
            method="POST",
            headers=auth,
            body={
                "agent_id": agent_id,
                "hostname": "node-01.lan",
                "ed25519_public_key_b64": pub_b64,
            },
        )
        self.assertEqual(st, 200, enrolled)

        st_po, _ = self._request(
            "/api/v1/alerts/pushover/channels",
            method="POST",
            headers=auth,
            body={
                "name": "SOC Emergency",
                "user_key": "u-test-key",
                "api_token": "a-test-token",
                "retry": 60,
                "expire": 3600,
                "sound": "siren",
            },
        )
        self.assertEqual(st_po, 200)
        return priv, enrolled["kid"], enrolled["aes_key_b64"]

    def test_1_agent_enrollment_and_encrypted_push_daemon_e2e(self):
        self.mock_pushover.sent_messages.clear()
        agent_id = "host:linux:node-e2e"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)

        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-01.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "ttl_seconds": 3600,
            "os": {"distro": "debian", "version": "12", "kernel": "6.8.12", "reboot_required": True},
            "packages": {
                "manager": "apt",
                "upgradable_total": 5,
                "security_updates": 2,
                "pending": [
                    {"name": "openssl", "current": "3.0.15-1", "candidate": "3.0.15-2", "is_security": True}
                ],
            },
            "cves": [
                {
                    "cve_id": "CVE-2026-99999",
                    "package": "openssl",
                    "cvss_v3": 9.8,
                    "severity": "critical",
                    "cisa_kev": True,
                }
            ],
        }
        envelope, headers = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, priv, inner)
        st, resp = self.daemon_mod.push_envelope(self.base_url, envelope, headers)
        self.assertEqual(st, 200, resp)
        self.assertEqual(resp["status"], "ingested")
        self.assertEqual(resp["critical_cve_count"], 1)
        self.assertTrue(resp["escalated"])

        # Verify mock Pushover received Priority 2 emergency alert
        self.assertEqual(len(self.mock_pushover.sent_messages), 1)
        po_msg = self.mock_pushover.sent_messages[0]
        self.assertEqual(po_msg["priority"], 2)
        self.assertEqual(po_msg["retry"], 60)
        self.assertEqual(po_msg["expire"], 3600)
        self.assertIn("CVE-2026-99999", po_msg["message"])

        # Verify posture and pure telemetry snapshot
        auth = {"X-API-Key": self.API_KEY}
        st_pos, posture = self._request("/api/v1/daemon/posture", headers=auth)
        self.assertEqual(st_pos, 200)
        self.assertIn(agent_id, posture)
        self.assertEqual(posture[agent_id]["critical_cve_count"], 1)

        st_snap, snap = self._request(f"/api/v1/telemetry/snapshot?node_id={agent_id}", headers=auth)
        self.assertEqual(st_snap, 200)
        self.assertEqual(snap[f"daemon-{agent_id}-critical-cves"]["value"], 1)

    def test_2_anti_replay_nonce_rejection(self):
        agent_id = "host:linux:node-replay"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)
        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-replay.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "os": {"distro": "debian", "version": "12", "reboot_required": False},
            "packages": {"manager": "apt", "upgradable_total": 0, "security_updates": 0, "pending": []},
            "cves": [],
        }
        envelope, headers = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, priv, inner)
        st1, _ = self.daemon_mod.push_envelope(self.base_url, envelope, headers)
        self.assertEqual(st1, 200)
        st2, _ = self.daemon_mod.push_envelope(self.base_url, envelope, headers)
        self.assertEqual(st2, 409)

    def test_3_tampered_ciphertext_and_bad_signature_rejected(self):
        agent_id = "host:linux:node-tamper"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)
        evil_priv, _ = self.daemon_mod.generate_ed25519_keypair()
        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-tamper.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "os": {"distro": "debian", "version": "12", "reboot_required": False},
            "packages": {"manager": "apt", "upgradable_total": 1, "security_updates": 0, "pending": []},
            "cves": [],
        }
        # Bad signature (signed by wrong Ed25519 key)
        env_bad_sig, hdr_bad_sig = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, evil_priv, inner)
        st_sig, _ = self.daemon_mod.push_envelope(self.base_url, env_bad_sig, hdr_bad_sig)
        self.assertEqual(st_sig, 401)

        # Valid signature? No: tamper ciphertext with valid signature over tampered bytes -> AES-GCM tag fails -> 401
        env_ok, hdr_ok = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, priv, inner)
        env_ok["ciphertext"] = "AAAA" + env_ok["ciphertext"][4:]
        st_ct, _ = self.daemon_mod.push_envelope(self.base_url, env_ok, hdr_ok)
        self.assertEqual(st_ct, 401)

    def test_4_stale_timestamp_skew_rejected(self):
        agent_id = "host:linux:node-skew"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)
        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-skew.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "os": {"distro": "debian", "version": "12", "reboot_required": False},
            "packages": {"manager": "apt", "upgradable_total": 0, "security_updates": 0, "pending": []},
            "cves": [],
        }
        stale_ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        env_stale, hdr_stale = self.daemon_mod.build_encrypted_envelope(
            agent_id, kid, aes_key_b64, priv, inner, timestamp=stale_ts
        )
        st, _ = self.daemon_mod.push_envelope(self.base_url, env_stale, hdr_stale)
        self.assertEqual(st, 401)

    def test_5_pushover_receipt_tracking_and_ack_polling(self):
        auth = {"X-API-Key": self.API_KEY}
        # Ensure receipt exists from test_1 (or create one if tests run out of order)
        agent_id = "host:linux:node-receipt"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)
        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-receipt.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "os": {"distro": "debian", "version": "12", "reboot_required": False},
            "packages": {"manager": "apt", "upgradable_total": 1, "security_updates": 1, "pending": []},
            "cves": [{"cve_id": "CVE-2026-10001", "package": "curl", "cvss_v3": 9.1, "severity": "critical", "cisa_kev": False}],
        }
        env, hdrs = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, priv, inner)
        st, _ = self.daemon_mod.push_envelope(self.base_url, env, hdrs)
        self.assertEqual(st, 200)

        st_list, receipts = self._request("/api/v1/alerts/pushover/receipts", headers=auth)
        self.assertEqual(st_list, 200)
        self.assertTrue(any(r["receipt_id"] == "rcpt_test_123" for r in receipts))

        st_poll, polled = self._request("/api/v1/alerts/pushover/receipts/rcpt_test_123/poll", method="POST", headers=auth)
        self.assertEqual(st_poll, 200)
        self.assertTrue(polled["acknowledged"])
        self.assertEqual(polled["status"], "acknowledged")

    def test_6_non_critical_updates_do_not_trigger_emergency_pushover(self):
        agent_id = "host:linux:node-low"
        priv, kid, aes_key_b64 = self._enroll_and_setup_pushover(agent_id)
        before_count = len(self.mock_pushover.sent_messages)

        inner = {
            "schema_version": "daemon.update_cve.v1",
            "host_uid": agent_id,
            "hostname": "node-low.lan",
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "os": {"distro": "debian", "version": "12", "reboot_required": False},
            "packages": {"manager": "apt", "upgradable_total": 2, "security_updates": 0, "pending": []},
            "cves": [{"cve_id": "CVE-2026-22222", "package": "vim", "cvss_v3": 4.3, "severity": "medium", "cisa_kev": False}],
        }
        env, hdrs = self.daemon_mod.build_encrypted_envelope(agent_id, kid, aes_key_b64, priv, inner)
        st, resp = self.daemon_mod.push_envelope(self.base_url, env, hdrs)
        self.assertEqual(st, 200)
        self.assertFalse(resp["escalated"])
        self.assertEqual(len(self.mock_pushover.sent_messages), before_count)

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
