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

let activeTab = 'main';
let token = localStorage.getItem('hp_token') || 'Architect_JWT_String'; // Fallback token
let socket = null;
const telemetryHistory = {};
let cachedEntities = {};

document.addEventListener('DOMContentLoaded', async () => {
  // Sync dashboard layout and configuration registry from database
  await syncDashboardConfigFromServer();

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
      lucide.createIcons();
    });
  }

  // Edit Mode Toggle hooks
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  const mainContent = document.getElementById('main-content');

  if (editToggleBtn && mainContent) {
    editToggleBtn.addEventListener('click', () => {
      const isEditMode = mainContent.classList.toggle('edit-mode');
      editToggleBtn.classList.toggle('active');

      // Update dynamic tab bar and enable/disable drag-and-drop
      renderDashboards();
      if (isEditMode) {
        enableDragAndDrop();
      } else {
        disableDragAndDrop();
      }

      const yamlToggleBtn = document.getElementById('yaml-toggle-btn');
      if (yamlToggleBtn) {
        yamlToggleBtn.style.display = isEditMode ? 'flex' : 'none';
      }

      const editBanner = document.getElementById('edit-mode-banner');
      if (editBanner) {
        editBanner.style.display = isEditMode ? 'flex' : 'none';
      }

      const spanText = editToggleBtn.querySelector('span');
      if (spanText) {
        spanText.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Dashboard';
      }

      const icon = editToggleBtn.querySelector('i');
      if (icon) {
        icon.setAttribute('data-lucide', isEditMode ? 'check' : 'edit-3');
      }
      lucide.createIcons();
    });
  }
}

// 3. Tab switching filtering logic
function switchTab(tabName) {
  activeTab = tabName;

  // Update view states on tab buttons
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.classList.remove('active');
    const attr = btn.getAttribute('onclick');
    if (attr && attr.includes(tabName)) {
      btn.classList.add('active');
    }
  });

  // Filter Card Elements visibility based on data-tags attribute
  const cards = document.querySelectorAll('.dashboard-grid > .card');
  cards.forEach(card => {
    if (card.classList.contains('card-placeholder')) return; // Always keep placeholder visible in edit mode

    const tags = card.getAttribute('data-tags');
    if (tags && (tags.includes(tabName) || tabName === 'all')) {
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  });
}

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
    "server-room-temp": {
      "node_id": "core-mon",
      "entity_key": "server-room-temp",
      "name": "Server Temperature",
      "type": "sensor",
      "value_type": "float",
      "unit": "°C",
      "value": 24.2,
      "status": "Online",
      "status_type": "healthy",
      "tags": "main,server",
      "icon": "thermometer"
    },
    "living-room-lights": {
      "node_id": "smart-plug-01",
      "entity_key": "power_state",
      "name": "Living Room Lights",
      "type": "control",
      "value_type": "boolean",
      "value": true,
      "status": "Active",
      "status_type": "stable",
      "tags": "main,power",
      "icon": "lightbulb"
    }
  };
  buildDashboardCards(mockEntities);
}

