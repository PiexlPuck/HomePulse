# Changelog

All notable architectural, security, API, and workflow changes to **HomePulse** are documented in this file.

## [Unreleased] - 2026-11-24 — Modular Core, Hierarchy Engine, Plugin Sandbox, Encrypted Push Daemon & Gated Remediation (Phases 1–5)

### Overview
Refactored HomePulse from a tightly coupled FastAPI monolith into a decoupled, API-first, headless-capable telemetry and automation engine (`CORE_API_VERSION = 1.0.0`) enforcing strict separation between Core, Plugins, Storage, and Presentation across five verified milestones.

---

### Added

#### Phase 1 — Core API Decoupling & Repeater Mode
- **`core/__init__.py` & `core/config.py`**: Added `CORE_API_VERSION` and `CoreRuntimeConfig` (`HOMEPULSE_MODE` ∈ `storage | hybrid | repeater`, `HOMEPULSE_HEADLESS`, `HOMEPULSE_PROBES_CONFIG`, `HOMEPULSE_API_KEY`, `ENABLE_LEGACY_DISCOVERY`, and repeater batch/HMAC configuration).
- **`core/storage.py`**: Added `StorageRepository` abstraction with `PostgresRepository` and DB-less `InMemoryYamlRepository` (loads declarative YAML/JSON probes and repeater targets with bounded telemetry history).
- **`core/repeater.py`**: Added `RepeaterEngine` with bounded FIFO queue, `homepulse.repeater.v1` event batching, `X-HomePulse-Signature` HMAC-SHA256 payload signing, and front-of-queue retry with exponential backoff on upstream outages.
- **`core/api_v1.py`**: Added versioned `/api/v1/*` endpoints:
  - `GET /api/v1/health` (DB-optional health reporting `200` in `repeater` mode)
  - `GET /api/v1/telemetry/snapshot` (UI presentation keys stripped)
  - `GET/POST/PUT/DELETE /api/v1/probes`
  - `GET /api/v1/repeater/status`, `GET/POST/DELETE /api/v1/repeater/targets`, `POST /api/v1/repeater/flush`
  - `WebSocket /api/v1/ws/stream` (API-key authenticated, topic-filtered `telemetry`/`alerts`/`audits` with monotonic `seq`)

#### Phase 2 — Hierarchy Graph & Consolidated Cascade Suppression
- **`core/topology.py`**: Added `TopologyGraph`, a typed DAG (`network_core`, `host`, `hypervisor`, `vm`, `lxc`, `container`, `service`, `plugin`) mirrored in memory and optionally persisted to `topology_nodes`, `topology_edges`, and `topology_migration_events`. Enforces cycle rejection (`TopologyCycleError` / HTTP `409`), live-migration grace leases (`start_migration`), atomic parent rebinding (`rebind_parent`) preserving downstream `VM -> Service` edges, and automatic import of legacy `node_dependencies` rows.
- **`core/alerting.py`**: Added `CascadeAlertSuppressor` providing unified suppression across both `alert_rules` and `alert_flows`: emits a single consolidated root-cause parent alert summarizing all impacted downstream guests/services, suppresses child firing and orphaned child recovery noise, buffers transient flaps during migration leases, and detaches HA-rebound guests from failed hypervisors.
- **Topology & Gateway Endpoints**: Added `/api/v1/topology/*` (`graph`, `nodes`, `edges`, `migrations/start`, `migrations/rebind`, `evaluate-alert`) and `/api/plugins/gateway/topology*`.

#### Phase 3 — Plugin Isolation Sandbox, Certified IPC Bus & External Registry
- **`core/manifest_validator.py`**: Implemented fail-closed `homepulse.manifest.v2` Review Engine enforcing:
  - Schema version, ID slug regex, SemVer & `compatibility.core_api` range, and `feature_pack` submodule definitions (Rule R1)
  - Path traversal/symlink containment checks and SHA-256 file integrity verification (Rule R2)
  - Pinned `==` `requirements.txt` validation blocking VCS/URL/editable installs (Rule R3)
  - Least-privilege permission allowlist + explicit admin consent flagging for `remediation:*` / `network_egress: any` (Rule R4)
  - Static Python AST scan rejecting forbidden core/DB imports and secret environment variable lookups (Rule R5)
  - Pinned 40-char commit SHA & `https://` validation for external registry indexes (Rule R6)
- **`core/sandbox.py`**: Added `build_sandboxed_env()` (minimal secret-free environment scoped to `<plugin_dir>/.tmp`, eliminating host `os.environ.copy()` leakage of `DATABASE_URL`/`SECRET_KEY`) and `make_resource_limiter()` (`os.setsid()` process-group isolation, `RLIMIT_NOFILE`, `RLIMIT_DATA`, `RLIMIT_AS`, and optional UID/GID drop).
- **`core/ipc.py`**: Added `PluginTokenRegistry` (SHA-256 hashed scoped `hp_plug_*` tokens) and `PluginIPCBroker` enforcing declared `ipc:publish` / `ipc:subscribe` topic ACLs and non-spoofable `sender_plugin_id`.
- **`core/registry.py`**: Added `PluginRegistryStore` backed by memory and `plugin_repositories` table.
- **Registry & IPC APIs**: Added `/api/v1/plugins/repositories`, `/api/v1/plugins/validate`, `/api/v1/plugins/validate-registry`, and plugin-token-authenticated `/api/v1/ipc/publish`, `/api/v1/ipc/messages`, `/api/v1/ipc/telemetry`.

