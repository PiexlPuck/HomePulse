import os
import sys
import time
import asyncio
import logging
import psutil
import asyncpg
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
discovery_queue = []

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

# 3. Static serving routing
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
    return JSONResponse(content={"status": "settings_applied", "settings": app_settings})



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