// 5. Build dynamic Cards DOM
function buildDashboardCards(entitiesMap) {
  cachedEntities = entitiesMap;
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // 1. Initialize widgets configuration list if missing
  let widgets = [];
  try {
    const stored = localStorage.getItem('hp_dashboard_widgets');
    if (stored) {
      widgets = JSON.parse(stored);
    } else {
      widgets = initializeWidgets();
      syncLocalConfigToServer();
    }
  } catch (err) {
    console.error("Failed to load hp_dashboard_widgets configuration:", err);
    widgets = initializeWidgets();
    syncLocalConfigToServer();
  }

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

    // If widget has single primary entity target
    if (widget.entities && widget.entities.length === 1 && (widget.type === 'sensor' || widget.type === 'control' || widget.type === 'value')) {
      const eRef = widget.entities[0];
      const matchedKey = Object.keys(entitiesMap).find(key => {
        const item = entitiesMap[key];
        return item.node_id === eRef.nodeId && item.entity_key === eRef.entityKey;
      });
      const item = matchedKey ? entitiesMap[matchedKey] : null;

      if (item) {
        cardEl.id = `card-${item.node_id}-${item.entity_key}`; // Keep legacy ID for WS update mappings
        cardEl.setAttribute('data-value-type', item.value_type || 'float');
        cardEl.setAttribute('data-unit', widget.options.unit || item.unit || '');

        if (item.value === true || item.value === 'true' || item.value >= 1) {
          cardEl.classList.add('highlighted');
        }

        const displayName = widget.title || item.name || item.entity_key;
        const displayUnit = widget.options.unit !== undefined ? widget.options.unit : (item.unit || '');
        const displayColor = widget.options.color || item.color || 'var(--color-optimal)';

        let headerHTML = `
          <div class="card-header">
            <div class="card-title-area">
              <span class="card-title">${displayName}</span>
              <span class="card-subtitle">${item.node_id}.local</span>
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
        cardEl.setAttribute('data-unit', widget.options.unit || item.unit || '');
        cardEl.classList.add('card-gauge');

        const min = parseFloat(widget.options.min !== undefined ? widget.options.min : 0);
        const max = parseFloat(widget.options.max !== undefined ? widget.options.max : 100);
        const numericVal = parseFloat(item.value) || 0;
        const pct = Math.max(0, Math.min(1, (numericVal - min) / (max - min)));
        const offset = 110 - (pct * 110);
        const displayColor = widget.options.color || item.color || 'var(--color-optimal)';
        const unit = widget.options.unit || item.unit || '';

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
        <div class="card-header" style="flex-wrap: wrap; gap: 8px;">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Global System Audit"}</span>
            <span class="card-subtitle">Realtime DB event tracking</span>
          </div>
          <!-- Severity Filtering Controls -->
          <div style="display: flex; gap: 4px;">
            <button class="audit-filter-btn active" data-filter="all" onclick="filterAuditLogs('all')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: var(--bg-secondary); color: var(--text-primary); border-radius: 4px; cursor: pointer;">All</button>
            <button class="audit-filter-btn" data-filter="info" onclick="filterAuditLogs('info')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Info</button>
            <button class="audit-filter-btn" data-filter="success" onclick="filterAuditLogs('success')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Success</button>
            <button class="audit-filter-btn" data-filter="warning" onclick="filterAuditLogs('warning')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Warning</button>
            <button class="audit-filter-btn" data-filter="error" onclick="filterAuditLogs('error')" style="font-size:0.56rem; padding: 2px 6px; border: 1px solid var(--border-soft); background: transparent; color: var(--text-secondary); border-radius: 4px; cursor: pointer;">Error</button>
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
  lucide.createIcons();

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

  const card = document.getElementById(`card-${nodeId}-${entityId}`);
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
  lucide.createIcons();

  // Enforce scroll history item limit (only count entries that match current filter/all to prevent overflow)
  while (auditList.children.length > 25) {
    auditList.removeChild(auditList.lastChild);
  }
}

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
    badge.textContent = count;
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
  badge.textContent = count;

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
  let dbConnected = false;

  // Compile calculations from cachedEntities memory cache
  Object.values(cachedEntities).forEach(item => {
    if (item.entity_key === 'cpu-utilization') {
      cpuVal = parseFloat(item.value) || 0;
    } else if (item.entity_key === 'memory-saturation') {
      memVal = parseFloat(item.value) || 0;
    } else if (item.entity_key === 'database-status') {
      dbConnected = (item.value === 'CONNECTED');
    }
  });

  // A. Global Availability
  const availability = dbConnected ? 100 : 0;
  const availText = document.getElementById('snapshot-availability');
  const availBar = document.getElementById('snapshot-availability-bar');
  if (availText) availText.textContent = `${availability}%`;
  if (availBar) availBar.style.width = `${availability}%`;

  // B. Resource Saturation: Average of CPU and Memory Usage
  const saturation = Math.round((cpuVal + memVal) / 2);
  const satText = document.getElementById('snapshot-saturation');
  const satBar = document.getElementById('snapshot-saturation-bar');
  if (satText) satText.textContent = `${saturation}%`;
  if (satBar) satBar.style.width = `${saturation}%`;

  // C. Security Posture
  const secText = document.getElementById('snapshot-security');
  const secBar = document.getElementById('snapshot-security-bar');
  if (secText) {
    secText.textContent = dbConnected ? 'Nominal' : 'Alarm';
    secText.className = `snapshot-value ${dbConnected ? 'green' : 'red'}`;
  }
  if (secBar) {
    secBar.style.width = dbConnected ? '100%' : '20%';
    secBar.className = `snapshot-progress-fill ${dbConnected ? 'green' : 'red'}`;
  }
}

function addNewCardPlaceholder() {
  alert('Entity Configurator: Select approved micro-entities to mount as grid cards.');
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

// ─────────────────────────────────────────
// SETTINGS PAGE LOGIC
// ─────────────────────────────────────────

// Navigation: hook Settings and Dashboard sidebar links
document.addEventListener('DOMContentLoaded', () => {
  const navSettings = document.getElementById('nav-settings');
  if (navSettings) {
    navSettings.addEventListener('click', (e) => {
      e.preventDefault();
      showSettingsView();
    });
  }

  const navDashboard = document.getElementById('nav-dashboard');
  if (navDashboard) {
    navDashboard.addEventListener('click', (e) => {
      e.preventDefault();
      showDashboardView();
      // Highlight nav item
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      navDashboard.classList.add('active');
    });
  }
});

function showSettingsView() {
  // Exit edit mode if active
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (settingsView) settingsView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navSettings = document.getElementById('nav-settings');
  if (navSettings) navSettings.classList.add('active');

  loadSettings();
}

function showDashboardView() {
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'flex';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = '';
  if (bottomSection) bottomSection.style.display = '';
  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
}

function showProbesView() {
  // Exit edit mode if active
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (probesView) probesView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navProbes = document.getElementById('nav-probes');
  if (navProbes) navProbes.classList.add('active');

  navigateProbesLevel(1);
}

function showAutomationsView() {
  // Exit edit mode if active
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (automationsView) automationsView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navAutomations = document.getElementById('nav-automations');
  if (navAutomations) navAutomations.classList.add('active');

  // Load Alert Router lists dynamically
  loadAlertRules();
  loadNotificationChannels();
}

function showDeveloperToolsView() {
  // Exit edit mode if active
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navDevtools = document.getElementById('nav-devtools');
  if (navDevtools) navDevtools.classList.add('active');
}

// Bind nav triggers during initialization
document.addEventListener('DOMContentLoaded', () => {
  const navDashboard = document.getElementById('nav-dashboard');
  if (navDashboard) {
    navDashboard.addEventListener('click', (e) => {
      e.preventDefault();
      showDashboardView();
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      navDashboard.classList.add('active');
    });
  }

  const navProbes = document.getElementById('nav-probes');
  if (navProbes) {
    navProbes.addEventListener('click', (e) => {
      e.preventDefault();
      showProbesView();
    });
  }

  const navAutomations = document.getElementById('nav-automations');
  if (navAutomations) {
    navAutomations.addEventListener('click', (e) => {
      e.preventDefault();
      showAutomationsView();
    });
  }

  const navDevtools = document.getElementById('nav-devtools');
  if (navDevtools) {
    navDevtools.addEventListener('click', (e) => {
      e.preventDefault();
      showDeveloperToolsView();
    });
  }

  const navHistory = document.getElementById('nav-history');
  if (navHistory) {
    navHistory.addEventListener('click', (e) => {
      e.preventDefault();
      showUptimeHistoryView();
    });
  }

  const navHosts = document.getElementById('nav-hosts');
  if (navHosts) {
    navHosts.addEventListener('click', (e) => {
      e.preventDefault();
      showHostsView();
    });
  }

  // Bind catalog search box input listener
  const catalogSearch = document.getElementById('catalog-search');
  if (catalogSearch) {
    catalogSearch.addEventListener('input', (e) => {
      renderCatalogBlocks(e.target.value);
    });
  }

  // Bind Service Monitors launcher buttons
  const btnConfigProbe = document.getElementById('btn-configure-new-probe');
  if (btnConfigProbe) {
    btnConfigProbe.addEventListener('click', (e) => {
      e.preventDefault();
      openAddMonitorModal();
    });
  }

  const btnInstallMonitors = document.getElementById('btn-install-custom-monitors');
  if (btnInstallMonitors) {
    btnInstallMonitors.addEventListener('click', (e) => {
      e.preventDefault();
      openMarketplaceModal();
    });
  }
});

async function toggleMonitorEnabled(id, enabled, event) {
  if (event) event.stopPropagation();
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitors/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Reload local engine states list
    loadProbesLevel2(activeProbeEngineType);
  } catch (err) {
    console.error("Failed to toggle monitor:", err);
    alert(`Failed to update monitor status: ${err.message}`);
  }
}

window.openMarketplaceModal = function () {
  console.log("openMarketplaceModal triggered");
  openModal('marketplace-modal');
  if (window.lucide) window.lucide.createIcons();
};

// Fetch settings from API and populate UI controls
async function loadSettings() {
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/settings`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Populate controls with loaded values
    const intervalEl = document.getElementById('setting-interval');
    const intervalVal = document.getElementById('setting-interval-val');
    if (intervalEl && data.telemetry_interval) {
      intervalEl.value = data.telemetry_interval;
      if (intervalVal) intervalVal.textContent = `${data.telemetry_interval}s`;
    }

    const retentionEl = document.getElementById('setting-retention');
    const retentionVal = document.getElementById('setting-retention-val');
    if (retentionEl && data.log_retention) {
      retentionEl.value = data.log_retention;
      if (retentionVal) retentionVal.textContent = `${data.log_retention} days`;
    }

    const tzEl = document.getElementById('setting-timezone');
    if (tzEl && data.timezone) {
      tzEl.value = data.timezone;
      currentTimezone = data.timezone;
    }

    const pskEl = document.getElementById('setting-psk');
    if (pskEl && data.preshared_key) pskEl.value = data.preshared_key;

    const compactEl = document.getElementById('setting-compact');
    if (compactEl) compactEl.checked = (data.layout_compact === 'true');

    // Apply theme
    if (data.theme) applyTheme(data.theme);

  } catch (err) {
    console.warn('Could not load settings from API:', err);
  }

  // Always initialize interactive bindings
  initSettingsControls();
}

// Bind all interactive settings controls
function initSettingsControls() {
  // Slider: polling interval
  const intervalEl = document.getElementById('setting-interval');
  const intervalVal = document.getElementById('setting-interval-val');
  if (intervalEl) {
    intervalEl.addEventListener('input', () => {
      if (intervalVal) intervalVal.textContent = `${intervalEl.value}s`;
    });
  }

  // Slider: log retention
  const retentionEl = document.getElementById('setting-retention');
  const retentionVal = document.getElementById('setting-retention-val');
  if (retentionEl) {
    retentionEl.addEventListener('input', () => {
      if (retentionVal) retentionVal.textContent = `${retentionEl.value} days`;
    });
  }

  // Timezone dropdown: instantly update header clock
  const tzEl = document.getElementById('setting-timezone');
  if (tzEl) {
    tzEl.addEventListener('change', () => {
      currentTimezone = tzEl.value;
      updateHeaderTime();
    });
  }

  // Theme picker
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTheme(btn.getAttribute('data-theme'));
    });
  });

  // Compact layout toggle
  const compactEl = document.getElementById('setting-compact');
  if (compactEl) {
    compactEl.addEventListener('change', () => {
      document.body.classList.toggle('layout-compact', compactEl.checked);
    });
  }



  // Save settings button
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const { httpUrl } = getApiUrls();
      const payload = {
        telemetry_interval: parseInt(document.getElementById('setting-interval')?.value || '3'),
        log_retention: parseInt(document.getElementById('setting-retention')?.value || '7'),
        timezone: document.getElementById('setting-timezone')?.value || 'UTC',
        preshared_key: document.getElementById('setting-psk')?.value || 'device_pin_12345',
        theme: document.querySelector('.theme-btn.active')?.getAttribute('data-theme') || 'midnight',
        layout_compact: String(document.getElementById('setting-compact')?.checked || false)
      };
      try {
        const res = await fetch(`${httpUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast('Settings saved successfully', 'success');
          // Navigate back to dashboard
          setTimeout(showDashboardView, 800);
        } else {
          alert('Failed to save settings. Server error.');
        }
      } catch (err) {
        console.error('Save settings error:', err);
      }
    });
  }
}

// Apply a theme skin to the <body>
function applyTheme(theme) {
  document.body.classList.remove('theme-glass', 'theme-cozy', 'theme-cyber');
  if (theme && theme !== 'midnight') {
    document.body.classList.add(`theme-${theme}`);
  }
  // Sync active button
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
  });
}

// ─────────────────────────────────────────
// DRAG-AND-DROP & CARD EDITOR IMPLEMENTATION
// ─────────────────────────────────────────

let draggedCard = null;

function enableDragAndDrop() {
  const cards = document.querySelectorAll('#dashboard-grid > .card:not(.card-placeholder)');
  cards.forEach(card => {
    card.setAttribute('draggable', 'false');
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', handleDrop);
    card.addEventListener('dragend', handleDragEnd);

    // Enable dragging only when clicking the edit-handle
    const handle = card.querySelector('.edit-handle');
    if (handle) {
      handle.onmousedown = () => card.setAttribute('draggable', 'true');
      handle.ontouchstart = () => card.setAttribute('draggable', 'true');
    }
  });
}

function disableDragAndDrop() {
  const cards = document.querySelectorAll('#dashboard-grid > .card:not(.card-placeholder)');
  cards.forEach(card => {
    card.removeAttribute('draggable');
    card.removeEventListener('dragstart', handleDragStart);
    card.removeEventListener('dragover', handleDragOver);
    card.removeEventListener('dragleave', handleDragLeave);
    card.removeEventListener('drop', handleDrop);
    card.removeEventListener('dragend', handleDragEnd);
    card.classList.remove('drag-over');

    const handle = card.querySelector('.edit-handle');
    if (handle) {
      handle.onmousedown = null;
      handle.ontouchstart = null;
    }
  });
}

function handleDragStart(e) {
  draggedCard = this;
  this.style.opacity = '0.5';
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  e.preventDefault();
  this.classList.add('drag-over');
  return false;
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  if (draggedCard !== this) {
    const grid = document.getElementById('dashboard-grid');
    const kids = Array.from(grid.children);
    const draggedIdx = kids.indexOf(draggedCard);
    const targetIdx = kids.indexOf(this);

    if (draggedIdx < targetIdx) {
      grid.insertBefore(draggedCard, this.nextSibling);
    } else {
      grid.insertBefore(draggedCard, this);
    }

    saveWidgetOrder();
  }
}

function handleDragEnd(e) {
  this.style.opacity = '1';
  this.setAttribute('draggable', 'false');
  document.querySelectorAll('#dashboard-grid > .card').forEach(c => c.classList.remove('drag-over'));
}

function saveWidgetOrder() {
  const grid = document.getElementById('dashboard-grid');
  const cards = grid.querySelectorAll('.card:not(.card-placeholder)');
  const orderList = Array.from(cards).map(card => card.id);
  localStorage.setItem('hp_widget_order', JSON.stringify(orderList));
}

// ─────────────────────────────────────────
// DYNAMIC DASHBOARDS (TABS) ENGINE
// ─────────────────────────────────────────

function renderDashboards() {
  const container = document.getElementById('tab-bar');
  if (!container) return;
  container.innerHTML = '';

  // Initialize main defaults if missing
  if (!localStorage.getItem('hp_dashboards')) {
    localStorage.setItem('hp_dashboards', JSON.stringify([
      { id: "main", name: "Main" }
    ]));
  }

  let dashboards = [];
  try {
    dashboards = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (err) {
    dashboards = [{ id: "main", name: "Main" }];
  }

  const isEditMode = document.getElementById('main-content').classList.contains('edit-mode');

  dashboards.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.setAttribute('data-tab', tab.id);
    btn.onclick = () => switchTab(tab.id);
    btn.ondblclick = () => onTabDoubleClick(tab.id, tab.name);

    // Set text label
    btn.textContent = tab.name;
    if (isEditMode) {
      btn.title = "Double-click to Rename/Delete";
    }

    if (tab.id === activeTab) {
      btn.classList.add('active');
    }
    container.appendChild(btn);
  });

  // Appends Creator Plus button if editing
  if (isEditMode) {
    const plusBtn = document.createElement('button');
    plusBtn.className = 'add-tab-btn';
    plusBtn.onclick = addNewDashboardTab;
    plusBtn.innerHTML = '<i data-lucide="plus" style="width:14px; height:14px;"></i>';
    container.appendChild(plusBtn);

    // Re-render plus icon
    setTimeout(() => lucide.createIcons(), 5);
  }
}

function switchTab(tabId) {
  activeTab = tabId;
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content').classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
}

function onTabDoubleClick(tabId, tabName) {
  if (!document.getElementById('main-content').classList.contains('edit-mode')) return;
  const res = prompt(`Rename dashboard view "${tabName}" to:\n(Or type "delete" to remove this dashboard view)`, tabName);
  if (res === null) return;
  const val = res.trim();
  if (val.toLowerCase() === 'delete') {
    deleteDashboardTab(tabId);
  } else if (val && val !== tabName) {
    renameDashboardTab(tabId, val);
  }
}

function addNewDashboardTab() {
  const name = prompt("Enter name for the new dashboard view:");
  if (!name) return;
  const tabName = name.trim();
  const id = 'tab_' + Date.now();

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  list.push({ id, name: tabName });
  localStorage.setItem('hp_dashboards', JSON.stringify(list));

  renderDashboards();
  switchTab(id);
}

function renameDashboardTab(tabId, newName) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  const tab = list.find(t => t.id === tabId);
  if (tab) {
    tab.name = newName;
    localStorage.setItem('hp_dashboards', JSON.stringify(list));
    renderDashboards();
  }
}

function deleteDashboardTab(tabId) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  if (list.length <= 1) {
    alert("Cannot delete the only remaining dashboard tab.");
    return;
  }
  if (!confirm("Are you sure you want to delete this tab? All cards inside it will be reassigned to the main dashboard tab.")) return;

  list = list.filter(t => t.id !== tabId);
  localStorage.setItem('hp_dashboards', JSON.stringify(list));

  const primaryTab = list[0].id;
  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  widgets.forEach(w => {
    if (w.tab === tabId) w.tab = primaryTab;
  });
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  renderDashboards();
  switchTab(primaryTab);
}

// ─────────────────────────────────────────
// WIDGET CONFIGURATION & CATALOG MANAGERS
// ─────────────────────────────────────────

function initializeWidgets() {
  let widgets = [];

  // Default snapshot span
  widgets.push({
    id: "widget-hp-health",
    type: "health",
    title: "Health Snapshot",
    tab: "main",
    entities: [],
    options: { gridWidth: 3, gridHeight: 1 }
  });

  // Consolidated Database card
  widgets.push({
    id: "widget-hp-db-engine",
    type: "entities",
    title: "Database Engine",
    tab: "main",
    entities: [
      { nodeId: "core-mon", entityKey: "database-status" },
      { nodeId: "core-mon", entityKey: "database-latency" }
    ],
    options: { gridWidth: 2, gridHeight: 1 }
  });

  // Add remaining entities as standard single-widget cards
  Object.keys(cachedEntities).forEach(key => {
    const item = cachedEntities[key];
    if (item.entity_key === 'database-status' || item.entity_key === 'database-latency') return;

    const widgetId = `widget-${item.node_id}-${item.entity_key}`;
    if (item.type === 'control') {
      widgets.push({
        id: widgetId,
        type: "control",
        title: item.name || item.entity_key,
        tab: "main",
        entities: [{ nodeId: item.node_id, entityKey: item.entity_key }],
        options: { gridWidth: 1, gridHeight: 1 }
      });
    } else if (item.type === 'value') {
      widgets.push({
        id: widgetId,
        type: "value",
        title: item.name || item.entity_key,
        tab: "main",
        entities: [{ nodeId: item.node_id, entityKey: item.entity_key }],
        options: { gridWidth: 1, gridHeight: 1, color: item.color || 'var(--accent-blue)' }
      });
    } else {
      widgets.push({
        id: widgetId,
        type: "sensor",
        title: item.name || item.entity_key,
        tab: "main",
        entities: [{ nodeId: item.node_id, entityKey: item.entity_key }],
        options: { gridWidth: 1, gridHeight: 1, graphic: item.graphic || 'sparkline' }
      });
    }
  });

  // Default Audits log card
  widgets.push({
    id: "widget-hp-audits",
    type: "audit",
    title: "Global System Audit",
    tab: "main",
    entities: [],
    options: { gridWidth: 3, gridHeight: 1 }
  });

  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));
  return widgets;
}

window.openModal = function (modalId) {
  console.log("openModal triggered for:", modalId);
  let modal = document.getElementById(modalId);
  if (!modal) {
    console.error("Modal not found:", modalId);
    return;
  }

  // Move modal to document.body to escape any stacking context
  if (modal.parentNode !== document.body) {
    document.body.appendChild(modal);
  }

  modal.style.cssText = 'display:flex !important; opacity:1 !important; pointer-events:auto !important; position:fixed !important; top:0 !important; left:0 !important; right:0 !important; bottom:0 !important; z-index:999999 !important; background:rgba(0,0,0,0.75) !important; align-items:center !important; justify-content:center !important;';
  modal.classList.add('active');
  if (window.lucide) window.lucide.createIcons();
};

window.closeModal = function (modalId) {
  console.log("closeModal triggered for:", modalId);
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
    modal.style.opacity = '0';
    modal.style.pointerEvents = 'none';
  }
};

function openCardEditor(widgetId, initialMode = 'ui') {
  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  const widget = widgets.find(w => w.id === widgetId);
  if (!widget) return;

  document.getElementById('edit-widget-id').value = widgetId;
  document.getElementById('edit-widget-title').value = widget.title || '';
  document.getElementById('edit-widget-unit').value = widget.options.unit || '';
  document.getElementById('edit-widget-color').value = widget.options.color || 'var(--color-optimal)';
  document.getElementById('edit-widget-width').value = widget.options.gridWidth || 1;
  document.getElementById('edit-widget-height').value = widget.options.gridHeight || 1;
  document.getElementById('edit-scale-min').value = widget.options.min !== undefined ? widget.options.min : 0;
  document.getElementById('edit-scale-max').value = widget.options.max !== undefined ? widget.options.max : 100;

  // Render tab selects
  const tabSelect = document.getElementById('edit-widget-tab');
  if (tabSelect) {
    tabSelect.innerHTML = '';
    const tabs = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
    tabs.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      tabSelect.appendChild(opt);
    });
    tabSelect.value = widget.tab;
  }

  // Toggle scales visibility based on types
  const scaleGroup = document.querySelector('.edit-scale-group');
  if (scaleGroup) {
    scaleGroup.style.display = (widget.type === 'gauge' || widget.type === 'sensor') ? 'flex' : 'none';
  }

  const modal = document.getElementById('widget-editor-modal');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
  }

  // Bind initial tab state to UI
  toggleWidgetEditorMode(initialMode);
}

function saveWidgetSettings() {
  const id = document.getElementById('edit-widget-id').value;
  const errorBanner = document.getElementById('edit-widget-yaml-error');
  if (errorBanner) errorBanner.style.display = 'none';

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  const widgetIdx = widgets.findIndex(w => w.id === id);
  if (widgetIdx === -1) return;

  // Sync UI form editor fields to YAML representation if saving from form editor
  if (widgetEditorMode === 'ui') {
    syncFormFieldsToYAML();
  }

  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (!yamlTextarea) return;

  try {
    const parsedWidget = jsyaml.load(yamlTextarea.value);
    if (!parsedWidget || typeof parsedWidget !== 'object') {
      throw new Error("YAML must represent a valid Lovelace card object structure.");
    }
    if (!parsedWidget.id || parsedWidget.id !== id) {
      throw new Error("Do not modify the card's unique 'id' field.");
    }
    if (!parsedWidget.type) {
      throw new Error("Card configuration is missing a 'type' field.");
    }
    if (!parsedWidget.tab) {
      throw new Error("Card configuration is missing a destination 'tab' field.");
    }

    widgets[widgetIdx] = parsedWidget;
    localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  } catch (e) {
    console.error("Card YAML editor parse warning: ", e);
    // Switch tabs to show valid code errors
    toggleWidgetEditorMode('yaml');

    if (errorBanner) {
      errorBanner.textContent = "Validation Failure: " + e.message;
      errorBanner.style.display = 'block';
      const modalBody = document.querySelector('#widget-editor-modal .modal-body');
      if (modalBody) modalBody.scrollTop = 0;
    } else {
      alert("Validation error: " + e.message);
    }
    return; // Block save
  }

  closeModal('widget-editor-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content').classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
}

// --- Card-Level Lovelace Code Editor Helper Tabs API ---

let widgetEditorMode = 'ui';

function toggleWidgetEditorMenu(e) {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('widget-editor-menu-dropdown');
  if (!dropdown) return;
  const isShown = dropdown.style.display === 'block';
  dropdown.style.display = isShown ? 'none' : 'block';
}

function clickedToggleEditorMode(e) {
  if (e) e.preventDefault();
  const newMode = (widgetEditorMode === 'ui') ? 'yaml' : 'ui';
  toggleWidgetEditorMode(newMode);
  const dropdown = document.getElementById('widget-editor-menu-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

// Close 3-dots widget editor menu when clicking outside
document.addEventListener('click', function (e) {
  const dropdown = document.getElementById('widget-editor-menu-dropdown');
  if (dropdown && dropdown.style.display === 'block') {
    const parentContainer = e.target.closest('#widget-editor-modal');
    if (parentContainer && !e.target.closest('.btn-icon')) {
      dropdown.style.display = 'none';
    }
  }
});

function toggleWidgetEditorMode(mode) {
  widgetEditorMode = mode;
  const uiFields = document.getElementById('editor-ui-fields');
  const yamlContainer = document.getElementById('editor-yaml-container');
  const yamlError = document.getElementById('edit-widget-yaml-error');
  const menuLink = document.getElementById('menu-toggle-editor-mode');

  if (yamlError) yamlError.style.display = 'none';

  if (menuLink) {
    menuLink.textContent = (mode === 'ui') ? 'Edit in YAML' : 'Edit in visual editor';
  }

  if (mode === 'ui') {
    if (uiFields) uiFields.style.display = 'flex';
    if (yamlContainer) yamlContainer.style.display = 'none';

    // Sync structural form fields values from YAML draft code parameters
    syncYAMLToFormFields();
  } else {
    if (uiFields) uiFields.style.display = 'none';
    if (yamlContainer) yamlContainer.style.display = 'flex';

    // Dump active form field settings into YAML textarea value
    syncFormFieldsToYAML();
  }
}

function syncFormFieldsToYAML() {
  const widgetId = document.getElementById('edit-widget-id').value;
  const widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  const widget = widgets.find(w => w.id === widgetId);
  if (!widget) return;

  const draftWidget = {
    id: widget.id,
    type: widget.type,
    title: document.getElementById('edit-widget-title').value,
    tab: document.getElementById('edit-widget-tab').value,
    entities: widget.entities || [],
    options: {
      ...(widget.options || {}),
      unit: document.getElementById('edit-widget-unit').value,
      color: document.getElementById('edit-widget-color').value,
      gridWidth: parseInt(document.getElementById('edit-widget-width').value),
      gridHeight: parseInt(document.getElementById('edit-widget-height').value)
    }
  };

  const minInput = document.getElementById('edit-scale-min');
  const maxInput = document.getElementById('edit-scale-max');
  if (minInput && maxInput && (widget.type === 'gauge' || widget.type === 'sensor')) {
    draftWidget.options.min = parseFloat(minInput.value);
    draftWidget.options.max = parseFloat(maxInput.value);
  }

  try {
    const yamlVal = jsyaml.dump(draftWidget, { indent: 2, noRefs: true });
    const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
    if (yamlTextarea) yamlTextarea.value = yamlVal;
  } catch (err) {
    console.error("Widget YAML dump failed: ", err);
  }
}

function syncYAMLToFormFields() {
  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (!yamlTextarea) return;

  try {
    const parsed = jsyaml.load(yamlTextarea.value);
    if (parsed && typeof parsed === 'object') {
      if (parsed.title !== undefined) document.getElementById('edit-widget-title').value = parsed.title;
      if (parsed.tab !== undefined) document.getElementById('edit-widget-tab').value = parsed.tab;
      if (parsed.options) {
        if (parsed.options.unit !== undefined) document.getElementById('edit-widget-unit').value = parsed.options.unit;
        if (parsed.options.color !== undefined) document.getElementById('edit-widget-color').value = parsed.options.color;
        if (parsed.options.gridWidth !== undefined) document.getElementById('edit-widget-width').value = parsed.options.gridWidth;
        if (parsed.options.gridHeight !== undefined) document.getElementById('edit-widget-height').value = parsed.options.gridHeight;
        if (parsed.options.min !== undefined && document.getElementById('edit-scale-min')) {
          document.getElementById('edit-scale-min').value = parsed.options.min;
        }
        if (parsed.options.max !== undefined && document.getElementById('edit-scale-max')) {
          document.getElementById('edit-scale-max').value = parsed.options.max;
        }
      }
    }
  } catch (err) {
    // Ignore draft parse errors during typing switches
  }
}

function deleteWidgetSettings() {
  const id = document.getElementById('edit-widget-id').value;
  if (!confirm("Are you sure you want to remove this widget card?")) return;

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  widgets = widgets.filter(w => w.id !== id);
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  closeModal('widget-editor-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content').classList.contains('edit-mode')) {
    enableDragAndDrop();
  }

  addAuditEntry('warning', `Widget Card "${id}" deleted from dashboard layout.`);
}

function addNewCardPlaceholder() {
  const typeSelect = document.getElementById('catalog-card-type');
  if (typeSelect) {
    typeSelect.value = 'sensor';
    onCreatorTypeChange('sensor');
  }

  const searchInput = document.getElementById('catalog-search');
  if (searchInput) searchInput.value = '';
  renderCatalogBlocks('');

  document.getElementById('catalog-widget-title').value = '';
  document.getElementById('catalog-widget-unit').value = '';
  document.getElementById('catalog-widget-width').value = '1';
  document.getElementById('catalog-widget-height').value = '1';
  document.getElementById('creator-scale-min').value = '0';
  document.getElementById('creator-scale-max').value = '100';

  const modal = document.getElementById('widget-catalog-modal');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
  }
}

const catalogTemplates = [
  { value: 'sensor', name: 'Standard Telemetry Sensor', desc: 'Display a single real-time sensor value with dynamic charts.', icon: 'activity' },
  { value: 'control', name: 'Interactive Control Widget', desc: 'Add interactive toggle switches, sliders, or action triggers.', icon: 'sliders' },
  { value: 'value', name: 'Value Display Badge', desc: 'A minimal compact badge highlighting numeric or text states.', icon: 'pocket' },
  { value: 'gauge', name: 'Circular Gauge Card', desc: 'A beautiful radial circular gauge for resource limit tracking.', icon: 'compass' },
  { value: 'entities', name: 'Multi-Entity Row List', desc: 'Display multiple entity values stacked cleanly in list rows.', icon: 'list' },
  { value: 'glance', name: 'Glance Columns Grid', desc: 'An layout displaying several status badges side-by-side.', icon: 'grid' },
  { value: 'health', name: 'System Health Snapshot', desc: 'View global system averages, load status, and issues count.', icon: 'heart' },
  { value: 'audit', name: 'Global System Audit Log', desc: 'A real-time historical event stream of system logs.', icon: 'file-text' }
];

function renderCatalogBlocks(filterText = '') {
  const gridEl = document.getElementById('catalog-blocks-grid');
  if (!gridEl) return;

  const query = filterText.toLowerCase().trim();
  const typeSelect = document.getElementById('catalog-card-type');
  const currentValue = typeSelect ? typeSelect.value : 'sensor';

  let html = '';
  catalogTemplates.forEach(tpl => {
    const matches = tpl.name.toLowerCase().includes(query) || tpl.desc.toLowerCase().includes(query);
    if (!matches) return;

    const isActive = tpl.value === currentValue;
    html += `
      <div class="creator-block-card ${isActive ? 'active' : ''}" onclick="selectCatalogBlock('${tpl.value}')">
        <div class="creator-block-header">
          <i data-lucide="${tpl.icon}"></i>
          <span class="creator-block-title">${tpl.name}</span>
        </div>
        <span class="creator-block-desc">${tpl.desc}</span>
      </div>`;
  });

  gridEl.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

function selectCatalogBlock(value) {
  const typeSelect = document.getElementById('catalog-card-type');
  if (typeSelect) {
    typeSelect.value = value;
    onCreatorTypeChange(value);
  }
  renderCatalogBlocks(document.getElementById('catalog-search')?.value || '');
}

function onCreatorTypeChange(type) {
  const group = document.getElementById('creator-entity-select-group');
  if (!group) return;

  // Toggle scales visibility
  const scaleGroup = document.querySelector('.creator-scale-group');
  if (scaleGroup) {
    scaleGroup.style.display = (type === 'gauge' || type === 'sensor') ? 'flex' : 'none';
  }

  if (type === 'health' || type === 'audit') {
    group.innerHTML = '<span style="color:var(--text-secondary); font-size:0.75rem;">(This card uses global infrastructure metrics and does not map to a specific entity)</span>';
    return;
  }

  if (type === 'entities' || type === 'glance') {
    // Generate Checklist checkboxes
    let html = '<label>Select Target Entities</label><div style="max-height: 140px; overflow-y: auto; border: 1px solid var(--border-soft); padding: 8px; border-radius: 6px; display:flex; flex-direction:column; gap:6px;">';
    Object.values(cachedEntities).forEach(entity => {
      html += `
        <label style="display:flex; align-items:center; gap:8px; font-weight: normal; font-size:0.75rem;">
          <input type="checkbox" name="creator-entities" value="${entity.node_id}|${entity.entity_key}">
          <span>${entity.name || entity.entity_key} (${entity.node_id}.local)</span>
        </label>
      `;
    });
    html += '</div>';
    group.innerHTML = html;
  } else {
    // Single selector dropdown
    let html = '<label for="creator-select">Select Target Entity</label><select id="creator-select" class="modal-input" style="background:#221d16; color:#f0e6d3; border: 1px solid rgba(200, 140, 60, 0.12); padding: 8px 12px; border-radius: 6px;">';
    Object.values(cachedEntities).forEach(entity => {
      html += `<option value="${entity.node_id}|${entity.entity_key}">${entity.name || entity.entity_key} (${entity.node_id}.local)</option>`;
    });
    html += '</select>';
    group.innerHTML = html;
  }
}

function addWidgetToGrid() {
  const type = document.getElementById('catalog-card-type').value;
  const title = document.getElementById('catalog-widget-title').value.trim();
  const unit = document.getElementById('catalog-widget-unit').value.trim();
  const w = parseInt(document.getElementById('catalog-widget-width').value) || 1;
  const h = parseInt(document.getElementById('catalog-widget-height').value) || 1;
  const color = document.getElementById('catalog-widget-color').value;
  const min = parseFloat(document.getElementById('creator-scale-min').value);
  const max = parseFloat(document.getElementById('creator-scale-max').value);

  let entities = [];
  if (type === 'entities' || type === 'glance') {
    const checked = document.querySelectorAll('input[name="creator-entities"]:checked');
    checked.forEach(chk => {
      const [nId, eKey] = chk.value.split('|');
      entities.push({ nodeId: nId, entityKey: eKey });
    });
  } else if (type !== 'health' && type !== 'audit') {
    const select = document.getElementById('creator-select');
    if (select && select.value) {
      const [nId, eKey] = select.value.split('|');
      entities.push({ nodeId: nId, entityKey: eKey });
    }
  }

  const id = 'widget_' + Date.now();
  const newWidget = {
    id: id,
    type: type,
    title: title,
    tab: activeTab,
    entities: entities,
    options: {
      gridWidth: w,
      gridHeight: h,
      color: color,
      unit: unit,
      min: min,
      max: max,
      graphic: 'sparkline'
    }
  };

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  widgets.push(newWidget);
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  closeModal('widget-catalog-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content').classList.contains('edit-mode')) {
    enableDragAndDrop();
  }

  addAuditEntry('success', `Created new ${type} card on layout.`);
}

// --- Lovelace YAML Code Editor API ---

function openYAMLConfigEditor() {
  const errorBanner = document.getElementById('yaml-error-banner');
  if (errorBanner) errorBanner.style.display = 'none';

  // Retrieve current state from localStorage
  const dashboards = JSON.parse(localStorage.getItem('hp_dashboards')) || [
    { id: 'main', name: 'Main' }
  ];
  const widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets')) || [];

  // Construct unified object
  const configObj = {
    dashboards: dashboards,
    widgets: widgets
  };

  try {
    // Convert to YAML using js-yaml library
    const yamlContent = jsyaml.dump(configObj, { indent: 2, noRefs: true });
    const textarea = document.getElementById('yaml-editor-textarea');
    if (textarea) {
      textarea.value = yamlContent;
    }
    // Open modal
    openModal('yaml-config-modal');
  } catch (e) {
    console.error("YAML serialization failed: ", e);
    alert("Error serializing to YAML: " + e.message);
  }
}

function saveYAMLConfigSettings() {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;

  const yamlText = textarea.value;
  const errorBanner = document.getElementById('yaml-error-banner');

  try {
    if (errorBanner) errorBanner.style.display = 'none';

    // Parse YAML content
    const configObj = jsyaml.load(yamlText);

    // Validation check
    if (!configObj || typeof configObj !== 'object') {
      throw new Error("YAML layout content must be a structured configuration object with dashboards and widgets lists.");
    }

    if (!Array.isArray(configObj.dashboards)) {
      throw new Error("Missing 'dashboards' configuration list.");
    }

    if (!Array.isArray(configObj.widgets)) {
      throw new Error("Missing 'widgets' configuration list.");
    }

    // Validate each widget structure
    configObj.widgets.forEach((widget, idx) => {
      if (!widget.id) {
        throw new Error(`Widget at index ${idx} is missing a unique 'id' field.`);
      }
      if (!widget.type) {
        throw new Error(`Widget '${widget.id}' is missing a 'type' field.`);
      }
      if (!widget.tab) {
        throw new Error(`Widget '${widget.id}' is missing a destination 'tab' identifier.`);
      }
      if (!widget.entities) {
        widget.entities = [];
      } else if (!Array.isArray(widget.entities)) {
        throw new Error(`Widget '${widget.id}' 'entities' field must be an array of { nodeId, entityKey } structures.`);
      }
      if (!widget.options) {
        widget.options = {};
      }
    });

    // Clean/Verify dashboards
    configObj.dashboards.forEach((db, idx) => {
      if (!db.id) {
        throw new Error(`Dashboard view at index ${idx} must contain a unique 'id' code.`);
      }
      if (!db.name) {
        throw new Error(`Dashboard view '${db.id}' must contain a display 'name'.`);
      }
    });

    // Persist arrays into localStorage
    localStorage.setItem('hp_dashboards', JSON.stringify(configObj.dashboards));
    localStorage.setItem('hp_dashboard_widgets', JSON.stringify(configObj.widgets));

    // Reset activeTab if it has been deleted in YAML
    const tabExists = configObj.dashboards.some(db => db.id === activeTab);
    if (!tabExists && configObj.dashboards.length > 0) {
      activeTab = configObj.dashboards[0].id;
    }

    // Refresh dashboard grids and views UI
    closeModal('yaml-config-modal');
    renderDashboards();
    buildDashboardCards(cachedEntities);

    // Force updates to audit list
    addAuditEntry('info', "Dashboard configuration updated and validated via raw YAML settings editor.");

  } catch (e) {
    console.error("YAML parsing error: ", e);
    if (errorBanner) {
      errorBanner.textContent = "Validation Failure: " + e.message;
      errorBanner.style.display = 'block';
      const modalBody = document.querySelector('#yaml-config-modal .modal-body');
      if (modalBody) modalBody.scrollTop = 0;
    } else {
      alert("Validation Error: " + e.message);
    }
  }
}

// Built-in Background Monitor Client Functions
// Multi-Level Standalone Probes Manager JS Engine
let activeProbeEngineType = null;
let activeProbeMonitorId = null;

function navigateProbesLevel(level, param) {
  const lvl1 = document.getElementById('probes-level-1');
  const lvl2 = document.getElementById('probes-level-2');
  const lvl3 = document.getElementById('probes-level-3');
  const lvlCatalog = document.getElementById('probes-level-catalog');

  if (!lvl1 || !lvl2 || !lvl3 || !lvlCatalog) return;

  if (level === 1) {
    lvl1.style.display = 'block';
    lvl2.style.display = 'none';
    lvl3.style.display = 'none';
    lvlCatalog.style.display = 'none';
    loadProbesLevel1();
  } else if (level === 2) {
    lvl1.style.display = 'none';
    lvl2.style.display = 'block';
    lvl3.style.display = 'none';
    lvlCatalog.style.display = 'none';
    if (param) activeProbeEngineType = param;
    loadProbesLevel2(activeProbeEngineType);
  } else if (level === 3) {
    lvl1.style.display = 'none';
    lvl2.style.display = 'none';
    lvl3.style.display = 'block';
    lvlCatalog.style.display = 'none';
    if (param) {
      activeProbeMonitorId = param;
      loadProbesLevel3(activeProbeMonitorId);
    }
  } else if (level === 'catalog') {
    lvl1.style.display = 'none';
    lvl2.style.display = 'none';
    lvl3.style.display = 'none';
    lvlCatalog.style.display = 'block';
    if (window.lucide) window.lucide.createIcons();
  }
}

function isProbeStatusOnline(status, type) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return (
    s === 'UP' ||
    s === 'ONLINE' ||
    s === 'SSL_OK' ||
    s === 'DNS_OK' ||
    s === 'PORT_OK' ||
    s === 'ICMP_OK' ||
    s === '101' ||
    s.includes('REMAINING') ||
    s.includes('DAYS') ||
    (type === 'http' && !isNaN(s) && parseInt(s) < 400)
  );
}

async function loadProbesLevel1() {
  const { httpUrl } = getApiUrls();
  const gridEl = document.getElementById('engines-grid');
  if (!gridEl) return;

  try {
    const res = await fetch(`${httpUrl}/api/monitors`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const monitors = await res.json();

    const counts = { http: 0, websocket: 0, ping: 0, port: 0, dns: 0, ssl: 0 };
    monitors.forEach(m => {
      if (counts[m.type] !== undefined) counts[m.type]++;
    });

    const engines = [
      { type: 'http', name: 'HTTP/HTTPS Prober', desc: 'Web endpoints and REST APIs', icon: 'globe', color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
      { type: 'websocket', name: 'WebSocket Prober', desc: 'Active socket handshakes', icon: 'message-square', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)' },
      { type: 'ping', name: 'ICMP Ping Prober', desc: 'Simple host reachability checks', icon: 'shield', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)' },
      { type: 'port', name: 'TCP Port Prober', desc: 'Open database or SSH port queries', icon: 'server', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
      { type: 'dns', name: 'DNS Resolver Prober', desc: 'Hostname IP resolution query checks', icon: 'globe-2', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)' },
      { type: 'ssl', name: 'SSL Expiration Prober', desc: 'SSL/TLS certificate expiration checks', icon: 'lock', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.1)' }
    ];

    const visibleEngines = engines.filter(eng => counts[eng.type] > 0);

    if (visibleEngines.length === 0) {
      gridEl.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; background: rgba(20, 20, 22, 0.4); border: 1px dashed var(--border-soft); border-radius: 8px;">
          <i data-lucide="shield-alert" style="width: 32px; height: 32px; color: var(--text-secondary); margin-bottom: 12px; display: block; margin-left: auto; margin-right: auto;"></i>
          <p style="font-size: 0.82rem; color: var(--text-primary); font-weight: 600; margin: 0 0 4px 0;">No Background Probes Configured</p>
          <p style="font-size: 0.72rem; color: var(--text-secondary); margin: 0 0 16px 0;">Configure your first check to compile monitoring metrics.</p>
          <button class="btn btn-primary" onclick="openAddMonitorModal()" style="font-size: 0.75rem; padding: 6px 14px; margin: 0 auto; display: block; cursor: pointer;">Configure New Probe</button>
        </div>`;
      if (gridEl.style.display === 'none') {
        gridEl.style.display = 'grid';
      }
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    let html = '';
    visibleEngines.forEach(eng => {
      const activeCount = counts[eng.type];
      const countLabel = activeCount === 1 ? '1 active probe' : `${activeCount} active probes`;

      html += `
        <div class="mon-picker-card" onclick="navigateProbesLevel(2, '${eng.type}')" style="display: flex; flex-direction: column; align-items: flex-start;">
          <div style="display:flex; align-items:center; justify-content:center; background: ${eng.bg}; color: ${eng.color}; border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; width: 38px; height: 38px; margin-bottom: 12px; flex-shrink: 0;">
            <i data-lucide="${eng.icon}" style="width: 20px; height: 20px; color: ${eng.color}; margin-bottom: 0;"></i>
          </div>
          <span class="title">${eng.name}</span>
          <span class="desc">${eng.desc}</span>
          <span style="font-size:0.65rem; color:${eng.color}; margin-top:10px; font-weight:600; background:${eng.bg}; padding:2px 8px; border-radius:4px; max-width:80%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${countLabel}
          </span>
        </div>`;
    });

    gridEl.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    gridEl.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem;">Failure compiling engines stats: ${err.message}</p>`;
  }
}