#### Phase 4 — Encrypted Push Update/CVE Daemon & Critical Pushover Escalation
- **`core/daemon_ingest.py`**: Implemented `DaemonIngestEngine` with agent enrollment (`/api/v1/daemon/enroll`, `agents`, `posture`) and `POST /api/v1/daemon/ingest` validating `homepulse.envelope.v1` → `daemon.update_cve.v1` via Ed25519 signatures, `±60s` clock-skew bounds, anti-replay `(agent_id, nonce)` TTL cache (`409` on replay), AAD binding, and AES-256-GCM decryption (`401` on tamper/bad key).
- **`core/pushover_escalation.py`**: Implemented `PushoverEscalator` dispatching Pushover Priority 2 Emergency alerts (`retry >= 30s`, `expire <= 10800s`) on critical CVEs (`cvss_v3 >= 9.0`, `cisa_kev == true`, or `severity == "critical"`) and tracking/polling acknowledgment receipts (`pushover_receipts`).
- **`agents/hp-update-daemon/`**: Added standalone encrypted update/CVE push agent (`daemon.py` + `README.md`) supporting `--generate-keys`, `--collect-once`, and `--push`.

#### Phase 5 — Remediation Tiers, Execution Gating & Flow Canvas Nodes
- **`core/remediation.py`**: Implemented `RemediationEngine` separating Tier-1 routine self-healing (`plugin_restart`, `cache_clear`, `webhook_notify`, `local_control`) from Tier-2 remote endpoint mutations (`remote_*`) and Tier-3 hypervisor/cluster operations (`hypervisor_*`, `cluster_*`, unknown actions fail-closed). Tier-2/3 actions halt at `pending_approval` with one-time SHA-256-hashed approval tokens, TTL expiration (`410`), RBAC enforcement (`observer` blocked `403`, only `architect` may approve `403`), dry-run previews, immutable audit records, and certified IPC dispatch onto `core.remediation.approved.<plugin_id>`.
- **Remediation & Gated Control APIs**: Added `/api/v1/remediation/propose`, `/api/v1/remediation/approvals`, `/api/v1/remediation/approvals/{id}/approve|reject`, `/api/v1/remediation/audits`, and gated `/api/v1/entities/control/{node_uid}/{entity_key}`.
- **Flow Canvas UI**: Added `approval_gate` and `remediation_action` nodes to [index.html](index.html), [src/09-flow-canvas.ts](src/09-flow-canvas.ts), and compiled [app.js](app.js).

#### Verification Suites
- Added automated test suites in `tests/`:
  - `tests/test_phase1_core_repeater.py` (7 tests)
  - `tests/test_phase2_topology_cascade.py` (7 tests)
  - `tests/test_phase3_plugin_sandbox_registry.py` (7 tests)
  - `tests/test_phase4_daemon_pushover.py` (7 tests)
  - `tests/test_phase5_remediation_gating.py` (7 tests)

---

### Changed
- **`main.py`**:
  - Removed hard `DATABASE_URL` boot failure in `repeater` mode and added `HOMEPULSE_HEADLESS` static route gating.
  - Fixed `monitor_probers_task()` so `gateway_mode == "true"` no longer skips probing; routed prober reads/writes through `storage_repo` and `repeater_engine`.
  - Unified `verify_api_key` across legacy `/api/*` middleware and `/api/v1/*`.
  - Removed hardcoded vendor-specific Plex monitor renaming SQL and Tuya smart-plug entity/token stubs from core.
  - Wired `TopologyGraph`, `CascadeAlertSuppressor`, `PluginTokenRegistry`, `PluginIPCBroker`, `PluginRegistryStore`, `DaemonIngestEngine`, `PushoverEscalator`, and `RemediationEngine` (including PostgreSQL DDL for `repeater_targets`, `topology_*`, `plugin_repositories`, `enrolled_agents`, `daemon_cve_reports`, `pushover_receipts`, and `remediation_approvals`).
  - Routed both `alert_rules` and `alert_flows` through `CascadeAlertSuppressor`, and extended flow traversal to support `approval_gate` and `remediation_action` nodes.
- **`plugins_manager.py`**:
  - Decoupled repeater forwarding in `gateway_post_state()` from `if db_pool and plugin_id:` so plugin telemetry streams in DB-less mode.
  - Added fail-closed manifest review gate inside `install_plugin()` before `compile_plugin_venv()`.
  - Replaced `os.environ.copy()` with `build_sandboxed_env()` + `make_resource_limiter()` and scoped `X-Plugin-Token` minting/revocation + anti-spoofing verification across `/api/plugins/gateway/*`.
- **`plugins/proxmox-ve-monitor/main.py`**:
  - Added multi-node `cluster/resources` topology synchronization (`hv:pve:<cluster>:<node>` -> `guest:pve:<cluster>:<vmid>`) and automatic `live_migration` / `ha_failover` rebind reporting.

---

### Parked / Deferred
- **mDNS Auto-Discovery**: Legacy `/api/discovery/queue` and `/api/discovery/approve/{node_id}` endpoints are parked behind `ENABLE_LEGACY_DISCOVERY=false` (returning `501 Not Implemented`) pending future extraction into an optional discovery plugin.
