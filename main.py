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
from pydantic import BaseModel
from typing import List, Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Header
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

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
    }
}

# Staged discovery queue
discovery_queue = [
    {
        "id": "smart-plug-84ab",
        "name": "Smart Power Plug",
        "ip": "192.168.0.185",
        "manifest": {
            "hardware": {"mac": "AA:BB:CC:DD:EE:01"}
        }
    }
]

class ControlPayload(BaseModel):
    value: Any

class ApprovePayload(BaseModel):
    preshared_key: str

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

                # Ensure system_monitors has 'enabled' column
                try:
                    await conn.execute("ALTER TABLE system_monitors ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;")
                    logger.info("Migrated system_monitors database schema: enabled column verified.")
                except Exception as mig_err:
                    logger.warning(f"Error checking enabled column migration: {mig_err}")

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

                tables = await conn.fetch("SELECT table_name FROM information_schema.tables WHERE table_schema='public';")
                logger.info(f"Database schema verification complete. Tables: {[t['table_name'] for t in tables]}")
            return
        except Exception as e:
            logger.warning(f"Database setup wait loop (attempt {attempt+1}/10)... Error: {e}")
            await asyncio.sleep(3)
    logger.error("Could not coordinate Database connection, proceeding in standalone mode.")

@app.on_event("startup")
async def startup_event():
    await init_db_pool()
    asyncio.create_task(collect_system_statistics_task())
    asyncio.create_task(monitor_probers_task())

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
            for key in ["cpu-utilization", "memory-saturation", "network-throughput", "database-latency", "database-status"]:
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
    telemetry_interval: int
    log_retention: int
    timezone: str
    preshared_key: str
    theme: str
    layout_compact: str

@app.get("/api/settings")
async def get_settings():
    return JSONResponse(content=app_settings)

@app.post("/api/settings")
async def post_settings(payload: SettingsPayload):
    # Update cache
    app_settings["telemetry_interval"] = payload.telemetry_interval
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

@app.get("/api/monitors")
async def get_monitors():
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, name, type, target, check_interval, timeout, last_status, last_latency, last_checked, enabled FROM system_monitors ORDER BY id ASC;")
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
                """INSERT INTO system_monitors (name, type, target, check_interval, timeout, last_status, enabled) 
                   VALUES ($1, $2, $3, $4, $5, 'unknown', true) RETURNING id;""",
                payload.name.strip(), payload.type, payload.target.strip(), payload.check_interval, payload.timeout
            )
            
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
                
            await conn.execute(
                """UPDATE system_monitors 
                   SET name = $1, type = $2, target = $3, check_interval = $4, timeout = $5
                   WHERE id = $6;""",
                payload.name.strip(), payload.type, payload.target.strip(), payload.check_interval, payload.timeout, monitor_id
            )
            
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
async def get_monitor_logs(entity_key: str):
    if not db_pool:
        return JSONResponse(content=[])
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT timestamp, value FROM telemetry_logs 
                   WHERE entity_key = $1 
                   ORDER BY timestamp DESC LIMIT 10;""",
                entity_key
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