async function loadProbesLevel2(type) {
  const { httpUrl } = getApiUrls();
  const listEl = document.getElementById('probes-source-list');
  if (!listEl) return;

  const titles = {
    http: { title: "HTTP/HTTPS Prober Engine", desc: "Monitors HTTP/HTTPS website load status codes and latency." },
    websocket: { title: "WebSocket Connection Engine", desc: "Monitors WebSockets connectivity logs." },
    ping: { title: "ICMP Ping reachability Engine", desc: "Monitors response durations of network gateways." },
    port: { title: "TCP Port query Engine", desc: "Monitors open ports for database, socket, or HTTP systems." },
    dns: { title: "DNS Query Name Resolver", desc: "Monitors DNS lookup values for key servers." },
    ssl: { title: "SSL Certificate Expiry Engine", desc: "Monitors SSL/TLS certificate validity dates and thresholds." }
  };

  const info = titles[type] || { title: "Probes Engine", desc: "Manage Probes" };
  document.getElementById('lvl2-engine-title').textContent = info.title;
  document.getElementById('lvl2-engine-desc').textContent = info.desc;

  try {
    const res = await fetch(`${httpUrl}/api/monitors`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const monitors = await res.json();

    const filtered = monitors.filter(m => m.type === type);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <p style="font-size:0.8rem; color:var(--text-secondary); text-align:center; padding:24px; border:1px dashed var(--border-soft); border-radius:6px; margin:0;">
          No active probes for this monitor engine. Click "+ Add Probe" to configure one.
        </p>`;
      return;
    }

    let displayMonitors = [];
    let handledIds = new Set();

    if (type === 'http') {
      filtered.forEach(m1 => {
        if (handledIds.has(m1.id)) return;

        let baseName = null;
        let partnerName = null;
        if (m1.name.endsWith(' (HTTP)')) {
          baseName = m1.name.slice(0, -7);
          partnerName = baseName + ' (HTTPS)';
        } else if (m1.name.endsWith(' (HTTPS)')) {
          baseName = m1.name.slice(0, -8);
          partnerName = baseName + ' (HTTP)';
        }

        if (baseName) {
          const m2 = filtered.find(m => m.name === partnerName);
          if (m2 && !handledIds.has(m2.id)) {
            displayMonitors.push({
              isGrouped: true,
              id: `${m1.id},${m2.id}`,
              editMonId: m1.id,
              name: baseName,
              target: m1.target.replace(/^(https?:\/\/)+/i, ''),
              type: 'http',
              check_interval: m1.check_interval,
              timeout: m1.timeout,
              m1: m1,
              m2: m2
            });
            handledIds.add(m1.id);
            handledIds.add(m2.id);
            return;
          }
        }
      });

      filtered.forEach(m => {
        if (!handledIds.has(m.id)) {
          displayMonitors.push({
            isGrouped: false,
            id: String(m.id),
            name: m.name,
            target: m.target,
            type: m.type,
            check_interval: m.check_interval,
            timeout: m.timeout,
            m1: m
          });
        }
      });
    } else {
      filtered.forEach(m => {
        displayMonitors.push({
          isGrouped: false,
          id: String(m.id),
          name: m.name,
          target: m.target,
          type: m.type,
          check_interval: m.check_interval,
          timeout: m.timeout,
          m1: m
        });
      });
    }

    let html = '';
    displayMonitors.forEach(mon => {
      let isEnabled = true;
      let statusLabel = '';
      let statusColor = '';
      let latencyStr = '';
      let m1Enabled = mon.m1.enabled !== false;

      if (mon.isGrouped) {
        let m2Enabled = mon.m2.enabled !== false;
        isEnabled = m1Enabled || m2Enabled;
        const isUp1 = m1Enabled && isProbeStatusOnline(mon.m1.last_status, mon.m1.type);
        const isUp2 = m2Enabled && isProbeStatusOnline(mon.m2.last_status, mon.m2.type);

        if (!isEnabled) {
          statusLabel = 'DISABLED';
          statusColor = '#6b7280';
          latencyStr = '--';
        } else {
          let lats = [];
          if (m1Enabled && mon.m1.last_latency !== null) lats.push(parseFloat(mon.m1.last_latency));
          if (m2Enabled && mon.m2.last_latency !== null) lats.push(parseFloat(mon.m2.last_latency));

          if (lats.length > 0) {
            const avgLat = (lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1);
            latencyStr = `${avgLat} ms avg`;
          } else {
            latencyStr = '--';
          }

          if (isUp1 && isUp2) {
            statusLabel = 'BOTH ONLINE';
            statusColor = 'var(--color-optimal)';
          } else if (isUp1) {
            statusLabel = 'HTTP ONLINE';
            statusColor = 'var(--accent-orange)';
          } else if (isUp2) {
            statusLabel = 'HTTPS ONLINE';
            statusColor = 'var(--accent-orange)';
          } else {
            statusLabel = 'BOTH OFFLINE';
            statusColor = '#f43f5e';
          }
        }
      } else {
        isEnabled = mon.m1.enabled !== false;
        const isUp = isEnabled && isProbeStatusOnline(mon.m1.last_status, mon.m1.type);
        statusColor = !isEnabled ? '#6b7280' : (isUp ? 'var(--color-optimal)' : '#f43f5e');
        statusLabel = !isEnabled ? 'DISABLED' : (isUp ? (mon.m1.type === 'ssl' ? mon.m1.last_status : 'ONLINE') : (mon.m1.last_status === 'unknown' ? 'UNKNOWN' : 'OFFLINE'));
        latencyStr = isEnabled && mon.m1.last_latency !== null ? `${mon.m1.last_latency} ms` : '--';
      }

      html += `
        <div style="background:#1d1b18; border:1px solid var(--border-soft); border-radius:6px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="goLvl3('${mon.id}', event)">
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${mon.name}</span>
            <span style="font-size:0.72rem; color:var(--text-secondary); font-family:monospace; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${mon.target}</span>
          </div>
          
          <div style="display:flex; align-items:center; gap:16px;">
            <div style="text-align:right; display:flex; flex-direction:column; gap:2px;">
              <span style="font-size:0.75rem; font-weight:700; color:${statusColor};">${statusLabel}</span>
              <span style="font-size:0.65rem; color:var(--text-secondary); font-family:monospace;">${latencyStr}</span>
            </div>
            
            <label class="switch" title="Enable/Disable Monitor" onclick="event.stopPropagation()">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleMonitorEnabled('${mon.id}', this.checked, event)">
              <span class="slider"></span>
            </label>

            <button class="btn-icon" onclick="openEditMonitor('${mon.id}', event)" style="background:none; border:none; padding:4px; cursor:pointer;" title="Edit Monitor">
              <i data-lucide="edit-3" style="width:14px; height:14px; color:var(--accent-orange);"></i>
            </button>
            <button class="btn-icon" onclick="deleteMonitorSource(${mon.id.includes(',') ? `'${mon.id}'` : mon.id}, event)" style="background:none; border:none; padding:4px; cursor:pointer;" title="Delete Monitor">
              <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
            </button>
          </div>
        </div>`;
    });

    listEl.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem;">Failure loading probes: ${err.message}</p>`;
  }
}

function goLvl3(monId, e) {
  if (e.target.closest('button') || e.target.closest('.btn-icon') || e.target.closest('.switch')) return;
  navigateProbesLevel(3, monId);
}

async function loadProbesLevel3(monId) {
  const { httpUrl } = getApiUrls();
  const tableBody = document.getElementById('lvl3-history-table-body');
  if (!tableBody) return;

  tableBody.innerHTML = `<tr><td colspan="3" style="padding:16px; text-align:center; color:var(--text-secondary);">Querying logs...</td></tr>`;

  try {
    const resMon = await fetch(`${httpUrl}/api/monitors`);
    if (!resMon.ok) throw new Error(`HTTP ${resMon.status}`);
    const monitors = await resMon.json();

    const ids = String(monId).split(',');
    const isGrouped = ids.length > 1;

    if (isGrouped) {
      const mon1 = monitors.find(m => String(m.id) === String(ids[0]));
      const mon2 = monitors.find(m => String(m.id) === String(ids[1]));

      if (!mon1 || !mon2) {
        alert("Probe details not found.");
        navigateProbesLevel(2);
        return;
      }

      const baseName = mon1.name.endsWith(' (HTTP)') ? mon1.name.slice(0, -7) : mon1.name.slice(0, -8);
      document.getElementById('lvl3-probe-title').textContent = baseName + " (Combined Probe)";
      document.getElementById('lvl3-probe-meta').textContent = `HTTP URL: ${mon1.target} | HTTPS URL: ${mon2.target}`;

      const isUp1 = (mon1.enabled !== false) && isProbeStatusOnline(mon1.last_status, mon1.type);
      const isUp2 = (mon2.enabled !== false) && isProbeStatusOnline(mon2.last_status, mon2.type);

      // Seed cachedEntities with current values for these monitors to prevent out-of-sync WebSocket updates
      const statusKey1 = `monitor-${ids[0]}-status`;
      const latencyKey1 = `monitor-${ids[0]}-latency`;
      const statusKey2 = `monitor-${ids[1]}-status`;
      const latencyKey2 = `monitor-${ids[1]}-latency`;

      cachedEntities[statusKey1] = {
        node_id: 'monitors',
        entity_key: statusKey1,
        value: mon1.last_status,
        status: mon1.last_status,
        status_type: isUp1 ? 'healthy' : 'error'
      };
      cachedEntities[latencyKey1] = {
        node_id: 'monitors',
        entity_key: latencyKey1,
        value: mon1.last_latency
      };
      cachedEntities[statusKey2] = {
        node_id: 'monitors',
        entity_key: statusKey2,
        value: mon2.last_status,
        status: mon2.last_status,
        status_type: isUp2 ? 'healthy' : 'error'
      };
      cachedEntities[latencyKey2] = {
        node_id: 'monitors',
        entity_key: latencyKey2,
        value: mon2.last_latency
      };

      let statusLabel = '';
      let statusColor = '';
      if (isUp1 && isUp2) {
        statusLabel = 'BOTH ONLINE';
        statusColor = 'var(--color-optimal)';
      } else if (isUp1) {
        statusLabel = 'HTTP ONLINE';
        statusColor = 'var(--accent-orange)';
      } else if (isUp2) {
        statusLabel = 'HTTPS ONLINE';
        statusColor = 'var(--accent-orange)';
      } else {
        statusLabel = 'BOTH OFFLINE';
        statusColor = '#f43f5e';
      }

      document.getElementById('lvl3-stat-status').textContent = statusLabel;
      document.getElementById('lvl3-stat-status').style.color = statusColor;

      let latString = '';
      if (mon1.last_latency !== null && mon2.last_latency !== null) {
        latString = `HTTP: ${mon1.last_latency.toFixed(1)} ms | HTTPS: ${mon2.last_latency.toFixed(1)} ms`;
      } else if (mon1.last_latency !== null) {
        latString = `HTTP: ${mon1.last_latency.toFixed(1)} ms | HTTPS: -- ms`;
      } else if (mon2.last_latency !== null) {
        latString = `HTTP: -- ms | HTTPS: ${mon2.last_latency.toFixed(1)} ms`;
      } else {
        latString = '-- ms';
      }
      document.getElementById('lvl3-stat-latency').textContent = latString;
      document.getElementById('lvl3-stat-interval').textContent = `${mon1.check_interval} seconds`;

      const resStatus1 = await fetch(`${httpUrl}/api/monitors/logs/monitor-${ids[0]}-status?limit=10`);
      const statusLogs1 = resStatus1.ok ? await resStatus1.json() : [];
      const resStatus2 = await fetch(`${httpUrl}/api/monitors/logs/monitor-${ids[1]}-status?limit=10`);
      const statusLogs2 = resStatus2.ok ? await resStatus2.json() : [];

      const resLatency1 = await fetch(`${httpUrl}/api/monitors/logs/monitor-${ids[0]}-latency?limit=10`);
      const latencyLogs1 = resLatency1.ok ? await resLatency1.json() : [];
      const resLatency2 = await fetch(`${httpUrl}/api/monitors/logs/monitor-${ids[1]}-latency?limit=10`);
      const latencyLogs2 = resLatency2.ok ? await resLatency2.json() : [];

      let combinedLogs = [];
      statusLogs1.forEach((log, index) => {
        const matchingLat = latencyLogs1[index];
        combinedLogs.push({
          timestamp: log.timestamp,
          source: 'HTTP',
          status: log.value,
          latency: matchingLat ? parseFloat(matchingLat.value) : 0.0
        });
      });
      statusLogs2.forEach((log, index) => {
        const matchingLat = latencyLogs2[index];
        combinedLogs.push({
          timestamp: log.timestamp,
          source: 'HTTPS',
          status: log.value,
          latency: matchingLat ? parseFloat(matchingLat.value) : 0.0
        });
      });

      combinedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Slice to 10 for basic display
      const displayLogs = combinedLogs.slice(0, 10);

      if (displayLogs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="padding:16px; text-align:center; color:var(--text-secondary);">No logs recorded yet for this probe.</td></tr>`;
      } else {
        tableBody.innerHTML = displayLogs.map(log => {
          const isLogUp = isProbeStatusOnline(log.status, 'http');
          const finalStatus = isLogUp ? `[${log.source}] HTTP ${log.status}` : `[${log.source}] ${log.status}`;
          return `
            <tr style="border-bottom:1px solid var(--border-soft);">
              <td style="padding: 10px 14px; font-size:0.75rem; color:var(--text-secondary); font-family:monospace;">${new Date(log.timestamp).toLocaleString()}</td>
              <td style="padding: 10px 14px; font-weight:700; font-size:0.75rem; color:${isLogUp ? 'var(--color-optimal)' : '#f43f5e'};">${finalStatus}</td>
              <td style="padding: 10px 14px; font-family:monospace; font-size:0.75rem;">${log.latency.toFixed(2)} ms</td>
            </tr>`;
        }).join('');
      }
    } else {
      const mon = monitors.find(m => String(m.id) === String(monId));

      if (!mon) {
        alert("Probe details not found.");
        navigateProbesLevel(2);
        return;
      }

      document.getElementById('lvl3-probe-title').textContent = mon.name;
      document.getElementById('lvl3-probe-meta').textContent = `Engine: ${mon.type.toUpperCase()} | Address: ${mon.target}`;

      const isUp = isProbeStatusOnline(mon.last_status, mon.type);
      const statusColor = isUp ? 'var(--color-optimal)' : '#f43f5e';

      // Seed cachedEntities with current values for this monitor to prevent out-of-sync WebSocket updates
      const statusKey = `monitor-${monId}-status`;
      const latencyKey = `monitor-${monId}-latency`;

      cachedEntities[statusKey] = {
        node_id: 'monitors',
        entity_key: statusKey,
        value: mon.last_status,
        status: mon.last_status,
        status_type: isUp ? 'healthy' : 'error'
      };
      cachedEntities[latencyKey] = {
        node_id: 'monitors',
        entity_key: latencyKey,
        value: mon.last_latency
      };
      const statusLabel = isUp ? (mon.type === 'ssl' ? mon.last_status : 'ONLINE') : (mon.last_status === 'unknown' ? 'UNKNOWN' : 'OFFLINE');
      const latencyStr = mon.last_latency !== null ? `${mon.last_latency} ms` : '-- ms';

      document.getElementById('lvl3-stat-status').textContent = statusLabel;
      document.getElementById('lvl3-stat-status').style.color = statusColor;
      document.getElementById('lvl3-stat-latency').textContent = latencyStr;
      document.getElementById('lvl3-stat-interval').textContent = `${mon.check_interval} seconds`;

      const resStatus = await fetch(`${httpUrl}/api/monitors/logs/monitor-${monId}-status?limit=10`);
      if (!resStatus.ok) throw new Error(`Status Logs HTTP ${resStatus.status}`);
      const statusLogs = await resStatus.json();

      const resLatency = await fetch(`${httpUrl}/api/monitors/logs/monitor-${monId}-latency?limit=10`);
      if (!resLatency.ok) throw new Error(`Latency Logs HTTP ${resLatency.status}`);
      const latencyLogs = await resLatency.json();

      if (statusLogs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="padding:16px; text-align:center; color:var(--text-secondary);">No logs recorded yet for this probe.</td></tr>`;
        return;
      }

      let logsHtml = '';
      for (let i = 0; i < statusLogs.length; i++) {
        const sLog = statusLogs[i];
        const lLog = latencyLogs[i] || { value: '0.0' };

        const dt = new Date(sLog.timestamp).toLocaleString();
        const statusVal = sLog.value;

        let isLvlUp = isProbeStatusOnline(sLog.value, mon.type);
        let displayStatus = statusVal;

        if (statusVal === 'up' || statusVal === 'UP' || statusVal === 'ONLINE') {
          displayStatus = 'ONLINE';
        } else if (statusVal === 'down' || statusVal === 'DOWN' || statusVal === 'OFFLINE') {
          displayStatus = 'OFFLINE';
        } else {
          const codeNum = parseInt(statusVal);
          if (!isNaN(codeNum)) {
            displayStatus = `HTTP ${statusVal}`;
          } else {
            displayStatus = statusVal.replace(/_/g, ' ');
          }
        }

        const resultColor = isLvlUp ? 'var(--color-optimal)' : '#f43f5e';
        const latencyVal = parseFloat(lLog.value) || 0;

        logsHtml += `
          <tr style="border-bottom:1px solid var(--border-soft);">
            <td style="padding:10px 14px; font-family:monospace; color:var(--text-secondary);">${dt}</td>
            <td style="padding:10px 14px; font-weight:700; color:${resultColor};">${displayStatus}</td>
            <td style="padding:10px 14px; font-family:monospace;">${latencyVal.toFixed(2)} ms</td>
          </tr>`;
      }
      tableBody.innerHTML = logsHtml;
    }
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="3" style="padding:16px; text-align:center; color:#f43f5e;">Failed to load logs details: ${err.message}</td></tr>`;
  }
}

window.openAddMonitorModal = function () {
  console.log("openAddMonitorModal triggered - navigating to catalog page");
  navigateProbesLevel('catalog');
};

window.selectProbeTypeToConfigure = function (type) {
  console.log("selectProbeTypeToConfigure triggered for:", type);

  const nameInput = document.getElementById('mon-name');
  if (nameInput) nameInput.value = '';
  const typeInput = document.getElementById('mon-type');
  if (typeInput) typeInput.value = type;
  const targetInput = document.getElementById('mon-target');
  if (targetInput) targetInput.value = '';
  const intervalInput = document.getElementById('mon-interval');
  if (intervalInput) intervalInput.value = '30';
  const timeoutInput = document.getElementById('mon-timeout');
  if (timeoutInput) timeoutInput.value = '5';

  onMonitorTypeChange(type);

  openModal('add-monitor-modal');
};

function onMonitorTypeChange(type) {
  const container = document.getElementById('modal-http-protocol-select-container');
  if (container) {
    container.style.display = (type === 'http') ? 'flex' : 'none';
  }
}

async function submitAddMonitor() {
  const name = document.getElementById('mon-name').value.trim();
  const type = document.getElementById('mon-type').value;
  const target = document.getElementById('mon-target').value.trim();
  const interval = parseInt(document.getElementById('mon-interval').value) || 30;
  const timeout = parseInt(document.getElementById('mon-timeout').value) || 5;

  if (!name || !target) {
    alert("Required fields Name and Target Address must be filled!");
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    if (type === 'http') {
      const proto = document.getElementById('mon-proto')?.value || 'http';
      const cleanTarget = target.replace(/^(https?:\/\/)+/i, '');

      if (proto === 'both') {
        const resHttp = await fetch(`${httpUrl}/api/monitors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${name} (HTTP)`,
            type: type,
            target: `http://${cleanTarget}`,
            check_interval: interval,
            timeout
          })
        });
        if (!resHttp.ok) {
          const errData = await resHttp.json();
          throw new Error(`HTTP Save failed: ${errData.detail || resHttp.status}`);
        }

        const resHttps = await fetch(`${httpUrl}/api/monitors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${name} (HTTPS)`,
            type: type,
            target: `https://${cleanTarget}`,
            check_interval: interval,
            timeout
          })
        });
        if (!resHttps.ok) {
          const errData = await resHttps.json();
          throw new Error(`HTTPS Save failed: ${errData.detail || resHttps.status}`);
        }
      } else {
        const urlPrefix = proto === 'https' ? 'https://' : 'http://';
        const res = await fetch(`${httpUrl}/api/monitors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            type: type,
            target: urlPrefix + cleanTarget,
            check_interval: interval,
            timeout
          })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.detail || `HTTP ${res.status}`);
        }
      }
    } else {
      const res = await fetch(`${httpUrl}/api/monitors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: type, target, check_interval: interval, timeout })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || `HTTP ${res.status}`);
      }
    }

    closeModal('add-monitor-modal');
    loadProbesLevel1();
    if (activeProbeEngineType) {
      loadProbesLevel2(activeProbeEngineType);
    }
    showToast(`Successfully configured background probe: ${name}`, "success");
  } catch (err) {
    alert(`Failed to save monitor probe config: ${err.message}`);
  }
}

