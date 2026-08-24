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

# Encryption key and cipher cache
cipher_suite = None
cipher_lock = asyncio.Lock()

async def init_encryption():
    global cipher_suite
    if cipher_suite is not None:
        return
    if not db_pool:
        logger.warning("Database pool not available for encryption initialization.")
        return
        
    async with cipher_lock:
        if cipher_suite is not None:
            return
        try:
            async with db_pool.acquire() as conn:
                row = await conn.fetchrow("SELECT value FROM system_settings WHERE key = $1;", "plugin_encryption_key")
                if row:
                    key_str = row["value"]
                else:
                    from cryptography.fernet import Fernet
                    key_bytes = Fernet.generate_key()
                    key_str = key_bytes.decode('utf-8')
                    await conn.execute("INSERT INTO system_settings (key, value) VALUES ($1, $2);", "plugin_encryption_key", key_str)
                
                from cryptography.fernet import Fernet
                cipher_suite = Fernet(key_str.encode('utf-8'))
                logger.info("Plugin configuration encryption engine successfully initialized.")
        except Exception as e:
            logger.error(f"Failed to initialize plugin encryption key: {e}")

async def get_cipher():
    global cipher_suite
    if cipher_suite is None:
        await init_encryption()
    return cipher_suite

async def encrypt_config(config_dict: dict) -> str:
    cipher = await get_cipher()
    if not cipher:
        return json.dumps(config_dict)
    try:
        plaintext = json.dumps(config_dict).encode("utf-8")
        ciphertext = cipher.encrypt(plaintext).decode("utf-8")
        return json.dumps({"encrypted": True, "ciphertext": ciphertext})
    except Exception as e:
        logger.error(f"Error encrypting config: {e}")
        return json.dumps(config_dict)

