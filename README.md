# HomePulse

HomePulse is a community-focused, highly modular framework for real-time telemetry monitoring and dashboard visualization. Inspired by Home Assistant's Lovelace design, it consumes telemetry streams from local nodes, custom servers, and microcontrollers, displaying them on a lightweight, highly responsive interface.

---

## Technical Architecture Overview

```mermaid
graph TD
    classDef client fill:#3b82f6,stroke:#1d4ed8,color:#fff;
    classDef api fill:#10b981,stroke:#047857,color:#fff;
    classDef db fill:#f59e0b,stroke:#d97706,color:#fff;
    classDef bg fill:#8b5cf6,stroke:#6d28d9,color:#fff;

    A[mDNS Discovery Daemon (In Dev)]:::bg -->|Push Nodes| B(FastAPI Server Integration):::api
    C[IoT Nodes / Prober Servers] -->|HTTP POST / WebSocket| B
    B -->|Serve Files / Static Routing| D[Lovelace Frontend UI]:::client
    D -->|WS Client Stream Connection| B
    D -->|Settings & Panel API Requests| B
    B -->|Write Telemetry & Configs| E[(PostgreSQL Storage Layer)]:::db
```

*   **Frontend**: Built on HTML5, Vanilla JavaScript (ES6+), and tailored CSS themes. Page elements load dynamically via Lucide Icons, and telemetry charts utilize Chart.js.
*   **Backend**: Managed by a Python `FastAPI` instance. It handles WebSocket notification streams, runs background network polling workers, processes incoming JSON telemetry logs, and hosts mDNS node discovery services (currently in development/inactive).
*   **Database**: PostgreSQL serves as the relational and history logs data store. The database initializes schema and runs setup checks upon startup.

---

## Core UI Modules & Capabilities

### 1. Advanced Lovelace YAML Layouts
*   Configure widgets dynamically via in-browser YAML updates.
*   Widgets include Semicircular Gauges, Glance Grids, and Entity lists.
*   Supports a **Compact Room Layout** mode alongside standard grid views.

### 2. Flexible Host Manager
*   Configure and probe remote servers and network devices.
*   Supports a persistent **Grid/List View** preference saved in the client's `localStorage` (`hp_hosts_layout`).

### 3. Zabbix-Style Analytics
*   Filter history telemetry through purely time-based intervals (1h, 3h, 12h, 24h, 7d, 30d) or input a **Custom Date-Time Range**.
*   Shift query windows backward (`<`) and forward (`>`) by the timeframe increment.
*   Calculates and renders a rose-dashed **Average Latency Guideline** overlay on history charts.
*   Adapts chart x-axis ticks to include dates or weekday names for query ranges exceeding 24 hours.

### 4. Collapsible Hover Logs Table Drilldown
*   Detailed history logs are nested within a collapsible `<details>` panel ("Advanced Telemetry Records").
*   Hovering over any node on the line chart dynamically filters this log list to display only records within a ±2 minute window of the hovered point, highlighting the closest time match.

### 5. Custom Promise Dialogs
*   Removed blocking native browser alerts. All critical system warnings and delete calls use custom styles, non-blocking HTML promise modal overlays.

---

## Database Schema Directory

Below is a reference of the key tables created during the database schema verification:

| Table | Purpose | Primary Specifications |
| :--- | :--- | :--- |
| `nodes` | Network endpoints tracked by discovery | `id` (PK), `name`, `status`, `version`, `hardware_model`, `mac_address`, `approved_at` |
| `entities` | Telemetry channels associated with nodes | `id` (PK), `node_id` (FK), `entity_key`, `name`, `type` ('sensor'/'control'), `unit` |
| `telemetry_logs` | High-frequency telemetry log entries | `id` (PK), `node_id`, `entity_key`, `value`, `timestamp` |
| `system_settings` | Key-value settings registry | `key` (PK), `value` (polling interval, timezone, system theme, pincode key) |
| `system_monitors` | Core service check target specifications | `id` (PK), `name`, `type`, `target`, `check_interval`, `timeout`, `last_status`, `enabled` |
| `hosts` | User-managed remote host manager targets | `id` (PK), `name`, `target`, `ping_enabled`, `http_enabled`, `https_enabled` |
| `dashboard_config` | Lovelace layout representation configurations | `key` (PK), `value` (raw YAML representation) |
| `alert_rules` | User-defined alert thresholds | `id` (PK), `entity_key`, `rule_condition`, `warning_level`, `enabled` |

---

## API Router Reference

### 1. WebSocket Live Stream
*   **Endpoint**: `GET /api/ws/client`
*   **Description**: Establishes bi-directional communication to stream telemetry, system audits, and discovery queue updates live to client dashboards.

### 2. Device Controllers
*   **Endpoint**: `POST /api/control/{node_id}/{entity_key}`
*   **Payload**: `{"value": <any>}`
*   **Description**: Controls active IoT switches or sliders, broadcasting state changes to all connected clients.

### 3. Node Discovery & Approvals (In Development)
*   **Endpoint**: `GET /api/discovery` - Lists pending nodes cached during mDNS discovery (feature in development / placeholder queue).
*   **Endpoint**: `POST /api/discovery/approve/{node_id}`
*   **Payload**: `{"preshared_key": "<key>"}`
*   **Description**: Validates the payload device authorization code PIN to register a node and map its entities (feature in development).

### 4. Telemetry History API
*   **Endpoint**: `GET /api/monitors/logs/{entity_key}`
*   **Parameters**:
    *   `hours`: Number of hours offset.
    *   `offset`: Zabbix-style backward time offset shift.
    *   `start_time` / `end_time` *(Optional)*: Timezone-naive datetime-local filter bounds.
*   **Description**: Returns sorted chronological telemetry log records for charts and collapsible detail tables.

---

## Maintenance & Administration CLI

HomePulse includes a robust administrative script (`maintenance.sh` / `update.sh`) located in the root directory. To run:

```bash
chmod +x maintenance.sh
./maintenance.sh
```

### CLI Command Options
1.  **Backup System Database**: Creates gzipped schemas and SQL table backups, rotating archives to preserve only the 3 most recent backups.
2.  **Restore Database**: Scans the backup archives directory, updates permissions, and imports selected configurations.
3.  **Delete Backups Menu**: Provides an interactive terminal menu list to purge specific archives.
4.  **Perform Fresh Installation**: Wipes existing configurations, databases, and logs, returning HomePulse to its initial clean-slate state.

---

## Local Development Deployment

Start the development multi-container Docker compose service stack:

```bash
# Spin up configurations in background mode
docker compose up -d --build
```
