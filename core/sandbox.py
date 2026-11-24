"""Process isolation sandbox helpers for plugin subprocess execution."""

import os
import resource
from typing import Callable, Dict, Optional

FORBIDDEN_CONFIG_ENV_KEYS = {
    "DATABASE_URL",
    "SECRET_KEY",
    "JWT_SECRET_KEY",
    "HOMEPULSE_API_KEY",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
}


def build_sandboxed_env(
    plugin_id: str,
    plugin_token: str,
    config: Optional[Dict[str, object]],
    api_url: str,
    ipc_url: str,
    plugin_dir: str,
    venv_bin: Optional[str] = None,
) -> Dict[str, str]:
    """Construct a minimal, secret-free environment dict for an isolated plugin subprocess."""
    tmp_dir = os.path.join(plugin_dir, ".tmp")
    os.makedirs(tmp_dir, exist_ok=True)

    path_prefix = f"{venv_bin}:" if venv_bin else ""
    env: Dict[str, str] = {
        "PATH": f"{path_prefix}/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": os.environ.get("TZ", "UTC"),
        "HOME": tmp_dir,
        "TMPDIR": tmp_dir,
        "PYTHONUNBUFFERED": "1",
        "PLUGIN_ID": str(plugin_id),
        "PLUGIN_TOKEN": str(plugin_token),
        "HOMEPULSE_API_URL": str(api_url),
        "HOMEPULSE_IPC_URL": str(ipc_url),
    }

    if isinstance(config, dict):
        for raw_key, val in config.items():
            key_upper = str(raw_key).strip().upper()
            if not key_upper:
                continue
            if key_upper in FORBIDDEN_CONFIG_ENV_KEYS:
                continue
            env_name = key_upper if key_upper.startswith("PLUGIN_") else f"PLUGIN_{key_upper}"
            if env_name in FORBIDDEN_CONFIG_ENV_KEYS:
                continue
            env[env_name] = str(val)

    return env


def _clamp_rlimit(limit_kind: int, desired: int) -> None:
    try:
        soft, hard = resource.getrlimit(limit_kind)
        if hard == resource.RLIM_INFINITY:
            target = desired
        else:
            target = min(desired, hard)
        resource.setrlimit(limit_kind, (target, hard if hard != resource.RLIM_INFINITY else target))
    except (ValueError, OSError):
        pass


def make_resource_limiter(
    max_memory_mb: int = 256,
    max_open_files: int = 128,
    drop_uid: Optional[int] = None,
    drop_gid: Optional[int] = None,
) -> Callable[[], None]:
    """Create a preexec_fn isolating session/process group and applying rlimit caps."""
    mem_bytes = max(64, int(max_memory_mb)) * 1024 * 1024
    # 64-bit Python virtual address space needs generous mmap room even when heap is capped
    as_bytes = max(mem_bytes, 512 * 1024 * 1024)
    nofile = max(32, int(max_open_files))

    def _apply_limits() -> None:
        try:
            os.setsid()
        except OSError:
            pass

        _clamp_rlimit(resource.RLIMIT_NOFILE, nofile)
        _clamp_rlimit(resource.RLIMIT_DATA, mem_bytes)
        _clamp_rlimit(resource.RLIMIT_AS, as_bytes)

        if os.geteuid() == 0:
            if drop_gid is not None:
                try:
                    os.setgid(int(drop_gid))
                except OSError:
                    pass
            if drop_uid is not None:
                try:
                    os.setuid(int(drop_uid))
                except OSError:
                    pass

    return _apply_limits
