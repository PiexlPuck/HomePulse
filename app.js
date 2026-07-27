// HomePulse Dashboard Client Interaction Logic
// Integrates with FastAPI REST endpoints & WebSocket Client Stream APIs

let activeTab = 'main';
let token = localStorage.getItem('hp_token') || 'Architect_JWT_String'; // Fallback token
let socket = null;
const telemetryHistory = {};
let cachedEntities = {};

document.addEventListener('DOMContentLoaded', () => {
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
      fetchDiscoveryQueue();
    });
  }
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
    }
  } catch (err) {
    console.error("Failed to load hp_dashboard_widgets configuration:", err);
    widgets = initializeWidgets();
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
          <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
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
          <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
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
        <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
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
        <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
      `;
    }

    // TYPE D: Health Snapshot widget
    else if (widget.type === 'health') {
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
                <div class="snapshot-progress-fill green" id="snapshot-security-bar" style="width: 0%; background:var(--color-optimal); height:100%; transition:width 0.4s ease;"></div>
              </div>
            </div>
          </div>
          <div class="snapshot-notice" style="margin-top:14px; font-size:0.72rem; color:var(--text-secondary); border-top:1px solid var(--border-soft); padding-top:10px;">
            Observer mode restricted: Manual configuration and control overrides are currently disabled by administrative policy.
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
      `;
    }

    // TYPE E: System Audit list panel widget
    else if (widget.type === 'audit') {
      cardEl.innerHTML = `
        <div class="card-header">
          <div class="card-title-area">
            <span class="card-title">${widget.title || "Global System Audit"}</span>
            <span class="card-subtitle">Realtime DB event tracking</span>
          </div>
        </div>
        <div class="card-body" style="padding:0 16px 16px 16px;">
          <div class="audit-list" id="audit-list" style="max-height: 180px; overflow-y: auto; background: var(--bg-primary); border: 1px solid var(--border-soft); border-radius: 6px; padding: 12px; font-family: monospace; font-size: 0.72rem; display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <!-- Dynamically populated -->
          </div>
        </div>
        <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
        <div class="edit-settings" onclick="openCardEditor('${widget.id}')"><i data-lucide="sliders"></i></div>
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
  }

  // B. Audit Log updates
  else if (data.event === 'audit_logged') {
    addAuditEntry(data.type, data.message);
  }

  // C. Dynamic mDNS discovery updates
  else if (data.event === 'device_discovered') {
    showDiscoveryAlert(data.node_id, data.name, data.ip);
  }
}

// Update DOM elements on Live Socket triggers
function updateCardState(nodeId, entityId, val, status, statusType) {
  const card = document.getElementById(`card-${nodeId}-${entityId}`);
  if (!card) return;

  const valueType = card.getAttribute('data-value-type');
  const unit = card.getAttribute('data-unit') || '';

  // Update memory cache for health status compilation
  const matchedKey = Object.keys(cachedEntities).find(key => {
    const item = cachedEntities[key];
    return item.node_id === nodeId && item.entity_key === entityId;
  });
  if (matchedKey) {
    cachedEntities[matchedKey].value = val;
    if (status) cachedEntities[matchedKey].status = status;
    if (statusType) cachedEntities[matchedKey].status_type = statusType;
  }

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
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = (max - min === 0) ? 1 : (max - min);

  const width = 100;
  const height = 30; // Max height inside viewBox
  const padding = 5;

  return values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * width;
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

  auditList.insertBefore(auditRow, auditList.firstChild);
  lucide.createIcons();

  // Enforce scroll history item limit
  while (auditList.children.length > 8) {
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
  // Toggle dashboard grid off, settings on
  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');

  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.remove('hide');

  // Highlight nav item
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navSettings = document.getElementById('nav-settings');
  if (navSettings) navSettings.classList.add('active');

  // Load from API and bind controls
  loadSettings();
}

function showDashboardView() {
  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');

  if (dashGrid) dashGrid.style.display = '';
  if (bottomSection) bottomSection.style.display = '';
  if (settingsView) settingsView.classList.add('hide');
}

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
          saveBtn.textContent = '✓ Saved';
          saveBtn.style.opacity = '0.7';
          setTimeout(() => {
            saveBtn.textContent = 'Save Settings';
            saveBtn.style.opacity = '1';
          }, 2000);
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
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', handleDrop);
    card.addEventListener('dragend', handleDragEnd);
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
  });
}

function handleDragStart(e) {
  // Only trigger drag if drag handle was clicked
  const handle = this.querySelector('.edit-handle');
  if (handle && !handle.contains(e.target)) {
    e.preventDefault();
    return false;
  }
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

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => {
      if (!modal.classList.contains('active')) {
        modal.style.display = 'none';
      }
    }, 200);
  }
}

function openCardEditor(widgetId) {
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
}

function saveWidgetSettings() {
  const id = document.getElementById('edit-widget-id').value;
  const title = document.getElementById('edit-widget-title').value.trim();
  const unit = document.getElementById('edit-widget-unit').value.trim();
  const color = document.getElementById('edit-widget-color').value;
  const tab = document.getElementById('edit-widget-tab').value;
  const w = parseInt(document.getElementById('edit-widget-width').value) || 1;
  const h = parseInt(document.getElementById('edit-widget-height').value) || 1;
  const min = parseFloat(document.getElementById('edit-scale-min').value);
  const max = parseFloat(document.getElementById('edit-scale-max').value);

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  const widget = widgets.find(w => w.id === id);
  if (widget) {
    widget.title = title;
    widget.tab = tab;
    widget.options.unit = unit;
    widget.options.color = color;
    widget.options.gridWidth = w;
    widget.options.gridHeight = h;
    widget.options.min = min;
    widget.options.max = max;

    localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));
  }

  closeModal('widget-editor-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content').classList.contains('edit-mode')) {
    enableDragAndDrop();
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