async function deleteMonitorSource(monId, e) {
  if (e) e.stopPropagation();
  if (!confirm("Are you sure you want to remove this probe?")) return;

  const { httpUrl } = getApiUrls();
  try {
    const resList = await fetch(`${httpUrl}/api/monitors`);
    if (!resList.ok) throw new Error(`HTTP ${resList.status}`);
    const monitors = await resList.json();
    const targetMon = monitors.find(m => String(m.id) === String(monId));

    let idsToDelete = [String(monId)];
    if (targetMon && targetMon.type === 'http') {
      let partner = null;
      if (targetMon.name.endsWith(' (HTTP)')) {
        const base = targetMon.name.substring(0, targetMon.name.length - 7);
        partner = monitors.find(m => m.type === 'http' && m.name === base + ' (HTTPS)');
      } else if (targetMon.name.endsWith(' (HTTPS)')) {
        const base = targetMon.name.substring(0, targetMon.name.length - 8);
        partner = monitors.find(m => m.type === 'http' && m.name === base + ' (HTTP)');
      }
      if (partner) {
        idsToDelete.push(String(partner.id));
      }
    }

    for (const deleteId of idsToDelete) {
      const res = await fetch(`${httpUrl}/api/monitors/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    loadProbesLevel1();
    loadProbesLevel2(activeProbeEngineType);
    showToast("Probe deleted successfully", "success");
  } catch (err) {
    alert(`Could not delete prober source: ${err.message}`);
  }
}

function onEditMonitorTypeChange(type) {
  const container = document.getElementById('modal-edit-http-protocol-select-container');
  if (container) {
    container.style.display = (type === 'http') ? 'flex' : 'none';
  }
}

async function openEditMonitor(monId, event) {
  if (event) event.stopPropagation();
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitors`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const monitors = await res.json();

    const ids = String(monId).split(',');
    const isGrouped = ids.length > 1;

    if (isGrouped) {
      const mon1 = monitors.find(m => String(m.id) === String(ids[0]));
      const mon2 = monitors.find(m => String(m.id) === String(ids[1]));
      if (!mon1 || !mon2) {
        alert("Configured monitors not found.");
        return;
      }

      const baseName = mon1.name.endsWith(' (HTTP)') ? mon1.name.slice(0, -7) : mon1.name.slice(0, -8);
      document.getElementById('edit-mon-id').value = monId;
      document.getElementById('edit-mon-name').value = baseName;
      document.getElementById('edit-mon-type').value = 'http';
      document.getElementById('edit-mon-proto').value = 'both';

      document.getElementById('edit-mon-target').value = mon1.target.replace(/^(https?:\/\/)+/i, '');
      document.getElementById('edit-mon-interval').value = mon1.check_interval;
      document.getElementById('edit-mon-timeout').value = mon1.timeout;
    } else {
      const mon = monitors.find(m => String(m.id) === String(monId));
      if (!mon) {
        alert("Monitor not found.");
        return;
      }

      document.getElementById('edit-mon-id').value = monId;
      document.getElementById('edit-mon-name').value = mon.name;
      document.getElementById('edit-mon-type').value = mon.type;

      if (mon.type === 'http') {
        const hasHttps = mon.target.startsWith('https://');
        document.getElementById('edit-mon-proto').value = hasHttps ? 'https' : 'http';
        document.getElementById('edit-mon-target').value = mon.target.replace(/^(https?:\/\/)+/i, '');
      } else {
        document.getElementById('edit-mon-target').value = mon.target;
      }

      document.getElementById('edit-mon-interval').value = mon.check_interval;
      document.getElementById('edit-mon-timeout').value = mon.timeout;
    }

    onEditMonitorTypeChange(document.getElementById('edit-mon-type').value);
    openModal('edit-monitor-modal');
  } catch (err) {
    alert(`Could not load monitor details: ${err.message}`);
  }
}

async function submitEditMonitor() {
  const monId = document.getElementById('edit-mon-id').value;
  const name = document.getElementById('edit-mon-name').value.trim();
  const type = document.getElementById('edit-mon-type').value;
  const target = document.getElementById('edit-mon-target').value.trim();
  const interval = parseInt(document.getElementById('edit-mon-interval').value) || 30;
  const timeout = parseInt(document.getElementById('edit-mon-timeout').value) || 5;

  if (!name || !target) {
    alert("Required fields Name and Target Address must be filled!");
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    const ids = String(monId).split(',');
    const wasGrouped = ids.length > 1;

    if (type === 'http') {
      const proto = document.getElementById('edit-mon-proto').value;
      const cleanTarget = target.replace(/^(https?:\/\/)+/i, '');

      if (proto === 'both') {
        if (wasGrouped) {
          const res1 = await fetch(`${httpUrl}/api/monitors/${ids[0]}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${name} (HTTP)`,
              type: type,
              target: `http://${cleanTarget}`,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res1.ok) throw new Error(`HTTP Update failed`);

          const res2 = await fetch(`${httpUrl}/api/monitors/${ids[1]}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${name} (HTTPS)`,
              type: type,
              target: `https://${cleanTarget}`,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res2.ok) throw new Error(`HTTPS Update failed`);
        } else {
          const res1 = await fetch(`${httpUrl}/api/monitors/${ids[0]}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${name} (HTTP)`,
              type: type,
              target: `http://${cleanTarget}`,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res1.ok) throw new Error(`HTTP Update failed`);

          const res2 = await fetch(`${httpUrl}/api/monitors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${name} (HTTPS)`,
              type: type,
              target: `https://${cleanTarget}`,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res2.ok) throw new Error(`HTTPS creation failed`);
        }
      } else {
        if (wasGrouped) {
          const resDel = await fetch(`${httpUrl}/api/monitors/${ids[1]}`, { method: 'DELETE' });
          if (!resDel.ok) throw new Error(`Failed to remove second monitor during ungrouping`);

          const finalTarget = proto === 'https' ? `https://${cleanTarget}` : `http://${cleanTarget}`;
          const res1 = await fetch(`${httpUrl}/api/monitors/${ids[0]}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name,
              type: type,
              target: finalTarget,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res1.ok) throw new Error(`Failed to update ungrouped monitor`);
        } else {
          const finalTarget = proto === 'https' ? `https://${cleanTarget}` : `http://${cleanTarget}`;
          const res1 = await fetch(`${httpUrl}/api/monitors/${ids[0]}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name,
              type: type,
              target: finalTarget,
              check_interval: interval,
              timeout: timeout
            })
          });
          if (!res1.ok) throw new Error(`Failed to update monitor`);
        }
      }
    } else {
      const res = await fetch(`${httpUrl}/api/monitors/${ids[0]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          type: type,
          target: target,
          check_interval: interval,
          timeout: timeout
        })
      });
      if (!res.ok) throw new Error(`Failed to update monitor`);
    }

    closeModal('edit-monitor-modal');
    loadProbesLevel1();
    if (activeProbeEngineType) {
      loadProbesLevel2(activeProbeEngineType);
    }
    showToast(`Successfully updated background probe: ${name}`, "success");
  } catch (err) {
    alert(`Failed to save monitor probe changes: ${err.message}`);
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;
  toast.innerHTML = `<i data-lucide="${type === 'success' ? 'check-circle' : type === 'error' ? 'alert-triangle' : 'info'}" style="width: 18px; height: 18px;"></i><span>${message}</span>`;
  container.appendChild(toast);

  if (window.lucide) {
    lucide.createIcons({
      node: toast
    });
  }

  setTimeout(() => {
    toast.classList.add('show');
  }, 50);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

window.showAlert = function (message, title = "System Alert", type = "error") {
  const modal = document.getElementById('custom-alert-modal');
  if (!modal) {
    console.warn("custom-alert-modal element not found in DOM.");
    return;
  }

  const titleSpan = document.getElementById('custom-alert-title');
  if (titleSpan) titleSpan.textContent = title;

  const bodyDiv = document.getElementById('custom-alert-body');
  if (bodyDiv) bodyDiv.textContent = message;

  const icon = document.getElementById('custom-alert-icon');
  if (icon) {
    if (type === 'error') {
      icon.style.color = '#f43f5e';
      icon.setAttribute('data-lucide', 'alert-triangle');
    } else if (type === 'success') {
      icon.style.color = '#10b981';
      icon.setAttribute('data-lucide', 'check-circle');
    } else {
      icon.style.color = 'var(--accent-orange)';
      icon.setAttribute('data-lucide', 'info');
    }
  }

  openModal('custom-alert-modal');
  if (window.lucide) {
    window.lucide.createIcons({
      node: modal
    });
  }
};

window.alert = function (message) {
  window.showAlert(message, "System Alert", "error");
};

let liveMonitorBuffer = {};

function handleLiveMonitorWSUpdate(entityId, value, status, statusType) {
  const lvl3View = document.getElementById('probes-level-3');
  if (!lvl3View || lvl3View.style.display === 'none') {
    return;
  }

  if (!activeProbeMonitorId) return;

  const ids = String(activeProbeMonitorId).split(',');
  const match = entityId.match(/^monitor-(\d+)-(status|latency)$/);
  if (!match) return;

  const monId = match[1];
  const field = match[2];

  if (!ids.includes(String(monId))) {
    return;
  }

  console.log(`[WS Live Probe] Received update for: ${entityId}, value: ${value}, activeProbeMonitorId: ${activeProbeMonitorId}`);

  if (!liveMonitorBuffer[monId]) {
    liveMonitorBuffer[monId] = { timestamp: new Date().toISOString() };
  }

  if (field === 'status') {
    liveMonitorBuffer[monId].status = value;
  } else if (field === 'latency') {
    liveMonitorBuffer[monId].latency = parseFloat(value);
  }

  console.log(`[WS Live Probe] Current buffer state for ${monId}:`, liveMonitorBuffer[monId]);

  checkAndCommitLiveLog(monId);
  updateLevel3HeadingStats();
}

function checkAndCommitLiveLog(monId) {
  const buf = liveMonitorBuffer[monId];
  if (buf && buf.status !== undefined && buf.latency !== undefined) {
    appendLiveHistoryRow(monId, buf.timestamp, buf.status, buf.latency);
    delete liveMonitorBuffer[monId];
  }
}

function appendLiveHistoryRow(monId, timestamp, status, latency) {
  const tableBody = document.getElementById('lvl3-history-table-body');
  if (!tableBody) return;

  if (tableBody.innerHTML.includes('Querying logs') || tableBody.innerHTML.includes('No logs recorded')) {
    tableBody.innerHTML = '';
  }

  const ids = String(activeProbeMonitorId).split(',');
  const isGrouped = ids.length > 1;

  let source = '';
  if (isGrouped) {
    if (String(monId) === String(ids[0])) {
      source = 'HTTP';
    } else if (String(monId) === String(ids[1])) {
      source = 'HTTPS';
    }
  }

  const isLogUp = isProbeStatusOnline(status, isGrouped ? 'http' : 'other');
  const finalStatus = source ? `[${source}] ${source === 'HTTP' ? 'HTTP ' + status : status}` : status;

  const html = `
    <tr style="border-bottom:1px solid var(--border-soft); transition: background-color 0.5s ease;">
      <td style="padding: 10px 14px; font-size:0.75rem; color:var(--text-secondary); font-family:monospace;">${new Date(timestamp).toLocaleString()}</td>
      <td style="padding: 10px 14px; font-weight:700; font-size:0.75rem; color:${isLogUp ? 'var(--color-optimal)' : '#f43f5e'};">${finalStatus}</td>
      <td style="padding: 10px 14px; font-family:monospace; font-size:0.75rem;">${parseFloat(latency).toFixed(2)} ms</td>
    </tr>
  `;

  tableBody.insertAdjacentHTML('afterbegin', html);

  const firstRow = tableBody.firstElementChild;
  if (firstRow) {
    firstRow.style.backgroundColor = 'rgba(200, 140, 60, 0.15)';
    setTimeout(() => {
      firstRow.style.backgroundColor = 'transparent';
    }, 1000);
  }

  while (tableBody.children.length > 30) {
    tableBody.lastElementChild.remove();
  }
}

function updateLevel3HeadingStats() {
  if (!activeProbeMonitorId) return;
  const ids = String(activeProbeMonitorId).split(',');
  const isGrouped = ids.length > 1;
  const eList = Object.values(cachedEntities);

  if (isGrouped) {
    const mon1Status = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[0]}-status`);
    const mon2Status = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[1]}-status`);
    const mon1Lat = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[0]}-latency`);
    const mon2Lat = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[1]}-latency`);

    if (mon1Status && mon2Status) {
      const isUp1 = isProbeStatusOnline(mon1Status.value, 'http');
      const isUp2 = isProbeStatusOnline(mon2Status.value, 'http');

      let label = 'BOTH OFFLINE';
      let color = '#f43f5e';
      if (isUp1 && isUp2) {
        label = 'BOTH ONLINE';
        color = 'var(--color-optimal)';
      } else if (isUp1) {
        label = 'HTTP ONLINE';
        color = 'var(--accent-orange)';
      } else if (isUp2) {
        label = 'HTTPS ONLINE';
        color = 'var(--accent-orange)';
      }

      const statusEl = document.getElementById('lvl3-stat-status');
      if (statusEl) {
        statusEl.textContent = label;
        statusEl.style.color = color;
      }

      let latString = '-- ms';
      const latVal1 = mon1Lat ? parseFloat(mon1Lat.value) : null;
      const latVal2 = mon2Lat ? parseFloat(mon2Lat.value) : null;

      if (latVal1 !== null && latVal2 !== null && latVal1 > 0 && latVal2 > 0) {
        latString = `HTTP: ${latVal1.toFixed(1)} ms | HTTPS: ${latVal2.toFixed(1)} ms`;
      } else if (latVal1 !== null && latVal1 > 0) {
        latString = `HTTP: ${latVal1.toFixed(1)} ms | HTTPS: -- ms`;
      } else if (latVal2 !== null && latVal2 > 0) {
        latString = `HTTP: -- ms | HTTPS: ${latVal2.toFixed(1)} ms`;
      }

      const latEl = document.getElementById('lvl3-stat-latency');
      if (latEl) latEl.textContent = latString;
    }
  } else {
    const monStatus = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[0]}-status`);
    const monLat = eList.find(e => e.node_id === 'monitors' && e.entity_key === `monitor-${ids[0]}-latency`);

    if (monStatus) {
      const isUp = isProbeStatusOnline(monStatus.value, 'other');
      const color = isUp ? 'var(--color-optimal)' : '#f43f5e';
      const label = isUp ? (monStatus.entity_key.includes('ssl') ? monStatus.value : 'ONLINE') : 'OFFLINE';

      const statusEl = document.getElementById('lvl3-stat-status');
      if (statusEl) {
        statusEl.textContent = label;
        statusEl.style.color = color;
      }
    }

    if (monLat) {
      const latVal = parseFloat(monLat.value);
      const latEl = document.getElementById('lvl3-stat-latency');
      if (latEl) latEl.textContent = (latVal > 0) ? `${latVal.toFixed(1)} ms` : '-- ms';
    }
  }
}

window.activeAuditFilter = 'all';

function filterAuditLogs(severity) {
  window.activeAuditFilter = severity;

  document.querySelectorAll('.audit-filter-btn').forEach(btn => {
    if (btn.getAttribute('data-filter') === severity) {
      btn.classList.add('active');
      btn.style.background = 'var(--bg-secondary)';
      btn.style.color = 'var(--text-primary)';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'transparent';
      btn.style.color = 'var(--text-secondary)';
    }
  });

  document.querySelectorAll('.audit-row').forEach(row => {
    const rowSev = row.dataset.severity;
    if (severity === 'all' || rowSev === severity) {
      row.style.display = 'flex';
    } else {
      row.style.display = 'none';
    }
  });
}

// ==========================================
// ALERT ROUTER ENGINE & RULES COMPOSER LOGIC
// ==========================================
window.cachedChannels = [];
window.activeAlertRuleId = null;
window.activeAlertChannelId = null;

function switchAlertSubView(viewName) {
  document.querySelectorAll('.alert-content-pane').forEach(p => p.classList.add('hide'));
  document.querySelectorAll('#alert-sub-navigation .sub-nav-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.style.background = 'none';
    btn.style.color = 'var(--text-secondary)';
    const icon = btn.querySelector('i');
    if (icon) icon.style.color = 'var(--text-secondary)';
  });

  const activePane = document.getElementById(`alert-sub-view-${viewName}`);
  if (activePane) activePane.classList.remove('hide');

  const activeBtn = document.getElementById(`alert-subnav-${viewName}`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.style.background = 'var(--bg-secondary)';
    activeBtn.style.color = 'var(--text-primary)';
    const icon = activeBtn.querySelector('i');
    if (icon) icon.style.color = 'var(--accent-orange)';
  }
}

async function loadNotificationChannels() {
  const { httpUrl } = getApiUrls();
  const listEl = document.getElementById('alert-channels-list');
  if (!listEl) return;

  try {
    const res = await fetch(`${httpUrl}/api/alerts/channels`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.cachedChannels = data;

    if (data.length === 0) {
      listEl.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:24px 0;">No notification channels configured yet.</p>`;
      return;
    }

    listEl.innerHTML = data.map(chan => {
      let iconName = 'bell';
      let details = '';
      if (chan.type === 'smtp') {
        iconName = 'mail';
        details = `Host: ${chan.config.host}:${chan.config.port} | To: ${chan.config.to_address}`;
      } else if (chan.type === 'telegram') {
        iconName = 'message-square';
        details = `Chat ID: ${chan.config.chat_id}`;
      } else if (chan.type === 'pushover') {
        iconName = 'smartphone';
        details = `User Key: ${chan.config.user_key.substring(0, 8)}... | Priority: ${chan.config.priority || 0}`;
      }

      return `
        <div style="background:#1d1b18; border:1px solid var(--border-soft); border-radius:8px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="background:rgba(200, 140, 60, 0.08); border-radius:50%; width:36px; height:36px; display:flex; align-items:center; justify-content:center; border:1px solid rgba(200, 140, 60, 0.15);">
              <i data-lucide="${iconName}" style="width:16px; height:16px; color:var(--accent-orange);"></i>
            </div>
            <div style="display:flex; flex-direction:column; gap:2px;">
              <span style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">${chan.name}</span>
              <span style="font-size:0.68rem; color:var(--text-secondary); font-family:monospace;">${details}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="btn btn-secondary" onclick="openChannelComposer(${chan.id})" style="font-size:0.7rem; padding:4px 10px;">Edit</button>
            <button class="btn-icon" onclick="deleteChannelSource(${chan.id}, event)" style="background:none; border:none; cursor:pointer;" title="Delete Profile">
              <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
            </button>
          </div>
        </div>`;
    }).join('');

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem;">Failure loading channels: ${err.message}</p>`;
  }
}

