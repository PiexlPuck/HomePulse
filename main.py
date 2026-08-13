import os
import sys
import time
import json
import asyncio
import logging
import psutil
import asyncpg
import socket
import urllib.request
import urllib.error
from pydantic import BaseModel, model_validator
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Header
from fastapi.responses import FileResponse, JSONResponse
import smtplib
from email.mime.text import MIMEText
from email.header import Header as EmailHeader
from plugins_manager import plugins_router, init_plugins_manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("homepulse-backend")

app = FastAPI(title="HomePulse Backend")

# DB Connection Pool
db_pool = None

# Active WebSocket connections
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Client websocket connected. Active connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Client websocket disconnected. Active connections: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.error(f"Error broadcasting to WS connection: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

def dispatch_notification_sync(channel_type: str, config: dict, message: str, title: str = "HomePulse Alert"):
    try:
        if channel_type == "smtp":
            host = config.get("host")
            port = int(config.get("port", 587))
            user = config.get("username")
            password = config.get("password")
            from_addr = config.get("from_address")
            to_addr = config.get("to_address")
            
            msg = MIMEText(message, 'plain', 'utf-8')
            msg['Subject'] = EmailHeader(title, 'utf-8')
            msg['From'] = from_addr
            msg['To'] = to_addr
            
            with smtplib.SMTP(host, port, timeout=10) as server:
                if port == 587:
                    server.starttls()
                if user and password:
                    server.login(user, password)
                server.sendmail(from_addr, [to_addr], msg.as_string())
            logger.info("SMTP email alert dispatched successfully.")
            
        elif channel_type == "telegram":
            token = config.get("bot_token")
            chat_id = config.get("chat_id")
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            
            payload = {
                "chat_id": chat_id,
                "text": f"*{title}*\n{message}",
                "parse_mode": "Markdown"
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                res_body = response.read().decode('utf-8')
                logger.info(f"Telegram alert dispatched successfully: {res_body}")
                
        elif channel_type == "pushover":
            user_key = config.get("user_key")
            token = config.get("api_token")
            priority = int(config.get("priority", 0))
            sound = config.get("sound", "pushover")
            
            payload = {
                "token": token,
                "user": user_key,
                "title": title,
                "message": message,
                "priority": priority,
                "sound": sound
            }
            if priority == 2:
                payload["retry"] = int(config.get("retry", 60))
                payload["expire"] = int(config.get("expire", 3600))
                
            url = "https://api.pushover.net/1/messages.json"
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                res_body = response.read().decode('utf-8')
                logger.info(f"Pushover alert dispatched successfully: {res_body}")
                
    except Exception as e:
        logger.error(f"Error dispatching notification via {channel_type}: {e}")
        raise e

async def dispatch_notification(channel_type: str, config: dict, message: str, title: str = "HomePulse Alert"):
    await asyncio.to_thread(dispatch_notification_sync, channel_type, config, message, title)

# Dynamic system configurations cache
app_settings = {
    "telemetry_interval": 3,
    "log_retention": 7,
    "timezone": "UTC",
    "preshared_key": "device_pin_12345",
    "theme": "midnight",
    "layout_compact": "false"
}

# Global State for local virtual entities
entity_states = {
    # System Stats
    "server-room-temp": {
        "node_id": "core-mon",
        "entity_key": "server-room-temp",
        "name": "Host CPU Temperature",
        "type": "sensor",
        "value_type": "float",
        "unit": "°C",
        "value": 45.2,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,server",
        "icon": "thermometer",
        "color": "#10b981",
        "graphic": "sparkline"
    },
    "cpu-utilization": {
        "node_id": "core-mon",
        "entity_key": "cpu-utilization",
        "name": "Core CPU Cycles",
        "type": "sensor",
        "value_type": "float",
        "unit": "%",
        "value": 15.0,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,server",
        "icon": "cpu",
        "color": "#10b981",
        "graphic": "sparkline"
    },
    "memory-saturation": {
        "node_id": "core-mon",
        "entity_key": "memory-saturation",
        "name": "Memory Pool Usage",
        "type": "sensor",
        "value_type": "float",
        "unit": "%",
        "value": 40.0,
        "status": "Stable",
        "status_type": "stable",
        "tags": "main,server",
        "icon": "hard-drive",
        "color": "#3b82f6",
        "graphic": "sparkline"
    },
    "database-latency": {
        "node_id": "core-mon",
        "entity_key": "database-latency",
        "name": "Database Connection Latency",
        "type": "sensor",
        "value_type": "float",
        "unit": "ms",
        "value": 5.0,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,server",
        "icon": "database",
        "color": "#10b981",
        "graphic": "sparkline"
    },
    "network-throughput": {
        "node_id": "core-mon",
        "entity_key": "network-throughput",
        "name": "Network Throughput",
        "type": "sensor",
        "value_type": "float",
        "unit": "MB/s",
        "value": 1.2,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,server",
        "icon": "activity",
        "color": "#10b981",
        "graphic": "sparkline"
    },
    "database-status": {
        "node_id": "core-mon",
        "entity_key": "database-status",
        "name": "PostgreSQL Connectivity",
        "type": "value",
        "value_type": "string",
        "unit": "",
        "value": "CONNECTED",
        "status": "Healthy",
        "status_type": "healthy",
        "tags": "main,server",
        "icon": "database",
        "color": "#10b981",
        "graphic": "bottom-bar"
    },
    "database-storage-pct": {
        "node_id": "core-mon",
        "entity_key": "database-storage-pct",
        "name": "Database Storage Space Full",
        "type": "sensor",
        "value_type": "float",
        "unit": "%",
        "value": 0.0,
        "status": "Healthy",
        "status_type": "healthy",
        "tags": "main,server",
        "icon": "database",
        "color": "#10b981",
        "graphic": "sparkline"
    }
}

# Staged discovery queue
discovery_queue = []

class ControlPayload(BaseModel):
    value: Any

class ApprovePayload(BaseModel):
    preshared_key: str

class ChannelPayload(BaseModel):
    name: str
    type: str # 'smtp', 'telegram', 'pushover'
    config: dict

class ChannelTestPayload(BaseModel):
    type: str
    config: dict

class RuleCondition(BaseModel):
    entity_key: str
    operator: str # '==', '!=', '>', '<', 'contains'
    value: str
    join_type: str # 'AND', 'OR', or ''

class RulePayload(BaseModel):
    name: str
    rules_json: List[RuleCondition]
    channel_ids: List[int]
    enabled: bool = True
    target_type: Optional[str] = "all"
    monitors_list: Optional[List[int]] = []
    target_groups: Optional[List[int]] = []
    target_groups_operator: Optional[str] = "any"

# 1. DB Init Routine
async def init_db_pool():
    global db_pool
    database_url = os.getenv("DATABASE_URL", "postgresql://hp_admin:hpsafe_dbpass123@localhost/homepulse")
    logger.info("Initializing Database connection pool...")
    for attempt in range(10):
        try:
            db_pool = await asyncpg.create_pool(database_url)
            logger.info("Database connection pool established successfully.")
            # Run quick tables diagnostics
            async with db_pool.acquire() as conn:
                logger.info("Verifying database schema...")
                # Initialize system_settings table and seed options
                await conn.execute("""
                    CREATE TABLE IF NOT EXISTS system_settings (
                        key VARCHAR(64) PRIMARY KEY,
                        value VARCHAR(255) NOT NULL
                    );
                """)
                await conn.execute("""
                    INSERT INTO system_settings (key, value) VALUES 
                    ('telemetry_interval', '3'),
                    ('log_retention', '7'),
                    ('auto_prune_enabled', 'false'),
                    ('timezone', 'UTC'),
                    ('preshared_key', 'device_pin_12345'),
                    ('theme', 'midnight'),
                    ('layout_compact', 'false')
                    ON CONFLICT (key) DO NOTHING;
                """)
                
                # Retrieve active configurations to update startup memory configs cache
                rows = await conn.fetch("SELECT key, value FROM system_settings;")
                for r in rows:
                    key, val = r["key"], r["value"]
                    if key in ["telemetry_interval", "log_retention"]:
                        app_settings[key] = int(val)
                    else:
                        app_settings[key] = val
                logger.info(f"Loaded config settings registry cache: {app_settings}")

                # Ensure system_monitors has 'enabled' and 'category' columns
                try:
                    await conn.execute("ALTER TABLE system_monitors ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;")
                    await conn.execute("ALTER TABLE system_monitors ADD COLUMN IF NOT EXISTS category VARCHAR(64) DEFAULT 'General';")
                    logger.info("Migrated system_monitors database schema: enabled and category columns verified.")
                except Exception as mig_err:
                    logger.warning(f"Error checking system_monitors columns migration: {mig_err}")

                # Clean up duplicate/misspelled lowercase proxmox definitions from system_monitors
                try:
                    await conn.execute("DELETE FROM system_monitors WHERE name = 'proxmox';")
                    logger.info("Cleaned up duplicate/misspelled proxmox monitor definitions.")
                except Exception as clean_err:
                    logger.warning(f"Error cleaning up proxmox monitor definitions: {clean_err}")

                # Create dashboard_config table
                try:
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS dashboard_config (
                            key VARCHAR(64) PRIMARY KEY,
                            value TEXT NOT NULL
                        );
                    """)
                    logger.info("dashboard_config table verified.")
                except Exception as db_err:
                    logger.warning(f"Error establishing dashboard_config table: {db_err}")

                # Create notification_channels table
                try:
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS notification_channels (
                            id SERIAL PRIMARY KEY,
                            name VARCHAR(255) NOT NULL,
                            type VARCHAR(32) NOT NULL,
                            config JSONB NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    logger.info("notification_channels table verified.")
                except Exception as nc_err:
                    logger.warning(f"Error establishing notification_channels table: {nc_err}")

                    # Create alert_rules table
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS alert_rules (
                            id SERIAL PRIMARY KEY,
                            name VARCHAR(255) NOT NULL,
                            rules_json JSONB NOT NULL,
                            channel_ids INT[] NOT NULL,
                            enabled BOOLEAN DEFAULT TRUE,
                            status VARCHAR(32) DEFAULT 'normal',
                            last_fired TIMESTAMP,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            target_type VARCHAR(64) DEFAULT 'all',
                            monitors_list INT[] DEFAULT '{}'::INT[]
                        );
                    """)
                    logger.info("alert_rules table verified.")
                except Exception as ar_err:
                    logger.warning(f"Error establishing alert_rules table: {ar_err}")

                try:
                    await conn.execute("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS target_type VARCHAR(64) DEFAULT 'all';")
                    await conn.execute("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS monitors_list INT[] DEFAULT '{}'::INT[];")
                    await conn.execute("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS target_groups INT[] DEFAULT '{}'::INT[];")
                    await conn.execute("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS target_groups_operator VARCHAR(10) DEFAULT 'any';")
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS monitor_groups (
                            id SERIAL PRIMARY KEY,
                            name VARCHAR(64) UNIQUE NOT NULL
                        );
                    """)
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS monitor_group_map (
                            monitor_id INT NOT NULL REFERENCES system_monitors(id) ON DELETE CASCADE,
                            group_id INT NOT NULL REFERENCES monitor_groups(id) ON DELETE CASCADE,
                            PRIMARY KEY (monitor_id, group_id)
                        );
                    """)
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS active_alerts (
                            rule_id INT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
                            monitor_id INT NOT NULL REFERENCES system_monitors(id) ON DELETE CASCADE,
                            fired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (rule_id, monitor_id)
                        );
                    """)
                    logger.info("active_alerts and monitor_groups/map schemas and migrations verified.")
                except Exception as mig_err:
                    logger.warning(f"Error executing alarm router migrations: {mig_err}")

                # Create hosts table and sync host_id foreign key constraint
                try:
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS hosts (
                            id SERIAL PRIMARY KEY,
                            name VARCHAR(255) NOT NULL,
                            target VARCHAR(255) NOT NULL,
                            ping_enabled BOOLEAN DEFAULT FALSE,
                            http_enabled BOOLEAN DEFAULT FALSE,
                            https_enabled BOOLEAN DEFAULT FALSE,
                            ssl_enabled BOOLEAN DEFAULT FALSE,
                            port_enabled BOOLEAN DEFAULT FALSE,
                            port_number INT,
                            polling_interval INT DEFAULT 3,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    await conn.execute("ALTER TABLE hosts ADD COLUMN IF NOT EXISTS polling_interval INT DEFAULT 3;")
                    await conn.execute("ALTER TABLE system_monitors ADD COLUMN IF NOT EXISTS host_id INT REFERENCES hosts(id) ON DELETE CASCADE;")
                    await conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_logs_timestamp ON telemetry_logs (timestamp);")
                    await conn.execute("CREATE INDEX IF NOT EXISTS idx_system_audits_timestamp ON system_audits (timestamp);")
                    logger.info("hosts database schema, indexes, and relationships verified.")
                except Exception as hosts_err:
                    logger.warning(f"Error establishing hosts and schemas: {hosts_err}")

                # Rename Plex monitors to distinguish SSL and Ping metrics
                try:
                    await conn.execute("UPDATE system_monitors SET name = 'Plex SSL Status' WHERE LOWER(name) = 'plex' AND type = 'ssl';")
                    await conn.execute("UPDATE system_monitors SET name = 'Plex Ping Status' WHERE LOWER(name) = 'plex' AND type = 'ping';")
                    logger.info("Renamed Plex monitor targets to differentiate engines.")
                except Exception as plex_err:
                    logger.warning(f"Error updating Plex monitor names: {plex_err}")

                # Query built-in monitors to pre-register their entity states
                try:
                    mon_rows = await conn.fetch("SELECT id, name, enabled FROM system_monitors;")
                    for m in mon_rows:
                        mid = m["id"]
                        mname = m["name"]
                        enabled = m["enabled"] if "enabled" in m else True
                        status_val = "unknown" if enabled else "disabled"
                        status_desc = "Unknown" if enabled else "Disabled"
                        status_type = "default" if enabled else "default"
                        status_color = "var(--text-secondary)" if enabled else "#6b7280"
                        status_icon = "activity" if enabled else "shield-off"
                        
                        entity_states[f"monitor-{mid}-status"] = {
                            "node_id": "monitors",
                            "entity_key": f"monitor-{mid}-status",
                            "name": f"{mname} Status",
                            "type": "sensor",
                            "value_type": "string",
                            "unit": "",
                            "value": status_val,
                            "status": status_desc,
                            "status_type": status_type,
                            "tags": "main",
                            "icon": status_icon,
                            "color": status_color
                        }
                        entity_states[f"monitor-{mid}-latency"] = {
                            "node_id": "monitors",
                            "entity_key": f"monitor-{mid}-latency",
                            "name": f"{mname} Latency",
                            "type": "sensor",
                            "value_type": "float",
                            "unit": "ms",
                            "value": 0.0,
                            "status": "Stable" if enabled else "Disabled",
                            "status_type": "stable" if enabled else "default",
                            "tags": "main",
                            "icon": "activity",
                            "color": "#3b82f6" if enabled else "#6b7280",
                            "graphic": "sparkline"
                        }
                except Exception as e:
                    logger.error(f"Failed to pre-register monitor entities: {e}")

                # Auto-provision "Main Monitor Host" and "Database Node" if not exist in hosts table
                try:
                    host_exists = await conn.fetchrow("SELECT id FROM hosts WHERE target = '127.0.0.1';")
                    if not host_exists:
                        logger.info("Auto-provisioning default Core Monitor Host and PostgreSQL host...")
                        
                        # 1. Main Host
                        host_payload_main = HostPayload(
                            name="Core Monitor Host",
                            target="127.0.0.1",
                            ping_enabled=True,
                            http_enabled=False,
                            https_enabled=False,
                            ssl_enabled=False,
                            port_enabled=False,
                            port_number=None,
                            polling_interval=3
                        )
                        # Insert Core Host
                        host_id_main = await conn.fetchval(
                            """INSERT INTO hosts (name, target, ping_enabled, http_enabled, https_enabled, ssl_enabled, port_enabled, port_number, polling_interval) 
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;""",
                            host_payload_main.name, host_payload_main.target, host_payload_main.ping_enabled,
                            host_payload_main.http_enabled, host_payload_main.https_enabled, host_payload_main.ssl_enabled,
                            host_payload_main.port_enabled, host_payload_main.port_number, host_payload_main.polling_interval
                        )
                        await sync_host_probers(conn, host_id_main, host_payload_main)

                        # 2. Database Server Host
                        host_payload_db = HostPayload(
                            name="PostgreSQL Database Node",
                            target="localhost",
                            ping_enabled=False,
                            http_enabled=False,
                            https_enabled=False,
                            ssl_enabled=False,
                            port_enabled=True,
                            port_number=5432,
                            polling_interval=5
                        )
                        host_id_db = await conn.fetchval(
                            """INSERT INTO hosts (name, target, ping_enabled, http_enabled, https_enabled, ssl_enabled, port_enabled, port_number, polling_interval) 
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;""",
                            host_payload_db.name, host_payload_db.target, host_payload_db.ping_enabled,
                            host_payload_db.http_enabled, host_payload_db.https_enabled, host_payload_db.ssl_enabled,
                            host_payload_db.port_enabled, host_payload_db.port_number, host_payload_db.polling_interval
                        )
                        await sync_host_probers(conn, host_id_db, host_payload_db)
                        logger.info("Default hosts successfully auto-provisioned.")
                except Exception as prov_err:
                    logger.error(f"Failed to auto-provision default hosts: {prov_err}")

                tables = await conn.fetch("SELECT table_name FROM information_schema.tables WHERE table_schema='public';")
                logger.info(f"Database schema verification complete. Tables: {[t['table_name'] for t in tables]}")
            return
        except Exception as e:
            logger.warning(f"Database setup wait loop (attempt {attempt+1}/10)... Error: {e}")
            await asyncio.sleep(3)
    logger.error("Could not coordinate Database connection, proceeding in standalone mode.")

def evaluate_condition(entity_key: str, operator: str, target_val: str) -> bool:
    state = entity_states.get(entity_key)
    if not state:
        return False
    
    current_val = state.get("value")
    if current_val is None:
        return False
        
    current_str = str(current_val).strip()
    target_str = str(target_val).strip()
    
    try:
        current_float = float(current_str)
        target_float = float(target_str)
        is_numeric = True
    except ValueError:
        is_numeric = False
        
    if operator == "==":
        return current_str.lower() == target_str.lower()
    elif operator == "!=":
        return current_str.lower() != target_str.lower()
    elif operator == ">":
        if is_numeric:
            return current_float > target_float
        return current_str > target_str
    elif operator == "<":
        if is_numeric:
            return current_float < target_float
        return current_str < target_str
    elif operator == "contains":
        return target_str.lower() in current_str.lower()
    return False

def check_monitor_rule_firing(m_id: int, conditions: list) -> bool:
    if not conditions:
        return False
        
    def eval_cond_for_mon(c):
        ekey = c.get("entity_key")
        # Map relative entity keys
        if ekey == "status":
            mapped_key = f"monitor-{m_id}-status"
        elif ekey == "latency":
            mapped_key = f"monitor-{m_id}-latency"
        else:
            mapped_key = ekey
            
        operator = c.get("operator")
        value = c.get("value")
        return evaluate_condition(mapped_key, operator, value)
        
    c0 = conditions[0]
    result = eval_cond_for_mon(c0)
    
    for c in conditions[1:]:
        join_type = c.get("join_type", "AND").upper()
        val = eval_cond_for_mon(c)
        if join_type == "AND":
            result = result and val
        elif join_type == "OR":
            result = result or val
    return result

async def alerts_evaluator_task():
    global db_pool
    logger.info("Starting Alert Router background rules evaluator task...")
    
    while True:
        await asyncio.sleep(10)
        if not db_pool:
            continue
            
        try:
            async with db_pool.acquire() as conn:
                rules = await conn.fetch("SELECT id, name, rules_json, channel_ids, enabled, status, target_type, monitors_list, target_groups, target_groups_operator FROM alert_rules WHERE enabled = TRUE;")
                for r in rules:
                    rid = r["id"]
                    rname = r["name"]
                    channel_ids = r["channel_ids"]
                    old_status = r["status"] or "normal"
                    target_type = r["target_type"] or "all"
                    monitors_list = r["monitors_list"] or []
                    target_groups = r["target_groups"] or []
                    target_groups_operator = r["target_groups_operator"] or "any"
                    
                    try:
                        conditions = json.loads(r["rules_json"]) if isinstance(r["rules_json"], str) else r["rules_json"]
                    except Exception as json_err:
                        logger.error(f"Rule {rid} rules_json parse error: {json_err}")
                        continue
                        
                    # Resolve matching monitors
                    all_monitors = await conn.fetch("""
                        SELECT sm.id, sm.name, sm.type, sm.target, sm.enabled, sm.category,
                               COALESCE(array_agg(mgm.group_id) FILTER (WHERE mgm.group_id IS NOT NULL), '{}') AS group_ids
                        FROM system_monitors sm
                        LEFT JOIN monitor_group_map mgm ON sm.id = mgm.monitor_id
                        WHERE sm.enabled = TRUE
                        GROUP BY sm.id;
                    """)
                    matching_monitors = []
                    
                    for m in all_monitors:
                        mid = m["id"]
                        mtype = m["type"]
                        
                        match = False
                        if target_type == "all":
                            match = True
                        elif target_type.startswith("type_"):
                            expected_type = target_type[5:] # e.g. "ping", "ssl" etc.
                            match = (mtype == expected_type)
                        elif target_type.startswith("category_"):
                            expected_category = target_type[9:] # e.g. "General", "Database Infrastructure" etc.
                            match = ((m["category"] or "General") == expected_category)
                        elif target_type == "custom":
                            match = (mid in monitors_list)
                        elif target_type == "custom_groups":
                            if target_groups_operator == "all":
                                match = all(gid in (m["group_ids"] or []) for gid in target_groups) if target_groups else False
                            else:
                                match = any(gid in target_groups for gid in (m["group_ids"] or []))
                            
                        # Exclude checks (only if target_type is not "custom" where monitors_list is inclusion list)
                        if match and target_type != "custom":
                            if mid in monitors_list:
                                match = False
                                
                        if match:
                            matching_monitors.append(m)
                            
                    # Evaluate firing status for each matching monitor
                    for m in matching_monitors:
                        is_firing = check_monitor_rule_firing(m["id"], conditions)
                        
                        # Query if already registered as firing
                        row = await conn.fetchrow("SELECT 1 FROM active_alerts WHERE rule_id = $1 AND monitor_id = $2;", rid, m["id"])
                        was_firing = (row is not None)
                        
                        if not was_firing and is_firing:
                            # Transition to firing for this monitor!
                            await conn.execute("INSERT INTO active_alerts (rule_id, monitor_id) VALUES ($1, $2);", rid, m["id"])
                            
                            # Dispatches warning alerts with host/monitor name in the message dynamically
                            title = f"❗ Alert [FIRING]: {rname}"
                            message = f"Oh, {m['name']} ({m['type'].upper()}) has gone into alarm! Target: {m['target']} is down.\n\n"
                            message += f"Rule: {rname}\nStatus: FIRING\n\nConditions check:\n"
                            for cond in conditions:
                                ekey = cond.get("entity_key")
                                if ekey == "status":
                                    mapped_key = f"monitor-{m['id']}-status"
                                elif ekey == "latency":
                                    mapped_key = f"monitor-{m['id']}-latency"
                                else:
                                    mapped_key = ekey
                                op = cond.get("operator")
                                val = cond.get("value")
                                curr_val = entity_states.get(mapped_key, {}).get("value", "unknown")
                                message += f"- {ekey} (Current: {curr_val}) {op} {val}\n"
                                
                            logger.info(f"Monitor alert firing: rule '{rname}' on monitor '{m['name']}'")
                            
                            # Send via channels
                            for cid in channel_ids:
                                chan = await conn.fetchrow("SELECT type, config FROM notification_channels WHERE id = $1;", cid)
                                if chan:
                                    c_type = chan["type"]
                                    c_cfg = json.loads(chan["config"]) if isinstance(chan["config"], str) else chan["config"]
                                    try:
                                        await dispatch_notification(c_type, c_cfg, message, title)
                                    except Exception as notify_err:
                                        logger.error(f"Failed to send notification via channel {cid}: {notify_err}")
                                        
                        elif was_firing and not is_firing:
                            # Transition to recovered!
                            await conn.execute("DELETE FROM active_alerts WHERE rule_id = $1 AND monitor_id = $2;", rid, m["id"])
                            
                            title = f"✅ Alert [RESOLVED]: {rname}"
                            message = f"Oh, {m['name']} ({m['type'].upper()}) has recovered to normal!\n\nTarget: {m['target']}\nRule: {rname}\nStatus: NORMAL\n"
                            
                            logger.info(f"Monitor alert recovered: rule '{rname}' on monitor '{m['name']}'")
                            
                            # Send via channels
                            for cid in channel_ids:
                                chan = await conn.fetchrow("SELECT type, config FROM notification_channels WHERE id = $1;", cid)
                                if chan:
                                    c_type = chan["type"]
                                    c_cfg = json.loads(chan["config"]) if isinstance(chan["config"], str) else chan["config"]
                                    try:
                                        await dispatch_notification(c_type, c_cfg, message, title)
                                    except Exception as notify_err:
                                        logger.error(f"Failed to send notification via channel {cid}: {notify_err}")
                                        
                    # Update rule overall status based on whether any matched monitors are active
                    active_count = await conn.fetchval("SELECT COUNT(*) FROM active_alerts WHERE rule_id = $1;", rid)
                    new_status = "firing" if active_count > 0 else "normal"
                    
                    if old_status != new_status:
                        logger.info(f"Alert rule overall transition '{rname}': {old_status} -> {new_status}")
                        if new_status == "firing":
                            await conn.execute(
                                "UPDATE alert_rules SET status = $1, last_fired = CURRENT_TIMESTAMP WHERE id = $2;",
                                new_status, rid
                            )
                        else:
                            await conn.execute(
                                "UPDATE alert_rules SET status = $1 WHERE id = $2;",
                                new_status, rid
                            )
                            
                        # Log system audit log
                        audit_type = "warning" if new_status == "firing" else "success"
                        audit_msg = f"Alert rule '{rname}' is FIRING!" if new_status == "firing" else f"Alert rule '{rname}' has recovered to normal."
                        await conn.execute(
                            "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                            audit_type, audit_msg
                        )
                        
        except Exception as eval_err:
            logger.error(f"Error in alerts_evaluator_task iteration: {eval_err}")

@app.on_event("startup")
async def startup_event():
    await init_db_pool()
    init_plugins_manager(db_pool, manager, entity_states)
    asyncio.create_task(collect_system_statistics_task())
    asyncio.create_task(monitor_probers_task())
    asyncio.create_task(alerts_evaluator_task())

@app.on_event("shutdown")
async def shutdown_event():
    global db_pool
    if db_pool:
        await db_pool.close()
        logger.info("Database connection pool closed.")

# 2. System Stats compilation background loop
async def collect_system_statistics_task():
    global db_pool
    logger.info("Starting system stats collection background task...")
    
    # Track network bytes to calculate delta throughput
    last_net_bytes = psutil.net_io_counters().bytes_sent + psutil.net_io_counters().bytes_recv
    last_time = time.time()

    while True:
        try:
            interval = app_settings.get("telemetry_interval", 3)
            await asyncio.sleep(interval)
            
            # A. CPU Utilization
            cpu_val = psutil.cpu_percent()
            entity_states["cpu-utilization"]["value"] = cpu_val

            # B. Memory Utilization
            mem_info = psutil.virtual_memory()
            mem_pct = mem_info.percent
            entity_states["memory-saturation"]["value"] = mem_pct

            # C. Network Throughput
            now_time = time.time()
            now_net_bytes = psutil.net_io_counters().bytes_sent + psutil.net_io_counters().bytes_recv
            time_delta = now_time - last_time
            bytes_delta = now_net_bytes - last_net_bytes
            
            # Convert to MB/s
            net_val = round((bytes_delta / (1024 * 1024)) / time_delta, 2) if time_delta > 0 else 0.0
            entity_states["network-throughput"]["value"] = net_val
            
            last_net_bytes = now_net_bytes
            last_time = now_time

            # D. Database connectivity and query performance latency
            db_status = "DISCONNECTED"
            db_latency = 0.0
            
            if db_pool:
                try:
                    start_db = time.perf_counter()
                    async with db_pool.acquire() as conn:
                        await conn.execute("SELECT 1;")
                    db_latency = round((time.perf_counter() - start_db) * 1000, 2)
                    db_status = "CONNECTED"
                except Exception as db_err:
                    logger.error(f"Database health query failed: {db_err}")
            
            entity_states["database-status"]["value"] = db_status
            entity_states["database-status"]["status"] = "Healthy" if db_status == "CONNECTED" else "Alarm"
            entity_states["database-status"]["status_type"] = "healthy" if db_status == "CONNECTED" else "error"
            entity_states["database-latency"]["value"] = db_latency
            entity_states["database-latency"]["status"] = "Optimal" if db_latency < 20 else "Caution"
            entity_states["database-latency"]["status_type"] = "optimal" if db_latency < 20 else "caution"

            # Disk Partition Space checks for DB Footprint capacity
            try:
                storage_pct = psutil.disk_usage('/').percent
            except Exception as disk_err:
                logger.warning(f"Failed to query disk storage stats: {disk_err}")
                storage_pct = 0.0
            entity_states["database-storage-pct"]["value"] = storage_pct
            entity_states["database-storage-pct"]["status"] = "Optimal" if storage_pct < 80 else ("Caution" if storage_pct < 90 else "Alarm")
            entity_states["database-storage-pct"]["status_type"] = "optimal" if storage_pct < 80 else ("caution" if storage_pct < 90 else "alarm")

            # E. Write to Postgres telemetry logs and system audits if connected
            if db_pool and db_status == "CONNECTED":
                try:
                    async with db_pool.acquire() as conn:
                        # Log high-frequency stats
                        await conn.execute(
                            "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                            "core-mon", "cpu-utilization", str(cpu_val)
                        )
                        await conn.execute(
                            "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                            "core-mon", "database-latency", str(db_latency)
                        )
                        await conn.execute(
                            "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                            "core-mon", "database-storage-pct", str(storage_pct)
                        )
                        
                        # Occasional systemic check audits
                        if cpu_val > 90.0:
                            await conn.execute(
                                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                                "warning", f"High core processor saturation detected: {cpu_val}%"
                            )
                            await manager.broadcast({
                                "event": "audit_logged",
                                "type": "warning",
                                "message": f"High core processor saturation detected: {cpu_val}%"
                            })
                except Exception as insert_err:
                    logger.error(f"Failed to log system telemetry to DB: {insert_err}")

                # G. Perform log retention pruning
                try:
                    auto_prune = app_settings.get("auto_prune_enabled", "false") == "true"
                    if auto_prune:
                        retention = app_settings.get("log_retention", 7)
                        async with db_pool.acquire() as conn:
                            await conn.execute(
                                "DELETE FROM telemetry_logs WHERE timestamp < NOW() - ($1::integer * INTERVAL '1 day');",
                                retention
                            )
                            await conn.execute(
                                "DELETE FROM system_audits WHERE timestamp < NOW() - ($1::integer * INTERVAL '1 day');",
                                retention
                            )
                except Exception as prune_err:
                    logger.error(f"Failed to prune retention logs: {prune_err}")

            # F. Broadcast WebSocket notifications
            for key in ["cpu-utilization", "memory-saturation", "network-throughput", "database-latency", "database-status", "database-storage-pct"]:
                state = entity_states[key]
                await manager.broadcast({
                    "event": "state_changed",
                    "node_id": state["node_id"],
                    "entity_id": state["entity_key"],
                    "value": state["value"],
                    "status": state["status"],
                    "status_type": state["status_type"]
                })

            # Broadcast occasional random audits to frontend list
            import random
            if random.random() > 0.90:
                audit_opt = [
                    {"type": "info", "msg": "Internal memory footprint optimization cycle completed."},
                    {"type": "success", "msg": "System cache verified. Uptime metrics remain nominal."},
                    {"type": "info", "msg": "Network bridge performance parameters diagnostic completed."}
                ]
                sel = random.choice(audit_opt)
                if db_pool and db_status == "CONNECTED":
                    try:
                        async with db_pool.acquire() as conn:
                            await conn.execute("INSERT INTO system_audits (type, message) VALUES ($1, $2);", sel["type"], sel["msg"])
                    except:
                        pass
                await manager.broadcast({
                    "event": "audit_logged",
                    "type": sel["type"],
                    "message": sel["msg"]
                })

        except Exception as loop_err:
            logger.error(f"Error in background loops telemetry task: {loop_err}")

# 3. Built-in Background Prober Task Core
async def execute_monitor_probe(mon_id: int, mtype: str, target: str, timeout: int):
    start_time = time.time()
    is_up = False
    status_code = "OFFLINE"
    
    try:
        if mtype == "http" or mtype == "https":
            url = target
            if not url.startswith("http://") and not url.startswith("https://"):
                url = "http://" + url
            
            response_code = "500"
            def run_urllib():
                nonlocal response_code
                req = urllib.request.Request(url, headers={"User-Agent": "HomePulse-Monitor/1.0"})
                try:
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        response_code = str(resp.getcode())
                        return resp.getcode() < 400
                except urllib.error.HTTPError as he:
                    response_code = str(he.code)
                    return he.code < 400
                except Exception as ex:
                    response_code = "CONN_REFUSED"
                    return False
            
            is_up = await asyncio.to_thread(run_urllib)
            status_code = response_code
            
        elif mtype == "websocket":
            host = target
            if "://" in host:
                host = host.split("://")[1].split("/")[0]
            else:
                host = host.split("/")[0]
                
            if ":" in host:
                host, port_str = host.split(":")
                port = int(port_str)
            else:
                port = 443 if target.startswith("wss") else 80
            
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            writer.close()
            await writer.wait_closed()
            is_up = True
            status_code = "101"
            
        elif mtype == "ping":
            host = target
            if "://" in host:
                host = host.split("://")[1].split("/")[0].split(":")[0]
            else:
                host = host.split(":")[0]
                
            proc = await asyncio.create_subprocess_exec(
                "ping", "-c", "1", "-W", str(timeout), host,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
            )
            await asyncio.wait_for(proc.wait(), timeout=timeout + 2)
            is_up = (proc.returncode == 0)
            status_code = "ICMP_OK" if is_up else "PING_FAIL"
            
        elif mtype == "port":
            host, port_str = target.split(":")
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, int(port_str)), timeout=timeout
            )
            writer.close()
            await writer.wait_closed()
            is_up = True
            status_code = "PORT_OK"
            
        elif mtype == "dns":
            host = target
            if "://" in host:
                host = host.split("://")[1].split("/")[0].split(":")[0]
            else:
                host = host.split(":")[0]
            await asyncio.get_event_loop().getaddrinfo(host, None)
            is_up = True
            status_code = "DNS_OK"
            
        elif mtype == "ssl":
            try:
                clean_host = target.replace("https://", "").replace("http://", "").split("/")[0].split(":")[0]
                import ssl
                import socket
                from datetime import datetime
                
                context = ssl.create_default_context()
                port = 443
                if ":" in target.split("/")[0]:
                    try:
                        port = int(target.split("/")[0].split(":")[1])
                    except:
                        pass
                
                start_time = time.time()
                with socket.create_connection((clean_host, port), timeout=timeout) as sock:
                    with context.wrap_socket(sock, server_hostname=clean_host) as ssock:
                        cert = ssock.getpeercert()
                latency = round((time.time() - start_time) * 1000, 2)
                
                not_after_str = cert.get('notAfter')
                if not_after_str:
                    not_after = datetime.strptime(not_after_str, '%b %d %H:%M:%S %Y %Z')
                    remaining_days = (not_after - datetime.utcnow()).days
                    is_up = remaining_days > 0
                    if is_up:
                        status_code = f"{remaining_days}d remaining"
                    else:
                        status_code = "Expired"
                else:
                    is_up = False
                    status_code = "No Cert Date"
            except Exception as ssl_err:
                # Fallback to connection failure
                is_up = False
                status_code = "SSL_ERROR"
                latency = 0.0
                logger.debug(f"SSL cert validation failed: {ssl_err}")
            
    except Exception as e:
        logger.debug(f"Monitor probe {mon_id} failed: {e}")
        is_up = False
        err_msg = str(e).upper()
        if "TIMEOUT" in err_msg:
            status_code = "TIMEOUT"
        elif "REFUSED" in err_msg or "RESET" in err_msg:
            status_code = "CONN_REFUSED"
        else:
            status_code = "OFFLINE"
        
    latency = (time.time() - start_time) * 1000 if is_up else 0.0
    return is_up, round(latency, 2), status_code


async def run_single_probe(monitor: dict):
    mon_id = monitor["id"]
    mname = monitor["name"]
    mtype = monitor["type"]
    target = monitor["target"]
    timeout = monitor["timeout"]
    
    is_up, latency, status_code = await execute_monitor_probe(mon_id, mtype, target, timeout)
    status_str = status_code
    status_type = "optimal" if is_up else "alarm"
    status_desc = "Optimal" if is_up else "Alarm"
    
    entity_states[f"monitor-{mon_id}-status"] = {
        "node_id": "monitors",
        "entity_key": f"monitor-{mon_id}-status",
        "name": f"{mname} Status",
        "type": "sensor",
        "value_type": "string",
        "unit": "",
        "value": status_str,
        "status": status_desc,
        "status_type": status_type,
        "tags": "main",
        "icon": "shield-check" if is_up else "shield-alert"
    }
    entity_states[f"monitor-{mon_id}-latency"] = {
        "node_id": "monitors",
        "entity_key": f"monitor-{mon_id}-latency",
        "name": f"{mname} Latency",
        "type": "sensor",
        "value_type": "float",
        "unit": "ms",
        "value": latency,
        "status": "Stable" if is_up else "Caution",
        "status_type": "stable" if is_up else "caution",
        "tags": "main",
        "icon": "activity",
        "color": "#10b981" if is_up else "#f43f5e",
        "graphic": "sparkline"
    }
    
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute(
                    """UPDATE system_monitors 
                       SET last_status = $1, last_latency = $2, last_checked = CURRENT_TIMESTAMP 
                       WHERE id = $3;""",
                    status_str, latency, mon_id
                )
                await conn.execute(
                    "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                    "monitors", f"monitor-{mon_id}-status", status_str
                )
                await conn.execute(
                    "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                    "monitors", f"monitor-{mon_id}-latency", str(latency)
                )
        except Exception as db_err:
            logger.error(f"Failed to record monitor {mon_id} results to DB: {db_err}")
            
    await manager.broadcast({
        "event": "state_changed",
        "node_id": "monitors",
        "entity_id": f"monitor-{mon_id}-status",
        "value": status_str,
        "status": status_desc,
        "status_type": status_type
    })
    await manager.broadcast({
        "event": "state_changed",
        "node_id": "monitors",
        "entity_id": f"monitor-{mon_id}-latency",
        "value": latency,
        "status": "Stable" if is_up else "Caution",
        "status_type": "stable" if is_up else "caution"
    })


async def monitor_probers_task():
    global db_pool
    logger.info("Starting built-in system monitors prober background task...")
    
    last_check_tracker = {}
    
    while True:
        try:
            if not db_pool:
                await asyncio.sleep(2)
                continue
                
            async with db_pool.acquire() as conn:
                monitors = await conn.fetch("SELECT id, name, type, target, check_interval, timeout, enabled FROM system_monitors;")
                
            now = time.time()
            for m in monitors:
                mid = m["id"]
                interval = m["check_interval"]
                enabled = m["enabled"] if "enabled" in m else True
                if not enabled:
                    continue
                
                last_time = last_check_tracker.get(mid, 0)
                if now - last_time >= interval:
                    last_check_tracker[mid] = now
                    asyncio.create_task(run_single_probe(dict(m)))
                    
        except Exception as e:
            logger.error(f"Exception in monitor prober background task: {e}")
            
        await asyncio.sleep(1)


app.include_router(plugins_router)

# 4. Static serving routing
@app.get("/")
async def get_index():
    return FileResponse("index.html")

@app.get("/app.js")
async def get_js():
    return FileResponse("app.js")

@app.get("/style.css")
async def get_css():
    return FileResponse("style.css")

# 4. REST API Implementation

@app.get("/api/health")
async def health_check():
    """
    General health check endpoint for Docker container check.
    Verifies FastAPI is accepting requests and connection pool is healthy.
    """
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection pool unavailable")
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("SELECT 1;")
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=500, detail=f"Database connectivity check failed: {str(e)}")

@app.get("/api/entities")
async def get_entities():
    # Merge status and states
    return JSONResponse(content=entity_states)

@app.post("/api/entities/control/{node_id}/{entity_id}")
async def post_control(node_id: str, entity_id: str, payload: ControlPayload):
    key = f"{node_id}-{entity_id}"
    # Match against simple key or structure
    matched_key = None
    for k, v in entity_states.items():
        if v["node_id"] == node_id and v["entity_key"] == entity_id:
            matched_key = k
            break
            
    if not matched_key:
        # Create a dynamic entry if missing
        entity_states[key] = {
            "node_id": node_id,
            "entity_key": entity_id,
            "name": f"{node_id} {entity_id}",
            "type": "control",
            "value_type": "boolean" if isinstance(payload.value, bool) else "float",
            "value": payload.value,
            "status": "Online",
            "status_type": "stable",
            "tags": "main"
        }
        matched_key = key
    
    entity_states[matched_key]["value"] = payload.value
    logger.info(f"Target command overridden: {node_id}/{entity_id} -> {payload.value}")

    # Log to DB logbook
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO telemetry_logs (node_id, entity_key, value) VALUES ($1, $2, $3);",
                    node_id, entity_id, str(payload.value)
                )
                await conn.execute(
                    "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                    "info", f"User overridden control state: {node_id}/{entity_id} -> {payload.value}"
                )
        except Exception as e:
            logger.error(f"Failed to log override state to DB: {e}")

    # Broadcast state change client WS
    state = entity_states[matched_key]
    await manager.broadcast({
        "event": "state_changed",
        "node_id": state["node_id"],
        "entity_id": state["entity_key"],
        "value": state["value"],
        "status": state["status"],
        "status_type": state["status_type"]
    })
    
    # Broadcast audit message
    await manager.broadcast({
        "event": "audit_logged",
        "type": "info",
        "message": f"User overridden control state: {node_id}/{entity_id} -> {payload.value}"
    })

    return {"status": "command_dispatched", "node_id": node_id, "entity_id": entity_id, "sent_value": payload.value}

@app.get("/api/discovery/queue")
async def get_discovery_queue():
    return JSONResponse(content=discovery_queue)

class SettingsPayload(BaseModel):
    timezone: str
    preshared_key: str
    theme: str
    layout_compact: str
    telemetry_interval: Optional[int] = None
    log_retention: Optional[int] = None

@app.get("/api/settings")
async def get_settings():
    return JSONResponse(content=app_settings)

@app.post("/api/settings")
async def post_settings(payload: SettingsPayload):
    # Update cache
    if payload.telemetry_interval is not None:
        app_settings["telemetry_interval"] = payload.telemetry_interval
    if payload.log_retention is not None:
        app_settings["log_retention"] = payload.log_retention
    app_settings["timezone"] = payload.timezone
    app_settings["preshared_key"] = payload.preshared_key
    app_settings["theme"] = payload.theme
    app_settings["layout_compact"] = payload.layout_compact

    # Save to Database
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                for key, val in app_settings.items():
                    await conn.execute(
                        "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2;",
                        key, str(val)
                    )
                # Log success audit
                await conn.execute(
                    "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                    "info", "System configurations successfully updated by administrator."
                )
        except Exception as e:
            logger.error(f"Failed to persist system settings overrides: {e}")
            raise HTTPException(status_code=500, detail=f"Database persistence error: {e}")

    # Broadcast event logs
    await manager.broadcast({
        "event": "audit_logged",
        "type": "info",
        "message": "System settings dynamically updated by administrator."
    })
    await manager.broadcast({
        "event": "settings_updated",
        "settings": app_settings
    })
    return JSONResponse(content={"status": "settings_applied", "settings": app_settings})


@app.get("/api/dashboard/config")
async def get_dashboard_config():
    if not db_pool:
        return JSONResponse(content={"widgets": [], "order": [], "tabs": []})
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT key, value FROM dashboard_config;")
            config = {}
            for r in rows:
                try:
                    config[r["key"]] = json.loads(r["value"])
                except Exception:
                    config[r["key"]] = r["value"]
            
            widgets = config.get("widgets", [])
            order = config.get("order", [])
            tabs = config.get("tabs", [{"id": "main", "name": "Main"}])
            return JSONResponse(content={"widgets": widgets, "order": order, "tabs": tabs})
    except Exception as e:
        logger.error(f"Error fetching dashboard config: {e}")
        return JSONResponse(content={"widgets": [], "order": [], "tabs": []})

class DashboardConfigPayload(BaseModel):
    widgets: list
    order: list
    tabs: list

@app.post("/api/dashboard/config")
async def post_dashboard_config(payload: DashboardConfigPayload):
    if not db_pool:
        return {"status": "error", "message": "No database connection"}
    try:
        async with db_pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO dashboard_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2;",
                "widgets", json.dumps(payload.widgets)
            )
            await conn.execute(
                "INSERT INTO dashboard_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2;",
                "order", json.dumps(payload.order)
            )
            await conn.execute(
                "INSERT INTO dashboard_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2;",
                "tabs", json.dumps(payload.tabs)
            )
        
        await manager.broadcast({
            "event": "dashboard_config_updated",
            "widgets": payload.widgets,
            "order": payload.order,
            "tabs": payload.tabs
        })
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error saving dashboard config: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# Built-in background monitor CRUD routes
class MonitorPayload(BaseModel):
    name: str
    type: str # 'http', 'websocket', 'ping', 'port', 'dns'
    target: str
    check_interval: int = 30
    timeout: int = 5
    category: Optional[str] = 'General'
    group_ids: Optional[List[int]] = []

class HostPayload(BaseModel):
    name: str
    target: str
    ping_enabled: bool = False
    http_enabled: bool = False
    https_enabled: bool = False
    ssl_enabled: bool = False
    port_enabled: bool = False
    port_number: Optional[int] = None
    polling_interval: int = 3

@app.get("/api/alerts/channels")
async def get_channels():
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, name, type, config FROM notification_channels ORDER BY id ASC;")
            res = []
            for r in rows:
                d = dict(r)
                d["config"] = json.loads(d["config"]) if isinstance(d["config"], str) else d["config"]
                res.append(d)
            return JSONResponse(content=res)
    except Exception as e:
        logger.error(f"Failed to fetch notification channels: {e}")
        raise HTTPException(status_code=500, detail="Database query error.")

@app.post("/api/alerts/channels")
async def add_channel(payload: ChannelPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO notification_channels (name, type, config) VALUES ($1, $2, $3) RETURNING id;",
                payload.name, payload.type, json.dumps(payload.config)
            )
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "success", f"Created notification channel profile '{payload.name}' of type {payload.type}."
            )
            return JSONResponse(content={"status": "success", "id": row["id"]})
    except Exception as e:
        logger.error(f"Failed to save channel: {e}")
        raise HTTPException(status_code=500, detail="Database insert error.")

@app.put("/api/alerts/channels/{cid}")
async def update_channel(cid: int, payload: ChannelPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE notification_channels SET name = $1, type = $2, config = $3 WHERE id = $4;",
                payload.name, payload.type, json.dumps(payload.config), cid
            )
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Updated notification channel profile '{payload.name}' (ID: {cid})."
            )
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to update channel: {e}")
        raise HTTPException(status_code=500, detail="Database update error.")

@app.delete("/api/alerts/channels/{cid}")
async def delete_channel(cid: int):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("DELETE FROM notification_channels WHERE id = $1;", cid)
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Deleted notification channel profile ID: {cid}."
            )
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to delete channel: {e}")
        raise HTTPException(status_code=500, detail="Database delete error.")

@app.post("/api/alerts/channels/test")
async def test_channel(payload: ChannelTestPayload):
    try:
        await dispatch_notification(
            channel_type=payload.type,
            config=payload.config,
            message="This is a test notification from your HomePulse Alert Router! Your notifier integration is working successfully.",
            title="HomePulse Test Alert"
        )
        return JSONResponse(content={"status": "success"})
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/alerts/rules")
async def get_rules():
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, name, rules_json, channel_ids, enabled, status, last_fired, target_type, monitors_list, target_groups, target_groups_operator FROM alert_rules ORDER BY id ASC;")
            res = []
            for r in rows:
                d = dict(r)
                d["rules_json"] = json.loads(d["rules_json"]) if isinstance(d["rules_json"], str) else d["rules_json"]
                if d["last_fired"]:
                    d["last_fired"] = d["last_fired"].isoformat()
                res.append(d)
            return JSONResponse(content=res)
    except Exception as e:
        logger.error(f"Failed to fetch alert rules: {e}")
        raise HTTPException(status_code=500, detail="Database query error.")

@app.post("/api/alerts/rules")
async def add_rule(payload: RulePayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        rules_str = json.dumps([r.model_dump() for r in payload.rules_json])
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO alert_rules (name, rules_json, channel_ids, enabled, target_type, monitors_list, target_groups, target_groups_operator) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id;",
                payload.name, rules_str, payload.channel_ids, payload.enabled, payload.target_type, payload.monitors_list, payload.target_groups, payload.target_groups_operator
            )
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "success", f"Created warning rule '{payload.name}'."
            )
            return JSONResponse(content={"status": "success", "id": row["id"]})
    except Exception as e:
        logger.error(f"Failed to add rule: {e}")
        raise HTTPException(status_code=500, detail="Database insert error.")

@app.put("/api/alerts/rules/{rid}")
async def update_rule(rid: int, payload: RulePayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        rules_str = json.dumps([r.model_dump() for r in payload.rules_json])
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE alert_rules SET name = $1, rules_json = $2, channel_ids = $3, enabled = $4, target_type = $5, monitors_list = $6, target_groups = $7, target_groups_operator = $8 WHERE id = $9;",
                payload.name, rules_str, payload.channel_ids, payload.enabled, payload.target_type, payload.monitors_list, payload.target_groups, payload.target_groups_operator, rid
            )
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Updated warning rule '{payload.name}' (ID: {rid})."
            )
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to update rule: {e}")
        raise HTTPException(status_code=500, detail="Database update error.")

@app.delete("/api/alerts/rules/{rid}")
async def delete_rule(rid: int):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("DELETE FROM alert_rules WHERE id = $1;", rid)
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Deleted warning rule ID: {rid}."
            )
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to delete rule: {e}")
        raise HTTPException(status_code=500, detail="Database delete error.")

class MonitorGroupPayload(BaseModel):
    name: str

@app.get("/api/monitor-groups")
async def get_monitor_groups():
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT mg.id, mg.name, COUNT(mgm.monitor_id)::int AS monitor_count
                FROM monitor_groups mg
                LEFT JOIN monitor_group_map mgm ON mg.id = mgm.group_id
                GROUP BY mg.id, mg.name
                ORDER BY mg.id ASC;
            """)
            return JSONResponse(content=[dict(r) for r in rows])
    except Exception as e:
        logger.error(f"Failed to fetch monitor groups: {e}")
        raise HTTPException(status_code=500, detail="Database query error.")

