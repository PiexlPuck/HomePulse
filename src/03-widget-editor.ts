// ============================================================================
// Module: src/03-widget-editor.ts
// Description: Drag-and-Drop Card Editor, Dynamic Tabs, Widget Modals & YAML Editor
// ============================================================================

// ─────────────────────────────────────────
// DRAG-AND-DROP & CARD EDITOR IMPLEMENTATION
// ─────────────────────────────────────────

let draggedCard: HTMLElement | null = null;

function enableDragAndDrop() {
  const cards = document.querySelectorAll('#dashboard-grid > .card');
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
  const cards = document.querySelectorAll('#dashboard-grid > .card');
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
      { id: "main", name: "Main", icon: "layout-dashboard" }
    ]));
  }

  let dashboards = [];
  try {
    dashboards = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (err) {
    dashboards = [{ id: "main", name: "Main", icon: "layout-dashboard" }];
  }

  const isEditMode = document.getElementById('main-content')?.classList.contains('edit-mode');

  dashboards.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.setAttribute('data-tab', tab.id);
    btn.onclick = () => switchTab(tab.id);
    btn.ondblclick = () => openManageDashboardsModal(tab.id);

    const iconName = tab.icon || 'layout-dashboard';
    btn.innerHTML = `<i data-lucide="${iconName}"></i><span>${tab.name}</span>`;
    btn.title = isEditMode ? "Click to view • Double-click to manage" : `View ${tab.name}`;

    if (tab.id === activeTab) {
      btn.classList.add('active');
    }
    container.appendChild(btn);
  });

  // Appends Add / Manage Views button
  const plusBtn = document.createElement('button');
  plusBtn.className = 'add-tab-btn';
  plusBtn.onclick = () => openNewDashboardModal();
  plusBtn.title = "Add or Manage Dashboard Views";
  plusBtn.innerHTML = '<i data-lucide="plus" style="width:13px; height:13px;"></i>';
  container.appendChild(plusBtn);

  if (window.lucide) window.lucide.createIcons();
}

function switchTab(tabId) {
  activeTab = tabId;
  buildDashboardCards(cachedEntities);
  renderDashboards();
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
}

// ─────────────────────────────────────────
// DASHBOARD VIEWS MODAL & MANAGEMENT API
// ─────────────────────────────────────────

const DASHBOARD_ICONS = [
  { id: 'layout-dashboard', label: 'Dashboard' },
  { id: 'server', label: 'Server' },
  { id: 'cpu', label: 'Compute' },
  { id: 'activity', label: 'Activity' },
  { id: 'wifi', label: 'Network' },
  { id: 'shield', label: 'Security' },
  { id: 'home', label: 'Home' },
  { id: 'database', label: 'Database' },
  { id: 'hard-drive', label: 'Storage' },
  { id: 'zap', label: 'Power' },
  { id: 'gauge', label: 'Telemetry' },
  { id: 'terminal', label: 'System' }
];

let selectedViewIcon = 'layout-dashboard';

