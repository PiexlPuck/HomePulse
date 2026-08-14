import os
import sys
import json
import asyncio
import logging
import shutil
import subprocess
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

logger = logging.getLogger("homepulse-plugins")

# Globals initialized at startup
db_pool = None
ws_manager = None
entity_states = None

# Tracks active plugin subprocesses: plugin_id -> subprocess.Popen
active_processes: Dict[str, subprocess.Popen] = {}
# Watchdog task
watchdog_task: Optional[asyncio.Task] = None

# APIRouter instance
plugins_router = APIRouter(prefix="/api/plugins", tags=["Plugins"])

# Base paths
PLUGINS_DIR = os.getenv("PLUGINS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins"))
os.makedirs(PLUGINS_DIR, exist_ok=True)

class PluginConfigPayload(BaseModel):
    config: Dict[str, Any]

def init_plugins_manager(pool, manager, states):
    global db_pool, ws_manager, entity_states, watchdog_task
    db_pool = pool
    ws_manager = manager
    entity_states = states
    
    # Run async startup tasks
    asyncio.create_task(db_migration_and_startup())

async def db_migration_and_startup():
    logger.info("Initializing plugins database table and startup daemon...")
    for attempt in range(10):
        if db_pool is not None:
            try:
                async with db_pool.acquire() as conn:
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS plugins (
                            id VARCHAR(64) PRIMARY KEY,
                            name VARCHAR(255) NOT NULL,
                            version VARCHAR(32) NOT NULL,
                            enabled BOOLEAN DEFAULT FALSE,
                            config JSONB DEFAULT '{}'::JSONB,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    logger.info("Database table 'plugins' verified successfully.")
                
                # Start all enabled plugins
                await start_all_enabled_plugins()
                
                # Start watchdog loop
                global watchdog_task
                watchdog_task = asyncio.create_task(plugins_watchdog_loop())
                return
            except Exception as e:
                logger.error(f"Error setting up plugins DB table: {e}")
        await asyncio.sleep(2)

# Subprocess Utilities
async def start_all_enabled_plugins():
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, config FROM plugins WHERE enabled = TRUE;")
            for r in rows:
                await start_plugin(r["id"], r["config"])
    except Exception as e:
        logger.error(f"Error starting enabled plugins: {e}")

import threading
import time

# Logs cache for plugins (plugin_id -> list of log dicts)
plugin_logs: Dict[str, List[Dict[str, Any]]] = {}

def add_plugin_log(plugin_id: str, level: str, message: str):
    if plugin_id not in plugin_logs:
        plugin_logs[plugin_id] = []
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "level": level.upper(),
        "message": message
    }
    plugin_logs[plugin_id].append(log_entry)
    if len(plugin_logs[plugin_id]) > 200:
        plugin_logs[plugin_id].pop(0)

def read_stream(stream, plugin_id, level):
    try:
        for line in iter(stream.readline, ''):
            if not line:
                break
            add_plugin_log(plugin_id, level, line.strip())
    except Exception as e:
        logger.error(f"Error reading plugin stream {plugin_id}: {e}")
    finally:
        try:
            stream.close()
        except:
            pass

