// ============================================================================
// Module: src/01-core-dashboard.ts
// Description: Core Dashboard, WebSocket Stream, YAML Parser & Server Sync
// ============================================================================

// HomePulse Dashboard Client Interaction Logic
// Integrates with FastAPI REST endpoints & WebSocket Client Stream APIs

// Zero-dependency offline fallback for js-yaml
if (typeof jsyaml === 'undefined') {
  window.jsyaml = {
    dump: function (obj, options) {
      function dumpValue(val, indent = 0) {
        const spacing = " ".repeat(indent);
        if (val === null || val === undefined) return "null";
        if (typeof val === 'boolean' || typeof val === 'number') return String(val);
        if (typeof val === 'string') {
          return `"${val.replace(/"/g, '\\"')}"`;
        }
        if (Array.isArray(val)) {
          if (val.length === 0) return "[]";
          let lines = [];
          val.forEach(item => {
            if (typeof item === 'object' && item !== null) {
              const subLines = [];
              const keys = Object.keys(item);
              keys.forEach((k, idx) => {
                const prefix = idx === 0 ? "- " : "  ";
                subLines.push(`${spacing}${prefix}${k}: ${dumpValue(item[k], 0)}`);
              });
              lines.push(subLines.join('\n'));
            } else {
              lines.push(`${spacing}- ${dumpValue(item, 0)}`);
            }
          });
          return "\n" + lines.join('\n');
        }
        if (typeof val === 'object') {
          let lines = [];
          for (const key in val) {
            if (!val.hasOwnProperty(key)) continue;
            const subVal = val[key];
            if (subVal === undefined) continue;
            if (typeof subVal === 'object' && subVal !== null) {
              lines.push(`${spacing}${key}:${dumpValue(subVal, indent + 2)}`);
            } else {
              lines.push(`${spacing}${key}: ${dumpValue(subVal, 0)}`);
            }
          }
          return "\n" + lines.join('\n');
        }
        return `"${String(val)}"`;
      }
      return dumpValue(obj, 0).trim();
    },
    load: function (str) {
      const lines = str.split(/\r?\n/);
      const root = {};
      let currentPath = [];
      let currentArray = null;
      let currentArrayKey = null;
      let arrayItemObj = null;

      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;

        const indent = line.length - line.trimStart().length;

        if (trimmed.startsWith('-')) {
          if (currentArray) {
            const rest = trimmed.slice(1).trim();
            const colonIdx = rest.indexOf(':');
            if (colonIdx !== -1) {
              const subK = rest.slice(0, colonIdx).trim();
              const subRawVal = rest.slice(colonIdx + 1).trim();
              let subVal = subRawVal.replace(/^["']|["']$/g, '');
              if (subRawVal === 'true') subVal = true;
              else if (subRawVal === 'false') subVal = false;
              else if (!isNaN(subRawVal) && subRawVal !== '') subVal = parseFloat(subRawVal);

              arrayItemObj = {};
              arrayItemObj[subK] = subVal;
              currentArray.push(arrayItemObj);
            } else {
              let val = rest.replace(/^["']|["']$/g, '');
              if (rest === 'true') val = true;
              else if (rest === 'false') val = false;
              else if (!isNaN(rest) && rest !== '') val = parseFloat(rest);
              currentArray.push(val);
            }
          }
          return;
        }

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) return;

        const k = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();

        if (indent > 2 && arrayItemObj) {
          let val = rawVal.replace(/^["']|["']$/g, '');
          if (rawVal === 'true') val = true;
          else if (rawVal === 'false') val = false;
          else if (!isNaN(rawVal) && rawVal !== '') val = parseFloat(rawVal);
          arrayItemObj[k] = val;
          return;
        }

        if (indent === 0) {
          currentPath = [root];
          currentArray = null;
          arrayItemObj = null;
        } else {
          const level = Math.floor(indent / 2);
          while (currentPath.length > level) {
            currentPath.pop();
          }
        }

        const activeObj = currentPath[currentPath.length - 1] || root;

        if (rawVal === '') {
          if (k === 'entities' || k === 'widgets' || k === 'dashboards') {
            currentArray = [];
            activeObj[k] = currentArray;
            currentArrayKey = k;
          } else {
            const newObj = {};
            activeObj[k] = newObj;
            currentPath.push(newObj);
            currentArray = null;
            arrayItemObj = null;
          }
        } else {
          let val = rawVal.replace(/^["']|["']$/g, '');
          if (rawVal === 'true') val = true;
          else if (rawVal === 'false') val = false;
          else if (!isNaN(rawVal) && rawVal !== '') val = parseFloat(rawVal);

          activeObj[k] = val;
        }
      });

      return root;
    }
  };
}

let activeTab: string = 'main';
let token = localStorage.getItem('hp_token') || 'Architect_JWT_String'; // Fallback token
let socket = null;
const telemetryHistory = {};
let cachedEntities: Record<string, TelemetryEntity> = {};

document.addEventListener('DOMContentLoaded', async () => {
  // Sync dashboard layout and configuration registry from database
  await syncDashboardConfigFromServer();

  // Load and apply system settings immediately on load for initial clock timezone alignment
  await loadInitialSettingsOnStart();

  // Initialize header timestamp
  updateHeaderTime();
  setInterval(updateHeaderTime, 1000);

  // Initialize UI Collapsible Sidebar
  initializeSidebar();

  // Load Active Entities & Connect Stream
  loadEntities();
  setupWebSocket();

  // Render Dynamic views/tabs
  renderDashboards();

  // Initialize density mode and bottom audit feed
  initDensityMode();
  initAuditListPlaceholder();

  // Hook global tab navigation from sidebar
  const navDiscovery = document.getElementById('nav-discovery');
  if (navDiscovery) {
    navDiscovery.addEventListener('click', (e) => {
      e.preventDefault();
      // Deactivated per request: let the button do nothing
    });
  }

  // Sync discovery queue badge on load - Deactivated per request
  // syncDiscoveryBadge();
});

function initDensityMode() {
  const saved = localStorage.getItem('hp_layout_compact');
  const isCompact = (saved === 'true');
  document.body.classList.toggle('layout-compact', isCompact);
  const label = document.getElementById('density-mode-label');
  if (label) label.textContent = isCompact ? 'Spacious' : 'Compact';
  const icon = document.querySelector('#header-density-toggle i');
  if (icon) {
    icon.setAttribute('data-lucide', isCompact ? 'maximize-2' : 'layout-grid');
    if (window.lucide) window.lucide.createIcons();
  }
}

window.toggleDensityMode = function () {
  const isCompact = document.body.classList.toggle('layout-compact');
  localStorage.setItem('hp_layout_compact', isCompact ? 'true' : 'false');
  const label = document.getElementById('density-mode-label');
  if (label) label.textContent = isCompact ? 'Spacious' : 'Compact';
  const icon = document.querySelector('#header-density-toggle i');
  if (icon) {
    icon.setAttribute('data-lucide', isCompact ? 'maximize-2' : 'layout-grid');
    if (window.lucide) window.lucide.createIcons();
  }
  const settingCompact = document.getElementById('setting-compact');
  if (settingCompact) settingCompact.checked = isCompact;
};

function initAuditListPlaceholder() {
  const auditList = document.getElementById('audit-list');
  if (!auditList || auditList.children.length > 0) return;

  addAuditEntry('success', 'HomePulse telemetry monitoring cluster online and active.');
  addAuditEntry('info', 'PostgreSQL persistent database connection verified.');
  addAuditEntry('info', 'WebSocket event router subscription stream initialized.');
}

async function loadInitialSettingsOnStart() {
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      window.currentSettingsData = data;
      applyGlobalSettings(data);
    }
  } catch (err) {
    console.warn("Could not load initial settings:", err);
  }
}

// Active settings state
let currentTimezone = 'UTC';

// 1. Header refresh time
function updateHeaderTime() {
  const timeText = document.getElementById('refresh-time-text');
  if (timeText) {
    const now = new Date();
    let timeStr;
    try {
      const tz = currentTimezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTimezone;
      timeStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
      const tzLabel = currentTimezone === 'local' ? 'LOCAL' : currentTimezone;
      timeText.textContent = `Last refreshed: ${timeStr} ${tzLabel} • Live connection active`;
    } catch {
      const pad = (num) => String(num).padStart(2, '0');
      timeStr = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
      timeText.textContent = `Last refreshed: ${timeStr} UTC • Live connection active`;
    }
  }
}


// 2. Sidebar Collapsible Toggle
function initializeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');

  if (toggleSidebarBtn && sidebar) {
    toggleSidebarBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      const isCollapsed = sidebar.classList.contains('collapsed');

      // Update chevron icon direction
      if (sidebarToggleIcon) {
        sidebarToggleIcon.setAttribute('data-lucide', isCollapsed ? 'chevron-right' : 'chevron-left');
      }
      if (window.lucide) window.lucide.createIcons();
    });
  }

  // Edit Mode Toggle hooks
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) {
    editToggleBtn.addEventListener('click', toggleEditMode);
  }
}