async function loadAlertRules() {
  const { httpUrl } = getApiUrls();
  const listEl = document.getElementById('alert-rules-list');
  if (!listEl) return;

  try {
    const res = await fetch(`${httpUrl}/api/alerts/rules`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.length === 0) {
      listEl.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:24px 0;">No warning rules configured yet.</p>`;
      return;
    }

    listEl.innerHTML = data.map(rule => {
      // Build conditions presentation text
      const condsText = rule.rules_json.map((c, idx) => {
        const prefix = idx > 0 ? ` <span style="color:var(--accent-orange); font-weight:700;">${c.join_type}</span> ` : '';
        return `${prefix}<span style="color:var(--text-primary); font-family:monospace;">${c.entity_key}</span> ${c.operator} <span style="font-family:monospace; color:var(--accent-orange);">${c.value}</span>`;
      }).join('');

      const isFiring = rule.status === 'firing';
      const statusLabel = isFiring ? 'FIRING' : 'NORMAL';
      const statusColorClass = isFiring ? 'status-pill critical' : 'status-pill optimal';

      // Find channel names associated
      const chanNames = rule.channel_ids.map(cid => {
        const matchingChan = window.cachedChannels.find(c => c.id === cid);
        return matchingChan ? matchingChan.name : `Channel #${cid}`;
      }).join(', ') || 'No notifier linked';

      return `
        <div style="background:#1d1b18; border:1px solid var(--border-soft); border-radius:8px; padding:16px; display:flex; flex-direction:column; gap:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <h4 style="font-size:0.85rem; font-weight:700; color:var(--text-primary); margin:0 0 4px 0;">${rule.name}</h4>
              <div style="font-size:0.75rem; color:var(--text-secondary); line-height:1.4;">
                ${condsText}
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px;">
              <span class="${statusColorClass}" style="font-size:0.65rem;">${statusLabel}</span>
              <label class="switch" title="Enable/Disable Rule" onclick="event.stopPropagation()">
                <input type="checkbox" ${rule.enabled !== false ? 'checked' : ''} onchange="toggleRuleEnabled(${rule.id}, this.checked, event)">
                <span class="slider"></span>
              </label>
            </div>
          </div>
          
          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-soft); padding-top:10px; margin-top:4px;">
            <span style="font-size:0.68rem; color:var(--text-secondary);"><i data-lucide="send" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Channels: <strong style="color:var(--text-primary);">${chanNames}</strong></span>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="btn btn-secondary" onclick="openRuleComposer(${rule.id})" style="font-size:0.7rem; padding:4px 10px;">Edit</button>
              <button class="btn-icon" onclick="deleteRuleSource(${rule.id}, event)" style="background:none; border:none; cursor:pointer;" title="Delete Rule">
                <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
              </button>
            </div>
          </div>
        </div>`;
    }).join('');

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem;">Failure loading rules: ${err.message}</p>`;
  }
}