async def start_plugin(plugin_id: str, config: Dict[str, Any]):
    # Stop compile/running process if already active
    await stop_plugin(plugin_id)
    
    plugin_dir = os.path.join(PLUGINS_DIR, plugin_id)
    if not os.path.isdir(plugin_dir):
        logger.error(f"Cannot start plugin {plugin_id}: Directory does not exist.")
        return False
        
    manifest_path = os.path.join(plugin_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        logger.error(f"Cannot start plugin {plugin_id}: manifest.json not found.")
        return False
        
    try:
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
        entrypoint = manifest.get("entrypoint", "main.py")
        script_path = os.path.join(plugin_dir, entrypoint)
        
        if not os.path.isfile(script_path):
            logger.error(f"Cannot start plugin {plugin_id}: Entrypoint {script_path} not found.")
            return False
            
        # Determine interpreter (virtualenv python or system python)
        venv_python = os.path.join(plugin_dir, "venv", "bin", "python3")
        interpreter = venv_python if os.path.isfile(venv_python) else sys.executable
        
        # Prepare environment
        env = os.environ.copy()
        # Inject config values as environment variables (prefixed with PLUGIN_)
        for k, v in config.items():
            env[f"PLUGIN_{k.upper()}"] = str(v)
            
        # Inject API Gateway configs
        env["HOMEPULSE_API_URL"] = "http://localhost:8000/api/plugins/gateway"
        env["PLUGIN_ID"] = plugin_id
        
        logger.info(f"Spawning subprocess for plugin {plugin_id} with {interpreter}...")
        proc = subprocess.Popen(
            [interpreter, script_path],
            env=env,
            cwd=plugin_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        active_processes[plugin_id] = proc
        
        # Start thread-based readers to consume stdout and stderr to avoid buffer filling issues
        t1 = threading.Thread(target=read_stream, args=(proc.stdout, plugin_id, "INFO"), daemon=True)
        t2 = threading.Thread(target=read_stream, args=(proc.stderr, plugin_id, "ERROR"), daemon=True)
        t1.start()
        t2.start()
        
        # Update entity state to reflect plugin is running
        entity_key = f"plugin-{plugin_id}-status"
        if entity_states is not None:
            entity_states[entity_key] = {
                "node_id": "plugins",
                "entity_key": entity_key,
                "name": f"Plugin: {manifest.get('name', plugin_id)}",
                "type": "binary_sensor",
                "value": "ON",
                "attributes": {
                    "version": manifest.get("version", "1.0.0"),
                    "status": "running"
                }
            }
            if ws_manager is not None:
                await ws_manager.broadcast({
                    "event": "entity_update",
                    "data": entity_states[entity_key]
                })
        return True
    except Exception as e:
        logger.error(f"Exception starting plugin {plugin_id}: {e}")
        return False

async def stop_plugin(plugin_id: str):
    proc = active_processes.pop(plugin_id, None)
    if proc:
        logger.info(f"Stopping plugin process {plugin_id}...")
        try:
            proc.terminate()
            # Wait up to 3 seconds for graceful shutdown
            for _ in range(30):
                if proc.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            if proc.poll() is None:
                logger.warning(f"Plugin {plugin_id} did not terminate, killing it...")
                proc.kill()
        except Exception as e:
            logger.error(f"Error stopping plugin process {plugin_id}: {e}")
            
    # Update state to OFF
    entity_key = f"plugin-{plugin_id}-status"
    if entity_states is not None and entity_key in entity_states:
        entity_states[entity_key]["value"] = "OFF"
        entity_states[entity_key]["attributes"]["status"] = "stopped"
        if ws_manager is not None:
            await ws_manager.broadcast({
                "event": "entity_update",
                "data": entity_states[entity_key]
            })

async def plugins_watchdog_loop():
    while True:
        try:
            await asyncio.sleep(5)
            for plugin_id in list(active_processes.keys()):
                proc = active_processes.get(plugin_id)
                if proc and proc.poll() is not None:
                    # Process died
                    exit_code = proc.returncode
                    stderr_data = proc.stderr.read() if proc.stderr else "No traceback captured"
                    logger.error(f"Plugin {plugin_id} exited with code {exit_code}. Error logs: {stderr_data}")
                    
                    # Update status
                    active_processes.pop(plugin_id, None)
                    entity_key = f"plugin-{plugin_id}-status"
                    if entity_states is not None and entity_key in entity_states:
                        entity_states[entity_key]["value"] = "OFF"
                        entity_states[entity_key]["attributes"]["status"] = "crashed"
                        entity_states[entity_key]["attributes"]["exit_code"] = exit_code
                        entity_states[entity_key]["attributes"]["error"] = stderr_data[-200:] # Last 200 chars
                        if ws_manager is not None:
                            await ws_manager.broadcast({
                                "event": "entity_update",
                                "data": entity_states[entity_key]
                            })
        except Exception as e:
            logger.error(f"Exception in plugins watchdog: {e}")

# API routes
@plugins_router.get("/marketplace")
async def get_marketplace():
    """Queries the remote plugins repository and returns folder inventories."""
    url = "https://api.github.com/repos/PiexlPuck/homepulse-plugins/contents/plugins"
    req = urllib.request.Request(url, headers={"User-Agent": "HomePulse-Admin-Agent"})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            items = json.loads(response.read().decode('utf-8'))
            
        plugins = []
        for item in items:
            if item.get("type") == "dir":
                plugin_id = item.get("name")
                # Retrieve the manifest
                manifest_url = f"https://raw.githubusercontent.com/PiexlPuck/homepulse-plugins/main/plugins/{plugin_id}/manifest.json"
                m_req = urllib.request.Request(manifest_url, headers={"User-Agent": "HomePulse-Admin-Agent"})
                try:
                    with urllib.request.urlopen(m_req, timeout=5) as m_res:
                        manifest = json.loads(m_res.read().decode('utf-8'))
                        manifest["id"] = plugin_id
                        plugins.append(manifest)
                except Exception as m_err:
                    logger.warning(f"Error fetching manifest for remote plugin {plugin_id}: {m_err}")
                    plugins.append({
                        "id": plugin_id,
                        "name": plugin_id.replace("-", " ").title(),
                        "version": "1.0.0",
                        "description": "Custom community plugin."
                    })
        return plugins
    except Exception as e:
        logger.error(f"Failed to query remote plugins marketplace: {e}")
        # Fallback empty list
        return []

@plugins_router.get("/installed")
async def get_installed():
    """Retrieves list of locally installed plugins and their active states."""
    installed = []
    if not os.path.exists(PLUGINS_DIR):
        return installed
        
    db_states = {}
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                rows = await conn.fetch("SELECT id, enabled, config FROM plugins;")
                for r in rows:
                    db_states[r["id"]] = {"enabled": r["enabled"], "config": json.loads(r["config"])}
        except Exception as e:
            logger.error(f"Error reading installed plugins DB state: {e}")
            
    for f_name in os.listdir(PLUGINS_DIR):
        f_path = os.path.join(PLUGINS_DIR, f_name)
        if os.path.isdir(f_path):
            manifest_path = os.path.join(f_path, "manifest.json")
            if os.path.isfile(manifest_path):
                try:
                    with open(manifest_path, 'r') as mf:
                        manifest = json.load(mf)
                    p_id = manifest.get("id", f_name)
                    db_val = db_states.get(p_id, {"enabled": False, "config": {}})
                    manifest["enabled"] = db_val["enabled"]
                    manifest["config"] = db_val["config"]
                    installed.append(manifest)
                except Exception as e:
                    logger.error(f"Failed reading manifest for installed plugin {f_name}: {e}")
    return installed

@plugins_router.post("/install/{plugin_id}")
async def install_plugin(plugin_id: str):
    """Downloads files from remote repository and populates the local plugin directory."""
    # To keep this safe and simple we pull files from the main branch contents API
    target_dir = os.path.join(PLUGINS_DIR, plugin_id)
    shutil.rmtree(target_dir, ignore_errors=True)
    os.makedirs(target_dir, exist_ok=True)
    
    # We fetch files from GitHub API: contents/plugins/{plugin_id}
    url = f"https://api.github.com/repos/PiexlPuck/homepulse-plugins/contents/plugins/{plugin_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "HomePulse-Admin-Agent"})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            contents = json.loads(response.read().decode('utf-8'))
            
        for file_item in contents:
            if file_item.get("type") == "file":
                file_name = file_item.get("name")
                file_url = file_item.get("download_url")
                # Downloader download url
                f_req = urllib.request.Request(file_url, headers={"User-Agent": "HomePulse-Admin-Agent"})
                with urllib.request.urlopen(f_req) as f_res:
                    file_content = f_res.read()
                    
                local_f_path = os.path.join(target_dir, file_name)
                # Ensure directory safety
                if not local_f_path.startswith(PLUGINS_DIR):
                    raise HTTPException(status_code=400, detail="Invalid plugin download path.")
                    
                with open(local_f_path, 'wb') as f:
                    f.write(file_content)
            elif file_item.get("type") == "dir":
                # Handle assets subdirectory (single nesting)
                sub_dir_name = file_item.get("name")
                sub_dir_url = file_item.get("url")
                os.makedirs(os.path.join(target_dir, sub_dir_name), exist_ok=True)
                
                s_req = urllib.request.Request(sub_dir_url, headers={"User-Agent": "HomePulse-Admin-Agent"})
                with urllib.request.urlopen(s_req) as s_res:
                    sub_contents = json.loads(s_res.read().decode('utf-8'))
                    
                for s_item in sub_contents:
                    if s_item.get("type") == "file":
                        s_name = s_item.get("name")
                        s_download_url = s_item.get("download_url")
                        
                        sf_req = urllib.request.Request(s_download_url, headers={"User-Agent": "HomePulse-Admin-Agent"})
                        with urllib.request.urlopen(sf_req) as sf_res:
                            sf_content = sf_res.read()
                        with open(os.path.join(target_dir, sub_dir_name, s_name), 'wb') as f:
                            f.write(sf_content)
                            
        # Successfully written. Let's read main manifest
        manifest_path = os.path.join(target_dir, "manifest.json")
        if not os.path.isfile(manifest_path):
            raise HTTPException(status_code=400, detail="Plugin missing manifest.json after download.")
            
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
            
        p_name = manifest.get("name", plugin_id)
        p_version = manifest.get("version", "1.0.0")
        
        # Prepare Venv asynchronously
        asyncio.create_task(compile_plugin_venv(plugin_id, target_dir))
        
        # Save to database
        if db_pool:
            async with db_pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO plugins (id, name, version, enabled, config)
                    VALUES ($1, $2, $3, FALSE, '{}'::JSONB)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version;
                """, plugin_id, p_name, p_version)
                
        return {"status": "success", "message": f"Plugin {p_name} downloaded successfully. Environment setup in background."}
    except Exception as e:
        logger.error(f"Failed to install plugin {plugin_id}: {e}")
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Download failed: {e}")

async def compile_plugin_venv(plugin_id: str, target_dir: str):
    req_txt = os.path.join(target_dir, "requirements.txt")
    if not os.path.isfile(req_txt):
        return
        
    try:
        logger.info(f"Creating local python venv for plugin {plugin_id}...")
        # Spawn venv creation
        proc_venv = await asyncio.create_subprocess_exec(
            "python3", "-m", "venv", os.path.join(target_dir, "venv"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        await proc_venv.wait()
        
        logger.info(f"Installing dependencies for plugin {plugin_id}...")
        pip_path = os.path.join(target_dir, "venv", "bin", "pip")
        proc_pip = await asyncio.create_subprocess_exec(
            pip_path, "install", "-r", req_txt,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        await proc_pip.wait()
        logger.info(f"Plugin {plugin_id} environment successfully compiled.")
    except Exception as e:
        logger.error(f"Error compiling venv environment for plugin {plugin_id}: {e}")

@plugins_router.post("/toggle/{plugin_id}")
async def toggle_plugin(plugin_id: str):
    """Enables or disables a local plugin."""
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")
        
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT enabled, config FROM plugins WHERE id = $1;", plugin_id)
        if not row:
            raise HTTPException(status_code=404, detail="Plugin not found in registry database.")
            
        new_state = not row["enabled"]
        config = json.loads(row["config"])
        
        await conn.execute("UPDATE plugins SET enabled = $1 WHERE id = $2;", new_state, plugin_id)
        
    if new_state:
        started = await start_plugin(plugin_id, config)
        if not started:
            # Revert DB state
            async with db_pool.acquire() as conn:
                await conn.execute("UPDATE plugins SET enabled = FALSE WHERE id = $2;", plugin_id)
            raise HTTPException(status_code=500, detail="Failed to spawn plugin subprocess.")
    else:
        await stop_plugin(plugin_id)
        
    return {"status": "success", "enabled": new_state}

@plugins_router.post("/config/{plugin_id}")
async def save_config(plugin_id: str, payload: PluginConfigPayload):
    """Saves custom credential parameters for a plugin."""
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")
        
    config_json = json.dumps(payload.config)
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT enabled FROM plugins WHERE id = $1;", plugin_id)
        if not row:
            raise HTTPException(status_code=404, detail="Plugin not found in registry database.")
            
        await conn.execute("UPDATE plugins SET config = $1 WHERE id = $2;", config_json, plugin_id)
        is_enabled = row["enabled"]
        
    # Restart to apply new configs immediately if already running
    if is_enabled:
        await start_plugin(plugin_id, payload.config)
        
    return {"status": "success", "message": "Configuration saved successfully."}

@plugins_router.post("/uninstall/{plugin_id}")
async def uninstall_plugin(plugin_id: str):
    """Stops the plugin process and deletes all file resources."""
    await stop_plugin(plugin_id)
    
    target_dir = os.path.join(PLUGINS_DIR, plugin_id)
    shutil.rmtree(target_dir, ignore_errors=True)
    
    if db_pool:
        async with db_pool.acquire() as conn:
            await conn.execute("DELETE FROM plugins WHERE id = $1;", plugin_id)
            
    # Remove entity state
    entity_key = f"plugin-{plugin_id}-status"
    if entity_states is not None:
        entity_states.pop(entity_key, None)
        if ws_manager is not None:
            await ws_manager.broadcast({
                "event": "entity_update",
                "data": {"entity_key": entity_key, "deleted": True}
            })
            
    return {"status": "success", "message": f"Plugin {plugin_id} uninstalled successfully."}

# LOCAL GATEWAY APIRoutes for plugin processes
@plugins_router.post("/gateway/state")
async def gateway_post_state(payload: Dict[str, Any]):
    """Receives entity metrics and telemetry from child processes."""
    # Required keys in payload: entity_key, value, name, type (e.g. sensor)
    entity_key = payload.get("entity_key")
    if not entity_key:
        raise HTTPException(status_code=400, detail="Missing key entity_key in payload.")
        
    if entity_states is not None:
        entity_states[entity_key] = {
            "node_id": payload.get("node_id", "plugins"),
            "entity_key": entity_key,
            "name": payload.get("name", entity_key.replace("-", " ").title()),
            "type": payload.get("type", "sensor"),
            "value": payload.get("value"),
            "value_type": payload.get("value_type", "string"),
            "attributes": payload.get("attributes", {})
        }
        if ws_manager is not None:
            await ws_manager.broadcast({
                "event": "entity_update",
                "data": entity_states[entity_key]
            })
    return {"status": "success"}

@plugins_router.post("/gateway/logs")
async def gateway_post_logs(payload: Dict[str, Any]):
    """Receives trace logs from running plugin daemons."""
    message = payload.get("message")
    level = payload.get("level", "INFO").upper()
    plugin_name = payload.get("plugin_id", "unknown-plugin")
    
    log_line = f"[{plugin_name}] [{level}] {message}"
    if level == "ERROR":
        logger.error(log_line)
    elif level == "WARNING":
        logger.warning(log_line)
    else:
        logger.info(log_line)
        
    add_plugin_log(plugin_name, level, message)
        
    # Broadcast dynamic log to admin client logger
    if ws_manager is not None:
        await ws_manager.broadcast({
            "event": "system_log",
            "data": {
                "timestamp": payload.get("timestamp"),
                "logger": f"plugins.{plugin_name}",
                "level": level,
                "message": message
            }
        })
    return {"status": "success"}

@plugins_router.get("/logs/{plugin_id}")
async def get_plugin_logs(plugin_id: str):
    """Returns cached log lines for the given plugin."""
    logs = plugin_logs.get(plugin_id, [])
    return {"logs": logs}

@plugins_router.post("/kill/{plugin_id}")
async def kill_plugin_payload(plugin_id: str):
    """Force-terminates a plugin process immediately."""
    proc = active_processes.pop(plugin_id, None)
    if proc:
        try:
            proc.kill()
            logger.warning(f"Plugin {plugin_id} force killed by administrator.")
        except Exception as e:
            logger.error(f"Error killing plugin {plugin_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))
            
    # Update DB enabled to false
    if db_pool:
        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE plugins SET enabled = FALSE WHERE id = $1;", plugin_id)
            
    # Update state to OFF in entity states
    entity_key = f"plugin-{plugin_id}-status"
    if entity_states is not None and entity_key in entity_states:
        entity_states[entity_key]["value"] = "OFF"
        entity_states[entity_key]["attributes"]["status"] = "stopped"
        if ws_manager is not None:
            await ws_manager.broadcast({
                "event": "entity_update",
                "data": entity_states[entity_key]
            })
    return {"status": "success", "message": f"Plugin {plugin_id} force-terminated."}