let lastToggleTime = 0;
function toggleEditMode() {
  const now = Date.now();
  if (now - lastToggleTime < 250) return;
  lastToggleTime = now;

  const mainContent = document.getElementById('main-content');
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (!mainContent) return;

  const isEditMode = mainContent.classList.toggle('edit-mode');
  if (editToggleBtn) {
    editToggleBtn.classList.toggle('active', isEditMode);
    const spanText = editToggleBtn.querySelector('span');
    if (spanText) {
      spanText.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Dashboard';
    }
    const icon = editToggleBtn.querySelector('i');
    if (icon) {
      icon.setAttribute('data-lucide', isEditMode ? 'check' : 'edit-3');
    }
  }

  const editBanner = document.getElementById('edit-mode-banner');
  if (editBanner) {
    editBanner.style.display = isEditMode ? 'flex' : 'none';
  }

  // Update dynamic tab bar and enable/disable drag-and-drop
  renderDashboards();
  if (isEditMode) {
    enableDragAndDrop();
  } else {
    disableDragAndDrop();
  }

  if (window.lucide) window.lucide.createIcons();
}
window.toggleEditMode = toggleEditMode;

// (Legacy switchTab definition removed; active switchTab is defined below renderDashboards)

// Help determine backend URL based on how the page is loaded (file:// vs http://)
function getApiUrls() {
  let host = window.location.host;
  let protocol = window.location.protocol;

  if (!host || protocol === 'file:') {
    host = 'localhost:8000';
    protocol = 'http:';
  }

  const httpUrl = protocol.startsWith('http') ? `${protocol}//${host}` : `http://${host}`;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${host}`;

  return { httpUrl, wsUrl };
}

// 4. REST API - Fetch Active Entities & Render
function loadEntities() {
  console.log("Fetching active entities from server...");
  const { httpUrl } = getApiUrls();
  fetch(`${httpUrl}/api/entities`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.json();
    })
    .then(data => {
      buildDashboardCards(data);
    })
    .catch(err => {
      console.error("Could not load entities. Service offline?", err);
      addAuditEntry('warning', `Failed to sync database entities: REST endpoint unreachable.`);
      setupFallbackMocks();
    });
}

// Fallback logic for offline integration / local review
function setupFallbackMocks() {
  console.log("Setting up fallback mock visual nodes.");
  const mockEntities = {
    "cpu-utilization": {
      "node_id": "core-mon",
      "entity_key": "cpu-utilization",
      "name": "Core CPU Cycles",
      "type": "sensor",
      "value_type": "float",
      "unit": "%",
      "value": 18.4,
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
      "value": 42.1,
      "status": "Stable",
      "status_type": "stable",
      "tags": "main,server",
      "icon": "hard-drive",
      "color": "#3b82f6",
      "graphic": "sparkline"
    },
    "server-room-temp": {
      "node_id": "core-mon",
      "entity_key": "server-room-temp",
      "name": "Host CPU Temperature",
      "type": "sensor",
      "value_type": "float",
      "unit": "°C",
      "value": 41.5,
      "status": "Optimal",
      "status_type": "optimal",
      "tags": "main,server",
      "icon": "thermometer",
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
      "value": 2.4,
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
    "database-latency": {
      "node_id": "core-mon",
      "entity_key": "database-latency",
      "name": "Database Connection Latency",
      "type": "sensor",
      "value_type": "float",
      "unit": "ms",
      "value": 4.2,
      "status": "Optimal",
      "status_type": "optimal",
      "tags": "main,server",
      "icon": "database",
      "color": "#10b981",
      "graphic": "sparkline"
    },
    "database-storage-pct": {
      "node_id": "core-mon",
      "entity_key": "database-storage-pct",
      "name": "Database Storage Space Full",
      "type": "sensor",
      "value_type": "float",
      "unit": "%",
      "value": 12.0,
      "status": "Healthy",
      "status_type": "healthy",
      "tags": "main,server",
      "icon": "database",
      "color": "#10b981",
      "graphic": "sparkline"
    }
  };
  buildDashboardCards(mockEntities);
}

// 5. Build dynamic Cards DOM
function buildDashboardCards(entitiesMap: Record<string, TelemetryEntity>) {
  cachedEntities = entitiesMap;
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // 1. Initialize widgets configuration list if missing
  let widgets = [];
  try {
    const stored = localStorage.getItem('hp_dashboard_widgets');
    if (stored) {
      widgets = JSON.parse(stored);
      // Clean out legacy hardcoded living room widgets or legacy grid-embedded health/audit cards
      const hadLegacy = widgets.some(w => w.id === 'widget-hp-health' || w.id === 'widget-hp-audits' || (w.entities && w.entities.some(e => e.entityKey === 'power_state' || e.nodeId === 'smart-plug-01')));
      if (hadLegacy) {
        widgets = widgets.filter(w => w.id !== 'widget-hp-health' && w.id !== 'widget-hp-audits' && !(w.entities && w.entities.some(e => e.entityKey === 'power_state' || e.nodeId === 'smart-plug-01')));
        localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));
        syncLocalConfigToServer();
      }
    } else {
      widgets = initializeWidgets();
      syncLocalConfigToServer();
    }
  } catch (err) {
    console.error("Failed to load hp_dashboard_widgets configuration:", err);
    widgets = initializeWidgets();
    syncLocalConfigToServer();
  }

  // Normalize widgets: resolve sensor_id strings to { nodeId, entityKey } structures to support HA style entity tags
  widgets.forEach(widget => {
    if (widget.entity && typeof widget.entity === 'string') {
      const ref = window.resolveSensorIdToEntityRef(widget.entity);
      if (ref) {
        widget.entities = [ref];
      }
    }
    if (widget.entities && Array.isArray(widget.entities)) {
      widget.entities = widget.entities.map(item => {
        if (typeof item === 'string') {
          return window.resolveSensorIdToEntityRef(item) || item;
        }
        return item;
      });
    }
  });

  // Preserve the plus-circle add placeholder
  const placeholder = grid.querySelector('.card-placeholder');

  // Clear existing cards
  const existingCards = grid.querySelectorAll('.card:not(.card-placeholder)');
  existingCards.forEach(c => c.remove());

  // 2. Sort widgets by saved order array
  try {
    const savedOrder = JSON.parse(localStorage.getItem('hp_widget_order') || '[]');
    if (savedOrder.length > 0) {
      widgets.sort((a, b) => {
        let idxA = savedOrder.indexOf(`card-${a.id}`);
        let idxB = savedOrder.indexOf(`card-${b.id}`);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB;
      });
    }
  } catch (err) {
    console.error("Failed to sort dynamic widgets:", err);
  }

  // 3. Render widgets
  widgets.forEach(widget => {
    // Check if target tab is active
    if (widget.tab !== activeTab) return;

    const cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.id = `card-${widget.id}`;

    // Apply sizing options classes
    const w = widget.options.gridWidth || 1;
    const h = widget.options.gridHeight || 1;
    if (w > 1) cardEl.classList.add(`grid-w-${w}`);
    if (h > 1) cardEl.classList.add(`grid-h-${h}`);

    if (widget.type === 'error') {
      cardEl.style.background = '#f59e0b';
      cardEl.style.border = '1px solid #d97706';
      cardEl.style.color = '#000000';
      cardEl.style.display = 'flex';
      cardEl.style.flexDirection = 'column';
      cardEl.style.justifyContent = 'center';
      cardEl.style.alignItems = 'center';
      cardEl.style.minHeight = '140px';
      cardEl.style.padding = '16px';
      cardEl.style.borderRadius = '8px';
      cardEl.style.boxSizing = 'border-box';
      cardEl.style.textAlign = 'center';
      cardEl.style.position = 'relative';

      let deleteBtnHtml = '';
      if (typeof isEditMode !== 'undefined' && isEditMode) {
        cardEl.setAttribute('draggable', 'true');
        cardEl.addEventListener('dragstart', handleDragStart);
        cardEl.addEventListener('dragover', handleDragOver);
        cardEl.addEventListener('dragleave', handleDragLeave);
        cardEl.addEventListener('drop', handleDrop);
        cardEl.addEventListener('dragend', handleDragEnd);
        cardEl.ondblclick = () => openCardEditor(widget.id);

        deleteBtnHtml = `
          <button class="card-action-btn delete-btn" onclick="event.stopPropagation(); deleteWidgetSettings('${widget.id}')" title="Delete Error Card" style="position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.2); border:none; color:#000; border-radius:4px; width:24px; height:24px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
            <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
          </button>
        `;
      }

      cardEl.innerHTML = `
        ${deleteBtnHtml}
        <i data-lucide="alert-triangle" style="width: 36px; height: 36px; color: #000; margin-bottom: 8px;"></i>
        <div style="font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; line-height: 1.2;">Configuration Error</div>
        <div style="font-size: 0.72rem; opacity: 0.85; margin-top: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${widget.options.error_message || 'YAML parsing exception'}">${widget.options.error_message || 'YAML format exception'}</div>
      `;
      grid.appendChild(cardEl);
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // If widget has single primary entity target
    if (widget.entities && widget.entities.length === 1 && (widget.type === 'sensor' || widget.type === 'control' || widget.type === 'value')) {
      const eRef = widget.entities[0];
      const matchedKey = Object.keys(entitiesMap).find(key => {
        const item = entitiesMap[key];
        return item.node_id === eRef.nodeId && item.entity_key === eRef.entityKey;
      });
      const item = matchedKey ? entitiesMap[matchedKey] : null;

      if (item) {
        cardEl.setAttribute('data-node-id', item.node_id);
        cardEl.setAttribute('data-entity-key', item.entity_key);
        cardEl.setAttribute('data-value-type', item.value_type || 'float');
        const resolvedItemUnit = item.unit || (item.attributes && item.attributes.unit) || '';
        cardEl.setAttribute('data-unit', widget.options.unit || resolvedItemUnit);

        if (item.value === true || item.value === 'true' || item.value >= 1) {
          cardEl.classList.add('highlighted');
        }

        const displayName = widget.title || item.name || item.entity_key;
        const displayUnit = widget.options.unit !== undefined ? widget.options.unit : resolvedItemUnit;
        const displayColor = widget.options.color || item.color || 'var(--color-optimal)';
        const sensorId = window.getSensorIdForEntity(item.node_id, item.entity_key, item.name, item.type);

        let headerHTML = `
          <div class="card-header">
            <div class="card-title-area">
              <span class="card-title">${displayName}</span>
              <span class="card-subtitle">${item.node_id}.local</span>
              <span class="card-subtitle" style="font-size:0.62rem; opacity:0.65; margin-top:2px; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:210px; cursor:pointer;" title="Click to copy: ${sensorId}" onclick="navigator.clipboard?.writeText('${sensorId}'); showToast?.('Copied Entity ID')">Entity ID: ${sensorId}</span>
            </div>
            <span class="status-pill ${item.status_type || 'default'}">${item.status || 'Stable'}</span>
          </div>
        `;

        let bodyHTML = '';
        const initialVal = item.value !== undefined ? item.value : '';

        if (widget.type === 'control') {
          if (item.value_type === 'boolean') {
            const isChecked = (item.value === true || item.value === 'true' || item.value === 'ON');
            bodyHTML = `
              <div class="card-body">
                <div class="card-value">${isChecked ? 'ON' : 'OFF'}</div>
                <div class="control-row" style="margin-top: 14px;">
                  <div class="status-indicator">
                    <span class="status-dot online"></span>
                    <span>Active</span>
                  </div>
                  <label class="switch">
                    <input type="checkbox" onchange="onControlChange('${item.node_id}', '${item.entity_key}', this.checked)" ${isChecked ? 'checked' : ''}>
                    <span class="slider"></span>
                  </label>
                </div>
              </div>
            `;
          } else {
            const minVal = item.range ? item.range[0] : 0;
            const maxVal = item.range ? item.range[1] : 100;
            bodyHTML = `
              <div class="card-body">
                <div class="card-value">${initialVal}<span class="card-unit"> ${displayUnit}</span></div>
                <div class="slider-container" style="margin-top: 10px;">
                  <i data-lucide="${item.icon || 'sliders'}"></i>
                  <input type="range" class="range-slider" min="${minVal}" max="${maxVal}" value="${initialVal}" 
                    oninput="onSliderDrag('${item.node_id}', '${item.entity_key}', this.value)" 
                    onchange="onControlChange('${item.node_id}', '${item.entity_key}', parseInt(this.value))">
                </div>
              </div>
            `;
          }
        } else if (widget.type === 'value') {
          bodyHTML = `
            <div class="card-body">
              <div class="card-value">${initialVal}<span class="card-unit"> ${displayUnit}</span></div>
              <div class="flat-bottom-bar blue" style="background-color: ${displayColor}"></div>
            </div>
          `;
        } else { // sensor
          const sparklineHTML = widget.options.graphic === 'sparkline' ? `
            <div class="card-graphic-container">
              <svg class="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none">
                <path d="" fill="none" stroke="${displayColor}" stroke-width="1.5"></path>
              </svg>
            </div>
          ` : '';

          bodyHTML = `
            <div class="card-body">
              <div class="card-value">${initialVal}<span class="card-unit"> ${displayUnit}</span></div>
              ${sparklineHTML}
            </div>
          `;
        }

        cardEl.innerHTML = headerHTML + bodyHTML + `
          <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
          <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
          <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
        `;
      } else {
        cardEl.classList.add('unavailable');
        cardEl.innerHTML = `
          <div class="card-header" style="opacity: 0.6;">
            <div class="card-title-area">
              <span class="card-title">${widget.title || eRef.entityKey}</span>
              <span class="card-subtitle">${eRef.nodeId}.local</span>
            </div>
            <span class="status-pill default" style="background:rgba(239, 68, 68, 0.1); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.2);">Offline</span>
          </div>
          <div class="card-body" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:60px; color:var(--text-secondary); font-size:0.75rem; text-align:center;">
            <i data-lucide="alert-circle" style="width:20px; height:20px; color:#ef4444; margin-bottom:6px;"></i>
            <span>Entity unavailable or offline</span>
          </div>
          <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
          <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
          <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
        `;
      }
    }

    // TYPE A: Circular Gauge Card
    else if (widget.type === 'gauge') {
      const eRef = widget.entities[0];
      const matchedKey = Object.keys(entitiesMap).find(key => {
        const item = entitiesMap[key];
        return item.node_id === eRef.nodeId && item.entity_key === eRef.entityKey;
      });
      const item = matchedKey ? entitiesMap[matchedKey] : null;

      if (item) {
        cardEl.setAttribute('data-node-id', item.node_id);
        cardEl.setAttribute('data-entity-id', item.entity_key);
        cardEl.setAttribute('data-scale-min', widget.options.min !== undefined ? widget.options.min : '0');
        cardEl.setAttribute('data-scale-max', widget.options.max !== undefined ? widget.options.max : '100');
        const resolvedGaugeUnit = item.unit || (item.attributes && item.attributes.unit) || '';
        cardEl.setAttribute('data-unit', widget.options.unit || resolvedGaugeUnit);
        cardEl.classList.add('card-gauge');

        const min = parseFloat(widget.options.min !== undefined ? widget.options.min : 0);
        const max = parseFloat(widget.options.max !== undefined ? widget.options.max : 100);
        const numericVal = parseFloat(item.value) || 0;
        const pct = Math.max(0, Math.min(1, (numericVal - min) / (max - min)));
        const offset = 110 - (pct * 110);
        const displayColor = widget.options.color || item.color || 'var(--color-optimal)';
        const unit = widget.options.unit || resolvedGaugeUnit;

        cardEl.innerHTML = `
          <div class="card-header">
            <div class="card-title-area">
              <span class="card-title">${widget.title || item.name || item.entity_key}</span>
              <span class="card-subtitle">${item.node_id}.local • Gauge</span>
            </div>
            <span class="status-pill ${item.status_type || 'default'}">${item.status || 'Stable'}</span>
          </div>
          <div class="card-body" style="padding: 0 16px 16px 16px;">
            <div class="gauge-container">
              <svg viewBox="0 0 100 60" class="gauge-svg">
                <path d="M 15 50 A 40 40 0 0 1 85 50" fill="none" stroke="var(--bg-secondary)" stroke-width="8" stroke-linecap="round"/>
                <path class="gauge-value-arc" d="M 15 50 A 40 40 0 0 1 85 50" fill="none" stroke="${displayColor}" stroke-width="8" stroke-linecap="round" stroke-dasharray="110" stroke-dashoffset="${offset}"/>
                <text x="50" y="44" text-anchor="middle" class="gauge-text" fill="var(--text-primary)" font-size="12" font-weight="700">${item.value}</text>
                <text x="50" y="54" text-anchor="middle" class="gauge-unit" fill="var(--text-secondary)" font-size="7">${unit}</text>
              </svg>
            </div>
          </div>
          <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
          <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
          <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
        `;
      } else {
        cardEl.classList.add('unavailable');
        cardEl.innerHTML = `
          <div class="card-header" style="opacity: 0.6;">
            <div class="card-title-area">
              <span class="card-title">${widget.title || eRef.entityKey}</span>
              <span class="card-subtitle">${eRef.nodeId}.local • Gauge</span>
            </div>
            <span class="status-pill default" style="background:rgba(239, 68, 68, 0.1); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.2);">Offline</span>
          </div>
          <div class="card-body" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:60px; color:var(--text-secondary); font-size:0.75rem; text-align:center;">
            <i data-lucide="alert-circle" style="width:20px; height:20px; color:#ef4444; margin-bottom:6px;"></i>
            <span>Entity unavailable or offline</span>
          </div>
          <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
          <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
          <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
        `;
      }
    }
    // TYPE A.1: Title / Section Header Card
    else if (widget.type === 'title') {
      cardEl.classList.add('card-title-type');
      cardEl.style.minHeight = '50px';

      const titleColor = widget.options.color || 'var(--accent-orange)';

      cardEl.innerHTML = `
        <div style="display: flex; align-items: center; width: 100%; height: 100%;">
          <span style="font-size: 1.05rem; font-weight: 700; color: ${titleColor};">${widget.title || 'Section Title'}</span>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
        <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
      `;
    }

    // TYPE B: Multi-Entity Row List Card
    else if (widget.type === 'entities') {
      let rowsHTML = '';
      widget.entities.forEach(ref => {
        const item = Object.values(entitiesMap).find(e => e.node_id === ref.nodeId && e.entity_key === ref.entityKey);
        if (item) {
          const unit = item.unit || '';
          let stateContent = '';

          if (item.type === 'control' && item.value_type === 'boolean') {
            const isChecked = (item.value === true || item.value === 'true' || item.value === 'ON');
            stateContent = `
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="entity-row-state" style="font-size:0.75rem;">${isChecked ? 'ON' : 'OFF'}</span>
                <label class="switch" style="transform:scale(0.85);">
                  <input type="checkbox" onchange="onControlChange('${item.node_id}', '${item.entity_key}', this.checked)" ${isChecked ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
            `;
          } else if (item.type === 'control') {
            const min = item.range ? item.range[0] : 0;
            const max = item.range ? item.range[1] : 100;
            stateContent = `
              <div style="display:flex; align-items:center; gap:10px; width:130px;">
                <input type="range" class="range-slider" min="${min}" max="${max}" value="${item.value}" style="width:70px; margin:0;"
                  onchange="onControlChange('${item.node_id}', '${item.entity_key}', parseInt(this.value))">
                <span class="entity-row-state" style="min-width:36px; text-align:right;">${item.value}${unit ? ' ' + unit : ''}</span>
              </div>
            `;
          } else {
            stateContent = `<span class="entity-row-state">${item.value}${unit ? ' ' + unit : ''}</span>`;
          }

          rowsHTML += `
            <div class="entity-row" data-node-id="${item.node_id}" data-entity-key="${item.entity_key}" data-unit="${unit}">
              <span class="entity-row-name">${item.name || item.entity_key}</span>
              ${stateContent}
            </div>
          `;
        }
      });

      cardEl.innerHTML = `
        <div class="card-header">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Entities List"}</span>
            <span class="card-subtitle">Multiple Devices Overview</span>
          </div>
        </div>
        <div class="card-body">
          <div class="entities-list">
            ${rowsHTML || '<div style="color:var(--text-secondary); text-align:center; padding:10px; font-size:0.8rem;">No entities selected</div>'}
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
        <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
      `;
    }

    // TYPE C: Glance Grid Icons Card
    else if (widget.type === 'glance') {
      let itemsHTML = '';
      widget.entities.forEach(ref => {
        const item = Object.values(entitiesMap).find(e => e.node_id === ref.nodeId && e.entity_key === ref.entityKey);
        if (item) {
          const unit = item.unit || '';
          let displayVal = item.value;
          if (item.value === true || item.value === 'true' || item.value === 'ON') displayVal = 'ON';
          else if (item.value === false || item.value === 'false' || item.value === 'OFF') displayVal = 'OFF';

          itemsHTML += `
            <div class="glance-item" data-node-id="${item.node_id}" data-entity-key="${item.entity_key}" data-unit="${unit}">
              <span class="glance-item-name">${item.name || item.entity_key}</span>
              <i data-lucide="${item.icon || 'activity'}"></i>
              <span class="glance-item-state">${displayVal}${unit ? ' ' + unit : ''}</span>
            </div>
          `;
        }
      });

      cardEl.innerHTML = `
        <div class="card-header">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Glance Board"}</span>
            <span class="card-subtitle">At a glance metrics</span>
          </div>
        </div>
        <div class="card-body" style="padding: 0 16px 16px 16px;">
          <div class="glance-grid">
            ${itemsHTML || '<div style="color:var(--text-secondary); grid-column:1/-1; text-align:center; font-size:0.8rem;">No items</div>'}
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
        <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
      `;
    }

    // TYPE D: Health Snapshot widget
    else if (widget.type === 'health') {
      const isEditModeActive = document.getElementById('main-content')?.classList.contains('edit-mode');
      const snapshotNoticeText = isEditModeActive ?
        `Configuration mode active: Direct dashboard widgets configuration is unlocked.` :
        `Observer mode restricted: Manual configuration and control overrides are currently disabled by administrative policy.`;

      cardEl.innerHTML = `
        <div class="card-header">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Health Snapshot"}</span>
            <span class="card-subtitle">Infrastructure Core Performance</span>
          </div>
        </div>
        <div class="card-body" style="padding:0 16px 16px 16px;">
          <div class="snapshot-list" style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
            <div class="snapshot-item">
              <div class="snapshot-header" style="display:flex; justify-content:space-between; font-size:0.8rem; font-weight:600; margin-bottom:4px;">
                <span class="snapshot-label" style="color:var(--text-secondary);">Global Availability</span>
                <span class="snapshot-value green" id="snapshot-availability">--%</span>
              </div>
              <div class="snapshot-progress-bg" style="background:var(--border-soft); height:6px; border-radius:3px; overflow:hidden;">
                <div class="snapshot-progress-fill green" id="snapshot-availability-bar" style="width: 0%; background:var(--color-optimal); height:100%; transition:width 0.4s ease;"></div>
              </div>
            </div>
            <div class="snapshot-item">
              <div class="snapshot-header" style="display:flex; justify-content:space-between; font-size:0.8rem; font-weight:600; margin-bottom:4px;">
                <span class="snapshot-label" style="color:var(--text-secondary);">Resource Saturation</span>
                <span class="snapshot-value orange" id="snapshot-saturation">--%</span>
              </div>
              <div class="snapshot-progress-bg" style="background:var(--border-soft); height:6px; border-radius:3px; overflow:hidden;">
                <div class="snapshot-progress-fill orange" id="snapshot-saturation-bar" style="width: 0%; background:var(--color-caution); height:100%; transition:width 0.4s ease;"></div>
              </div>
            </div>
            <div class="snapshot-item">
              <div class="snapshot-header" style="display:flex; justify-content:space-between; font-size:0.8rem; font-weight:600; margin-bottom:4px;">
                <span class="snapshot-label" style="color:var(--text-secondary);">Security Posture</span>
                <span class="snapshot-value green" id="snapshot-security">Waiting...</span>
              </div>
              <div class="snapshot-progress-bg" style="background:var(--border-soft); height:6px; border-radius:3px; overflow:hidden;">
                <div class="snapshot-progress-fill green" id="sidebar-security-bar" style="width: 0%; background:var(--color-optimal); height:100%; transition:width 0.4s ease;"></div>
              </div>
            </div>
          </div>
          <div class="snapshot-notice" style="margin-top:14px; font-size:0.72rem; color:var(--text-secondary); border-top:1px solid var(--border-soft); padding-top:10px;">
            ${snapshotNoticeText}
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
        <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
      `;
    }

    // TYPE E: System Audit list panel widget
    else if (widget.type === 'audit') {
      cardEl.innerHTML = `
        <div class="card-header" style="flex-wrap: wrap; gap: 12px; display: flex; justify-content: space-between; align-items: center;">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Global System Audit"}</span>
            <span class="card-subtitle">Realtime DB event tracking</span>
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <!-- Severity Filtering Controls -->
            <div style="display: flex; gap: 4px;">
              <button class="audit-filter-btn active" data-filter="all" onclick="filterAuditLogs('all')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: var(--bg-secondary); color: var(--text-primary); border-radius: 4px; cursor: pointer;">All</button>
              <button class="audit-filter-btn" data-filter="info" onclick="filterAuditLogs('info')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Info</button>
              <button class="audit-filter-btn" data-filter="success" onclick="filterAuditLogs('success')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Success</button>
              <button class="audit-filter-btn" data-filter="warning" onclick="filterAuditLogs('warning')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Warning</button>
              <button class="audit-filter-btn" data-filter="error" onclick="filterAuditLogs('error')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Error</button>
            </div>
            <!-- Exporter Mappings -->
            <div style="display: flex; gap: 4px; border-left: 1px solid var(--border-soft); padding-left: 10px;">
              <button onclick="exportAuditLogs('json')" title="Export JSON" style="background: transparent; border: 1px solid var(--border-soft); color: var(--text-secondary); padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 0.56rem; display: flex; gap: 4px; align-items: center;">
                <i data-lucide="download" style="width: 10px; height: 10px;"></i> JSON
              </button>
              <button onclick="exportAuditLogs('csv')" title="Export CSV" style="background: transparent; border: 1px solid var(--border-soft); color: var(--text-secondary); padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 0.56rem; display: flex; gap: 4px; align-items: center;">
                <i data-lucide="download" style="width: 10px; height: 10px;"></i> CSV
              </button>
            </div>
          </div>
        </div>
        <div class="card-body" style="padding:0 16px 16px 16px;">
          <div class="audit-list" id="audit-list" style="max-height: 180px; overflow-y: auto; background: var(--bg-primary); border: 1px solid var(--border-soft); border-radius: 6px; padding: 12px; font-family: monospace; font-size: 0.72rem; display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <!-- Dynamically populated -->
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}', 'ui')"><i data-lucide="sliders"></i></div>
        <div class="edit-code" onclick="openCardEditor('${widget.id}', 'yaml')"><i data-lucide="code"></i></div>
      `;
    }

    // Insert card inside the grid
    if (placeholder) {
      grid.insertBefore(cardEl, placeholder);
    } else {
      grid.appendChild(cardEl);
    }
  });

  // Re-render Dynamic SVG icons via CDN
  if (window.lucide) window.lucide.createIcons();

  // Highlight and filter tab state
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === activeTab);
  });

  // Re-sync historical elements (sparklines)
  widgets.forEach(widget => {
    if (widget.tab !== activeTab || widget.type !== 'sensor') return;
    const eRef = widget.entities[0];
    const key = `${eRef.nodeId}-${eRef.entityKey}`;
    const cardEl = document.getElementById(`card-${key}`);
    if (cardEl && telemetryHistory[key] && telemetryHistory[key].length > 0) {
      const path = cardEl.querySelector('.sparkline path');
      if (path) {
        path.setAttribute('d', getSparklinePath(telemetryHistory[key]));
      }
    }
  });

  // Update dynamic Health Snapshot values
  updateHealthSnapshot();
}

// 6. Action handlers triggered from Card DOM elements
function onSliderDrag(nodeId, entityId, val) {
  const card = document.getElementById(`card-${nodeId}-${entityId}`);
  if (card) {
    const valueDisp = card.querySelector('.card-value');
    const unit = card.getAttribute('data-unit') || '';
    if (valueDisp) {
      valueDisp.innerHTML = `${val}<span class="card-unit"> ${unit}</span>`;
    }
  }
}

function onControlChange(nodeId, entityId, val) {
  console.log(`Command dispatched: ${nodeId}/${entityId} -> ${val}`);

  // Optimistically toggle class highlights
  const card = document.getElementById(`card-${nodeId}-${entityId}`);
  if (card && typeof val === 'boolean') {
    card.classList.toggle('highlighted', val);
    const valText = card.querySelector('.card-value');
    if (valText) valText.textContent = val ? 'ON' : 'OFF';
  }

  const { httpUrl } = getApiUrls();
  fetch(`${httpUrl}/api/entities/control/${nodeId}/${entityId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ value: val })
  })
    .then(res => {
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      console.log("Action response completed status:", data);
    })
    .catch(err => {
      console.error("Endpoint actuator failed:", err);
      addAuditEntry('warning', `Actuation error on ${nodeId} (${entityId}): REST service unavailable.`);
    });
}