function openChannelComposer(cid = null) {
  window.activeAlertChannelId = cid;
  const modal = document.getElementById('channel-modal');
  const titleEl = document.getElementById('channel-modal-title');
  const nameInput = document.getElementById('chan-name');
  const typeSelect = document.getElementById('chan-type');

  if (!modal) return;

  if (cid) {
    titleEl.textContent = 'Edit Notification Channel';
    const chan = window.cachedChannels.find(c => c.id === cid);
    if (chan) {
      nameInput.value = chan.name;
      typeSelect.value = chan.type;
      renderChannelConfigFields(chan.config);
    }
  } else {
    titleEl.textContent = 'Add Notification Channel';
    nameInput.value = '';
    typeSelect.value = 'smtp';
    renderChannelConfigFields({});
  }

  openModal('channel-modal');
}

function renderChannelConfigFields(currentConfig = {}) {
  const container = document.getElementById('chan-dynamic-fields');
  const type = document.getElementById('chan-type').value;
  if (!container) return;

  if (type === 'smtp') {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">SMTP Server Host</label>
        <input type="text" id="smtp-host" placeholder="smtp.gmail.com" value="${currentConfig.host || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">SMTP Port</label>
        <input type="number" id="smtp-port" placeholder="587" value="${currentConfig.port || 587}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Sender / Username (Optional)</label>
        <input type="text" id="smtp-user" placeholder="e.g. notifications@yourdomain.com" value="${currentConfig.username || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Password (Optional)</label>
        <input type="password" id="smtp-pass" placeholder="••••••••" value="${currentConfig.password || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Sender Envelope From address</label>
        <input type="text" id="smtp-from" placeholder="notifications@yourdomain.com" value="${currentConfig.from_address || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Recipient To address</label>
        <input type="text" id="smtp-to" placeholder="sysalerts@coxonfam.au" value="${currentConfig.to_address || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
    `;
  } else if (type === 'telegram') {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Telegram Bot Token</label>
        <input type="password" id="telegram-token" placeholder="bot123456789:ABCDefgh..." value="${currentConfig.bot_token || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Chat ID / Target Channel</label>
        <input type="text" id="telegram-chat" placeholder="e.g. -10015839958" value="${currentConfig.chat_id || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
    `;
  } else if (type === 'pushover') {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Pushover User Key</label>
        <input type="password" id="pushover-user" placeholder="uabcdefg123456..." value="${currentConfig.user_key || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Application API Token</label>
        <input type="password" id="pushover-token" placeholder="azxy123456..." value="${currentConfig.api_token || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Sound Ringtone</label>
        <select id="pushover-sound" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
          <option value="pushover" ${currentConfig.sound === 'pushover' ? 'selected' : ''}>Pushover Default</option>
          <option value="bike" ${currentConfig.sound === 'bike' ? 'selected' : ''}>Bike</option>
          <option value="bugle" ${currentConfig.sound === 'bugle' ? 'selected' : ''}>Bugle</option>
          <option value="classical" ${currentConfig.sound === 'classical' ? 'selected' : ''}>Classical</option>
          <option value="cosmic" ${currentConfig.sound === 'cosmic' ? 'selected' : ''}>Cosmic</option>
          <option value="falling" ${currentConfig.sound === 'falling' ? 'selected' : ''}>Falling</option>
          <option value="gamelan" ${currentConfig.sound === 'gamelan' ? 'selected' : ''}>Gamelan</option>
          <option value="incoming" ${currentConfig.sound === 'incoming' ? 'selected' : ''}>Incoming Call</option>
          <option value="intermission" ${currentConfig.sound === 'intermission' ? 'selected' : ''}>Intermission</option>
          <option value="magic" ${currentConfig.sound === 'magic' ? 'selected' : ''}>Magic</option>
          <option value="mechanical" ${currentConfig.sound === 'mechanical' ? 'selected' : ''}>Mechanical</option>
          <option value="pianobar" ${currentConfig.sound === 'pianobar' ? 'selected' : ''}>Pianobar</option>
          <option value="siren" ${currentConfig.sound === 'siren' ? 'selected' : ''}>Siren</option>
          <option value="spacealarm" ${currentConfig.sound === 'spacealarm' ? 'selected' : ''}>Space Alarm</option>
          <option value="tugboat" ${currentConfig.sound === 'tugboat' ? 'selected' : ''}>Tug Boat</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Message Priority</label>
        <select id="pushover-priority" onchange="togglePushoverCriticalFields(this.value)" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
          <option value="-2" ${currentConfig.priority === -2 ? 'selected' : ''}>Lowest (Silent Background)</option>
          <option value="-1" ${currentConfig.priority === -1 ? 'selected' : ''}>Low (No sound/vibe)</option>
          <option value="0" ${currentConfig.priority === 0 || !currentConfig.priority ? 'selected' : ''}>Normal</option>
          <option value="1" ${currentConfig.priority === 1 ? 'selected' : ''}>High (Bypasses quiet hours)</option>
          <option value="2" ${currentConfig.priority === 2 ? 'selected' : ''}>Emergency / Critical Alert</option>
        </select>
      </div>
      <div id="pushover-critical-params" style="display:${currentConfig.priority == 2 ? 'flex' : 'none'}; flex-direction:column; gap:10px;">
        <div style="display:flex; flex-direction:column; gap:4px;">
          <label style="font-size:0.7rem; color:var(--text-secondary);">Retry interval (seconds)</label>
          <input type="number" id="pushover-retry" placeholder="60" value="${currentConfig.retry || 60}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
        </div>
        <div style="display:flex; flex-direction:column; gap:4px;">
          <label style="font-size:0.7rem; color:var(--text-secondary);">Expire time (seconds)</label>
          <input type="number" id="pushover-expire" placeholder="3600" value="${currentConfig.expire || 3600}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
        </div>
      </div>
    `;
  }
}

function togglePushoverCriticalFields(val) {
  const customFields = document.getElementById('pushover-critical-params');
  if (customFields) {
    customFields.style.display = (parseInt(val) === 2) ? 'flex' : 'none';
  }
}

function gatherChannelConfig() {
  const type = document.getElementById('chan-type').value;
  let cfg = {};

  if (type === 'smtp') {
    cfg = {
      host: document.getElementById('smtp-host').value.trim(),
      port: parseInt(document.getElementById('smtp-port').value) || 587,
      username: document.getElementById('smtp-user').value.trim(),
      password: document.getElementById('smtp-pass').value.trim(),
      from_address: document.getElementById('smtp-from').value.trim(),
      to_address: document.getElementById('smtp-to').value.trim()
    };
  } else if (type === 'telegram') {
    cfg = {
      bot_token: document.getElementById('telegram-token').value.trim(),
      chat_id: document.getElementById('telegram-chat').value.trim()
    };
  } else if (type === 'pushover') {
    cfg = {
      user_key: document.getElementById('pushover-user').value.trim(),
      api_token: document.getElementById('pushover-token').value.trim(),
      sound: document.getElementById('pushover-sound').value,
      priority: parseInt(document.getElementById('pushover-priority').value)
    };
    if (cfg.priority === 2) {
      cfg.retry = parseInt(document.getElementById('pushover-retry').value) || 60;
      cfg.expire = parseInt(document.getElementById('pushover-expire').value) || 3600;
    }
  }
  return cfg;
}

async function testCurrentChannelConfig() {
  const type = document.getElementById('chan-type').value;
  const config = gatherChannelConfig();

  const { httpUrl } = getApiUrls();
  showToast("Dispatching test notification...", "info");
  try {
    const res = await fetch(`${httpUrl}/api/alerts/channels/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, config })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    showToast("Test notification dispatched successfully!", "success");
  } catch (err) {
    showToast(`Test failed: ${err.message}`, "error");
  }
}

