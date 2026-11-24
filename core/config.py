"""Runtime configuration loader for Home Pulse Core."""

import os
import socket
from dataclasses import dataclass

VALID_MODES = ("storage", "hybrid", "repeater")


def _parse_bool(value: str, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("true", "1", "yes", "on")


def _parse_int(value: str, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_float(value: str, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class CoreRuntimeConfig:
    """Immutable runtime configuration for Home Pulse Core."""

    mode: str
    headless: bool
    enable_legacy_discovery: bool
    database_url: str
    api_key: str
    probes_config_path: str
    repeater_id: str
    repeater_url: str
    repeater_secret: str
    repeater_batch_size: int
    repeater_flush_interval: float
    repeater_max_queue: int


def load_runtime_config() -> CoreRuntimeConfig:
    """Load runtime configuration from environment variables."""
    raw_mode = (os.getenv("HOMEPULSE_MODE") or "storage").strip().lower()
    mode = raw_mode if raw_mode in VALID_MODES else "storage"

    return CoreRuntimeConfig(
        mode=mode,
        headless=_parse_bool(os.getenv("HOMEPULSE_HEADLESS", ""), default=False),
        enable_legacy_discovery=_parse_bool(os.getenv("ENABLE_LEGACY_DISCOVERY", ""), default=False),
        database_url=(os.getenv("DATABASE_URL") or "").strip(),
        api_key=(os.getenv("HOMEPULSE_API_KEY") or "").strip(),
        probes_config_path=(os.getenv("HOMEPULSE_PROBES_CONFIG") or "").strip(),
        repeater_id=(os.getenv("HOMEPULSE_REPEATER_ID") or socket.gethostname()).strip() or "homepulse-repeater",
        repeater_url=(os.getenv("HOMEPULSE_REPEATER_URL") or "").strip(),
        repeater_secret=(os.getenv("HOMEPULSE_REPEATER_SECRET") or "").strip(),
        repeater_batch_size=max(1, _parse_int(os.getenv("HOMEPULSE_REPEATER_BATCH_SIZE", ""), 25)),
        repeater_flush_interval=max(0.1, _parse_float(os.getenv("HOMEPULSE_REPEATER_FLUSH_INTERVAL", ""), 2.0)),
        repeater_max_queue=max(10, _parse_int(os.getenv("HOMEPULSE_REPEATER_MAX_QUEUE", ""), 1000)),
    )