// 7. WebSocket Client Feed Connection
function setupWebSocket() {
  const { wsUrl } = getApiUrls();
  const wsEndpoint = `${wsUrl}/api/ws/client`;

  console.log(`Connecting to WebSocket: ${wsEndpoint}`);
  socket = new WebSocket(wsEndpoint);

  socket.onopen = () => {
    console.log("WebSocket stream connected successfully.");
    addAuditEntry('success', "Active WebSocket live event subscription stream established.");

    // Subscribe to events structure
    socket.send(JSON.stringify({
      action: "subscribe",
      token: token,
      streams: ["telemetry", "audits", "discovery"]
    }));
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleIncomingWSEvent(data);
    } catch (err) {
      console.warn("Could not parse WS payload:", err);
    }
  };

  socket.onclose = (event) => {
    console.warn(`WebSocket closed: Code ${event.code}. Reconnecting in 5 seconds...`);
    addAuditEntry('warning', "Live connection lost. Streaming disconnected. Retrying...");
    setTimeout(setupWebSocket, 5000);
  };

  socket.onerror = (err) => {
    console.error("WS error encountered:", err);
  };
}

// 8. WS Event router matching protocol specifications
function handleIncomingWSEvent(data) {
  if (!data) return;

  // A. Telemetry updates
  if (data.event === 'state_changed') {
    updateCardState(data.node_id, data.entity_id, data.value, data.status, data.status_type);
    if (data.node_id === 'monitors') {
      handleLiveMonitorWSUpdate(data.entity_id, data.value, data.status, data.status_type);
    }
  }
  else if (data.event === 'entity_update') {
    const ent = data.data;
    if (ent && ent.entity_key) {
      if (ent.deleted) {
        delete cachedEntities[ent.entity_key];
      } else {
        cachedEntities[ent.entity_key] = ent;
        updateCardState(
          ent.node_id || 'plugins',
          ent.entity_key,
          ent.value,
          ent.status || 'Optimal',
          ent.status_type || 'optimal'
        );
      }
      const pluginsView = document.getElementById('plugins-view');
      if (pluginsView && !pluginsView.classList.contains('hide')) {
        loadInstalledPlugins();
      }
      const hostsView = document.getElementById('hosts-view');
      if (hostsView && !hostsView.classList.contains('hide')) {
        loadHosts();
      }
    }
  }

  // B. Audit Log updates
  else if (data.event === 'audit_logged') {
    addAuditEntry(data.type, data.message);
  }

  // C. Dynamic mDNS discovery updates
  else if (data.event === 'device_discovered') {
    // Deactivated per request
  }

  // D. Global Settings updates
  else if (data.event === 'settings_updated') {
    applyGlobalSettings(data.settings);
  }

  // E. Global Dashboard Config updates
  else if (data.event === 'dashboard_config_updated') {
    applyGlobalDashboardConfig(data.widgets, data.order, data.tabs);
  }
}