async function submitSaveChannel() {
  const name = document.getElementById('chan-name').value.trim();
  const type = document.getElementById('chan-type').value;
  const config = gatherChannelConfig();

  if (!name) {
    alert("Profile configurations need a name!");
    return;
  }

  const { httpUrl } = getApiUrls();
  const cid = window.activeAlertChannelId;
  const method = cid ? 'PUT' : 'POST';
  const url = cid ? `${httpUrl}/api/alerts/channels/${cid}` : `${httpUrl}/api/alerts/channels`;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, config })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    closeModal('channel-modal');
    loadNotificationChannels();
    showToast("Notification channel config profile committed.", "success");
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

async function deleteChannelSource(cid, event) {
  if (event) event.stopPropagation();
  if (!confirm("Are you sure you want to permanently delete this notification channel? Custom rules routing to it will lose reference.")) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/alerts/channels/${cid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadNotificationChannels();
    showToast("Deleted notification channel profile.", "success");
  } catch (err) {
    showToast(`Deletion failed: ${err.message}`, "error");
  }
}

async function openRuleComposer(rid = null) {
  window.activeAlertRuleId = rid;
  const modal = document.getElementById('rule-modal');
  const titleEl = document.getElementById('rule-modal-title');
  const nameInput = document.getElementById('rule-name');
  const conditionsContainer = document.getElementById('rule-conditions-editor-container');
  const channelsContainer = document.getElementById('rule-channels-list-container');

  if (!modal) return;

  conditionsContainer.innerHTML = '';

  // Render linked channel checkboxes
  if (window.cachedChannels.length === 0) {
    channelsContainer.innerHTML = `<span style="font-size:0.72rem; color:var(--text-secondary);">No notification channels configured yet. Create a channel profile first!</span>`;
  } else {
    channelsContainer.innerHTML = window.cachedChannels.map(chan => `
      <label style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer;">
        <input type="checkbox" class="rule-channel-chk" value="${chan.id}" style="accent-color:var(--accent-orange);">
        <span>${chan.name} (${chan.type.toUpperCase()})</span>
      </label>
    `).join('');
  }

  if (rid) {
    titleEl.textContent = 'Edit Alert Rule';
    try {
      const { httpUrl } = getApiUrls();
      const res = await fetch(`${httpUrl}/api/alerts/rules`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const list = await res.json();
      const rule = list.find(r => r.id === rid);
      if (rule) {
        nameInput.value = rule.name;

        // Render conditions rows
        rule.rules_json.forEach(cond => {
          addVisualRuleConditionRow(cond);
        });

        // Toggle checkboxes
        document.querySelectorAll('.rule-channel-chk').forEach(c => {
          if (rule.channel_ids.includes(parseInt(c.value))) {
            c.checked = true;
          }
        });
      }
    } catch (err) {
      alert(`Failed to load rule detail: ${err.message}`);
    }
  } else {
    titleEl.textContent = 'Create Alert Rule';
    nameInput.value = '';
    addVisualRuleConditionRow(); // Seed first row
  }

  openModal('rule-modal');
}

function addVisualRuleConditionRow(cond = null) {
  const container = document.getElementById('rule-conditions-editor-container');
  if (!container) return;

  const rowCount = container.children.length;
  const isFirstRow = rowCount === 0;

  // Build entity selector options
  let entityOptionsHtml = '';
  Object.values(cachedEntities).forEach(item => {
    entityOptionsHtml += `<option value="${item.entity_key}" ${cond && cond.entity_key === item.entity_key ? 'selected' : ''}>${item.name || item.entity_key} [${item.entity_key}]</option>`;
  });

  const rowDiv = document.createElement('div');
  rowDiv.className = 'rule-condition-row';
  rowDiv.style = 'display:flex; gap:8px; align-items:center; width:100%; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.02); padding-bottom:6px;';

  rowDiv.innerHTML = `
    <!-- Connector -->
    <div style="width: 75px; min-width:75px;">
      ${isFirstRow ? `
        <span style="font-size:0.75rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; padding-left:14px;">Trigger IF</span>
      ` : `
        <select class="cond-join" style="width:100%; background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:4px 6px; font-size:0.72rem;">
          <option value="AND" ${cond && cond.join_type === 'AND' ? 'selected' : ''}>AND</option>
          <option value="OR" ${cond && cond.join_type === 'OR' ? 'selected' : ''}>OR</option>
        </select>
      `}
    </div>

    <!-- Entity Dropdown -->
    <select class="cond-entity" style="flex:2; min-width:150px; background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:4px 6px; font-size:0.72rem;">
      ${entityOptionsHtml}
    </select>

    <!-- Operator -->
    <select class="cond-op" style="width:85px; min-width:85px; background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:4px 6px; font-size:0.72rem;">
      <option value="==" ${cond && cond.operator === '==' ? 'selected' : ''}>=</option>
      <option value="!=" ${cond && cond.operator === '!=' ? 'selected' : ''}>!=</option>
      <option value=">" ${cond && cond.operator === '>' ? 'selected' : ''}>&gt;</option>
      <option value="<" ${cond && cond.operator === '<' ? 'selected' : ''}>&lt;</option>
      <option value="contains" ${cond && cond.operator === 'contains' ? 'selected' : ''}>contains</option>
    </select>

    <!-- Target Value -->
    <input type="text" class="cond-val" placeholder="value" value="${cond ? cond.value : ''}" style="flex:1; min-width:80px; background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:4px 6px; font-size:0.72rem;">

    <!-- Trash Actions Row delete -->
    ${isFirstRow ? `
      <div style="width:24px; height:24px;"></div>
    ` : `
      <button class="btn-icon delete-row-btn" onclick="this.parentElement.remove()" style="background:none; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center;" title="Delete Condition">
        <i data-lucide="x" style="width:14px; height:14px; color:#f43f5e;"></i>
      </button>
    `}
  `;

  container.appendChild(rowDiv);
  if (window.lucide) window.lucide.createIcons();
}

async function submitSaveRule() {
  const name = document.getElementById('rule-name').value.trim();
  if (!name) {
    alert("Warning rule must have a name!");
    return;
  }

  // Gather conditions
  const conditions = [];
  const rows = document.querySelectorAll('.rule-condition-row');

  if (rows.length === 0) {
    alert("Must contain at least 1 trigger condition!");
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const entity_key = row.querySelector('.cond-entity').value;
    const operator = row.querySelector('.cond-op').value;
    const value = row.querySelector('.cond-val').value.trim();

    let join_type = '';
    if (i > 0) {
      join_type = row.querySelector('.cond-join').value;
    }

    if (value === '') {
      alert(`Condition value in row ${i + 1} cannot be empty!`);
      return;
    }

    conditions.push({ entity_key, operator, value, join_type });
  }

  // Gather channel IDs
  const channel_ids = [];
  document.querySelectorAll('.rule-channel-chk:checked').forEach(c => {
    channel_ids.push(parseInt(c.value));
  });

  if (channel_ids.length === 0) {
    alert("Please select at least 1 destination notification channel!");
    return;
  }

  const { httpUrl } = getApiUrls();
  const rid = window.activeAlertRuleId;
  const method = rid ? 'PUT' : 'POST';
  const url = rid ? `${httpUrl}/api/alerts/rules/${rid}` : `${httpUrl}/api/alerts/rules`;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rules_json: conditions, channel_ids, enabled: true })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    closeModal('rule-modal');
    loadAlertRules();
    showToast("Warning trigger rule configuration saved.", "success");
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