async def decrypt_config(config_val) -> dict:
    if not config_val:
        return {}
    
    if isinstance(config_val, str):
        try:
            data = json.loads(config_val)
        except Exception:
            return {}
    else:
        data = config_val
        
    if isinstance(data, dict) and data.get("encrypted") is True:
        cipher = await get_cipher()
        if not cipher:
            return {}
        try:
            ciphertext = data.get("ciphertext", "")
            plaintext = cipher.decrypt(ciphertext.encode("utf-8"))
            return json.loads(plaintext.decode("utf-8"))
        except Exception as e:
            logger.error(f"Failed to decrypt plugin configuration: {e}")
            return {}
    else:
        if isinstance(data, dict):
            return data
        return {}

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
                    
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS plugin_entity_states (
                            entity_key VARCHAR(255) PRIMARY KEY,
                            plugin_id VARCHAR(64) REFERENCES plugins(id) ON DELETE CASCADE,
                            node_id VARCHAR(64) NOT NULL,
                            name VARCHAR(255) NOT NULL,
                            type VARCHAR(64) NOT NULL,
                            value VARCHAR(255),
                            value_type VARCHAR(64) DEFAULT 'string',
                            attributes JSONB DEFAULT '{}'::JSONB,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    logger.info("Database table 'plugin_entity_states' verified successfully.")

                    # Load saved entity states from DB
                    rows = await conn.fetch("SELECT * FROM plugin_entity_states;")
                    for r in rows:
                        if entity_states is not None:
                            try:
                                attrs = r["attributes"]
                                if isinstance(attrs, str):
                                    attrs = json.loads(attrs)
                                entity_states[r["entity_key"]] = {
                                    "node_id": r["node_id"],
                                    "entity_key": r["entity_key"],
                                    "name": r["name"],
                                    "type": r["type"],
                                    "value": r["value"],
                                    "value_type": r["value_type"],
                                    "attributes": attrs or {}
                                }
                            except Exception as parse_err:
                                logger.error(f"Error parsing entity state attributes for {r['entity_key']}: {parse_err}")
                    logger.info(f"Restored {len(rows)} plugin entity states from DB.")
                
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
                dec_conf = await decrypt_config(r["config"])
                await start_plugin(r["id"], dec_conf)
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

async def start_plugin(plugin_id: str, config: Any):
    # Stop compile/running process if already active
    await stop_plugin(plugin_id)
    
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except Exception as e:
            logger.error(f"Failed to parse JSON config string for plugin {plugin_id}: {e}")
            config = {}
            
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
        env["PYTHONUNBUFFERED"] = "1"
        
        logger.info(f"Spawning subprocess for plugin {plugin_id} with {interpreter}...")
        proc = subprocess.Popen(
            [interpreter, "-u", script_path],
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
            if db_pool:
                try:
                    attrs_json = json.dumps(entity_states[entity_key]["attributes"])
                    async with db_pool.acquire() as conn:
                        await conn.execute("""
                            INSERT INTO plugin_entity_states (entity_key, plugin_id, node_id, name, type, value, value_type, attributes, updated_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                            ON CONFLICT (entity_key) DO UPDATE SET
                                value = EXCLUDED.value,
                                attributes = EXCLUDED.attributes,
                                updated_at = NOW();
                        """, entity_key, plugin_id, entity_states[entity_key]["node_id"], entity_states[entity_key]["name"], entity_states[entity_key]["type"], "ON", "string", attrs_json)
                except Exception as dberr:
                    logger.error(f"Error saving plugin status to DB: {dberr}")
            if ws_manager is not None:
                await ws_manager.broadcast({
                    "event": "entity_update",
                    "data": entity_states[entity_key]
                })
        return True
    except Exception as e:
        logger.error(f"Exception starting plugin {plugin_id}: {e}")
        return False

async def stop_or_idle_plugin_entities(plugin_id: str, status_val: str = "stopped"):
    """Turns status and binary sensor entities of a stopped plugin to stopped/idle in cache + database, leaving telemetry intact."""
    if entity_states is not None:
        for entity_key, ent in list(entity_states.items()):
            # Check if this entity is related to the plugin
            if ent.get("node_id") == plugin_id or ent.get("node_id") == f"plugin-{plugin_id}" or entity_key.startswith(f"plugin-{plugin_id}-"):
                if entity_key == f"plugin-{plugin_id}-status":
                    ent["value"] = "OFF"
                    if "attributes" not in ent or ent["attributes"] is None:
                        ent["attributes"] = {}
                    ent["attributes"]["status"] = status_val
                else:
                    # For sub-probers, if it represents status/state (binary_sensor or name/key contains status/state)
                    # we modify its value to idle/stopped
                    ent_type = ent.get("type", "sensor")
                    ent_key_lower = entity_key.lower()
                    ent_name_lower = ent.get("name", "").lower()
                    
                    if ent_type == "binary_sensor" or "status" in ent_key_lower or "status" in ent_name_lower or "state" in ent_key_lower or "state" in ent_name_lower:
                        # Change value (like ONLINE / OK) to stopped or idle
                        ent["value"] = status_val
                        
                    if "attributes" not in ent or ent["attributes"] is None:
                        ent["attributes"] = {}
                    ent["attributes"]["status"] = status_val
                
                # Persist to database
                if db_pool:
                    try:
                        attrs_json = json.dumps(ent.get("attributes", {}))
                        async with db_pool.acquire() as conn:
                            await conn.execute("""
                                INSERT INTO plugin_entity_states (entity_key, plugin_id, node_id, name, type, value, value_type, attributes, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                                ON CONFLICT (entity_key) DO UPDATE SET
                                    value = EXCLUDED.value,
                                    attributes = EXCLUDED.attributes,
                                    updated_at = NOW();
                            """, entity_key, plugin_id, ent["node_id"], ent["name"], ent["type"], str(ent["value"]), ent.get("value_type", "string"), attrs_json)
                    except Exception as dberr:
                        logger.error(f"Error saving updated entity state for {entity_key}: {dberr}")
                
                # Broadcast through WebSocket
                if ws_manager is not None:
                    await ws_manager.broadcast({
                        "event": "entity_update",
                        "data": ent
                    })

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
            
    # Update state of all plugin entities to stopped
    await stop_or_idle_plugin_entities(plugin_id, "stopped")

async def plugins_watchdog_loop():
    while True:
        try:
            await asyncio.sleep(5)
            for plugin_id in list(active_processes.keys()):
                proc = active_processes.get(plugin_id)
                if proc and proc.poll() is not None:
                    # Process died
                    exit_code = proc.returncode
                    stderr_data = "No traceback captured"
                    if proc.stderr and not proc.stderr.closed:
                        try:
                            stderr_data = proc.stderr.read()
                        except Exception:
                            pass
                    logger.error(f"Plugin {plugin_id} exited with code {exit_code}. Error logs: {stderr_data}")
                    
                    # Update status
                    active_processes.pop(plugin_id, None)
                    await stop_or_idle_plugin_entities(plugin_id, "crashed")
                    
                    # Add extra crash details to the status entity
                    entity_key = f"plugin-{plugin_id}-status"
                    if entity_states is not None and entity_key in entity_states:
                        entity_states[entity_key]["attributes"]["exit_code"] = exit_code
                        entity_states[entity_key]["attributes"]["error"] = stderr_data[-200:]
                        if db_pool:
                            try:
                                attrs_json = json.dumps(entity_states[entity_key]["attributes"])
                                async with db_pool.acquire() as conn:
                                    await conn.execute("""
                                        UPDATE plugin_entity_states 
                                        SET attributes = $1, value = 'OFF'
                                        WHERE entity_key = $2;
                                    """, attrs_json, entity_key)
                            except Exception as dberr:
                                logger.error(f"Error saving crash details: {dberr}")
                                
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
    """Queries the remote plugins repository using Git Trees API and returns manifests and files presence."""
    url = "https://api.github.com/repos/PiexlPuck/homepulse-plugins/git/trees/main?recursive=1"
    req = urllib.request.Request(url, headers={"User-Agent": "HomePulse-Admin-Agent"})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            tree_data = json.loads(response.read().decode('utf-8'))
            
        tree_items = tree_data.get("tree", [])
        plugin_dirs = {}
        manifest_paths = {}
        
        for item in tree_items:
            path = item.get("path", "")
            if not path.startswith("plugins/"):
                continue
            parts = path.split("/")
            if len(parts) >= 3:
                plugin_id = parts[1]
                subpath = "/".join(parts[2:])
                if plugin_id not in plugin_dirs:
                    plugin_dirs[plugin_id] = {"has_readme": False, "readme_filename": None}
                if subpath.lower() == "manifest.json":
                    manifest_paths[plugin_id] = path
                if subpath.lower() in ("readme.md", "readme.md"):
                    plugin_dirs[plugin_id]["has_readme"] = True
                    plugin_dirs[plugin_id]["readme_filename"] = parts[2]
                    
        plugins = []
        for plugin_id, manifest_path in manifest_paths.items():
            manifest_url = f"https://raw.githubusercontent.com/PiexlPuck/homepulse-plugins/main/{manifest_path}"
            m_req = urllib.request.Request(manifest_url, headers={"User-Agent": "HomePulse-Admin-Agent"})
            try:
                with urllib.request.urlopen(m_req, timeout=5) as m_res:
                    manifest = json.loads(m_res.read().decode('utf-8'))
                    manifest["id"] = plugin_id
                    info = plugin_dirs.get(plugin_id, {"has_readme": False, "readme_filename": None})
                    manifest["has_readme"] = info["has_readme"]
                    if info["has_readme"]:
                        manifest["readme_url"] = f"https://raw.githubusercontent.com/PiexlPuck/homepulse-plugins/main/plugins/{plugin_id}/{info['readme_filename']}"
                    plugins.append(manifest)
            except Exception as m_err:
                logger.warning(f"Error fetching manifest for remote plugin {plugin_id}: {m_err}")
                info = plugin_dirs.get(plugin_id, {"has_readme": False, "readme_filename": None})
                fallback = {
                    "id": plugin_id,
                    "name": plugin_id.replace("-", " ").title(),
                    "version": "1.0.0",
                    "description": "Custom community plugin.",
                    "has_readme": info["has_readme"]
                }
                if info["has_readme"]:
                    fallback["readme_url"] = f"https://raw.githubusercontent.com/PiexlPuck/homepulse-plugins/main/plugins/{plugin_id}/{info['readme_filename']}"
                plugins.append(fallback)
        return plugins
    except Exception as e:
        logger.error(f"Failed to query remote plugins marketplace: {e}")
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
                    dec_conf = await decrypt_config(r["config"])
                    db_states[r["id"]] = {"enabled": r["enabled"], "config": dec_conf}
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
                    
                    # Local README check
                    has_readme = False
                    for fname in ("README.md", "readme.md"):
                        if os.path.isfile(os.path.join(f_path, fname)):
                            has_readme = True
                            break
                    manifest["has_readme"] = has_readme
                    if has_readme:
                        manifest["readme_url"] = f"/api/plugins/readme/{p_id}"
                        
                    installed.append(manifest)
                except Exception as e:
                    logger.error(f"Failed reading manifest for installed plugin {f_name}: {e}")
    return installed

@plugins_router.get("/readme/{plugin_id}")
async def get_plugin_readme(plugin_id: str):
    """Returns the readme content of a locally installed plugin."""
    target_dir = os.path.join(PLUGINS_DIR, plugin_id)
    if not os.path.exists(target_dir):
        raise HTTPException(status_code=404, detail="Plugin directory not found.")
    for fn in ("README.md", "readme.md"):
        fpath = os.path.join(target_dir, fn)
        if os.path.isfile(fpath):
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    return {"content": f.read()}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
    raise HTTPException(status_code=404, detail="README not found.")

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
        config = await decrypt_config(row["config"])
        
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
        
    encrypted_config = await encrypt_config(payload.config)
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT enabled FROM plugins WHERE id = $1;", plugin_id)
        if not row:
            raise HTTPException(status_code=404, detail="Plugin not found in registry database.")
            
        await conn.execute("UPDATE plugins SET config = $1 WHERE id = $2;", encrypted_config, plugin_id)
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
            await conn.execute("DELETE FROM plugin_entity_states WHERE plugin_id = $1;", plugin_id)
            
    # Remove entity states from cache if we have any
    if entity_states is not None:
        for entity_key in list(entity_states.keys()):
            ent = entity_states[entity_key]
            if ent.get("node_id") == plugin_id or ent.get("node_id") == f"plugin-{plugin_id}" or entity_key.startswith(f"plugin-{plugin_id}-"):
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
        
    plugin_id = payload.get("node_id")
    if entity_key == "status" and plugin_id:
        entity_key = f"plugin-{plugin_id}-status"
        # Translate ONLINE/OFFLINE to ON/OFF for binary_sensor compatibility
        val = payload.get("value")
        if val == "ONLINE":
            payload["value"] = "ON"
        elif val == "OFFLINE":
            payload["value"] = "OFF"

    if entity_states is not None:
        existing_ent = entity_states.get(entity_key, {})
        existing_attrs = existing_ent.get("attributes", {}) if isinstance(existing_ent.get("attributes"), dict) else {}
        new_attrs = payload.get("attributes", {})
        merged_attrs = {**existing_attrs, **new_attrs}

        entity_states[entity_key] = {
            "node_id": payload.get("node_id", "plugins"),
            "entity_key": entity_key,
            "name": payload.get("name", entity_key.replace("-", " ").title()) if entity_key != f"plugin-{plugin_id}-status" else f"Plugin: {plugin_id.replace('-', ' ').title()}",
            "type": payload.get("type", "sensor"),
            "value": payload.get("value"),
            "value_type": payload.get("value_type", "string"),
            "attributes": merged_attrs
        }
        
        if db_pool and plugin_id:
            try:
                attrs_json = json.dumps(merged_attrs)
                async with db_pool.acquire() as conn:
                    await conn.execute("""
                        INSERT INTO plugin_entity_states (entity_key, plugin_id, node_id, name, type, value, value_type, attributes, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                        ON CONFLICT (entity_key) DO UPDATE SET
                            value = EXCLUDED.value,
                            attributes = EXCLUDED.attributes,
                            updated_at = NOW();
                    """, entity_key, plugin_id, payload.get("node_id"), entity_states[entity_key]["name"], payload.get("type"), str(payload.get("value")), payload.get("value_type", "string"), attrs_json)
                    
                    # Autodetect historic telemetry: if value is numeric, insert it to telemetry_logs
                    val_str = str(payload.get("value"))
                    is_numeric = False
                    try:
                        float(val_str)
                        is_numeric = True
                    except ValueError:
                        pass
                        
                    if is_numeric:
                        from main import save_telemetry_log
                        await save_telemetry_log(payload.get("node_id"), entity_key, val_str)
                        
                    from main import app_settings, forward_telemetry_webhook
                    if app_settings.get("gateway_mode") == "true":
                        await forward_telemetry_webhook(entity_key, entity_states[entity_key])
            except Exception as dberr:
                logger.error(f"Error saving plugin entity state to DB: {dberr}")
                
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
            
    # Update state of all plugin entities to stopped
    await stop_or_idle_plugin_entities(plugin_id, "stopped")
    return {"status": "success", "message": f"Plugin {plugin_id} force-terminated."}