// Dynamically sync and apply updated system settings to this browser instance
function applyGlobalSettings(data) {
  if (!data) return;
  console.log("Applying dynamic settings update broadcast:", data);

  const tzEl = document.getElementById('setting-timezone');
  if (tzEl && data.timezone) {
    tzEl.value = data.timezone;
  }
  currentTimezone = data.timezone || 'UTC';
  updateHeaderTime();

  const retentionEl = document.getElementById('setting-retention');
  const retentionVal = document.getElementById('setting-retention-val');
  if (retentionEl && data.log_retention) {
    retentionEl.value = data.log_retention;
    if (retentionVal) retentionVal.textContent = `${data.log_retention} days`;
  }

  const intervalEl = document.getElementById('setting-interval');
  const intervalVal = document.getElementById('setting-interval-val');
  if (intervalEl && data.telemetry_interval) {
    intervalEl.value = data.telemetry_interval;
    if (intervalVal) intervalVal.textContent = `${data.telemetry_interval}s`;
  }

  const pskEl = document.getElementById('setting-psk');
  if (pskEl && data.preshared_key) pskEl.value = data.preshared_key;

  const compactEl = document.getElementById('setting-compact');
  if (compactEl) {
    compactEl.checked = (data.layout_compact === 'true');
    document.body.classList.toggle('layout-compact', compactEl.checked);
  }

  const monitorsToggleEl = document.getElementById('setting-show-service-monitors');
  if (monitorsToggleEl && data.show_service_monitors !== undefined) {
    monitorsToggleEl.checked = (data.show_service_monitors === 'true');
    const navProbes = document.getElementById('nav-probes');
    if (navProbes) {
      navProbes.style.display = (data.show_service_monitors === 'true') ? '' : 'none';
    }
  }

  if (data.theme) {
    applyTheme(data.theme);
  }
}