function renderViewIconChips() {
  const container = document.getElementById('view-icon-chips-grid');
  if (!container) return;

  let html = '';
  DASHBOARD_ICONS.forEach(item => {
    const isActive = item.id === selectedViewIcon;
    html += `
      <div class="view-icon-chip ${isActive ? 'active' : ''}" onclick="selectViewIcon('${item.id}')" title="${item.label}">
        <i data-lucide="${item.id}"></i>
        <span>${item.label}</span>
      </div>`;
  });
  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

function selectViewIcon(iconId) {
  selectedViewIcon = iconId;
  const input = document.getElementById('new-dash-icon');
  if (input) input.value = iconId;

  renderViewIconChips();
  updateDashboardPreview();
}

function updateDashboardPreview() {
  const nameInput = document.getElementById('new-dash-name');
  const labelEl = document.getElementById('preview-tab-label');
  const iconEl = document.getElementById('preview-tab-icon');

  const val = (nameInput?.value.trim()) || 'New View';
  if (labelEl) labelEl.textContent = val;
  if (iconEl) iconEl.setAttribute('data-lucide', selectedViewIcon);

  if (window.lucide) window.lucide.createIcons();
}

function openNewDashboardModal() {
  const modal = document.getElementById('dashboard-view-modal');
  if (!modal) return;

  const nameInput = document.getElementById('new-dash-name');
  if (nameInput) {
    nameInput.value = '';
    nameInput.style.borderColor = '';
  }

  selectedViewIcon = 'layout-dashboard';
  const iconInput = document.getElementById('new-dash-icon');
  if (iconInput) iconInput.value = 'layout-dashboard';

  renderViewIconChips();
  updateDashboardPreview();
  switchDashboardModalTab('create');

  modal.style.display = 'flex';
  setTimeout(() => {
    modal.classList.add('active');
    if (nameInput) nameInput.focus();
  }, 10);
}

function openManageDashboardsModal(tabId) {
  openNewDashboardModal();
  switchDashboardModalTab('manage');
}

function switchDashboardModalTab(mode) {
  const createPane = document.getElementById('dash-create-pane');
  const managePane = document.getElementById('dash-manage-pane');
  const btnCreate = document.getElementById('tab-dash-create');
  const btnManage = document.getElementById('tab-dash-manage');
  const footerBtn = document.getElementById('btn-save-dashboard-view');

  if (btnCreate) btnCreate.classList.toggle('active', mode === 'create');
  if (btnManage) btnManage.classList.toggle('active', mode === 'manage');

  if (mode === 'create') {
    if (createPane) createPane.style.display = 'flex';
    if (managePane) managePane.style.display = 'none';
    if (footerBtn) footerBtn.style.display = 'inline-flex';
  } else {
    if (createPane) createPane.style.display = 'none';
    if (managePane) managePane.style.display = 'flex';
    if (footerBtn) footerBtn.style.display = 'none';
    renderDashboardsManageList();
  }
}

function renderDashboardsManageList() {
  const container = document.getElementById('dashboards-list-container');
  if (!container) return;

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  if (list.length === 0) {
    container.innerHTML = '<span style="font-size:0.75rem; color:var(--text-secondary);">No views configured.</span>';
    return;
  }

  let html = '';
  list.forEach(tab => {
    const cardCount = widgets.filter(w => w.tab === tab.id).length;
    const isOnlyOne = list.length <= 1;
    const isCurrent = tab.id === activeTab;

    html += `
      <div class="manage-view-item" id="manage-item-${tab.id}">
        <div class="manage-view-info">
          <i data-lucide="${tab.icon || 'layout-dashboard'}"></i>
          <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="text" class="modal-input" id="manage-input-${tab.id}" value="${tab.name}" style="padding:4px 8px; font-size:0.8rem; font-weight:600; width:150px; background:var(--bg-primary);">
              ${isCurrent ? '<span style="font-size:0.6rem; color:var(--color-optimal); background:rgba(16,185,129,0.12); padding:1px 6px; border-radius:4px; font-weight:600;">ACTIVE</span>' : ''}
            </div>
            <span class="manage-view-count">${cardCount} card${cardCount === 1 ? '' : 's'} assigned</span>
          </div>
        </div>
        <div class="manage-view-actions">
          <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem;" onclick="saveDashboardName('${tab.id}')" title="Save name change">
            <i data-lucide="check" style="width:12px; height:12px;"></i> Save
          </button>
          <button class="btn btn-danger" style="padding:5px 8px; font-size:0.75rem; ${isOnlyOne ? 'opacity:0.4; cursor:not-allowed;' : ''}" ${isOnlyOne ? 'disabled' : `onclick="deleteDashboardTab('${tab.id}')"`} title="${isOnlyOne ? 'Cannot delete the only remaining view' : 'Delete View'}">
            <i data-lucide="trash-2" style="width:12px; height:12px;"></i>
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

function saveDashboardName(tabId) {
  const input = document.getElementById(`manage-input-${tabId}`);
  if (!input) return;
  const newName = input.value.trim();
  if (!newName) {
    input.style.borderColor = '#f43f5e';
    return;
  }

  renameDashboardTab(tabId, newName);
  input.style.borderColor = 'var(--color-optimal)';
  setTimeout(() => {
    input.style.borderColor = '';
  }, 1000);
  addAuditEntry('info', `Renamed dashboard view to "${newName}".`);
}

function submitNewDashboardView() {
  const nameInput = document.getElementById('new-dash-name');
  if (!nameInput) return;

  const tabName = nameInput.value.trim();
  if (!tabName) {
    nameInput.style.borderColor = '#f43f5e';
    nameInput.focus();
    return;
  }

  const iconName = selectedViewIcon || 'layout-dashboard';
  const id = 'tab_' + Date.now();

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  list.push({ id, name: tabName, icon: iconName });
  localStorage.setItem('hp_dashboards', JSON.stringify(list));

  closeModal('dashboard-view-modal');
  renderDashboards();
  switchTab(id);
  addAuditEntry('success', `Created new dashboard view "${tabName}".`);
}

function addNewDashboardTab() {
  openNewDashboardModal();
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

async function deleteDashboardTab(tabId) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { }

  if (list.length <= 1) {
    alert("Cannot delete the only remaining dashboard tab.");
    return;
  }
  if (!await showConfirm("Are you sure you want to delete this tab? All cards inside it will be reassigned to the main dashboard tab.", "Delete Dashboard Tab")) return;

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
  renderDashboardsManageList();
  if (activeTab === tabId) {
    switchTab(primaryTab);
  }
  addAuditEntry('warning', `Deleted dashboard view "${tabId}".`);
}

// ─────────────────────────────────────────
// WIDGET CONFIGURATION & CATALOG MANAGERS
// ─────────────────────────────────────────

function initializeWidgets() {
  let widgets = [];

  const entityKeys = Object.keys(cachedEntities);
  const hasDbEntities = entityKeys.some(k => cachedEntities[k].entity_key === 'database-status');

  // Consolidated Database card
  if (hasDbEntities) {
    widgets.push({
      id: "widget-hp-db-engine",
      type: "entities",
      title: "Database Engine",
      tab: "main",
      entities: [
        { nodeId: "core-mon", entityKey: "database-status" },
        { nodeId: "core-mon", entityKey: "database-latency" },
        { nodeId: "core-mon", entityKey: "database-storage-pct" }
      ],
      options: { gridWidth: 2, gridHeight: 1 }
    });
  }

  // Add all detected entities dynamically
  entityKeys.forEach(key => {
    const item = cachedEntities[key];
    if (hasDbEntities && (item.entity_key === 'database-status' || item.entity_key === 'database-latency' || item.entity_key === 'database-storage-pct')) return;

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

  // Fallback defaults if no entities loaded yet
  if (widgets.length === 0) {
    widgets.push(
      { id: "widget-core-cpu", type: "sensor", title: "Core CPU Cycles", tab: "main", entities: [{ nodeId: "core-mon", entityKey: "cpu-utilization" }], options: { gridWidth: 1, gridHeight: 1, graphic: "sparkline", color: "var(--color-optimal)", unit: "%" } },
      { id: "widget-core-mem", type: "sensor", title: "Memory Pool Usage", tab: "main", entities: [{ nodeId: "core-mon", entityKey: "memory-saturation" }], options: { gridWidth: 1, gridHeight: 1, graphic: "sparkline", color: "var(--accent-blue)", unit: "%" } },
      { id: "widget-core-temp", type: "sensor", title: "Host CPU Temperature", tab: "main", entities: [{ nodeId: "core-mon", entityKey: "server-room-temp" }], options: { gridWidth: 1, gridHeight: 1, graphic: "sparkline", color: "var(--color-optimal)", unit: "°C" } },
      { id: "widget-core-net", type: "sensor", title: "Network Throughput", tab: "main", entities: [{ nodeId: "core-mon", entityKey: "network-throughput" }], options: { gridWidth: 1, gridHeight: 1, graphic: "sparkline", color: "var(--color-optimal)", unit: "MB/s" } }
    );
  }

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
  updateEditorVisualPreview();

  // Initialize and bind YAML Live Preview
  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (yamlTextarea) {
    setupYamlTextareaTabKey(yamlTextarea);
    updateYamlPreview(yamlTextarea.value);

    const onYamlInput = () => {
      updateYamlPreview(yamlTextarea.value);
    };
    yamlTextarea.removeEventListener('input', onYamlInput);
    yamlTextarea.addEventListener('input', onYamlInput);
  }
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

  let parsedWidget = null;
  try {
    parsedWidget = jsyaml.load(yamlTextarea.value);
    if (!parsedWidget || typeof parsedWidget !== 'object') {
      throw new Error("YAML must represent a valid Lovelace card object structure.");
    }
    // Auto-preserve or assign id and tab so user is not penalized if omitted
    if (!parsedWidget.id) {
      parsedWidget.id = id;
    }
    if (!parsedWidget.tab) {
      parsedWidget.tab = widgets[widgetIdx].tab || activeTab;
    }
    if (!parsedWidget.type) {
      parsedWidget.type = widgets[widgetIdx].type || 'sensor';
    }
    // Normalize name/title
    if (!parsedWidget.title && parsedWidget.name) {
      parsedWidget.title = parsedWidget.name;
    }
    // Normalize entities
    if (parsedWidget.entity && (!parsedWidget.entities || parsedWidget.entities.length === 0)) {
      const norm = normalizeEntityRef(parsedWidget.entity);
      if (norm) parsedWidget.entities = [norm];
    } else if (Array.isArray(parsedWidget.entities)) {
      parsedWidget.entities = parsedWidget.entities.map(normalizeEntityRef).filter(Boolean);
    }
    if (!parsedWidget.options) parsedWidget.options = {};
  } catch (e) {
    console.warn("Card YAML editor parse warning, saving as error widget: ", e);
    // Parse tab from string via regex, defaulting to activeTab
    const tabMatch = yamlTextarea.value.match(/tab:\s*['"]?([a-zA-Z0-9_\-]+)['"]?/);
    const tab = tabMatch ? tabMatch[1] : (widgets[widgetIdx].tab || activeTab);

    // Construct error config object fallback
    parsedWidget = {
      id: id,
      type: "error",
      tab: tab,
      title: "Misconfigured Card",
      options: {
        gridWidth: 1,
        gridHeight: 1,
        yaml_error_config: yamlTextarea.value,
        error_message: e.message
      }
    };
  }

  widgets[widgetIdx] = parsedWidget;
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  // Sync updated layout to backend database
  syncLocalConfigToServer().catch(err => console.error("Failed to sync card to server:", err));

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
  const tabUi = document.getElementById('editor-tab-ui');
  const tabYaml = document.getElementById('editor-tab-yaml');
  const menuLink = document.getElementById('menu-toggle-editor-mode');

  if (yamlError) yamlError.style.display = 'none';

  if (tabUi) tabUi.classList.toggle('active', mode === 'ui');
  if (tabYaml) tabYaml.classList.toggle('active', mode === 'yaml');

  if (menuLink) {
    menuLink.textContent = (mode === 'ui') ? 'Edit in YAML' : 'Edit in visual editor';
  }

  if (mode === 'ui') {
    if (uiFields) uiFields.style.display = 'flex';
    if (yamlContainer) yamlContainer.style.display = 'none';

    // Sync structural form fields values from YAML draft code parameters
    syncYAMLToFormFields();
    updateEditorVisualPreview();
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

  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (widget.type === 'error' && widget.options && widget.options.yaml_error_config) {
    if (yamlTextarea) yamlTextarea.value = widget.options.yaml_error_config;
    return;
  }

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

function updateYamlPreview(yamlStr) {
  const errBanner = document.getElementById('edit-widget-yaml-error');
  const linterStatus = document.getElementById('yaml-linter-status');
  if (!linterStatus) return;

  try {
    const parsed = jsyaml.load(yamlStr);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error("YAML must represent a valid Lovelace card object structure.");
    }
    if (!parsed.type) {
      throw new Error("Card configuration is missing a 'type' field.");
    }

    if (errBanner) errBanner.style.display = 'none';
    linterStatus.style.color = '#10b981';
    linterStatus.innerHTML = `
      <i data-lucide="check-circle" style="width: 14px; height: 14px; color: #10b981;"></i>
      <span>YAML Format Valid</span>
    `;
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    linterStatus.style.color = '#ef4444';
    linterStatus.innerHTML = `
      <i data-lucide="alert-triangle" style="width: 14px; height: 14px; color: #ef4444;"></i>
      <span>YAML Format Error</span>
    `;
    if (window.lucide) window.lucide.createIcons();

    if (errBanner) {
      errBanner.textContent = "Live Parse Warning: " + e.message;
      errBanner.style.display = 'block';
    }
  }
}

function renderMockCardHTML(widget) {
  const title = widget.title || "Untitled Card";
  const type = widget.type || "sensor";
  const unit = (widget.options && widget.options.unit) || "";
  const color = (widget.options && widget.options.color) || "var(--color-optimal)";

  if (type === 'title') {
    return `
      <div class="card card-title-type" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:10px 14px; display:flex; align-items:center; min-height:48px;">
        <span style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">${title}</span>
      </div>
    `;
  }

  let body = '';
  if (type === 'gauge') {
    body = `
      <div class="card-body" style="display:flex; flex-direction:column; align-items:center; justify-content:center; flex:1;">
        <div style="width:70px; height:35px; background:rgba(255,255,255,0.05); border-radius:35px 35px 0 0; position:relative; overflow:hidden; border:1px solid var(--border-soft);">
          <div style="position:absolute; bottom:0; left:0; width:100%; height:100%; background:${color}; transform:rotate(45deg); transform-origin:bottom center;"></div>
        </div>
        <div style="font-size:0.8rem; font-weight:bold; margin-top:6px;">50<span style="font-size:0.55rem;"> ${unit}</span></div>
      </div>
    `;
  } else if (type === 'control') {
    body = `
      <div class="card-body" style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-size:0.8rem; font-weight:bold; margin-bottom:4px;">ON</div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.6rem; color:var(--text-secondary);">Active State</span>
          <label class="switch" style="scale:0.7; pointer-events:none;"><input type="checkbox" checked><span class="slider"></span></label>
        </div>
      </div>
    `;
  } else if (type === 'value') {
    body = `
      <div class="card-body" style="flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-size:0.9rem; font-weight:bold;">84.2<span style="font-size:0.6rem;"> ${unit}</span></div>
        <div style="height:3px; background:${color}; margin-top:8px; border-radius:1px;"></div>
      </div>
    `;
  } else if (type === 'entities') {
    body = `
      <div class="card-body" style="display:flex; flex-direction:column; gap:6px; flex:1; justify-content:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.72rem;">
          <span style="color:var(--text-primary);">Node Status</span>
          <span style="font-weight:600; color:${color};">Optimal</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.72rem;">
          <span style="color:var(--text-primary);">Load Rate</span>
          <span style="font-weight:600;">142${unit ? ' ' + unit : ' req/s'}</span>
        </div>
      </div>
    `;
  } else if (type === 'glance') {
    body = `
      <div class="card-body" style="display:flex; justify-content:space-around; align-items:center; flex:1;">
        <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
          <i data-lucide="cpu" style="width:16px; height:16px; color:${color};"></i>
          <span style="font-size:0.6rem; color:var(--text-secondary);">CPU</span>
          <span style="font-size:0.72rem; font-weight:600;">18%</span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
          <i data-lucide="database" style="width:16px; height:16px; color:${color};"></i>
          <span style="font-size:0.6rem; color:var(--text-secondary);">RAM</span>
          <span style="font-size:0.72rem; font-weight:600;">52%</span>
        </div>
      </div>
    `;
  } else {
    // sensor
    body = `
      <div class="card-body" style="padding-bottom: 0; flex:1; display:flex; flex-direction:column; justify-content:flex-end;">
        <div style="font-size:0.9rem; font-weight:bold; margin-bottom:6px;">32<span style="font-size:0.6rem;"> ${unit}</span></div>
        <div style="height:20px; width:100%; display:flex; align-items:flex-end; gap:2px;">
          <div style="flex:1; height:8px; background:${color}; opacity:0.8; border-radius:1px;"></div>
          <div style="flex:1; height:12px; background:${color}; opacity:0.8; border-radius:1px;"></div>
          <div style="flex:1; height:18px; background:${color}; opacity:0.8; border-radius:1px;"></div>
          <div style="flex:1; height:14px; background:${color}; opacity:0.8; border-radius:1px;"></div>
          <div style="flex:1; height:20px; background:${color}; opacity:0.8; border-radius:1px;"></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="card grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); pointer-events:none; display:flex; flex-direction:column; min-height:95px; box-sizing:border-box; margin:0; width: 100%;">
      <div class="card-header" style="padding:6px 10px; border-bottom:1px solid var(--border-soft); display:flex; justify-content:space-between; align-items:center;">
        <div class="card-title-area" style="display:flex; flex-direction:column;">
          <span class="card-title" style="font-size:0.75rem; font-weight:bold; color:var(--text-primary);">${title}</span>
        </div>
        <span class="status-pill success" style="font-size:0.5rem; padding:1px 4px;">Live</span>
      </div>
      <div style="padding:6px 10px; flex:1; display:flex; flex-direction:column; justify-content:space-between;">
        ${body}
      </div>
    </div>
  `;
}

function updateEditorVisualPreview() {
  const container = document.getElementById('editor-visual-preview-container');
  if (!container) return;
  const widgetId = document.getElementById('edit-widget-id')?.value;
  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }
  const widget = widgets.find(w => w.id === widgetId);
  const type = widget ? widget.type : 'sensor';
  const title = document.getElementById('edit-widget-title')?.value || (widget ? widget.title : 'Widget');
  const unit = document.getElementById('edit-widget-unit')?.value || '';
  const color = document.getElementById('edit-widget-color')?.value || 'var(--color-optimal)';

  container.innerHTML = renderMockCardHTML({
    type,
    title,
    options: { unit, color }
  });
  if (window.lucide) window.lucide.createIcons();
}

function updateCreatorVisualPreview() {
  const container = document.getElementById('creator-visual-preview-container');
  if (!container) return;
  const type = document.getElementById('catalog-card-type')?.value || 'sensor';
  const title = document.getElementById('catalog-widget-title')?.value || (type.charAt(0).toUpperCase() + type.slice(1) + ' Card');
  const unit = document.getElementById('catalog-widget-unit')?.value || '';
  const color = document.getElementById('catalog-widget-color')?.value || 'var(--color-optimal)';

  container.innerHTML = renderMockCardHTML({
    type,
    title,
    options: { unit, color }
  });
  if (window.lucide) window.lucide.createIcons();
}

async function deleteWidgetSettings() {
  const id = document.getElementById('edit-widget-id').value;
  if (!await showConfirm("Are you sure you want to remove this widget card?", "Delete Widget")) return;

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

  renderCatalogBlocks();

  document.getElementById('catalog-widget-title').value = '';
  document.getElementById('catalog-widget-unit').value = '';
  document.getElementById('catalog-widget-width').value = '1';
  document.getElementById('catalog-widget-height').value = '1';
  document.getElementById('creator-scale-min').value = '0';
  document.getElementById('creator-scale-max').value = '100';

  updateCreatorVisualPreview();

  const modal = document.getElementById('widget-catalog-modal');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
  }
}

const catalogTemplates = [
  { value: 'sensor', name: 'Sensor', desc: 'Real-time telemetry sensor with sparkline', icon: 'activity' },
  { value: 'control', name: 'Control', desc: 'Interactive toggle switch or trigger', icon: 'sliders' },
  { value: 'gauge', name: 'Gauge', desc: 'Circular progress & resource gauge', icon: 'compass' },
  { value: 'value', name: 'Value', desc: 'Compact numeric or status badge', icon: 'pocket' },
  { value: 'entities', name: 'Entities', desc: 'Stacked multi-entity list rows', icon: 'list' },
  { value: 'glance', name: 'Glance', desc: 'Side-by-side status glance badges', icon: 'grid' },
  { value: 'title', name: 'Section Title', desc: 'Section header dividing card groups', icon: 'heading' }
];

function renderCatalogBlocks(searchQuery?: string) {
  const gridEl = document.getElementById('catalog-blocks-grid');
  if (!gridEl) return;

  const typeSelect = document.getElementById('catalog-card-type');
  const currentValue = typeSelect ? typeSelect.value : 'sensor';

  let html = '';
  catalogTemplates.forEach(tpl => {
    const isActive = tpl.value === currentValue;
    html += `
      <div class="creator-chip ${isActive ? 'active' : ''}" onclick="selectCatalogBlock('${tpl.value}')" title="${tpl.desc}">
        <i data-lucide="${tpl.icon}"></i>
        <span>${tpl.name}</span>
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
  renderCatalogBlocks();
  updateCreatorVisualPreview();
}

function onCreatorTypeChange(type) {
  const group = document.getElementById('creator-entity-select-group');
  if (!group) return;

  // Toggle scales visibility
  const scaleGroups = document.querySelectorAll('.creator-scale-group');
  scaleGroups.forEach(el => {
    el.style.display = (type === 'gauge' || type === 'sensor') ? 'flex' : 'none';
  });

  if (type === 'health' || type === 'audit' || type === 'title') {
    group.innerHTML = '<span style="color:var(--text-secondary); font-size:0.75rem; font-style: italic;">No entity binding required for this card type.</span>';
    updateCreatorVisualPreview();
    return;
  }

  if (type === 'entities' || type === 'glance') {
    // Generate Checklist checkboxes
    let html = '<label style="font-size: 0.76rem; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">Target Entities</label><div style="max-height: 120px; overflow-y: auto; border: 1px solid var(--border-soft); padding: 8px; border-radius: 6px; display:flex; flex-direction:column; gap:6px; background: var(--bg-secondary);">';
    const entList = Object.values(cachedEntities || {});
    if (entList.length === 0) {
      html += '<span style="font-size:0.75rem; color:var(--text-secondary);">No discovered entities available.</span>';
    } else {
      entList.forEach(entity => {
        html += `
          <label style="display:flex; align-items:center; gap:8px; font-weight: normal; font-size:0.75rem; cursor:pointer;">
            <input type="checkbox" name="creator-entities" value="${entity.node_id}|${entity.entity_key}">
            <span>${entity.name || entity.entity_key} (${entity.node_id}.local)</span>
          </label>
        `;
      });
    }
    html += '</div>';
    group.innerHTML = html;
  } else {
    // Single selector dropdown
    let html = '<label for="creator-select" style="font-size: 0.76rem; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">Target Entity</label><select id="creator-select" class="modal-input">';
    const entList = Object.values(cachedEntities || {});
    if (entList.length === 0) {
      html += '<option value="">No discovered entities available</option>';
    } else {
      entList.forEach(entity => {
        html += `<option value="${entity.node_id}|${entity.entity_key}">${entity.name || entity.entity_key} (${entity.node_id}.local)</option>`;
      });
    }
    html += '</select>';
    group.innerHTML = html;
  }

  updateCreatorVisualPreview();
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
  } else if (type !== 'health' && type !== 'audit' && type !== 'title') {
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

// --- Lovelace YAML Code Editor & Normalization Suite ---

function normalizeEntityRef(ent) {
  if (!ent) return null;
  if (typeof ent === 'object') {
    if (ent.nodeId && ent.entityKey) return { nodeId: String(ent.nodeId), entityKey: String(ent.entityKey) };
    if (ent.entity) {
      const parts = String(ent.entity).split('.');
      return parts.length > 1 ? { nodeId: parts[0], entityKey: parts.slice(1).join('.') } : { nodeId: 'system', entityKey: parts[0] };
    }
    if (ent.id) {
      const parts = String(ent.id).split('.');
      return parts.length > 1 ? { nodeId: parts[0], entityKey: parts.slice(1).join('.') } : { nodeId: 'system', entityKey: parts[0] };
    }
  } else if (typeof ent === 'string') {
    const s = ent.trim();
    if (!s) return null;
    const parts = s.split('.');
    if (parts.length > 1) {
      return { nodeId: parts[0], entityKey: parts.slice(1).join('.') };
    }
    return { nodeId: 'system', entityKey: s };
  }
  return null;
}

function normalizeCardObject(rawCard, defaultTab = 'main', index = 0) {
  if (!rawCard || typeof rawCard !== 'object') return null;

  const id = rawCard.id || ('widget-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5) + '-' + index);
  const type = rawCard.type || 'sensor';
  const tab = rawCard.tab || rawCard.view || defaultTab || 'main';
  const title = rawCard.title !== undefined ? rawCard.title : (rawCard.name !== undefined ? rawCard.name : (rawCard.header || ''));

  // Extract entities
  let entities = [];
  if (Array.isArray(rawCard.entities)) {
    entities = rawCard.entities.map(normalizeEntityRef).filter(Boolean);
  } else if (rawCard.entity) {
    const normalized = normalizeEntityRef(rawCard.entity);
    if (normalized) entities.push(normalized);
  } else if (Array.isArray(rawCard.cards)) {
    rawCard.cards.forEach(c => {
      if (c && c.entity) {
        const normalized = normalizeEntityRef(c.entity);
        if (normalized) entities.push(normalized);
      }
    });
  }

  // Extract options
  const options = { ...(rawCard.options || {}) };
  if (rawCard.unit !== undefined) options.unit = rawCard.unit;
  if (rawCard.unit_of_measurement !== undefined) options.unit = rawCard.unit_of_measurement;
  if (rawCard.color !== undefined) options.color = rawCard.color;
  if (rawCard.gridWidth !== undefined) options.gridWidth = parseInt(rawCard.gridWidth, 10);
  else if (rawCard.width !== undefined) options.gridWidth = parseInt(rawCard.width, 10);
  if (rawCard.gridHeight !== undefined) options.gridHeight = parseInt(rawCard.gridHeight, 10);
  else if (rawCard.height !== undefined) options.gridHeight = parseInt(rawCard.height, 10);
  if (rawCard.min !== undefined) options.min = parseFloat(rawCard.min);
  if (rawCard.max !== undefined) options.max = parseFloat(rawCard.max);
  if (rawCard.icon !== undefined) options.icon = rawCard.icon;
  if (rawCard.severity !== undefined) options.severity = rawCard.severity;

  return {
    id,
    type,
    tab,
    title,
    entities,
    options
  };
}

function normalizeDashboardConfig(input) {
  if (!input) throw new Error("Empty YAML configuration.");

  let dashboards = [];
  let widgets = [];

  // Case A: Input is an Array of cards/widgets directly
  if (Array.isArray(input)) {
    const currentTabs = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
    dashboards = currentTabs.length > 0 ? currentTabs : [{ id: 'main', name: 'Main' }];
    const defaultTab = activeTab || dashboards[0].id;
    widgets = input.map((item, idx) => normalizeCardObject(item, defaultTab, idx)).filter(Boolean);
    return { dashboards, widgets };
  }

  if (typeof input !== 'object') {
    throw new Error("YAML layout content must be a structured configuration object or list of cards.");
  }

  // Case B: Lovelace HA style with `views:`
  if (Array.isArray(input.views)) {
    input.views.forEach((v, vIdx) => {
      const viewId = String(v.path || v.id || ('view_' + (vIdx + 1))).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const viewName = v.title || v.name || ('View ' + (vIdx + 1));
      dashboards.push({ id: viewId, name: viewName });

      if (Array.isArray(v.cards)) {
        v.cards.forEach((card, cIdx) => {
          const w = normalizeCardObject(card, viewId, cIdx);
          if (w) widgets.push(w);
        });
      }
    });
  }

  // Case C: Standard HomePulse style with `dashboards:` or `tabs:`
  const rawDashboards = input.dashboards || input.tabs;
  if (Array.isArray(rawDashboards)) {
    rawDashboards.forEach((d, dIdx) => {
      const dId = String(d.id || d.path || ('view_' + (dIdx + 1))).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const dName = d.name || d.title || ('View ' + (dIdx + 1));
      if (!dashboards.some(existing => existing.id === dId)) {
        dashboards.push({ id: dId, name: dName });
      }
    });
  }

  // If no dashboards found yet, default to existing or main
  if (dashboards.length === 0) {
    const existing = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
    dashboards = existing.length > 0 ? existing : [{ id: 'main', name: 'Main' }];
  }

  // Now extract root widgets/cards if any
  const rawWidgets = input.widgets || input.cards;
  if (Array.isArray(rawWidgets)) {
    const defaultTab = dashboards[0].id;
    rawWidgets.forEach((w, idx) => {
      const cardObj = normalizeCardObject(w, defaultTab, idx);
      if (cardObj) widgets.push(cardObj);
    });
  }

  if (widgets.length === 0 && (!input.widgets && !input.cards && !input.views)) {
    throw new Error("YAML does not contain any cards or widgets ('cards:', 'widgets:', or 'views:').");
  }

  return { dashboards, widgets };
}

function setupYamlTextareaTabKey(textarea) {
  if (!textarea || textarea._tabKeyBound) return;
  textarea._tabKeyBound = true;
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = this.selectionStart;
      const end = this.selectionEnd;
      const val = this.value;

      if (e.shiftKey) {
        // Outdent 2 spaces
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        if (val.substr(lineStart, 2) === '  ') {
          this.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
          this.selectionStart = this.selectionEnd = Math.max(lineStart, start - 2);
        }
      } else {
        // Indent 2 spaces
        this.value = val.substring(0, start) + '  ' + val.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
      this.dispatchEvent(new Event('input'));
    }
  });
}

function updateDashboardYamlValidation(yamlStr) {
  const statusEl = document.getElementById('yaml-config-status');
  const statusText = document.getElementById('yaml-config-status-text');
  const errorBanner = document.getElementById('yaml-error-banner');
  const footerStats = document.getElementById('yaml-footer-stats');

  if (!statusEl) return;

  try {
    if (!yamlStr || !yamlStr.trim()) {
      statusEl.style.background = 'rgba(245, 158, 11, 0.15)';
      statusEl.style.color = '#f59e0b';
      statusEl.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      statusEl.innerHTML = '<i data-lucide="alert-triangle" style="width:13px;height:13px;"></i><span>Empty Config</span>';
      if (errorBanner) errorBanner.style.display = 'none';
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const parsed = jsyaml.load(yamlStr);
    const normalized = normalizeDashboardConfig(parsed);

    const viewsCount = normalized.dashboards.length;
    const cardsCount = normalized.widgets.length;

    statusEl.style.background = 'rgba(16, 185, 129, 0.15)';
    statusEl.style.color = '#10b981';
    statusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    statusEl.innerHTML = `<i data-lucide="check-circle" style="width:13px;height:13px;"></i><span>Valid YAML (${viewsCount} view${viewsCount === 1 ? '' : 's'}, ${cardsCount} card${cardsCount === 1 ? '' : 's'})</span>`;

    if (errorBanner) errorBanner.style.display = 'none';
    if (footerStats) {
      footerStats.textContent = `Parsed: ${viewsCount} views, ${cardsCount} cards. Press Tab to indent (2 spaces).`;
    }
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    statusEl.style.background = 'rgba(244, 63, 94, 0.15)';
    statusEl.style.color = '#f43f5e';
    statusEl.style.borderColor = 'rgba(244, 63, 94, 0.3)';

    let msg = err.message || 'Syntax Error';
    if (err.mark && err.mark.line !== undefined) {
      msg = `Line ${err.mark.line + 1}: ${err.reason || err.message}`;
    }
    statusEl.innerHTML = `<i data-lucide="alert-circle" style="width:13px;height:13px;"></i><span>${escapeHtml(msg.slice(0, 35))}</span>`;

    if (errorBanner) {
      errorBanner.textContent = "YAML Error: " + err.message;
      errorBanner.style.display = 'block';
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

function openYAMLConfigEditor() {
  const errorBanner = document.getElementById('yaml-error-banner');
  if (errorBanner) errorBanner.style.display = 'none';

  // Retrieve current state from localStorage
  const dashboards = JSON.parse(localStorage.getItem('hp_dashboards') || 'null') || [
    { id: 'main', name: 'Main' }
  ];
  const widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || 'null') || [];

  // Generate clean Lovelace-compatible YAML export
  const views = dashboards.map(d => ({
    id: d.id,
    title: d.name || d.title || d.id
  }));

  const cards = widgets.map(w => {
    const card: Record<string, any> = {
      type: w.type || 'sensor',
      title: w.title !== undefined ? w.title : '',
      tab: w.tab || 'main'
    };
    if (w.entities && w.entities.length === 1) {
      card.entity = `${w.entities[0].nodeId}.${w.entities[0].entityKey}`;
    } else if (w.entities && w.entities.length > 1) {
      card.entities = w.entities.map(e => `${e.nodeId}.${e.entityKey}`);
    }
    if (w.options && Object.keys(w.options).length > 0) {
      card.options = w.options;
    }
    return card;
  });

  const exportObj = {
    title: "HomePulse Dashboard",
    views: views,
    cards: cards
  };

  try {
    const yamlContent = jsyaml.dump(exportObj, { indent: 2, noRefs: true, lineWidth: -1 });
    const textarea = document.getElementById('yaml-editor-textarea');
    if (textarea) {
      textarea.value = yamlContent;
      setupYamlTextareaTabKey(textarea);
      updateDashboardYamlValidation(yamlContent);

      textarea.oninput = () => {
        updateDashboardYamlValidation(textarea.value);
      };
    }
    openModal('yaml-config-modal');
  } catch (e) {
    console.error("YAML serialization failed: ", e);
    alert("Error serializing to YAML: " + e.message);
  }
}

async function saveYAMLConfigSettings() {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;

  const yamlText = textarea.value.trim();
  const errorBanner = document.getElementById('yaml-error-banner');

  try {
    if (errorBanner) errorBanner.style.display = 'none';

    if (!yamlText) {
      throw new Error("YAML configuration cannot be empty.");
    }

    const parsed = jsyaml.load(yamlText);
    const normalized = normalizeDashboardConfig(parsed);

    // Save arrays into localStorage
    localStorage.setItem('hp_dashboards', JSON.stringify(normalized.dashboards));
    localStorage.setItem('hp_dashboard_widgets', JSON.stringify(normalized.widgets));

    // Reset activeTab if deleted
    const tabExists = normalized.dashboards.some(db => db.id === activeTab);
    if (!tabExists && normalized.dashboards.length > 0) {
      activeTab = normalized.dashboards[0].id;
    }

    // Persist to Postgres database via server API
    await syncLocalConfigToServer();

    // Refresh UI
    closeModal('yaml-config-modal');
    renderDashboards();
    buildDashboardCards(cachedEntities);

    showToast?.("Dashboard YAML configuration applied and saved.");
    addAuditEntry('success', "Dashboard configuration updated and validated via YAML settings editor.");

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

window.formatDashboardYAML = function () {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;
  try {
    const parsed = jsyaml.load(textarea.value);
    const normalized = normalizeDashboardConfig(parsed);

    const views = normalized.dashboards.map(d => ({
      id: d.id,
      title: d.name || d.title || d.id
    }));

    const cards = normalized.widgets.map(w => {
      const card: Record<string, any> = {
        type: w.type || 'sensor',
        title: w.title !== undefined ? w.title : '',
        tab: w.tab || 'main'
      };
      if (w.entities && w.entities.length === 1) {
        card.entity = `${w.entities[0].nodeId}.${w.entities[0].entityKey}`;
      } else if (w.entities && w.entities.length > 1) {
        card.entities = w.entities.map(e => `${e.nodeId}.${e.entityKey}`);
      }
      if (w.options && Object.keys(w.options).length > 0) {
        card.options = w.options;
      }
      return card;
    });

    const exportObj = {
      title: "HomePulse Dashboard",
      views: views,
      cards: cards
    };

    textarea.value = jsyaml.dump(exportObj, { indent: 2, noRefs: true, lineWidth: -1 });
    updateDashboardYamlValidation(textarea.value);
    showToast?.("YAML formatted cleanly.");
  } catch (err) {
    alert("Cannot format invalid YAML: " + err.message);
  }
};

window.copyDashboardYAML = function () {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;
  navigator.clipboard.writeText(textarea.value).then(() => {
    const copyText = document.getElementById('copy-yaml-text');
    if (copyText) {
      copyText.textContent = "Copied!";
      setTimeout(() => { if (copyText) copyText.textContent = "Copy"; }, 2000);
    }
    showToast?.("Dashboard YAML copied to clipboard.");
  }).catch(() => {
    textarea.select();
    document.execCommand('copy');
    showToast?.("Copied to clipboard.");
  });
};

window.downloadDashboardYAML = function () {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;
  const blob = new Blob([textarea.value], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `homepulse-dashboard-${new Date().toISOString().slice(0, 10)}.yaml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast?.("Dashboard YAML exported.");
};

window.importDashboardYAMLFile = function (event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const content = e.target.result;
    const textarea = document.getElementById('yaml-editor-textarea');
    if (textarea) {
      textarea.value = content;
      updateDashboardYamlValidation(content);
      showToast?.(`Loaded '${file.name}'. Click 'Save & Apply' to activate.`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
};

window.insertYamlSnippet = function (type) {
  if (!type) return;
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;

  const currentTab = activeTab || 'main';
  let snippet = '';

  switch (type) {
    case 'sensor':
      snippet = `\n  - type: sensor\n    title: "New Sensor"\n    tab: "${currentTab}"\n    entity: "system.cpu_usage"\n    options:\n      unit: "%"\n      color: "var(--color-optimal)"\n      gridWidth: 1\n      gridHeight: 1\n`;
      break;
    case 'gauge':
      snippet = `\n  - type: gauge\n    title: "Resource Gauge"\n    tab: "${currentTab}"\n    entity: "system.memory_usage"\n    options:\n      min: 0\n      max: 100\n      unit: "%"\n      color: "var(--accent-orange)"\n      gridWidth: 1\n      gridHeight: 1\n`;
      break;
    case 'control':
      snippet = `\n  - type: control\n    title: "Toggle Control"\n    tab: "${currentTab}"\n    entity: "plugins.service_switch"\n    options:\n      color: "var(--accent-blue)"\n      gridWidth: 1\n      gridHeight: 1\n`;
      break;
    case 'entities':
      snippet = `\n  - type: entities\n    title: "System Overview"\n    tab: "${currentTab}"\n    entities:\n      - system.cpu_usage\n      - system.memory_usage\n      - system.disk_usage\n    options:\n      gridWidth: 2\n      gridHeight: 2\n`;
      break;
    case 'glance':
      snippet = `\n  - type: glance\n    title: "Quick Glance"\n    tab: "${currentTab}"\n    entities:\n      - system.cpu_usage\n      - system.temperature\n    options:\n      gridWidth: 2\n      gridHeight: 1\n`;
      break;
  }

  if (snippet) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    textarea.value = val.substring(0, pos) + snippet + val.substring(pos);
    textarea.selectionStart = textarea.selectionEnd = pos + snippet.length;
    textarea.focus();
    updateDashboardYamlValidation(textarea.value);
    showToast?.(`Inserted ${type} card template.`);
  }
};