async function deleteRuleSource(rid, event) {
  if (event) event.stopPropagation();
  if (!confirm("Are you sure you want to delete this warning rule definition?")) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/alerts/rules/${rid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadAlertRules();
    showToast("Warning rule removed from database system.", "success");
  } catch (err) {
    showToast(`Rule deletion failed: ${err.message}`, "error");
  }
}

async function toggleRuleEnabled(rid, enabled, event) {
  if (event) event.stopPropagation();

  const { httpUrl } = getApiUrls();
  try {
    // We can fetch list of rules, find target, modify enabled boolean, and send PUT request
    const resList = await fetch(`${httpUrl}/api/alerts/rules`);
    if (!resList.ok) throw new Error(`List call failed`);
    const list = await resList.json();
    const rule = list.find(r => r.id === rid);

    if (rule) {
      const payload = {
        name: rule.name,
        rules_json: rule.rules_json,
        channel_ids: rule.channel_ids,
        enabled: enabled
      };

      const res = await fetch(`${httpUrl}/api/alerts/rules/${rid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`Save PUT failed: ${res.status}`);
      showToast(`Rule status successfully switched ${enabled ? 'ON' : 'OFF'}.`, "success");
    }
  } catch (err) {
    showToast(`Toggle failed: ${err.message}`, "error");
  }
}

// Expose loadHistoryAnalytics to window so dropdown shifts can invoke it
window.loadHistoryAnalytics = loadHistoryAnalytics;

function showUptimeHistoryView() {
  // Exit edit mode if active
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const uptimeHistoryView = document.getElementById('uptime-history-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (uptimeHistoryView) uptimeHistoryView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navHistory = document.getElementById('nav-history');
  if (navHistory) navHistory.classList.add('active');

  // Load monitors select and render
  populateHistoryMonitorsDropdown();
}

async function populateHistoryMonitorsDropdown() {
  const select = document.getElementById('history-monitor-select');
  if (!select) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitors`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const monitors = await res.json();

    let optionsHtml = '';
    monitors.forEach(mon => {
      optionsHtml += `<option value="${mon.id}" data-type="${mon.type}">${mon.name} (${mon.type.toUpperCase()})</option>`;
    });

    if (monitors.length === 0) {
      select.innerHTML = '<option value="">No monitors defined</option>';
      return;
    }

    select.innerHTML = optionsHtml;
    // Trigger initial load
    loadHistoryAnalytics();
  } catch (err) {
    console.error('Failed to populate history monitors list:', err);
  }
}

let historyChartInstance = null;

async function loadHistoryAnalytics() {
  const select = document.getElementById('history-monitor-select');
  const rangeEl = document.getElementById('history-timeframe-select');
  const tableBody = document.getElementById('history-logs-table-body');
  if (!select || !select.value || !tableBody) return;

  const monId = select.value;
  const selectedOpt = select.options[select.selectedIndex];
  const type = selectedOpt.getAttribute('data-type') || 'ping';

  const rangeVal = rangeEl ? rangeEl.value : 'limit-100';

  let queryParams = '';
  if (rangeVal.startsWith('limit-')) {
    queryParams = `?limit=${rangeVal.split('-')[1]}`;
  } else if (rangeVal.startsWith('hours-')) {
    queryParams = `?hours=${rangeVal.split('-')[1]}`;
  }

  tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:var(--text-secondary);">Loading analytics...</td></tr>`;

  const { httpUrl } = getApiUrls();
  try {
    const statusKey = `monitor-${monId}-status`;
    const latencyKey = `monitor-${monId}-latency`;

    const resStatus = await fetch(`${httpUrl}/api/monitors/logs/${statusKey}${queryParams}`);
    const statusLogs = resStatus.ok ? await resStatus.json() : [];

    const resLatency = await fetch(`${httpUrl}/api/monitors/logs/${latencyKey}${queryParams}`);
    const latencyLogs = resLatency.ok ? await resLatency.json() : [];

    if (statusLogs.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:var(--text-secondary);">No logs items found for this prober range.</td></tr>`;
      updateHistoryStats(0, 0, 0, 100);
      drawHistoryChart([], []);
      return;
    }

    // Zip and calculate stats
    let totalLatency = 0;
    let maxLatency = 0;
    let healthyCount = 0;
    let outages = 0;
    let prevUp = true;

    let chartData = [];
    let tableRows = '';

    const sortedStatus = [...statusLogs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const sortedLatency = [...latencyLogs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const chronologicalDetails = [];

    sortedStatus.forEach((statusLog, idx) => {
      const latVal = sortedLatency[idx] ? parseFloat(sortedLatency[idx].value) : 0;
      const isUpVal = isProbeStatusOnline(statusLog.value, type);

      chronologicalDetails.push({
        timestamp: statusLog.timestamp,
        status: statusLog.value,
        latency: latVal,
        isUp: isUpVal
      });
    });

    chronologicalDetails.forEach((log, idx) => {
      totalLatency += log.latency;
      if (log.latency > maxLatency) maxLatency = log.latency;
      if (log.isUp) {
        healthyCount++;
        prevUp = true;
      } else {
        if (prevUp && idx > 0) {
          outages++;
        }
        prevUp = false;
      }
    });

    const avgLatency = chronologicalDetails.length > 0 ? (totalLatency / chronologicalDetails.length) : 0;
    const uptimePct = chronologicalDetails.length > 0 ? (healthyCount / chronologicalDetails.length) * 100 : 100.0;

    // Render stats
    updateHistoryStats(avgLatency, maxLatency, outages, uptimePct);

    // Build logs display (reverse chronological for table)
    const reversedDetails = [...chronologicalDetails].reverse();
    reversedDetails.forEach(log => {
      const dt = new Date(log.timestamp).toLocaleString();
      let statusStr = log.status;
      if (statusStr === 'up' || statusStr === 'UP' || statusStr === 'ONLINE') {
        statusStr = 'ONLINE';
      } else if (statusStr === 'down' || statusStr === 'DOWN' || statusStr === 'OFFLINE') {
        statusStr = 'OFFLINE';
      } else {
        const numCode = parseInt(statusStr);
        if (!isNaN(numCode)) statusStr = `HTTP ${statusStr}`;
      }
      const isUp = log.isUp;
      const color = isUp ? 'var(--color-optimal)' : '#f43f5e';

      tableRows += `
        <tr style="border-bottom:1px solid var(--border-soft);">
          <td style="padding:10px 14px; font-family:monospace; color:var(--text-secondary);">${dt}</td>
          <td style="padding:10px 14px; font-weight:700; color:${color};">${statusStr}</td>
          <td style="padding:10px 14px; font-family:monospace;">${log.latency.toFixed(2)} ms</td>
        </tr>`;
    });
    tableBody.innerHTML = tableRows;

    // Render chart
    const labels = chronologicalDetails.map(log => new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const latencies = chronologicalDetails.map(log => log.latency);
    const healthBooleans = chronologicalDetails.map(log => log.isUp);

    drawHistoryChart(labels, latencies, healthBooleans);
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:#f43f5e;">Error loading analytics: ${err.message}</td></tr>`;
  }
}

function updateHistoryStats(avgLat, maxLat, outages, uptime) {
  const avgEl = document.getElementById('history-stat-avg-latency');
  const maxEl = document.getElementById('history-stat-max-latency');
  const outagesEl = document.getElementById('history-stat-outages');
  const uptimeEl = document.getElementById('history-stat-uptime');

  if (avgEl) avgEl.textContent = `${avgLat.toFixed(1)} ms`;
  if (maxEl) maxEl.textContent = `${maxLat.toFixed(1)} ms`;
  if (outagesEl) outagesEl.textContent = String(outages);
  if (uptimeEl) {
    uptimeEl.textContent = `${uptime.toFixed(1)}%`;
    if (uptime >= 99.0) {
      uptimeEl.style.color = 'var(--color-optimal)';
    } else if (uptime >= 95.0) {
      uptimeEl.style.color = 'var(--accent-orange)';
    } else {
      uptimeEl.style.color = '#f43f5e';
    }
  }
}

function drawHistoryChart(labels, values, healths) {
  const canvas = document.getElementById('analytics-chart-canvas');
  if (!canvas) return;

  if (historyChartInstance) {
    historyChartInstance.destroy();
  }

  // Create gradient fill
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  // Map bullet point colors depending on healthy statuses (green vs red)
  const pointColors = healths.map(h => h ? 'var(--color-optimal)' : '#f43f5e');

  historyChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Ping Response Latency',
        data: values,
        borderColor: '#3b82f6',
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointHoverRadius: 6,
        pointRadius: values.length > 50 ? 2 : 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'var(--text-secondary)', maxRotation: 45, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'var(--text-secondary)' },
          suggestedMin: 0
        }
      }
    }
  });
}

// ─────────────────────────────────────────
// HOST MANAGER PAGE LOGIC
// ─────────────────────────────────────────

function showHostsView() {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');

  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const uptimeHistoryView = document.getElementById('uptime-history-view');
  const hostsView = document.getElementById('hosts-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';

  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (uptimeHistoryView) uptimeHistoryView.classList.add('hide');
  if (hostsView) hostsView.classList.remove('hide');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navHosts = document.getElementById('nav-hosts');
  if (navHosts) navHosts.classList.add('active');

  loadHosts();
}

async function loadHosts() {
  const { httpUrl } = getApiUrls();
  const container = document.getElementById('hosts-list-container');
  if (!container) return;

  container.innerHTML = `<p style="grid-column: 1/-1; text-align:center; padding:32px; color:var(--text-secondary);">Loading hosts...</p>`;

  try {
    const response = await fetch(`${httpUrl}/api/hosts`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hosts = await response.json();

    if (hosts.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align:center; padding:48px 24px; border: 1px dashed var(--border-soft); border-radius: 8px;">
          <p style="color:var(--text-secondary); margin-bottom: 16px;">No hosts configured yet.</p>
          <button class="btn btn-primary" onclick="openAddHostModal()" style="font-size:0.75rem; padding: 8px 16px;">+ Add Your First Host</button>
        </div>`;
      return;
    }

    container.innerHTML = hosts.map(host => {
      const activeCheckers = [];
      if (host.ping_enabled) activeCheckers.push('Ping');
      if (host.http_enabled) activeCheckers.push('HTTP');
      if (host.https_enabled) activeCheckers.push('HTTPS');
      if (host.ssl_enabled) activeCheckers.push('SSL');
      if (host.port_enabled) activeCheckers.push(`Port ${host.port_number || ''}`);

      const checkersHtml = activeCheckers.length > 0
        ? activeCheckers.map(c => `<span style="font-size:0.65rem; background:rgba(255,255,255,0.05); color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:3px 8px; font-weight:600; text-transform:uppercase;">${c}</span>`).join(' ')
        : `<span style="font-size:0.65rem; color:var(--text-secondary); font-style:italic;">No active checks</span>`;

      return `
        <div class="settings-card" style="padding: 16px; margin: 0; background:rgba(255,255,255,0.01); display:flex; flex-direction:column; justify-content:space-between; min-height:160px; border-radius:8px; border:1px solid var(--border-soft);">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">${host.name}</h4>
              <div style="display:flex; gap:6px;">
                <button class="btn-icon" onclick="openEditHostModal(${JSON.stringify(host).replace(/"/g, '&quot;')})" style="padding:4px; opacity:0.8;" title="Edit Host">
                  <i data-lucide="edit-3" style="width:14px; height:14px; color:#94a3b8;"></i>
                </button>
                <button class="btn-icon" onclick="deleteHost(${host.id})" style="padding:4px; opacity:0.8;" title="Delete Host">
                  <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
                </button>
              </div>
            </div>
            <p style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px; font-family:monospace;">${host.target}</p>
          </div>
          <div style="border-top:1px solid var(--border-soft); padding-top:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${checkersHtml}
          </div>
        </div>`;
    }).join('');

    if (window.lucide) window.lucide.createIcons();

  } catch (err) {
    container.innerHTML = `<p style="grid-column: 1/-1; text-align:center; padding:32px; color:#f43f5e;">Failed to load hosts: ${err.message}</p>`;
  }
}

window.showHostsView = showHostsView;
window.openAddHostModal = function () {
  document.getElementById('host-modal-title').textContent = 'Configure New Host';
  document.getElementById('host-modal-id').value = '';
  document.getElementById('host-name').value = '';
  document.getElementById('host-target').value = '';
  document.getElementById('host-check-ping').checked = false;
  document.getElementById('host-check-http').checked = false;
  document.getElementById('host-check-https').checked = false;
  document.getElementById('host-check-ssl').checked = false;
  document.getElementById('host-check-port').checked = false;
  document.getElementById('host-port-number').value = '';
  document.getElementById('host-port-number').disabled = true;

  document.getElementById('host-modal').style.display = 'flex';
};

window.openEditHostModal = function (host) {
  document.getElementById('host-modal-title').textContent = 'Modify Host Device';
  document.getElementById('host-modal-id').value = host.id;
  document.getElementById('host-name').value = host.name;
  document.getElementById('host-target').value = host.target;
  document.getElementById('host-check-ping').checked = host.ping_enabled;
  document.getElementById('host-check-http').checked = host.http_enabled;
  document.getElementById('host-check-https').checked = host.https_enabled;
  document.getElementById('host-check-ssl').checked = host.ssl_enabled;
  document.getElementById('host-check-port').checked = host.port_enabled;
  document.getElementById('host-port-number').value = host.port_number || '';
  document.getElementById('host-port-number').disabled = !host.port_enabled;

  document.getElementById('host-modal').style.display = 'flex';
};

window.submitSaveHost = async function () {
  const { httpUrl } = getApiUrls();
  const id = document.getElementById('host-modal-id').value;
  const name = document.getElementById('host-name').value.trim();
  const target = document.getElementById('host-target').value.trim();

  if (!name || !target) {
    alert("Name and Target fields must not be empty.");
    return;
  }

  const payload = {
    name: name,
    target: target,
    ping_enabled: document.getElementById('host-check-ping').checked,
    http_enabled: document.getElementById('host-check-http').checked,
    https_enabled: document.getElementById('host-check-https').checked,
    ssl_enabled: document.getElementById('host-check-ssl').checked,
    port_enabled: document.getElementById('host-check-port').checked,
    port_number: document.getElementById('host-check-port').checked
      ? parseInt(document.getElementById('host-port-number').value) || null
      : null
  };

  try {
    let response;
    if (id) {
      response = await fetch(`${httpUrl}/api/hosts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      response = await fetch(`${httpUrl}/api/hosts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || `HTTP ${response.status}`);
    }

    closeModal('host-modal');
    loadHosts();
  } catch (err) {
    alert(`Failed to save host details: ${err.message}`);
  }
};

window.deleteHost = async function (id) {
  if (!confirm("Are you sure you want to delete this host? This will also remove all its monitored check probes.")) return;

  const { httpUrl } = getApiUrls();
  try {
    const response = await fetch(`${httpUrl}/api/hosts/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    loadHosts();
  } catch (err) {
    alert(`Failed to delete host: ${err.message}`);
  }
};