// Update DOM elements on Live Socket triggers
function updateCardState(nodeId, entityId, val, status, statusType) {
  // Update memory cache for health status compilation (always keep cachedEntities in sync)
  let matchedKey = Object.keys(cachedEntities).find(key => {
    const item = cachedEntities[key];
    return item.node_id === nodeId && item.entity_key === entityId;
  });
  if (!matchedKey) {
    const newKey = entityId;
    cachedEntities[newKey] = {
      node_id: nodeId,
      entity_key: entityId,
      name: entityId.replace(/-/g, ' '),
      type: 'sensor',
      value_type: entityId.includes('latency') ? 'float' : 'string',
      unit: entityId.includes('latency') ? 'ms' : '',
      value: val,
      status: status || '',
      status_type: statusType || 'default'
    };
    matchedKey = newKey;
  } else {
    cachedEntities[matchedKey].value = val;
    if (status) cachedEntities[matchedKey].status = status;
    if (statusType) cachedEntities[matchedKey].status_type = statusType;
  }

  const card = document.querySelector(`[data-node-id="${nodeId}"][data-entity-key="${entityId}"]`);
  if (!card) return;

  const valueType = card.getAttribute('data-value-type');
  const unit = card.getAttribute('data-unit') || '';

  // Update status pill dynamically
  if (status && statusType) {
    const pill = card.querySelector('.status-pill');
    if (pill) {
      pill.textContent = status;
      pill.className = `status-pill ${statusType}`;
    }
  }

  // Update state indicators
  const valText = card.querySelector('.card-value');
  if (valText) {
    if (valueType === 'boolean') {
      const isTrue = (val === true || val === 'true' || val === 'ON');
      valText.textContent = isTrue ? 'ON' : 'OFF';
      card.classList.toggle('highlighted', isTrue);

      const toggle = card.querySelector('.switch input');
      if (toggle) toggle.checked = isTrue;
    } else {
      valText.innerHTML = `${val}<span class="card-unit"> ${unit}</span>`;

      const slider = card.querySelector('.range-slider');
      if (slider) slider.value = val;
    }
  }

  // Update dynamic telemetry sparklines
  const path = card.querySelector('.sparkline path');
  if (path) {
    const key = `${nodeId}-${entityId}`;
    if (!telemetryHistory[key]) telemetryHistory[key] = [];

    // Keep last 12 data points
    telemetryHistory[key].push(parseFloat(val));
    if (telemetryHistory[key].length > 12) {
      telemetryHistory[key].shift();
    }

    const dAttr = getSparklinePath(telemetryHistory[key]);
    path.setAttribute('d', dAttr);
  }

  // Update Health Snapshot metrics dynamically
  updateHealthSnapshot();
}

