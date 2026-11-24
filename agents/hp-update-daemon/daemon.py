#!/usr/bin/env python3
"""Standalone encrypted push daemon for Home Pulse OS package & CVE posture reporting."""

import argparse
import base64
from datetime import datetime, timezone
import json
import os
import platform
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_SCHEMA_VERSION = "homepulse.envelope.v1"
PAYLOAD_SCHEMA_VERSION = "daemon.update_cve.v1"

_APT_LINE_RE = re.compile(
    r"^([^\s/]+)/([^\s]+)\s+([^\s]+)\s+[^\s]+\s+\[upgradable from:\s+([^\]]+)\]"
)


def generate_ed25519_keypair() -> Tuple[Ed25519PrivateKey, str]:
    """Generate a new Ed25519 private key and base64-encoded raw 32-byte public key."""
    priv = Ed25519PrivateKey.generate()
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return priv, base64.b64encode(pub_raw).decode("ascii")


def parse_apt_upgradable(output: str) -> List[Dict[str, Any]]:
    """Parse `apt list --upgradable` output into normalized pending package records."""
    pending: List[Dict[str, Any]] = []
    for raw_line in (output or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("Listing..."):
            continue
        m = _APT_LINE_RE.match(line)
        if not m:
            continue
        name, suite, candidate, current = m.group(1), m.group(2), m.group(3), m.group(4)
        pending.append({
            "name": name,
            "current": current,
            "candidate": candidate,
            "is_security": ("-security" in suite.lower()),
        })
    return pending


def _read_os_release() -> Tuple[str, str]:
    distro = platform.system().lower()
    version = platform.release()
    if os.path.isfile("/etc/os-release"):
        try:
            with open("/etc/os-release", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("ID="):
                        distro = line.split("=", 1)[1].strip().strip('"')
                    elif line.startswith("VERSION_ID="):
                        version = line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    return distro, version


def collect_host_posture(
    host_uid: str,
    cves: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 3600,
) -> Dict[str, Any]:
    """Collect host OS, kernel, reboot flag, and pending upgrades as daemon.update_cve.v1."""
    distro, version = _read_os_release()
    pending: List[Dict[str, Any]] = []
    pkg_manager = "apt"
    try:
        proc = subprocess.run(
            ["apt", "list", "--upgradable"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            pending = parse_apt_upgradable(proc.stdout)
    except Exception:
        pass

    sec_count = sum(1 for p in pending if p.get("is_security"))
    return {
        "schema_version": PAYLOAD_SCHEMA_VERSION,
        "host_uid": host_uid,
        "hostname": platform.node() or host_uid,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "ttl_seconds": int(ttl_seconds),
        "os": {
            "distro": distro,
            "version": version,
            "kernel": platform.release(),
            "reboot_required": os.path.isfile("/var/run/reboot-required"),
        },
        "packages": {
            "manager": pkg_manager,
            "upgradable_total": len(pending),
            "security_updates": sec_count,
            "pending": pending,
        },
        "cves": list(cves or []),
    }


def build_encrypted_envelope(
    agent_id: str,
    kid: str,
    aes_key_b64: str,
    private_key: Ed25519PrivateKey,
    inner_payload: Dict[str, Any],
    timestamp: Optional[str] = None,
    nonce_bytes: Optional[bytes] = None,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Encrypt inner_payload with AES-256-GCM and sign envelope with Ed25519."""
    ts = timestamp or datetime.now(timezone.utc).isoformat()
    n_bytes = nonce_bytes if nonce_bytes is not None else os.urandom(16)
    nonce_b64 = base64.b64encode(n_bytes).decode("ascii")
    iv_bytes = os.urandom(12)
    iv_b64 = base64.b64encode(iv_bytes).decode("ascii")
    aad_str = f"{agent_id}|{ts}|{nonce_b64}|{PAYLOAD_SCHEMA_VERSION}"

    aes_key = base64.b64decode(aes_key_b64.strip(), validate=True)
    plaintext = json.dumps(inner_payload).encode("utf-8")
    ct_and_tag = AESGCM(aes_key).encrypt(iv_bytes, plaintext, aad_str.encode("utf-8"))
    ciphertext_b64 = base64.b64encode(ct_and_tag[:-16]).decode("ascii")
    tag_b64 = base64.b64encode(ct_and_tag[-16:]).decode("ascii")

    signing_bytes = f"{agent_id}|{ts}|{nonce_b64}|{kid}|{iv_b64}|{ciphertext_b64}|{tag_b64}".encode("utf-8")
    sig_b64 = base64.b64encode(private_key.sign(signing_bytes)).decode("ascii")

    envelope = {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "alg": "AES-256-GCM",
        "kid": kid,
        "agent_id": agent_id,
        "timestamp": ts,
        "nonce": nonce_b64,
        "iv": iv_b64,
        "aad": aad_str,
        "ciphertext": ciphertext_b64,
        "tag": tag_b64,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Agent-Id": agent_id,
        "X-Envelope-Timestamp": ts,
        "X-Envelope-Nonce": nonce_b64,
        "X-Envelope-Signature": f"ed25519:{sig_b64}",
    }
    return envelope, headers


def push_envelope(
    server_url: str,
    envelope: Dict[str, Any],
    headers: Dict[str, str],
    timeout: int = 10,
) -> Tuple[int, Dict[str, Any]]:
    """POST an encrypted, signed envelope to /api/v1/daemon/ingest."""
    url = f"{server_url.rstrip('/')}/api/v1/daemon/ingest"
    req = urllib.request.Request(
        url,
        data=json.dumps(envelope).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"detail": raw}
        return err.code, parsed


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="HomePulse Encrypted Update & CVE Push Daemon")
    parser.add_argument("--generate-keys", action="store_true", help="Generate Ed25519 keypair JSON")
    parser.add_argument("--collect-once", action="store_true", help="Print collected daemon.update_cve.v1 JSON")
    parser.add_argument("--push", action="store_true", help="Encrypt and push posture to HomePulse server")
    parser.add_argument("--agent-id", default=os.getenv("HP_AGENT_ID", f"host:linux:{platform.node()}"))
    parser.add_argument("--server-url", default=os.getenv("HP_SERVER_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--kid", default=os.getenv("HP_KEY_ID", ""))
    parser.add_argument("--aes-key-b64", default=os.getenv("HP_AES_KEY_B64", ""))
    parser.add_argument("--private-key-pem", default=os.getenv("HP_PRIVATE_KEY_PEM", ""))
    args = parser.parse_args(argv)

    if args.generate_keys:
        priv, pub_b64 = generate_ed25519_keypair()
        pem = priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("ascii")
        print(json.dumps({"ed25519_public_key_b64": pub_b64, "private_key_pem": pem}, indent=2))
        return 0

    posture = collect_host_posture(args.agent_id)
    if args.collect_once:
        print(json.dumps(posture, indent=2))
        return 0

    if args.push:
        if not (args.kid and args.aes_key_b64 and args.private_key_pem):
            print("Missing --kid, --aes-key-b64, or --private-key-pem", file=sys.stderr)
            return 2
        with open(args.private_key_pem, "rb") as fh:
            priv_key = serialization.load_pem_private_key(fh.read(), password=None)
        envelope, headers = build_encrypted_envelope(
            agent_id=args.agent_id,
            kid=args.kid,
            aes_key_b64=args.aes_key_b64,
            private_key=priv_key,
            inner_payload=posture,
        )
        status, body = push_envelope(args.server_url, envelope, headers)
        print(json.dumps({"status": status, "response": body}, indent=2))
        return 0 if status == 200 else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
