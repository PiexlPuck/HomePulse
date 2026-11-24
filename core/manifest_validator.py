"""Fail-closed homepulse.manifest.v2 review engine for plugins, feature packs, and registries."""

import ast
import hashlib
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import yaml

from core import CORE_API_VERSION

MANIFEST_SCHEMA_VERSION = "homepulse.manifest.v2"
PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

ALLOWED_PERMISSIONS = {
    "network:outbound",
    "telemetry:publish",
    "topology:report",
    "ipc:publish",
    "ipc:subscribe",
    "remediation:propose",
    "remediation:execute_gated",
    "host:metrics",
}
PRIVILEGED_PERMISSIONS = {"remediation:propose", "remediation:execute_gated"}
FORBIDDEN_IMPORTS = {"main", "plugins_manager", "asyncpg", "psycopg2", "psycopg", "core"}
FORBIDDEN_ENV_KEYS = {"DATABASE_URL", "SECRET_KEY", "JWT_SECRET_KEY", "HOMEPULSE_API_KEY"}
DISALLOWED_PIP_PREFIXES = ("git+", "hg+", "svn+", "bzr+", "http://", "https://", "file:", "-e ", "--editable")
DISALLOWED_PIP_FLAGS = ("--index-url", "--extra-index-url", "--find-links", "-f ")