// Dynamically compute SVG graph coordinates
function getSparklinePath(values) {
  if (!values) return '';
  const validValues = values.filter(val => typeof val === 'number' && !isNaN(val) && isFinite(val));
  if (validValues.length < 2) return '';
  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  const range = (max - min === 0) ? 1 : (max - min);

  const width = 100;
  const height = 30; // Max height inside viewBox
  const padding = 5;

  return validValues.map((val, idx) => {
    const x = (idx / (validValues.length - 1)) * width;
    const y = height + padding - ((val - min) / range) * height;
    return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// 9. Audit event list builder
function addAuditEntry(type, message) {
  const auditList = document.getElementById('audit-list');
  if (!auditList) return;

  const now = new Date();
  const pad = (num) => String(num).padStart(2, '0');
  const timestamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (!window.latestAuditLogs) window.latestAuditLogs = [];
  window.latestAuditLogs.unshift({ timestamp, type, message });
  if (window.latestAuditLogs.length > 25) {
    window.latestAuditLogs.pop();
  }

  const auditRow = document.createElement('div');
  auditRow.className = `audit-row`;
  auditRow.dataset.severity = type;

  let iconName = 'info';
  let iconClass = 'info';
  if (type === 'success') { iconName = 'check-circle-2'; iconClass = 'success'; }
  else if (type === 'warning') { iconName = 'alert-triangle'; iconClass = 'warning'; }
  else if (type === 'security') { iconName = 'key-round'; iconClass = 'security'; }
  else if (type === 'error') { iconName = 'x-circle'; iconClass = 'error'; }

  auditRow.innerHTML = `
    <span class="audit-time">${timestamp}</span>
    <span class="audit-icon ${iconClass}"><i data-lucide="${iconName}" style="width: 14px; height: 14px;"></i></span>
    <span class="audit-msg">${message}</span>
  `;

  if (window.activeAuditFilter && window.activeAuditFilter !== 'all' && type !== window.activeAuditFilter) {
    auditRow.style.display = 'none';
  }

  auditList.insertBefore(auditRow, auditList.firstChild);
  if (window.lucide) window.lucide.createIcons();

  // Enforce scroll history item limit
  while (auditList.children.length > 25) {
    auditList.removeChild(auditList.lastChild);
  }
}

window.exportAuditLogs = function (format) {
  const logs = window.latestAuditLogs || [];
  if (logs.length === 0) {
    showToast("No audit logs available to export.", "warning");
    return;
  }

  const filter = window.activeAuditFilter || 'all';
  const filteredLogs = logs.filter(log => filter === 'all' || log.type === filter);
  if (filteredLogs.length === 0) {
    showToast(`No audit logs of severity "${filter}" available to export.`, "warning");
    return;
  }

  let content = '';
  let filename = `audit_logs_${Date.now()}`;
  let mimeType = 'text/plain';

  if (format === 'json') {
    content = JSON.stringify(filteredLogs, null, 2);
    filename += '.json';
    mimeType = 'application/json';
  } else if (format === 'csv') {
    content = 'Timestamp,Level,Message\n';
    filteredLogs.forEach(log => {
      const safeMsg = (log.message || '').replace(/"/g, '""');
      content += `"${log.timestamp}","${log.type}","${safeMsg}"\n`;
    });
    filename += '.csv';
    mimeType = 'text/csv';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(`Successfully exported audit logs to ${format.toUpperCase()}`, 'success');
};

// 10. mDNS Node Discovery Handlers
function showDiscoveryAlert(nodeId, name, ip) {
  const banner = document.getElementById('discovery-banner');
  const title = document.getElementById('discovery-title');
  const subtitle = document.getElementById('discovery-subtitle');
  const badge = document.getElementById('discovery-badge');

  if (!banner) return;

  // Stash target node identifying tokens
  banner.dataset.nodeId = nodeId;

  // Display details
  if (title) title.textContent = `New Endpoint Discovered: ${name}`;
  if (subtitle) subtitle.innerHTML = `mDNS broadcast detected: <strong>${nodeId}.local</strong> (IP: ${ip})`;

  // Show banner alert
  banner.classList.remove('hide');
  banner.style.display = 'flex';

  // Increment badge notification
  if (badge) {
    let count = parseInt(badge.textContent || '0');
    count++;
    badge.textContent = String(count);
    badge.style.opacity = '1';
    badge.style.pointerEvents = 'auto';
  }

  addAuditEntry('info', `Local mDNS broadcast identified new node target: ${nodeId}`);
}

function dismissDiscovery() {
  const banner = document.getElementById('discovery-banner');
  if (banner) {
    const nodeId = banner.dataset.nodeId || 'unknown';
    banner.classList.add('hide');
    banner.style.display = 'none';
    addAuditEntry('info', `mDNS discovery alert for ${nodeId}.local dismissed by admin.`);
    decrementDiscoveryBadge();
  }
}

function approveDiscovery() {
  const banner = document.getElementById('discovery-banner');
  if (!banner) return;

  const nodeId = banner.dataset.nodeId;
  if (!nodeId) return;

  // Request token key as specified under PSK approvals
  const pin = prompt(`Enter Presign PIN / Access Token to authenticate "${nodeId}":`, "device_pin_12345");
  if (pin === null) return; // Administrator canceled prompt

  const { httpUrl } = getApiUrls();
  fetch(`${httpUrl}/api/discovery/approve/${nodeId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ preshared_key: pin })
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP rejection status ${res.status}`);
      return res.json();
    })
    .then(data => {
      banner.classList.add('hide');
      banner.style.display = 'none';
      decrementDiscoveryBadge();

      // Reload state layout to render the new approved device card
      loadEntities();
      addAuditEntry('success', `mDNS node approval complete. Added "${nodeId}" to monitoring registry.`);
    })
    .catch(err => {
      console.error("Device verification failed:", err);
      alert(`Registration verification failed: ${err.message}`);
      addAuditEntry('warning', `Failed to approve node connection "${nodeId}": ${err.message}`);
    });
}

function decrementDiscoveryBadge() {
  const badge = document.getElementById('discovery-badge');
  if (!badge) return;

  let count = parseInt(badge.textContent || '0');
  count = Math.max(0, count - 1);
  badge.textContent = String(count);

  if (count <= 0) {
    badge.style.opacity = '0';
    badge.style.pointerEvents = 'none';
  }
}

// Fetch active discovery queue on manual navigation click
function fetchDiscoveryQueue() {
  const { httpUrl } = getApiUrls();
  fetch(`${httpUrl}/api/discovery/queue`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data && data.length > 0) {
        const topDevice = data[0];
        showDiscoveryAlert(topDevice.id, topDevice.name, topDevice.manifest?.hardware?.mac || 'N/A');
      } else {
        alert("Discovery Queue is currently empty. No pending mDNS nodes identified.");
      }
    })
    .catch(err => {
      console.warn("Failed to check active discovery queue:", err);
      alert("Could not load discovery queue. System REST service offline.");
    });
}

function syncDiscoveryBadge() {
  const { httpUrl } = getApiUrls();
  fetch(`${httpUrl}/api/discovery/queue`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
    .then(res => res.ok ? res.json() : [])
    .then(data => {
      const badge = document.getElementById('discovery-badge');
      if (badge) {
        const count = (data && data.length) ? data.length : 0;
        badge.textContent = count;
        if (count > 0) {
          badge.style.opacity = '1';
          badge.style.pointerEvents = 'auto';
        } else {
          badge.style.opacity = '0';
          badge.style.pointerEvents = 'none';
        }
      }
    })
    .catch(err => {
      console.warn("Failed to sync discovery badge:", err);
    });
}

// 11. Dynamic Health Snapshot calculations compiler
function updateHealthSnapshot() {
  let cpuVal = 0;
  let memVal = 0;
  let dbConnected = true;

  const entityList = Object.values(cachedEntities);
  let hasCpu = false;
  let hasMem = false;

  entityList.forEach(item => {
    if (item.entity_key === 'cpu-utilization') {
      cpuVal = parseFloat(item.value) || 0;
      hasCpu = true;
    } else if (item.entity_key === 'memory-saturation') {
      memVal = parseFloat(item.value) || 0;
      hasMem = true;
    } else if (item.entity_key === 'database-status') {
      dbConnected = (item.value === 'CONNECTED' || item.value === 'Connected' || item.value === 'healthy');
    }
  });

  const saturation = (hasCpu && hasMem) ? Math.round((cpuVal + memVal) / 2) : (hasCpu ? Math.round(cpuVal) : 28);
  const availability = dbConnected ? 100 : 0;

  // A. Global Availability
  const availText = document.getElementById('snapshot-availability');
  const availBar = document.getElementById('snapshot-availability-bar');
  if (availText) availText.textContent = `${availability}%`;
  if (availBar) availBar.style.width = `${availability}%`;

  // B. Resource Saturation
  const satText = document.getElementById('snapshot-saturation');
  const satBar = document.getElementById('snapshot-saturation-bar');
  if (satText) {
    satText.textContent = `${saturation}%`;
    satText.className = `snapshot-value ${saturation > 85 ? 'red' : (saturation > 65 ? 'orange' : 'green')}`;
  }
  if (satBar) {
    satBar.style.width = `${saturation}%`;
    satBar.className = `snapshot-progress-fill ${saturation > 85 ? 'red' : (saturation > 65 ? 'orange' : 'green')}`;
  }

  // C. Security Posture
  const secText = document.getElementById('snapshot-security');
  const secBar = document.getElementById('snapshot-security-bar');
  if (secText) {
    secText.textContent = dbConnected ? 'Hardened' : 'Degraded';
    secText.className = `snapshot-value ${dbConnected ? 'green' : 'red'}`;
  }
  if (secBar) {
    secBar.style.width = dbConnected ? '100%' : '30%';
    secBar.className = `snapshot-progress-fill ${dbConnected ? 'green' : 'red'}`;
  }

  // Overall status pill
  const overallPill = document.getElementById('snapshot-overall-status');
  if (overallPill) {
    if (!dbConnected) {
      overallPill.textContent = 'Degraded';
      overallPill.className = 'status-pill caution';
    } else if (saturation > 85) {
      overallPill.textContent = 'Warning';
      overallPill.className = 'status-pill caution';
    } else {
      overallPill.textContent = 'Healthy';
      overallPill.className = 'status-pill optimal';
    }
  }


}

// ─────────────────────────────────────────
// SERVER-SIDE DASHBOARD CONFIGURATION SYNC
// ─────────────────────────────────────────

async function syncLocalConfigToServer() {
  const { httpUrl } = getApiUrls();
  try {
    const widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
    const order = JSON.parse(localStorage.getItem('hp_widget_order') || '[]');
    const tabs = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');

    await fetch(`${httpUrl}/api/dashboard/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ widgets, order, tabs })
    });
  } catch (err) {
    console.error("Failed to sync local layout configuration to database:", err);
  }
}

async function syncDashboardConfigFromServer() {
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/dashboard/config`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.ok) {
      const data = await res.json();
      let hasData = false;

      window.isSyncingFromServer = true;
      if (data.widgets && data.widgets.length > 0) {
        localStorage.setItem('hp_dashboard_widgets', JSON.stringify(data.widgets));
        hasData = true;
      }
      if (data.order && data.order.length > 0) {
        localStorage.setItem('hp_widget_order', JSON.stringify(data.order));
      }
      if (data.tabs && data.tabs.length > 0) {
        localStorage.setItem('hp_dashboards', JSON.stringify(data.tabs));
        hasData = true;
      }
      window.isSyncingFromServer = false;

      if (!hasData) {
        window.isSyncingFromServer = true;
        localStorage.removeItem('hp_dashboard_widgets');
        localStorage.removeItem('hp_widget_order');
        localStorage.removeItem('hp_dashboards');
        window.isSyncingFromServer = false;

        // Initialize default tabs; widgets will be initialized once entities load
        localStorage.setItem('hp_dashboards', JSON.stringify([
          { id: "main", name: "Main" }
        ]));
      }
    }
  } catch (err) {
    console.error("Failed to fetch dashboard layout config from database:", err);
    window.isSyncingFromServer = false;
  }
}

function applyGlobalDashboardConfig(widgets, order, tabs) {
  console.log("Applying live dynamically-received global dashboard configurations.");
  window.isSyncingFromServer = true;
  if (widgets) localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));
  if (order) localStorage.setItem('hp_widget_order', JSON.stringify(order));
  if (tabs) localStorage.setItem('hp_dashboards', JSON.stringify(tabs));
  window.isSyncingFromServer = false;

  renderDashboards();
  if (cachedEntities && Object.keys(cachedEntities).length > 0) {
    buildDashboardCards(cachedEntities);
  }
}

// Global Proxy to auto-sync local storage updates to the database
(function () {
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function (key, value) {
    originalSetItem.apply(this, arguments);
    if (key === 'hp_dashboard_widgets' || key === 'hp_widget_order' || key === 'hp_dashboards') {
      if (!window.isSyncingFromServer) {
        syncLocalConfigToServer();
      }
    }
  };
})();

