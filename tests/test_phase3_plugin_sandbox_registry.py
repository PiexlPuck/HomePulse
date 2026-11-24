"""Phase 3 verification suite: Manifest v2 validation, sandbox secret isolation, IPC ACLs, and registry API."""

import asyncio
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

from fastapi import HTTPException
from starlette.requests import Request

from core.ipc import IPCPermissionError, PluginIPCBroker, PluginTokenRegistry
from core.manifest_validator import (
    MANIFEST_SCHEMA_VERSION,
    validate_manifest_dict,
    validate_plugin_directory,
    validate_registry_index,
)
from core.sandbox import build_sandboxed_env, make_resource_limiter


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _make_valid_plugin_dir(root_dir: str, plugin_id: str = "sample-probe-pack", kind: str = "plugin", extra_perms=None):
    os.makedirs(root_dir, exist_ok=True)
    main_py = b'import os\nimport time\n\ndef run():\n    return os.getenv("PLUGIN_ID")\n'
    req_txt = b"requests==2.32.3\npyyaml==6.0.2\n"

    with open(os.path.join(root_dir, "main.py"), "wb") as fh:
        fh.write(main_py)
    with open(os.path.join(root_dir, "requirements.txt"), "wb") as fh:
        fh.write(req_txt)

    integrity_files = {
        "main.py": _sha256_bytes(main_py),
        "requirements.txt": _sha256_bytes(req_txt),
    }

    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "id": plugin_id,
        "kind": kind,
        "name": "Sample Probe Pack",
        "version": "1.2.0",
        "compatibility": {"core_api": ">=1.0.0,<2.0.0"},
        "runtime": {
            "entrypoint": "main.py",
            "requirements_file": "requirements.txt",
            "sandbox": {"network_egress": ["configured_targets"], "max_memory_mb": 256},
        },
        "permissions": list(extra_perms or ["telemetry:publish", "ipc:publish", "ipc:subscribe"]),
        "ipc": {
            "publishes": [{"topic": "telemetry.custom"}],
            "subscribes": [{"topic": "core.remediation.approved.sample-probe-pack"}],
        },
        "integrity": {
            "algorithm": "sha256",
            "files": integrity_files,
        },
    }
    if kind == "feature_pack":
        sub_py = b"def check():\n    return True\n"
        os.makedirs(os.path.join(root_dir, "modules"), exist_ok=True)
        with open(os.path.join(root_dir, "modules", "telemetry.py"), "wb") as fh:
            fh.write(sub_py)
        integrity_files["modules/telemetry.py"] = _sha256_bytes(sub_py)
        manifest["submodules"] = [
            {"id": "sub-telemetry", "entrypoint": "modules/telemetry.py", "enabled_by_default": True}
        ]

    with open(os.path.join(root_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    return manifest


class Phase3SandboxAndManifestUnitTest(unittest.TestCase):
    def test_1_manifest_v2_valid_plugin_and_feature_pack(self):
        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            _make_valid_plugin_dir(tmp1, plugin_id="valid-sensor-plugin", kind="plugin")
            res1 = validate_plugin_directory(tmp1)
            self.assertTrue(res1["valid"], res1["errors"])
            self.assertFalse(res1["requires_explicit_admin_consent"])

            _make_valid_plugin_dir(
                tmp2,
                plugin_id="valid-feature-pack",
                kind="feature_pack",
                extra_perms=["telemetry:publish", "remediation:propose"],
            )
            res2 = validate_plugin_directory(tmp2)
            self.assertTrue(res2["valid"], res2["errors"])
            self.assertTrue(res2["requires_explicit_admin_consent"])

    def test_2_manifest_review_engine_rejections(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = _make_valid_plugin_dir(tmp, plugin_id="tamper-test")

            # A. Tampered SHA-256
            with open(os.path.join(tmp, "main.py"), "ab") as fh:
                fh.write(b"\n# tampered\n")
            res_hash = validate_plugin_directory(tmp)
            self.assertFalse(res_hash["valid"])
            self.assertTrue(any("SHA-256 mismatch" in e for e in res_hash["errors"]))

            # B. Unpinned & VCS requirements
            _make_valid_plugin_dir(tmp, plugin_id="unpinned-test")
            bad_req = b"requests>=2.0.0\ngit+https://github.com/evil/repo.git\n"
            with open(os.path.join(tmp, "requirements.txt"), "wb") as fh:
                fh.write(bad_req)
            manifest["integrity"]["files"]["requirements.txt"] = _sha256_bytes(bad_req)
            with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh)
            res_req = validate_plugin_directory(tmp)
            self.assertFalse(res_req["valid"])
            self.assertGreaterEqual(len(res_req["errors"]), 2)

            # C. AST forbidden import & secret env lookup
            _make_valid_plugin_dir(tmp, plugin_id="ast-test")
            bad_py = b'import main\nimport asyncpg\nimport os\nx = os.getenv("DATABASE_URL")\n'
            with open(os.path.join(tmp, "main.py"), "wb") as fh:
                fh.write(bad_py)
            manifest["integrity"]["files"]["main.py"] = _sha256_bytes(bad_py)
            with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh)
            res_ast = validate_plugin_directory(tmp)
            self.assertFalse(res_ast["valid"])
            self.assertTrue(any("forbidden import 'main'" in e for e in res_ast["errors"]))
            self.assertTrue(any("forbidden import 'asyncpg'" in e for e in res_ast["errors"]))
            self.assertTrue(any("DATABASE_URL" in e for e in res_ast["errors"]))

            # D. Schema version, incompatible core_api, traversal, unknown permission
            bad_manifest = dict(manifest)
            bad_manifest["schema_version"] = "v1"
            bad_manifest["compatibility"] = {"core_api": ">=9.0.0"}
            bad_manifest["permissions"] = ["root:shell"]
            bad_manifest["runtime"] = {"entrypoint": "../escape.py"}
            res_meta = validate_manifest_dict(bad_manifest)
            self.assertFalse(res_meta["valid"])
            self.assertGreaterEqual(len(res_meta["errors"]), 4)

    def test_3_registry_index_pinning_validation(self):
        bad_index = {
            "registry_version": "1",
            "maintainer": "Community",
            "plugins": [
                {
                    "id": "demo-pack",
                    "manifest_url": "http://insecure.example.com/manifest.json",
                    "commit_sha": "main",
                }
            ],
        }
        res_bad = validate_registry_index(bad_index)
        self.assertFalse(res_bad["valid"])

        good_index = {
            "registry_version": "1",
            "maintainer": "Community",
            "plugins": [
                {
                    "id": "demo-pack",
                    "manifest_url": "https://raw.githubusercontent.com/org/repo/abcdef/manifest.json",
                    "commit_sha": "a" * 40,
                }
            ],
        }
        res_good = validate_registry_index(good_index)
        self.assertTrue(res_good["valid"], res_good["errors"])

    def test_4_sandboxed_subprocess_blocks_secret_leakage(self):
        orig_env = {k: os.environ.get(k) for k in ("DATABASE_URL", "SECRET_KEY", "HOMEPULSE_API_KEY")}
        os.environ["DATABASE_URL"] = "postgresql://secret-db-pass@127.0.0.1/hp"
        os.environ["SECRET_KEY"] = "super-secret-jwt-key"
        os.environ["HOMEPULSE_API_KEY"] = "super-secret-api-key"

        try:
            with tempfile.TemporaryDirectory() as pdir:
                env = build_sandboxed_env(
                    plugin_id="sandbox-test",
                    plugin_token="hp_plug_test_tok",
                    config={"custom_opt": "abc", "database_url": "attempt-override"},
                    api_url="http://127.0.0.1:8000/api/plugins/gateway",
                    ipc_url="http://127.0.0.1:8000/api/v1/ipc",
                    plugin_dir=pdir,
                )
                proc = subprocess.run(
                    [sys.executable, "-c", "import json, os; print(json.dumps(dict(os.environ)))"],
                    env=env,
                    cwd=pdir,
                    capture_output=True,
                    text=True,
                    preexec_fn=make_resource_limiter(max_memory_mb=256),
                    timeout=10,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                child_env = json.loads(proc.stdout)
                self.assertNotIn("DATABASE_URL", child_env)
                self.assertNotIn("PLUGIN_DATABASE_URL", child_env)
                self.assertNotIn("SECRET_KEY", child_env)
                self.assertNotIn("HOMEPULSE_API_KEY", child_env)
                self.assertEqual(child_env["PLUGIN_ID"], "sandbox-test")
                self.assertEqual(child_env["PLUGIN_TOKEN"], "hp_plug_test_tok")
                self.assertEqual(child_env["PLUGIN_CUSTOM_OPT"], "abc")
                self.assertTrue(child_env["TMPDIR"].startswith(pdir))
        finally:
            for k, v in orig_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_5_ipc_broker_topic_acl_and_anti_spoofing(self):
        reg = PluginTokenRegistry()
        broker = PluginIPCBroker()

        tok_a = reg.mint_token("plugin-a", permissions=["ipc:publish", "telemetry:publish"], publishes=["topology.*"])
        tok_b = reg.mint_token("plugin-b", permissions=["ipc:subscribe"], subscribes=["topology.*"])
        sess_a = reg.authenticate(tok_a)
        sess_b = reg.authenticate(tok_b)
        self.assertIsNotNone(sess_a)
        self.assertIsNotNone(sess_b)

        msg = broker.publish(sess_a, "topology.migration", {"vmid": 101})
        self.assertEqual(msg["sender_plugin_id"], "plugin-a")

        polled = broker.poll_messages(sess_b, "topology.migration", since_seq=0)
        self.assertEqual(len(polled), 1)
        self.assertEqual(polled[0]["sender_plugin_id"], "plugin-a")

        with self.assertRaises(IPCPermissionError):
            broker.publish(sess_a, "remediation.execute", {"cmd": "reboot"})
        with self.assertRaises(IPCPermissionError):
            broker.poll_messages(sess_b, "secrets.dump", since_seq=0)
        with self.assertRaises(IPCPermissionError):
            broker.publish(sess_b, "topology.migration", {"spoof": True})

    def test_7_core_purity_check(self):
        core_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core")
        forbidden_vendors = ("proxmox", "truenas", "plex", "tuya", "unraid")
        for fname in os.listdir(core_dir):
            if fname.endswith(".py"):
                with open(os.path.join(core_dir, fname), "r", encoding="utf-8") as fh:
                    content = fh.read().lower()
                for vendor in forbidden_vendors:
                    self.assertNotIn(vendor, content, f"Vendor '{vendor}' leaked into core/{fname}")


class Phase3HttpIntegrationTest(unittest.TestCase):
    API_KEY = "phase3-api-key-777"

    @classmethod
    def setUpClass(cls):
        cls.app_port = _find_free_port()
        cls.plugins_dir = tempfile.mkdtemp(prefix="hp_p3_plugins_")
        _make_valid_plugin_dir(os.path.join(cls.plugins_dir, "sample-probe-pack"), plugin_id="sample-probe-pack")

        env = os.environ.copy()
        env.update({
            "HOMEPULSE_MODE": "repeater",
            "HOMEPULSE_HEADLESS": "true",
            "ENABLE_LEGACY_DISCOVERY": "false",
            "DATABASE_URL": "",
            "HOMEPULSE_API_KEY": cls.API_KEY,
            "HOMEPULSE_REPEATER_FLUSH_INTERVAL": "60",
            "PLUGINS_DIR": cls.plugins_dir,
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
        raise RuntimeError("Timed out waiting for Phase 3 server to start")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "proc", None):
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
        if getattr(cls, "plugins_dir", None) and os.path.exists(cls.plugins_dir):
            shutil.rmtree(cls.plugins_dir, ignore_errors=True)

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

    def test_6_http_v1_registry_validation_ipc_and_anti_spoofing(self):
        auth = {"X-API-Key": self.API_KEY}

        # 1. External repository registry CRUD
        st_reg, reg_res = self._request(
            "/api/v1/plugins/repositories",
            method="POST",
            headers=auth,
            body={"id": "community-lab", "name": "Community Lab", "registry_url": "https://example.com/registry.json"},
        )
        self.assertEqual(st_reg, 200)
        self.assertEqual(reg_res["repository"]["id"], "community-lab")

        st_list, repos = self._request("/api/v1/plugins/repositories", headers=auth)
        self.assertEqual(st_list, 200)
        self.assertEqual([r["id"] for r in repos], ["community-lab"])

        # 2. Manifest validation endpoint (valid vs AST-rejected)
        st_ok, ok_body = self._request(
            "/api/v1/plugins/validate",
            method="POST",
            headers=auth,
            body={"plugin_dir": os.path.join(self.plugins_dir, "sample-probe-pack")},
        )
        self.assertEqual(st_ok, 200)
        self.assertTrue(ok_body["valid"])

        with open(os.path.join(self.plugins_dir, "sample-probe-pack", "manifest.json"), "r", encoding="utf-8") as fh:
            valid_manifest = json.load(fh)
        st_bad, _ = self._request(
            "/api/v1/plugins/validate",
            method="POST",
            headers=auth,
            body={
                "manifest": valid_manifest,
                "source_files": {"main.py": "import main\n"},
            },
        )
        self.assertEqual(st_bad, 422)

        # 3. Registry index validation (floating branch rejected)
        st_idx_bad, _ = self._request(
            "/api/v1/plugins/validate-registry",
            method="POST",
            headers=auth,
            body={
                "index": {
                    "registry_version": "1",
                    "maintainer": "Test",
                    "plugins": [{"id": "sample-probe-pack", "manifest_url": "https://x.test/m.json", "commit_sha": "main"}],
                }
            },
        )
        self.assertEqual(st_idx_bad, 422)

        # 4. IPC endpoint rejects unauthenticated requests
        st_ipc, _ = self._request(
            "/api/v1/ipc/publish",
            method="POST",
            body={"topic": "telemetry.custom", "payload": {"x": 1}},
        )
        self.assertEqual(st_ipc, 401)

        # 5. Gateway & IPC anti-spoofing check against minted scoped tokens
        os.environ["HOMEPULSE_MODE"] = "repeater"
        os.environ["HOMEPULSE_HEADLESS"] = "true"
        os.environ["DATABASE_URL"] = ""
        import main as app_main
        import plugins_manager

        def _make_req(headers_dict):
            raw_headers = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers_dict.items()]
            return Request({"type": "http", "method": "POST", "path": "/api/plugins/gateway/state", "headers": raw_headers})

        tok_a = app_main.plugin_token_registry.mint_token(
            "plugin-a",
            permissions=["telemetry:publish", "ipc:publish"],
            publishes=["telemetry.a"],
        )
        tok_b = app_main.plugin_token_registry.mint_token(
            "plugin-b",
            permissions=["ipc:subscribe"],
            subscribes=["telemetry.a"],
        )

        async def _verify_anti_spoofing():
            plugins_manager.init_plugins_manager(
                None,
                app_main.manager,
                app_main.entity_states,
                repeater_enqueue_fn=app_main.repeater_engine.enqueue,
                mode="repeater",
                topology_graph_ref=app_main.topology_graph,
                token_registry_ref=app_main.plugin_token_registry,
            )
            await asyncio.sleep(0)

            # Active plugin claiming plugin-a without token -> 401
            with self.assertRaises(HTTPException) as ctx1:
                await plugins_manager.gateway_post_state(
                    {"node_id": "plugin-a", "entity_key": "k1", "value": 1},
                    _make_req({}),
                )
            self.assertEqual(ctx1.exception.status_code, 401)

            # plugin-a token attempting to spoof node_id=plugin-b -> 403
            with self.assertRaises(HTTPException) as ctx2:
                await plugins_manager.gateway_post_state(
                    {"node_id": "plugin-b", "entity_key": "k1", "value": 1},
                    _make_req({"X-Plugin-Token": tok_a}),
                )
            self.assertEqual(ctx2.exception.status_code, 403)

            # plugin-a valid token -> 200 success
            ok_res = await plugins_manager.gateway_post_state(
                {"node_id": "plugin-a", "entity_key": "k1", "value": 1},
                _make_req({"X-Plugin-Token": tok_a}),
            )
            self.assertEqual(ok_res["status"], "success")

        asyncio.run(_verify_anti_spoofing())

        sess_a = app_main.plugin_token_registry.authenticate(tok_a)
        sess_b = app_main.plugin_token_registry.authenticate(tok_b)
        pub_msg = app_main.plugin_ipc_broker.publish(sess_a, "telemetry.a", {"ok": True})
        self.assertEqual(pub_msg["sender_plugin_id"], "plugin-a")
        polled = app_main.plugin_ipc_broker.poll_messages(sess_b, "telemetry.a", since_seq=0)
        self.assertEqual(len(polled), 1)
        self.assertEqual(polled[0]["sender_plugin_id"], "plugin-a")

        app_main.plugin_token_registry.revoke_token("plugin-a")
        app_main.plugin_token_registry.revoke_token("plugin-b")

        # Cleanup repo
        st_del, _ = self._request("/api/v1/plugins/repositories/community-lab", method="DELETE", headers=auth)
        self.assertEqual(st_del, 200)


if __name__ == "__main__":
    unittest.main()