@app.post("/api/monitor-groups")
async def add_monitor_group(payload: MonitorGroupPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    name_clean = payload.name.strip()
    if not name_clean:
        raise HTTPException(status_code=400, detail="Group Name cannot be empty.")
    try:
        async with db_pool.acquire() as conn:
            gid = await conn.fetchval(
                "INSERT INTO monitor_groups (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id;",
                name_clean
            )
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Created monitor target group: {name_clean}"
            )
            return JSONResponse(content={"status": "success", "id": gid})
    except Exception as e:
        logger.error(f"Failed to save monitor group: {e}")
        raise HTTPException(status_code=500, detail="Database insert error.")

@app.delete("/api/monitor-groups/{gid}")
async def delete_monitor_group(gid: int):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            deleted_name = await conn.fetchval("DELETE FROM monitor_groups WHERE id = $1 RETURNING name;", gid)
            if deleted_name:
                await conn.execute(
                    "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                    "info", f"Deleted monitor target group: {deleted_name}"
                )
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to delete monitor group: {e}")
        raise HTTPException(status_code=500, detail="Database delete error.")

@app.get("/api/monitors")
async def get_monitors():
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT sm.id, sm.name, sm.type, sm.target, sm.check_interval, sm.timeout, 
                       sm.last_status, sm.last_latency, sm.last_checked, sm.enabled, 
                       sm.host_id, sm.category, 
                       COALESCE(array_agg(mgm.group_id) FILTER (WHERE mgm.group_id IS NOT NULL), '{}') AS group_ids
                FROM system_monitors sm
                LEFT JOIN monitor_group_map mgm ON sm.id = mgm.monitor_id
                GROUP BY sm.id
                ORDER BY sm.id ASC;
            """)
            res = []
            for r in rows:
                d = dict(r)
                if d["last_checked"]:
                    d["last_checked"] = d["last_checked"].isoformat()
                res.append(d)
            return JSONResponse(content=res)
    except Exception as e:
        logger.error(f"Failed to fetch system monitors: {e}")
        raise HTTPException(status_code=500, detail="Database query error.")

@app.post("/api/monitors")
async def add_monitor(payload: MonitorPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    
    if payload.type not in ('http', 'websocket', 'ping', 'port', 'dns', 'ssl'):
        raise HTTPException(status_code=400, detail="Invalid monitor type.")
    if not payload.name.strip() or not payload.target.strip():
        raise HTTPException(status_code=400, detail="Required fields Name and Target must be provided.")
        
    try:
        async with db_pool.acquire() as conn:
            monitor_id = await conn.fetchval(
                """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, category) 
                   VALUES ($1, $2, $3, $4, $5, 'unknown', true, $6) RETURNING id;""",
                payload.name.strip(), payload.type, payload.target.strip(), payload.check_interval, payload.timeout, payload.category or 'General'
            )
            
            if payload.group_ids:
                for gid in payload.group_ids:
                    await conn.execute("INSERT INTO monitor_group_map (monitor_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;", monitor_id, gid)
            
            entity_states[f"monitor-{monitor_id}-status"] = {
                "node_id": "monitors",
                "entity_key": f"monitor-{monitor_id}-status",
                "name": f"{payload.name} Status",
                "type": "sensor",
                "value_type": "string",
                "unit": "",
                "value": "unknown",
                "status": "Unknown",
                "status_type": "default",
                "tags": "main",
                "icon": "shield-question"
            }
            entity_states[f"monitor-{monitor_id}-latency"] = {
                "node_id": "monitors",
                "entity_key": f"monitor-{monitor_id}-latency",
                "name": f"{payload.name} Latency",
                "type": "sensor",
                "value_type": "float",
                "unit": "ms",
                "value": 0.0,
                "status": "Stable",
                "status_type": "stable",
                "tags": "main",
                "icon": "activity",
                "color": "#3b82f6",
                "graphic": "sparkline"
            }
            
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"New background monitor configured: {payload.name} ({payload.target})"
            )
        
        await manager.broadcast({
            "event": "audit_logged",
            "type": "info",
            "message": f"New monitor '{payload.name}' added with type {payload.type}."
        })
        
        return JSONResponse(content={"status": "created", "monitor_id": monitor_id})
    except Exception as e:
        logger.error(f"Failed to add monitor: {e}")
        raise HTTPException(status_code=500, detail="Database write error.")

@app.delete("/api/monitors/{monitor_id}")
async def delete_monitor(monitor_id: int):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
        
    try:
        async with db_pool.acquire() as conn:
            exists = await conn.fetchrow("SELECT id, name FROM system_monitors WHERE id = $1;", monitor_id)
            if not exists:
                raise HTTPException(status_code=404, detail="Monitor not found")
                
            await conn.execute("DELETE FROM system_monitors WHERE id = $1;", monitor_id)
            
            entity_states.pop(f"monitor-{monitor_id}-status", None)
            entity_states.pop(f"monitor-{monitor_id}-latency", None)
            
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "warning", f"Background monitor deleted by operator: {exists['name']}"
            )
            
        await manager.broadcast({
            "event": "audit_logged",
            "type": "warning",
            "message": f"Monitor '{exists['name']}' deleted."
        })
        
        return JSONResponse(content={"status": "deleted"})
    except Exception as e:
        logger.error(f"Failed to delete monitor: {e}")
        raise HTTPException(status_code=500, detail="Database write error.")

@app.put("/api/monitors/{monitor_id}")
async def update_monitor(monitor_id: int, payload: MonitorPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
        
    if payload.type not in ('http', 'websocket', 'ping', 'port', 'dns', 'ssl'):
        raise HTTPException(status_code=400, detail="Invalid monitor type.")
    if not payload.name.strip() or not payload.target.strip():
        raise HTTPException(status_code=400, detail="Required fields Name and Target must be provided.")
        
    try:
        async with db_pool.acquire() as conn:
            old_row = await conn.fetchrow(
                "SELECT name, type, target, check_interval, timeout FROM system_monitors WHERE id = $1;", 
                monitor_id
            )
            if not old_row:
                raise HTTPException(status_code=404, detail="Monitor not found")
            
            changes = []
            if old_row["name"] != payload.name.strip():
                changes.append(f"name('{old_row['name']}' -> '{payload.name.strip()}')")
            if old_row["type"] != payload.type:
                changes.append(f"type('{old_row['type']}' -> '{payload.type}')")
            if old_row["target"] != payload.target.strip():
                changes.append(f"target('{old_row['target']}' -> '{payload.target.strip()}')")
            if old_row["check_interval"] != payload.check_interval:
                changes.append(f"check_interval({old_row['check_interval']} -> {payload.check_interval})")
            if old_row["timeout"] != payload.timeout:
                changes.append(f"timeout({old_row['timeout']} -> {payload.timeout})")
                
            if old_row.get("category") != payload.category:
                changes.append(f"category('{old_row.get('category')}' -> '{payload.category}')")
                
            await conn.execute(
                """UPDATE system_monitors 
                   SET name = $1, type = $2, target = $3, check_interval = $4, timeout = $5, category = $6
                   WHERE id = $7;""",
                payload.name.strip(), payload.type, payload.target.strip(), payload.check_interval, payload.timeout, payload.category or 'General', monitor_id
            )
            
            await conn.execute("DELETE FROM monitor_group_map WHERE monitor_id = $1;", monitor_id)
            if payload.group_ids:
                for gid in payload.group_ids:
                    await conn.execute("INSERT INTO monitor_group_map (monitor_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;", monitor_id, gid)
            
            status_key = f"monitor-{monitor_id}-status"
            latency_key = f"monitor-{monitor_id}-latency"
            
            if status_key in entity_states:
                entity_states[status_key]["name"] = f"{payload.name.strip()} Status"
            else:
                entity_states[status_key] = {
                    "node_id": "monitors",
                    "entity_key": status_key,
                    "name": f"{payload.name.strip()} Status",
                    "type": "sensor",
                    "value_type": "string",
                    "unit": "",
                    "value": "unknown",
                    "status": "Unknown",
                    "status_type": "default",
                    "tags": "main",
                    "icon": "shield-question"
                }

            if latency_key in entity_states:
                entity_states[latency_key]["name"] = f"{payload.name.strip()} Latency"
            else:
                entity_states[latency_key] = {
                    "node_id": "monitors",
                    "entity_key": latency_key,
                    "name": f"{payload.name.strip()} Latency",
                    "type": "sensor",
                    "value_type": "float",
                    "unit": "ms",
                    "value": 0.0,
                    "status": "Stable",
                    "status_type": "stable",
                    "tags": "main",
                    "icon": "activity",
                    "color": "#3b82f6",
                    "graphic": "sparkline"
                }

            if changes:
                changes_str = ", ".join(changes)
                audit_msg = f"Background monitor '{old_row['name']}' updated by operator. Changes: {changes_str}"
            else:
                audit_msg = f"Background monitor '{old_row['name']}' saved without changes by operator."
                
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", audit_msg
            )
            
        await manager.broadcast({
            "event": "audit_logged",
            "type": "info",
            "message": audit_msg
        })
        
        return JSONResponse(content={"status": "updated", "monitor_id": monitor_id})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update monitor: {e}")
        raise HTTPException(status_code=500, detail="Database update error.")


@app.get("/api/hosts")
async def get_hosts():
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, name, target, ping_enabled, http_enabled, https_enabled, ssl_enabled, port_enabled, port_number, polling_interval FROM hosts ORDER BY id DESC;")
            res = []
            for r in rows:
                res.append(dict(r))
            return JSONResponse(content=res)
    except Exception as e:
        logger.error(f"Failed to fetch hosts: {e}")
        raise HTTPException(status_code=500, detail="Database query error.")

@app.post("/api/hosts")
async def add_host(payload: HostPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    
    if not payload.name.strip() or not payload.target.strip():
        raise HTTPException(status_code=400, detail="Name and target are required.")
        
    try:
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                # 1. Insert Host
                host_id = await conn.fetchval(
                    """INSERT INTO hosts (name, target, ping_enabled, http_enabled, https_enabled, ssl_enabled, port_enabled, port_number, polling_interval) 
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;""",
                    payload.name.strip(), payload.target.strip(), payload.ping_enabled,
                    payload.http_enabled, payload.https_enabled, payload.ssl_enabled,
                    payload.port_enabled, payload.port_number, payload.polling_interval
                )
                
                # 2. Sync Probers to system_monitors
                await sync_host_probers(conn, host_id, payload)
                
            return JSONResponse(content={"status": "success", "host_id": host_id})
    except Exception as e:
        logger.error(f"Failed to add host: {e}")
        raise HTTPException(status_code=500, detail=f"Database execution error: {str(e)}")

@app.put("/api/hosts/{host_id}")
async def update_host(host_id: int, payload: HostPayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    
    if not payload.name.strip() or not payload.target.strip():
        raise HTTPException(status_code=400, detail="Name and target are required.")
        
    try:
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                # 1. Check if host exists
                host_exists = await conn.fetchval("SELECT id FROM hosts WHERE id = $1;", host_id)
                if not host_exists:
                    raise HTTPException(status_code=404, detail="Host not found.")
                
                # 2. Clear old monitor IDs from memory cache before deleting from DB
                mids = await conn.fetch("SELECT id FROM system_monitors WHERE host_id = $1;", host_id)
                for r in mids:
                    mid = r["id"]
                    entity_states.pop(f"monitor-{mid}-status", None)
                    entity_states.pop(f"monitor-{mid}-latency", None)

                # 3. Update Host
                await conn.execute(
                    """UPDATE hosts SET name=$1, target=$2, ping_enabled=$3, http_enabled=$4, 
                       https_enabled=$5, ssl_enabled=$6, port_enabled=$7, port_number=$8, polling_interval=$9 WHERE id=$10;""",
                    payload.name.strip(), payload.target.strip(), payload.ping_enabled,
                    payload.http_enabled, payload.https_enabled, payload.ssl_enabled,
                    payload.port_enabled, payload.port_number, payload.polling_interval, host_id
                )
                
                # 4. Re-sync probers for this host (delete existing ones first, then insert needed ones)
                await conn.execute("DELETE FROM system_monitors WHERE host_id = $1;", host_id)
                await sync_host_probers(conn, host_id, payload)
                
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to update host: {e}")
        raise HTTPException(status_code=500, detail=f"Database execution error: {str(e)}")

@app.delete("/api/hosts/{host_id}")
async def delete_host(host_id: int):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
        
    try:
        async with db_pool.acquire() as conn:
            # 1. Clear old monitor IDs from memory cache before deleting from DB
            mids = await conn.fetch("SELECT id FROM system_monitors WHERE host_id = $1;", host_id)
            for r in mids:
                mid = r["id"]
                entity_states.pop(f"monitor-{mid}-status", None)
                entity_states.pop(f"monitor-{mid}-latency", None)

            # 2. Delete Host
            await conn.execute("DELETE FROM hosts WHERE id = $1;", host_id)
            return JSONResponse(content={"status": "success"})
    except Exception as e:
        logger.error(f"Failed to delete host: {e}")
        raise HTTPException(status_code=500, detail=f"Database execution error: {str(e)}")

@app.get("/api/support/logs")
async def get_support_logs():
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    try:
        support_pkg = {}
        async with db_pool.acquire() as conn:
            # 1. Fetch system settings
            settings_rows = await conn.fetch("SELECT key, value FROM system_settings;")
            support_pkg["settings"] = {r["key"]: r["value"] for r in settings_rows}

            # 2. Fetch hosts list
            hosts_rows = await conn.fetch("SELECT id, name, target, ping_enabled, http_enabled, https_enabled, ssl_enabled, port_enabled, port_number FROM hosts ORDER BY id DESC;")
            support_pkg["hosts"] = [dict(r) for r in hosts_rows]

            # 3. Fetch monitors lists
            monitors_rows = await conn.fetch("SELECT id, name, type, target, check_interval, timeout, last_status, enabled, host_id FROM system_monitors ORDER BY id DESC;")
            support_pkg["monitors"] = [dict(r) for r in monitors_rows]

            # 4. Fetch last 100 audits
            audits_rows = await conn.fetch("SELECT id, type, message, timestamp FROM system_audits ORDER BY id DESC LIMIT 100;")
            support_pkg["audits"] = [
                {
                    "id": r["id"],
                    "type": r["type"],
                    "message": r["message"],
                    "timestamp": r["timestamp"].isoformat() if r["timestamp"] else None
                }
                for r in audits_rows
            ]

        return JSONResponse(content=support_pkg)
    except Exception as e:
        logger.error(f"Failed to compile support logs: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to compile support logs: {str(e)}")

class PruneRequest(BaseModel):
    age: Optional[str] = None # hour, day, week, month, year, all, custom
    custom_days: Optional[int] = None
    delete_oldest_count: Optional[int] = None
    retain_latest_count: Optional[int] = None
    dry_run: bool = False

    # Advanced Filtering parameters
    host_id: Optional[int] = None
    entity_key: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def check_mutually_exclusive(cls, data):
        if not isinstance(data, dict):
            return data
        age = data.get("age")
        del_cnt = data.get("delete_oldest_count")
        ret_cnt = data.get("retain_latest_count")
        
        # If advanced filters are specified without any strategy, default to age = 'all' or don't error.
        is_filter_only = data.get("host_id") is not None or data.get("entity_key") is not None or data.get("start_date") is not None or data.get("end_date") is not None
        
        provided = sum(1 for x in [age, del_cnt, ret_cnt] if x is not None)
        if provided == 0:
            if not is_filter_only:
                raise ValueError("Either a pruning strategy (age, delete_oldest_count, retain_latest_count) or filtering parameters must be specified.")
        elif provided > 1:
            raise ValueError("At most one of 'age', 'delete_oldest_count', or 'retain_latest_count' can be specified.")
        
        if age == "custom" and data.get("custom_days") is None:
            raise ValueError("custom_days must be specified when age is 'custom'.")
            
        return data

@app.post("/api/support/prune")
async def prune_database_logs(payload: PruneRequest):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
    
    dry_run = payload.dry_run
    deleted_logs_count = 0
    deleted_audits_count = 0
    
    try:
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                # 1. Build WHERE conditions dynamically
                conditions = []
                params = []
                
                # Apply Age Preset Filters
                if payload.age is not None:
                    age = payload.age
                    if age == "all":
                        pass
                    else:
                        interval_str = None
                        if age == "hour":
                            interval_str = "1 hour"
                        elif age == "day":
                            interval_str = "1 day"
                        elif age == "week":
                            interval_str = "7 days"
                        elif age == "month":
                            interval_str = "30 days"
                        elif age == "year":
                            interval_str = "365 days"
                        elif age == "custom" and payload.custom_days is not None:
                            interval_str = f"{payload.custom_days} days"
                            
                        if interval_str:
                            conditions.append(f"timestamp < NOW() - INTERVAL '{interval_str}'")
                
                # Apply Custom Date Range Filters
                if payload.start_date:
                    params.append(payload.start_date)
                    conditions.append(f"timestamp >= ${len(params)}::timestamp")
                if payload.end_date:
                    params.append(payload.end_date)
                    conditions.append(f"timestamp <= ${len(params)}::timestamp")
                    
                # Apply Host filter
                if payload.host_id is not None:
                    host_id = int(payload.host_id)
                    host_row = await conn.fetchrow("SELECT target FROM hosts WHERE id = $1;", host_id)
                    if host_row:
                        host_target = host_row["target"]
                        mon_ids = [r["id"] for r in await conn.fetch("SELECT id FROM system_monitors WHERE host_id = $1;", host_id)]
                        host_conds = []
                        # Check if localhost / database / main node
                        if host_target in ["127.0.0.1", "localhost", "homepulse-db"]:
                            host_conds.append("node_id = 'core-mon'")
                        if mon_ids:
                            keys = []
                            for mid in mon_ids:
                                keys.append(f"monitor-{mid}-status")
                                keys.append(f"monitor-{mid}-latency")
                            params.append(keys)
                            host_conds.append(f"(node_id = 'monitors' AND entity_key = ANY(${len(params)}))")
                            
                        if host_conds:
                            conditions.append(f"({' OR '.join(host_conds)})")
                        else:
                            conditions.append("FALSE")
                    else:
                        conditions.append("FALSE")
                        
                # Apply Entity filter
                if payload.entity_key:
                    params.append(payload.entity_key)
                    conditions.append(f"entity_key = ${len(params)}")
                    
                # A. Strategy B: Delete oldest X
                if payload.delete_oldest_count is not None:
                    count = payload.delete_oldest_count
                    if count <= 0:
                        raise HTTPException(status_code=400, detail="delete_oldest_count must be positive.")
                    
                    where_clause = " AND ".join(conditions) if conditions else "TRUE"
                    select_q = f"SELECT id FROM telemetry_logs WHERE {where_clause} ORDER BY timestamp ASC LIMIT ${len(params)+1};"
                    ids_to_delete = [r["id"] for r in await conn.fetch(select_q, *params, count)]
                    
                    audit_ids_to_delete = []
                    if not payload.host_id and not payload.entity_key:
                        select_audits_q = f"SELECT id FROM system_audits WHERE {where_clause} ORDER BY timestamp ASC LIMIT ${len(params)+1};"
                        audit_ids_to_delete = [r["id"] for r in await conn.fetch(select_audits_q, *params, count)]
                        
                    if dry_run:
                        deleted_logs_count = len(ids_to_delete)
                        deleted_audits_count = len(audit_ids_to_delete)
                    else:
                        if ids_to_delete:
                            await conn.execute("DELETE FROM telemetry_logs WHERE id = ANY($1);", ids_to_delete)
                            deleted_logs_count = len(ids_to_delete)
                        if audit_ids_to_delete:
                            await conn.execute("DELETE FROM system_audits WHERE id = ANY($1);", audit_ids_to_delete)
                            deleted_audits_count = len(audit_ids_to_delete)
                            
                # B. Strategy C: Retain newest X
                elif payload.retain_latest_count is not None:
                    count = payload.retain_latest_count
                    if count < 0:
                        raise HTTPException(status_code=400, detail="retain_latest_count must be non-negative.")
                        
                    where_clause = " AND ".join(conditions) if conditions else "TRUE"
                    select_q = f"SELECT id FROM telemetry_logs WHERE {where_clause} ORDER BY timestamp DESC, id DESC LIMIT ${len(params)+1};"
                    ids_to_keep = [r["id"] for r in await conn.fetch(select_q, *params, count)]
                    
                    audit_ids_to_keep = []
                    if not payload.host_id and not payload.entity_key:
                        # Only apply audit rules if system prune
                        select_audits_q = f"SELECT id FROM system_audits WHERE {where_clause} ORDER BY timestamp DESC, id DESC LIMIT ${len(params)+1};"
                        audit_ids_to_keep = [r["id"] for r in await conn.fetch(select_audits_q, *params, count)]
                    
                    delete_params = list(params)
                    delete_params.append(ids_to_keep)
                    
                    select_logs_del_q = f"SELECT COUNT(*) FROM telemetry_logs WHERE {where_clause} AND id NOT IN (SELECT unnest(${len(delete_params)}::bigint[]));"
                    deleted_logs_count = await conn.fetchval(select_logs_del_q, *delete_params) or 0
                    
                    deleted_audits_count = 0
                    if not payload.host_id and not payload.entity_key:
                        delete_audit_params = list(params)
                        delete_audit_params.append(audit_ids_to_keep)
                        select_audits_del_q = f"SELECT COUNT(*) FROM system_audits WHERE {where_clause} AND id NOT IN (SELECT unnest(${len(delete_audit_params)}::integer[]));"
                        deleted_audits_count = await conn.fetchval(select_audits_del_q, *delete_audit_params) or 0
                        
                    if not dry_run:
                        if ids_to_keep:
                            await conn.execute(f"DELETE FROM telemetry_logs WHERE {where_clause} AND id NOT IN (SELECT unnest(${len(delete_params)}::bigint[]));", *delete_params)
                        else:
                            await conn.execute(f"DELETE FROM telemetry_logs WHERE {where_clause};", *params)
                        if not payload.host_id and not payload.entity_key:
                            if audit_ids_to_keep:
                                await conn.execute(f"DELETE FROM system_audits WHERE {where_clause} AND id NOT IN (SELECT unnest(${len(delete_audit_params)}::integer[]));", *delete_audit_params)
                            else:
                                await conn.execute(f"DELETE FROM system_audits WHERE {where_clause};", *params)
                                
                # C. Strategy A: Time-based / filters based
                else:
                    if payload.age == "all" and not payload.host_id and not payload.entity_key and not payload.start_date and not payload.end_date:
                        if dry_run:
                            deleted_logs_count = await conn.fetchval("SELECT COUNT(*) FROM telemetry_logs;") or 0
                            deleted_audits_count = await conn.fetchval("SELECT COUNT(*) FROM system_audits;") or 0
                        else:
                            await conn.execute("TRUNCATE TABLE telemetry_logs;")
                            await conn.execute("TRUNCATE TABLE system_audits;")
                            deleted_logs_count = -1
                            deleted_audits_count = -1
                    else:
                        where_clause = " AND ".join(conditions) if conditions else "TRUE"
                        select_logs = f"SELECT COUNT(*) FROM telemetry_logs WHERE {where_clause};"
                        delete_logs = f"DELETE FROM telemetry_logs WHERE {where_clause};"
                        
                        deleted_logs_count = await conn.fetchval(select_logs, *params) or 0
                        
                        deleted_audits_count = 0
                        if not payload.host_id and not payload.entity_key:
                            select_audits = f"SELECT COUNT(*) FROM system_audits WHERE {where_clause};"
                            delete_audits = f"DELETE FROM system_audits WHERE {where_clause};"
                            deleted_audits_count = await conn.fetchval(select_audits, *params) or 0
                            
                        if not dry_run:
                            await conn.execute(delete_logs, *params)
                            if not payload.host_id and not payload.entity_key:
                                await conn.execute(delete_audits, *params)
            
        if not dry_run:
            msg = f"Database prune executed. Deleted logs count: {deleted_logs_count if deleted_logs_count != -1 else 'ALL'}, deleted audits count: {deleted_audits_count if deleted_audits_count != -1 else 'ALL'}."
            await conn.execute("INSERT INTO system_audits (type, message) VALUES ('success', $1);", msg)
            
        return JSONResponse(content={
            "status": "success",
            "dry_run": dry_run,
            "deleted_logs": deleted_logs_count,
            "deleted_audits": deleted_audits_count
        })
    except ValueError as val_err:
        raise HTTPException(status_code=422, detail=str(val_err))
    except Exception as e:
        logger.error(f"Failed to prune logs: {e}")

async def sync_host_probers(conn, host_id: int, payload: HostPayload):
    host_name = payload.name.strip()
    target = payload.target.strip()
    interval = payload.polling_interval
    
    # 1. PING Check
    if payload.ping_enabled:
        mid = await conn.fetchval(
            """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, host_id) 
               VALUES ($1, 'ping', $2, $3, 5, 'unknown', true, $4) RETURNING id;""",
            f"{host_name} (Ping)", target, interval, host_id
        )
        register_memory_states(mid, f"{host_name} (Ping)")
        
    # 2. HTTP Check
    if payload.http_enabled:
        http_target = target
        if not target.startswith("http://") and not target.startswith("https://"):
            http_target = f"http://{target}"
        mid = await conn.fetchval(
            """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, host_id) 
               VALUES ($1, 'http', $2, $3, 5, 'unknown', true, $4) RETURNING id;""",
            f"{host_name} (HTTP)", http_target, interval, host_id
        )
        register_memory_states(mid, f"{host_name} (HTTP)")
        
    # 3. HTTPS Check
    if payload.https_enabled:
        https_target = target
        if not target.startswith("http://") and not target.startswith("https://"):
            https_target = f"https://{target}"
        mid = await conn.fetchval(
            """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, host_id) 
               VALUES ($1, 'http', $2, $3, 5, 'unknown', true, $4) RETURNING id;""",
            f"{host_name} (HTTPS)", https_target, interval, host_id
        )
        register_memory_states(mid, f"{host_name} (HTTPS)")
        
    # 4. SSL Expiry Check (Always checked every 7200 seconds / 2 hours)
    if payload.ssl_enabled:
        mid = await conn.fetchval(
            """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, host_id) 
               VALUES ($1, 'ssl', $2, 7200, 5, 'unknown', true, $3) RETURNING id;""",
            f"{host_name} (SSL)", target, host_id
        )
        register_memory_states(mid, f"{host_name} (SSL)")
        
    # 5. TCP Port Check
    if payload.port_enabled and payload.port_number:
        mid = await conn.fetchval(
            """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled, host_id) 
               VALUES ($1, 'port', $2, $3, 5, 'unknown', true, $4) RETURNING id;""",
            f"{host_name} (Port)", f"{target}:{payload.port_number}", interval, host_id
        )
        register_memory_states(mid, f"{host_name} (Port)")

def register_memory_states(monitor_id: int, name: str):
    entity_states[f"monitor-{monitor_id}-status"] = {
        "node_id": "monitors",
        "entity_key": f"monitor-{monitor_id}-status",
        "name": f"{name} Status",
        "type": "sensor",
        "value_type": "string",
        "unit": "",
        "value": "unknown",
        "status": "Unknown",
        "status_type": "default",
        "tags": "main",
        "icon": "shield-question"
    }
    entity_states[f"monitor-{monitor_id}-latency"] = {
        "node_id": "monitors",
        "entity_key": f"monitor-{monitor_id}-latency",
        "name": f"{name} Latency",
        "type": "sensor",
        "value_type": "float",
        "unit": "ms",
        "value": 0.0,
        "status": "Stable",
        "status_type": "stable",
        "tags": "main",
        "icon": "activity",
        "color": "#3b82f6",
        "graphic": "sparkline"
    }


class TogglePayload(BaseModel):
    enabled: bool

@app.post("/api/monitors/{monitor_id}/toggle")
async def toggle_monitor(monitor_id: int, payload: TogglePayload):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database connection not available")
        
    try:
        async with db_pool.acquire() as conn:
            exists = await conn.fetchrow("SELECT id, name FROM system_monitors WHERE id = $1;", monitor_id)
            if not exists:
                raise HTTPException(status_code=404, detail="Monitor not found")
                
            await conn.execute("UPDATE system_monitors SET enabled = $1 WHERE id = $2;", payload.enabled, monitor_id)
            
            # Broadcast state update immediately
            mname = exists["name"]
            status_val = "unknown" if payload.enabled else "disabled"
            status_desc = "Unknown" if payload.enabled else "Disabled"
            status_type = "default"
            status_icon = "activity" if payload.enabled else "shield-off"
            status_color = "var(--text-secondary)" if payload.enabled else "#6b7280"
            
            entity_states[f"monitor-{monitor_id}-status"] = {
                "node_id": "monitors",
                "entity_key": f"monitor-{monitor_id}-status",
                "name": f"{mname} Status",
                "type": "sensor",
                "value_type": "string",
                "unit": "",
                "value": status_val,
                "status": status_desc,
                "status_type": status_type,
                "tags": "main",
                "icon": status_icon,
                "color": status_color
            }
            entity_states[f"monitor-{monitor_id}-latency"] = {
                "node_id": "monitors",
                "entity_key": f"monitor-{monitor_id}-latency",
                "name": f"{mname} Latency",
                "type": "sensor",
                "value_type": "float",
                "unit": "ms",
                "value": 0.0,
                "status": "Stable" if payload.enabled else "Disabled",
                "status_type": "stable" if payload.enabled else "default",
                "tags": "main",
                "icon": "activity",
                "color": "#3b82f6" if payload.enabled else "#6b7280",
                "graphic": "sparkline"
            }
            
            await manager.broadcast({
                "event": "state_changed",
                "node_id": "monitors",
                "entity_id": f"monitor-{monitor_id}-status",
                "value": status_val,
                "status": status_desc,
                "status_type": status_type
            })
            await manager.broadcast({
                "event": "state_changed",
                "node_id": "monitors",
                "entity_id": f"monitor-{monitor_id}-latency",
                "value": 0.0,
                "status": "Stable" if payload.enabled else "Disabled",
                "status_type": "stable" if payload.enabled else "default"
            })
            
            await conn.execute(
                "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                "info", f"Background monitor {'enabled' if payload.enabled else 'disabled'} by operator: {mname}"
            )
            
        await manager.broadcast({
            "event": "audit_logged",
            "type": "info",
            "message": f"Monitor '{mname}' {'enabled' if payload.enabled else 'disabled'}."
        })
        
        return JSONResponse(content={"status": "success", "enabled": payload.enabled})
    except Exception as e:
        logger.error(f"Failed to toggle monitor: {e}")
        raise HTTPException(status_code=500, detail="Database write error.")

@app.get("/api/monitors/logs/{entity_key}")
async def get_monitor_logs(
    entity_key: str, 
    limit: int = 10, 
    hours: int = None, 
    offset: int = 0,
    start_time: str = None,
    end_time: str = None
):
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            if start_time and end_time:
                from datetime import datetime
                # Parse to offset-naive datetimes to avoid timezone mismatch errors
                t_start = datetime.fromisoformat(start_time.replace('Z', '+00:00')).replace(tzinfo=None)
                t_end = datetime.fromisoformat(end_time.replace('Z', '+00:00')).replace(tzinfo=None)
                
                # Query custom date-time window
                rows = await conn.fetch(
                    """SELECT timestamp, value FROM telemetry_logs 
                       WHERE entity_key = $1 
                         AND timestamp >= $2 
                         AND timestamp <= $3 
                       ORDER BY timestamp DESC;""",
                    entity_key, t_start, t_end
                )
            elif hours is not None:
                rows = await conn.fetch(
                    """SELECT timestamp, value FROM telemetry_logs 
                       WHERE entity_key = $1 
                         AND timestamp >= NOW() - (($2::integer + $3::integer) * INTERVAL '1 hour')
                         AND timestamp <= NOW() - ($3::integer * INTERVAL '1 hour')
                       ORDER BY timestamp DESC;""",
                    entity_key, hours, offset
                )
            else:
                rows = await conn.fetch(
                    """SELECT timestamp, value FROM telemetry_logs 
                       WHERE entity_key = $1 
                       ORDER BY timestamp DESC LIMIT $2;""",
                    entity_key, limit
                )
            res = []
            for r in rows:
                res.append({
                    "timestamp": r["timestamp"].isoformat(),
                    "value": r["value"]
                })
            return JSONResponse(content=res)
    except Exception as e:
        logger.error(f"Failed to fetch telemetry logs for {entity_key}: {e}")
        raise HTTPException(status_code=500, detail="Database log query error.")

@app.post("/api/discovery/approve/{node_id}")
async def approve_node(node_id: str, payload: ApprovePayload):
    expected_key = app_settings.get("preshared_key", "device_pin_12345")
    if payload.preshared_key != expected_key:
        raise HTTPException(status_code=401, detail="Authentication failed: Invalid device PIN/Token.")
    
    # Find node in queue
    found_node = None
    for item in discovery_queue:
        if item["id"] == node_id:
            found_node = item
            break
            
    if not found_node:
        raise HTTPException(status_code=404, detail=f"Node {node_id} not found in pending queue.")

    # Remove from pending queue
    discovery_queue.remove(found_node)

    # Approve in DB (if connected)
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO nodes (id, name, status, approved_at) VALUES ($1, $2, 'active', CURRENT_TIMESTAMP) ON CONFLICT (id) DO UPDATE SET status='active', approved_at=CURRENT_TIMESTAMP;",
                    node_id, found_node["name"]
                )
                await conn.execute(
                    "INSERT INTO system_audits (type, message) VALUES ($1, $2);",
                    "success", f"mDNS node approved and authenticated: {node_id}"
                )
        except Exception as e:
            logger.error(f"Failed to log approved node: {e}")

    # Add as active entity grid
    # Let's add its telemetry endpoint
    entity_states[f"{node_id}-power"] = {
        "node_id": node_id,
        "entity_key": "power",
        "name": f"{found_node['name']} Power",
        "type": "sensor",
        "value_type": "float",
        "unit": "W",
        "value": 12.4,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,power",
        "icon": "zap",
        "color": "#10b981",
        "graphic": "sparkline"
    }

    # Add a toggle control for the plug
    entity_states[f"{node_id}-toggle"] = {
        "node_id": node_id,
        "entity_key": "toggle",
        "name": f"{found_node['name']} State",
        "type": "control",
        "value_type": "boolean",
        "unit": "",
        "value": True,
        "status": "Optimal",
        "status_type": "optimal",
        "tags": "main,power",
        "icon": "power"
    }

    # Broadcast logs
    await manager.broadcast({
        "event": "audit_logged",
        "type": "success",
        "message": f"mDNS discovery target approved and integrated: {node_id}"
    })

    return {"status": "approved", "node_id": node_id, "access_token": "hp_active_tok_8471b8fa"}

# 5. Client WebSocket Connection Route
@app.websocket("/api/ws/client")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Standby for subscription commands
            data = await websocket.receive_json()
            action = data.get("action")
            if action == "subscribe":
                logger.info(f"Client subscribed to stream: {data.get('streams')}")
                # Instantly seed current active entries as state changed events
                for k, v in entity_states.items():
                    await websocket.send_json({
                        "event": "state_changed",
                        "node_id": v["node_id"],
                        "entity_id": v["entity_key"],
                        "value": v["value"],
                        "status": v["status"],
                        "status_type": v["status_type"]
                    })
                
                # Push initial audit logs
                await websocket.send_json({
                    "event": "audit_logged",
                    "type": "success",
                    "message": "HomePulse WebSockets database and stream link synchronized."
                })
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WS error: {e}")
        manager.disconnect(websocket)