def parse_semver(ver: str) -> Optional[Tuple[int, int, int]]:
    """Parse a SemVer string into a (major, minor, patch) tuple."""
    if not isinstance(ver, str):
        return None
    m = SEMVER_RE.match(ver.strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def satisfies_semver_range(current: str, range_spec: str) -> bool:
    """Check whether current SemVer satisfies comma-separated comparator clauses."""
    cur = parse_semver(current)
    if cur is None or not isinstance(range_spec, str) or not range_spec.strip():
        return False

    clauses = [c.strip() for c in range_spec.split(",") if c.strip()]
    if not clauses:
        return False

    for clause in clauses:
        matched = re.match(r"^(>=|<=|==|>|<)\s*(.+)$", clause)
        if not matched:
            return False
        op, ver_str = matched.group(1), matched.group(2).strip()
        target = parse_semver(ver_str)
        if target is None:
            return False
        if op == ">=" and not (cur >= target):
            return False
        if op == "<=" and not (cur <= target):
            return False
        if op == ">" and not (cur > target):
            return False
        if op == "<" and not (cur < target):
            return False
        if op == "==" and not (cur == target):
            return False
    return True


def _safe_rel_path(rel_path: Any) -> bool:
    if not isinstance(rel_path, str):
        return False
    cleaned = rel_path.strip()
    if not cleaned or "\\" in cleaned or os.path.isabs(cleaned):
        return False
    parts = cleaned.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return False
    return True


def validate_requirements_text(req_text: str) -> List[str]:
    """Validate pinned dependency specs; rejects unpinned entries and URL/VCS installs."""
    errors: List[str] = []
    for idx, raw_line in enumerate(req_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        # Strip inline comment
        line_no_comment = line.split("#", 1)[0].strip()
        if not line_no_comment:
            continue
        lowered = line_no_comment.lower()
        if any(lowered.startswith(pfx) for pfx in DISALLOWED_PIP_PREFIXES):
            errors.append(f"requirements line {idx}: disallowed VCS/URL/editable install '{line_no_comment}'")
            continue
        if any(flag in lowered for flag in DISALLOWED_PIP_FLAGS):
            errors.append(f"requirements line {idx}: disallowed pip index override '{line_no_comment}'")
            continue
        if "==" not in line_no_comment:
            errors.append(f"requirements line {idx}: dependency must be pinned with '==' ('{line_no_comment}')")
            continue
        # Strip optional --hash=... tokens before checking pkg==ver
        spec_part = line_no_comment.split("--hash=", 1)[0].strip().rstrip("\\").strip()
        if not re.match(r"^[A-Za-z0-9._-]+(\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9.*+_!-]+(\s*;.*)?$", spec_part):
            errors.append(f"requirements line {idx}: invalid pinned spec '{line_no_comment}'")
    return errors


def _const_str(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def scan_python_source_ast(source_text: str, filename: str = "<string>") -> List[str]:
    """Static AST check rejecting forbidden core/DB imports and forbidden host env lookups."""
    errors: List[str] = []
    try:
        tree = ast.parse(source_text, filename=filename)
    except SyntaxError as exc:
        return [f"{filename}:{exc.lineno}: syntax error: {exc.msg}"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".", 1)[0]
                if top in FORBIDDEN_IMPORTS:
                    errors.append(f"{filename}:{node.lineno}: forbidden import '{alias.name}'")
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                top = node.module.split(".", 1)[0]
                if top in FORBIDDEN_IMPORTS:
                    errors.append(f"{filename}:{node.lineno}: forbidden import from '{node.module}'")
        elif isinstance(node, ast.Call):
            func = node.func
            # Detect os.getenv("KEY") or os.environ.get("KEY")
            is_getenv = (
                isinstance(func, ast.Attribute)
                and func.attr == "getenv"
                and isinstance(func.value, ast.Name)
                and func.value.id == "os"
            )
            is_environ_get = (
                isinstance(func, ast.Attribute)
                and func.attr == "get"
                and isinstance(func.value, ast.Attribute)
                and func.value.attr == "environ"
                and isinstance(func.value.value, ast.Name)
                and func.value.value.id == "os"
            )
            if (is_getenv or is_environ_get) and node.args:
                key = _const_str(node.args[0])
                if key and key in FORBIDDEN_ENV_KEYS:
                    errors.append(f"{filename}:{node.lineno}: forbidden environment key access '{key}'")
        elif isinstance(node, ast.Subscript):
            # Detect os.environ["KEY"]
            if (
                isinstance(node.value, ast.Attribute)
                and node.value.attr == "environ"
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "os"
            ):
                key = _const_str(node.slice)
                if key and key in FORBIDDEN_ENV_KEYS:
                    errors.append(f"{filename}:{node.lineno}: forbidden os.environ['{key}'] access")

    return errors


def validate_manifest_dict(manifest: Any, core_api_version: str = CORE_API_VERSION) -> Dict[str, Any]:
    """Validate a manifest dictionary against homepulse.manifest.v2 rules R1, R2, and R4."""
    errors: List[str] = []
    warnings: List[str] = []
    requires_consent = False

    if not isinstance(manifest, dict):
        return {
            "valid": False,
            "errors": ["Manifest must be a JSON/YAML object"],
            "warnings": [],
            "requires_explicit_admin_consent": False,
            "normalized_manifest": None,
        }

    # R1: Schema version, id, kind, version, compatibility
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        errors.append(f"schema_version must equal '{MANIFEST_SCHEMA_VERSION}'")

    plugin_id = manifest.get("id")
    if not isinstance(plugin_id, str) or not PLUGIN_ID_RE.match(plugin_id):
        errors.append("id must match ^[a-z0-9][a-z0-9-]{2,63}$")

    kind = manifest.get("kind")
    if kind not in ("plugin", "feature_pack"):
        errors.append("kind must be 'plugin' or 'feature_pack'")

    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        errors.append("name is required")

    version = manifest.get("version")
    if not isinstance(version, str) or parse_semver(version) is None:
        errors.append("version must be a valid SemVer 2.0.0 string")

    compat = manifest.get("compatibility")
    if not isinstance(compat, dict) or not satisfies_semver_range(core_api_version, str(compat.get("core_api", ""))):
        errors.append(f"compatibility.core_api does not satisfy running core API {core_api_version}")

    if kind == "feature_pack":
        submodules = manifest.get("submodules")
        if not isinstance(submodules, list) or len(submodules) == 0:
            errors.append("feature_pack manifests must declare a non-empty submodules list")
        else:
            for idx, sm in enumerate(submodules):
                if not isinstance(sm, dict) or not sm.get("id") or not _safe_rel_path(sm.get("entrypoint")):
                    errors.append(f"submodules[{idx}] must define valid id and safe relative entrypoint")

    # R2: Runtime & paths
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        errors.append("runtime block is required")
        runtime = {}
    else:
        if not _safe_rel_path(runtime.get("entrypoint")):
            errors.append("runtime.entrypoint must be a safe relative path inside the plugin directory")
        req_file = runtime.get("requirements_file")
        if req_file is not None and not _safe_rel_path(req_file):
            errors.append("runtime.requirements_file must be a safe relative path")
        sandbox = runtime.get("sandbox") or {}
        if isinstance(sandbox, dict):
            egress = sandbox.get("network_egress")
            if egress == "any":
                requires_consent = True
                warnings.append("runtime.sandbox.network_egress='any' requires explicit admin consent")
            elif egress is not None and not (
                egress == "none" or (isinstance(egress, list) and all(isinstance(x, str) for x in egress))
            ):
                errors.append("runtime.sandbox.network_egress must be 'none', 'any', or a list of targets")

    ui_block = manifest.get("ui")
    if isinstance(ui_block, dict):
        for ui_field in ("card_bundle", "icon"):
            if ui_block.get(ui_field) is not None and not _safe_rel_path(ui_block.get(ui_field)):
                errors.append(f"ui.{ui_field} must be a safe relative path")

    # R4: Permissions least-privilege
    perms = manifest.get("permissions")
    if not isinstance(perms, list):
        errors.append("permissions must be a list")
        perms = []
    else:
        for perm in perms:
            if perm not in ALLOWED_PERMISSIONS:
                errors.append(f"disallowed permission '{perm}'")
            elif perm in PRIVILEGED_PERMISSIONS:
                requires_consent = True
                warnings.append(f"privileged permission '{perm}' requires explicit admin consent")

    # R2: Integrity block
    integrity = manifest.get("integrity")
    if not isinstance(integrity, dict):
        errors.append("integrity block is required")
    else:
        if integrity.get("algorithm") != "sha256":
            errors.append("integrity.algorithm must be 'sha256'")
        files_map = integrity.get("files")
        if not isinstance(files_map, dict) or len(files_map) == 0:
            errors.append("integrity.files must be a non-empty mapping of relative_path -> sha256")
        else:
            entrypoint = runtime.get("entrypoint") if isinstance(runtime, dict) else None
            if entrypoint and entrypoint not in files_map:
                errors.append(f"integrity.files must include runtime.entrypoint '{entrypoint}'")
            for rel_p, digest in files_map.items():
                if not _safe_rel_path(rel_p):
                    errors.append(f"integrity.files contains unsafe path '{rel_p}'")
                if not isinstance(digest, str) or not SHA256_HEX_RE.match(digest.lower()):
                    errors.append(f"integrity.files['{rel_p}'] must be a 64-char lowercase hex sha256 digest")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "requires_explicit_admin_consent": requires_consent,
        "normalized_manifest": manifest if len(errors) == 0 else None,
    }


def validate_plugin_directory(
    plugin_dir: str,
    manifest: Optional[Dict[str, Any]] = None,
    core_api_version: str = CORE_API_VERSION,
) -> Dict[str, Any]:
    """Run full fail-closed review (manifest + SHA-256 integrity + pinned deps + AST scan) on a plugin dir."""
    base_real = os.path.realpath(plugin_dir)
    if not os.path.isdir(base_real):
        return {
            "valid": False,
            "errors": [f"Plugin directory not found: {plugin_dir}"],
            "warnings": [],
            "requires_explicit_admin_consent": False,
            "normalized_manifest": None,
        }

    loaded_manifest = manifest
    if loaded_manifest is None:
        for fname in ("manifest.yaml", "manifest.yml", "manifest.json"):
            mpath = os.path.join(base_real, fname)
            if os.path.isfile(mpath):
                try:
                    with open(mpath, "r", encoding="utf-8") as fh:
                        loaded_manifest = yaml.safe_load(fh.read()) if fname.endswith((".yaml", ".yml")) else json.load(fh)
                    break
                except Exception as exc:
                    return {
                        "valid": False,
                        "errors": [f"Failed parsing {fname}: {exc}"],
                        "warnings": [],
                        "requires_explicit_admin_consent": False,
                        "normalized_manifest": None,
                    }

    if loaded_manifest is None:
        return {
            "valid": False,
            "errors": ["Missing manifest.yaml or manifest.json"],
            "warnings": [],
            "requires_explicit_admin_consent": False,
            "normalized_manifest": None,
        }

    res = validate_manifest_dict(loaded_manifest, core_api_version=core_api_version)
    errors = list(res["errors"])
    warnings = list(res["warnings"])

    # Verify integrity SHA-256 digests and containment inside plugin_dir
    integrity = loaded_manifest.get("integrity") if isinstance(loaded_manifest, dict) else None
    files_map = integrity.get("files") if isinstance(integrity, dict) else None
    if isinstance(files_map, dict):
        for rel_p, expected_hex in files_map.items():
            if not _safe_rel_path(rel_p):
                continue
            cand = os.path.join(base_real, rel_p)
            cand_real = os.path.realpath(cand)
            if os.path.commonpath([base_real, cand_real]) != base_real or cand_real == base_real:
                errors.append(f"integrity path escapes plugin directory: '{rel_p}'")
                continue
            if not os.path.isfile(cand_real):
                errors.append(f"integrity file missing: '{rel_p}'")
                continue
            h = hashlib.sha256()
            with open(cand_real, "rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
            actual_hex = h.hexdigest().lower()
            if actual_hex != str(expected_hex).lower():
                errors.append(f"SHA-256 mismatch for '{rel_p}' (expected {expected_hex}, got {actual_hex})")

    # Validate requirements file (R3)
    req_rel = None
    if isinstance(loaded_manifest, dict) and isinstance(loaded_manifest.get("runtime"), dict):
        req_rel = loaded_manifest["runtime"].get("requirements_file")
    req_rel = req_rel or "requirements.txt"
    if _safe_rel_path(req_rel):
        req_path = os.path.realpath(os.path.join(base_real, req_rel))
        if os.path.commonpath([base_real, req_path]) == base_real and os.path.isfile(req_path):
            with open(req_path, "r", encoding="utf-8") as fh:
                errors.extend(validate_requirements_text(fh.read()))

    # Static AST scan across all Python files (R5)
    for root, dirs, files in os.walk(base_real):
        dirs[:] = [d for d in dirs if d not in ("venv", ".venv", "__pycache__", ".git")]
        for fname in files:
            if not fname.endswith(".py"):
                continue
            fpath = os.path.join(root, fname)
            f_real = os.path.realpath(fpath)
            if os.path.commonpath([base_real, f_real]) != base_real:
                errors.append(f"python file symlink escapes plugin directory: '{fname}'")
                continue
            rel_name = os.path.relpath(f_real, base_real)
            with open(f_real, "r", encoding="utf-8") as fh:
                errors.extend(scan_python_source_ast(fh.read(), filename=rel_name))

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "requires_explicit_admin_consent": res["requires_explicit_admin_consent"],
        "normalized_manifest": loaded_manifest if len(errors) == 0 else None,
    }


def validate_registry_index(index_data: Any) -> Dict[str, Any]:
    """Validate an external plugin repository registry index (Rule R6)."""
    errors: List[str] = []
    if not isinstance(index_data, dict):
        return {"valid": False, "errors": ["Registry index must be a JSON object"]}

    if str(index_data.get("registry_version", "")) != "1":
        errors.append("registry_version must equal '1'")
    if not isinstance(index_data.get("maintainer"), str) or not index_data["maintainer"].strip():
        errors.append("maintainer is required")

    plugins = index_data.get("plugins")
    if not isinstance(plugins, list) or len(plugins) == 0:
        errors.append("plugins must be a non-empty list")
    else:
        for idx, entry in enumerate(plugins):
            if not isinstance(entry, dict):
                errors.append(f"plugins[{idx}] must be an object")
                continue
            pid = entry.get("id")
            if not isinstance(pid, str) or not PLUGIN_ID_RE.match(pid):
                errors.append(f"plugins[{idx}].id must match ^[a-z0-9][a-z0-9-]{{2,63}}$")
            murl = entry.get("manifest_url")
            if not isinstance(murl, str) or not murl.startswith("https://"):
                errors.append(f"plugins[{idx}].manifest_url must be an https:// URL")
            sha = entry.get("commit_sha")
            if not isinstance(sha, str) or not COMMIT_SHA_RE.match(sha):
                errors.append(f"plugins[{idx}].commit_sha must be a pinned 40-char lowercase hex commit SHA")

    return {"valid": len(errors) == 0, "errors": errors}
