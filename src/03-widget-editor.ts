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

  let dashboards: any[] = [];
  try {
    dashboards = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (err) {
    dashboards = [{ id: "main", name: "Main", icon: "layout-dashboard" }];
  }
  if (!Array.isArray(dashboards) || dashboards.length === 0) {
    dashboards = [{ id: "main", name: "Main", icon: "layout-dashboard" }];
  }

  // Ensure activeTab always points to an existing view
  if (!dashboards.some(t => t.id === activeTab)) {
    activeTab = dashboards[0].id;
  }

  const isEditMode = document.getElementById('main-content')?.classList.contains('edit-mode');

  dashboards.forEach((tab, idx) => {
    const iconName = tab.icon || 'layout-dashboard';

    if (isEditMode) {
      const wrap = document.createElement('div');
      wrap.className = `tab-btn-wrap ${tab.id === activeTab ? 'active' : ''}`;

      if (idx > 0) {
        const leftBtn = document.createElement('button');
        leftBtn.type = 'button';
        leftBtn.className = 'tab-mini-btn';
        leftBtn.title = 'Move view left';
        leftBtn.innerHTML = '<i data-lucide="chevron-left"></i>';
        leftBtn.onclick = (e) => { e.stopPropagation(); window.moveDashboardTab(tab.id, -1); };
        wrap.appendChild(leftBtn);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn';
      btn.setAttribute('data-tab', tab.id);
      btn.onclick = () => switchTab(tab.id);
      btn.ondblclick = () => openManageDashboardsModal(tab.id);
      btn.innerHTML = `<i data-lucide="${iconName}"></i><span>${tab.name || tab.id}</span>`;
      btn.title = 'Click to view • Double-click to edit';
      if (tab.id === activeTab) btn.classList.add('active');
      wrap.appendChild(btn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tab-mini-btn';
      editBtn.title = 'Edit or delete view';
      editBtn.innerHTML = '<i data-lucide="pencil"></i>';
      editBtn.onclick = (e) => { e.stopPropagation(); openManageDashboardsModal(tab.id); };
      wrap.appendChild(editBtn);

      if (idx < dashboards.length - 1) {
        const rightBtn = document.createElement('button');
        rightBtn.type = 'button';
        rightBtn.className = 'tab-mini-btn';
        rightBtn.title = 'Move view right';
        rightBtn.innerHTML = '<i data-lucide="chevron-right"></i>';
        rightBtn.onclick = (e) => { e.stopPropagation(); window.moveDashboardTab(tab.id, 1); };
        wrap.appendChild(rightBtn);
      }

      container.appendChild(wrap);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn';
      btn.setAttribute('data-tab', tab.id);
      btn.onclick = () => switchTab(tab.id);
      btn.ondblclick = () => openManageDashboardsModal(tab.id);
      btn.innerHTML = `<i data-lucide="${iconName}"></i><span>${tab.name || tab.id}</span>`;
      btn.title = `View ${tab.name || tab.id}`;
      if (tab.id === activeTab) {
        btn.classList.add('active');
      }
      container.appendChild(btn);
    }
  });

  // Appends Add / Manage Views button
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'add-tab-btn';
  plusBtn.onclick = () => openNewDashboardModal();
  plusBtn.title = "Add or Manage Dashboard Views";
  plusBtn.innerHTML = '<i data-lucide="plus" style="width:13px; height:13px;"></i>';
  container.appendChild(plusBtn);

  if (window.lucide) window.lucide.createIcons();
}

window.moveDashboardTab = function (tabId: string, delta: number) {
  let list: any[] = [];
  try {
    list = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
  } catch (e) { return; }

  const idx = list.findIndex(t => t.id === tabId);
  const newIdx = idx + delta;
  if (idx === -1 || newIdx < 0 || newIdx >= list.length) return;

  const [item] = list.splice(idx, 1);
  list.splice(newIdx, 0, item);
  localStorage.setItem('hp_dashboards', JSON.stringify(list));
  renderDashboards();
};

function switchTab(tabId) {
  activeTab = tabId;
  renderDashboards();
  buildDashboardCards(cachedEntities);
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

let currentEditingEntities: Array<{ nodeId: string; entityKey: string }> = [];

function isMultiEntityCardType(type: string) {
  return type === 'entities' || type === 'glance' || type === 'gauge';
}

function isEntitylessCardType(type: string) {
  return type === 'title' || type === 'health' || type === 'audit';
}

function matchesEntitySearch(item: any, query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const qHyphen = q.replace(/_/g, '-');
  const nodeId = String(item.node_id || '').toLowerCase();
  const entityKey = String(item.entity_key || '').toLowerCase();
  const canon = `${nodeId}.${entityKey}`;
  const canonUnderscore = canon.replace(/-/g, '_');
  const name = String(item.name || '').toLowerCase();
  const nameHyphen = name.replace(/_/g, '-');
  return (
    name.includes(q) ||
    nameHyphen.includes(qHyphen) ||
    canon.includes(q) ||
    canon.includes(qHyphen) ||
    canonUnderscore.includes(q) ||
    entityKey.includes(q) ||
    entityKey.includes(qHyphen) ||
    nodeId.includes(q) ||
    nodeId.includes(qHyphen)
  );
}

function getEditSelectedCardType() {
  const sel = document.getElementById('edit-widget-type');
  return sel ? String(sel.value || 'sensor') : 'sensor';
}

function renderEditEntityList(filterText = '') {
  const listEl = document.getElementById('edit-entity-list');
  const section = document.getElementById('edit-entity-picker-section');
  const labelEl = document.getElementById('edit-entity-picker-label');
  const hint = document.getElementById('edit-entity-picker-hint');
  if (!listEl || !section) return;

  const type = getEditSelectedCardType();
  if (isEntitylessCardType(type)) {
    section.style.display = 'none';
    updateEditorVisualPreview();
    return;
  }

  section.style.display = 'flex';
  const multi = isMultiEntityCardType(type);
  if (labelEl) {
    labelEl.textContent = multi ? 'Target Entities' : 'Target Entity';
  }
  if (hint) {
    hint.textContent = multi
      ? `${currentEditingEntities.length} selected (multi-entity)`
      : (currentEditingEntities.length > 0 ? '1 selected' : 'Select 1 entity');
  }

  const entities = Object.values(cachedEntities || {}).sort((a, b) =>
    String(a.name || a.entity_key).localeCompare(String(b.name || b.entity_key))
  );

  const filtered = entities.filter(item => matchesEntitySearch(item, filterText));

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding:10px; text-align:center; font-size:0.75rem; color:var(--text-secondary);">No matching live entities</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(item => {
    const canon = `${item.node_id}.${item.entity_key}`;
    const isChecked = currentEditingEntities.some(e => e.nodeId === item.node_id && e.entityKey === item.entity_key);
    const valStr = item.value !== undefined && item.value !== null ? `${item.value}${item.unit ? ' ' + item.unit : ''}` : '--';
    return `
      <label class="entity-picker-item ${isChecked ? 'selected' : ''}" onclick="toggleEditEntitySelection('${item.node_id}', '${item.entity_key}')">
        <div class="entity-picker-left">
          <input type="${multi ? 'checkbox' : 'radio'}" name="edit-entity-pick" ${isChecked ? 'checked' : ''} style="pointer-events:none; margin:0;">
          <div style="display:flex; flex-direction:column; min-width:0;">
            <span class="entity-picker-name">${item.name || item.entity_key}</span>
            <span class="entity-picker-id">${canon}</span>
          </div>
        </div>
        <span class="entity-picker-val">${valStr}</span>
      </label>
    `;
  }).join('');
}

window.filterEditEntityList = function (filterText: string) {
  renderEditEntityList(filterText);
};

window.toggleEditEntitySelection = function (nodeId: string, entityKey: string) {
  const type = getEditSelectedCardType();
  const multi = isMultiEntityCardType(type);
  const existingIdx = currentEditingEntities.findIndex(e => e.nodeId === nodeId && e.entityKey === entityKey);

  if (multi) {
    if (existingIdx !== -1) {
      currentEditingEntities.splice(existingIdx, 1);
    } else {
      currentEditingEntities.push({ nodeId, entityKey });
    }
  } else {
    currentEditingEntities = [{ nodeId, entityKey }];
  }

  const searchVal = document.getElementById('edit-entity-search')?.value || '';
  renderEditEntityList(searchVal);
  updateEditorVisualPreview();
};

window.onEditTypeChange = function (newType: string, preserveEntities = false) {
  const scaleGroup = document.querySelector('.edit-scale-group');
  if (scaleGroup) {
    scaleGroup.style.display = (newType === 'gauge' || newType === 'sensor') ? 'flex' : 'none';
  }
  const unitGroup = document.querySelector('.edit-unit-group');
  if (unitGroup) {
    unitGroup.style.display = isEntitylessCardType(newType) ? 'none' : 'flex';
  }

  if (!preserveEntities && !isMultiEntityCardType(newType) && currentEditingEntities.length > 1) {
    currentEditingEntities = [currentEditingEntities[0]];
  }

  const searchVal = document.getElementById('edit-entity-search')?.value || '';
  renderEditEntityList(searchVal);
  updateEditorVisualPreview();
};

function renderCardYamlEntityChips(filterText = '') {
  const container = document.getElementById('card-yaml-entity-chips');
  if (!container) return;

  const entities = Object.values(cachedEntities || {}).sort((a, b) =>
    String(a.name || a.entity_key).localeCompare(String(b.name || b.entity_key))
  );

  const filtered = entities.filter(item => matchesEntitySearch(item, filterText)).slice(0, 24);

  container.innerHTML = filtered.map(item => {
    const canon = `${item.node_id}.${item.entity_key}`;
    return `<button type="button" class="yaml-entity-chip" title="${item.name || canon} — click to insert" onclick="insertCardEntityIntoYaml('${canon}')">${canon}</button>`;
  }).join('') || '<span style="font-size:0.7rem; color:var(--text-secondary);">No matching entities</span>';
}
window.renderCardYamlEntityChips = renderCardYamlEntityChips;

window.insertCardEntityIntoYaml = function (canonId: string) {
  const textarea = document.getElementById('edit-widget-yaml-textarea');
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.substring(0, start) + canonId + textarea.value.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + canonId.length;
  textarea.focus();
  updateYamlPreview(textarea.value);
  if (typeof showToast === 'function') showToast(`Inserted ${canonId}`, 'info');
};

function openCardEditor(widgetId, initialMode = 'ui') {
  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  const widget = widgets.find(w => w.id === widgetId);
  if (!widget) return;

  document.getElementById('edit-widget-id').value = widgetId;
  const typeSelect = document.getElementById('edit-widget-type');
  if (typeSelect) typeSelect.value = widget.type || 'sensor';

  document.getElementById('edit-widget-title').value = widget.title || '';
  document.getElementById('edit-widget-unit').value = (widget.options && widget.options.unit) || '';
  document.getElementById('edit-widget-color').value = (widget.options && widget.options.color) || 'var(--color-optimal)';
  document.getElementById('edit-widget-width').value = (widget.options && widget.options.gridWidth) || 1;
  document.getElementById('edit-widget-height').value = (widget.options && widget.options.gridHeight) || 1;
  document.getElementById('edit-scale-min').value = (widget.options && widget.options.min !== undefined) ? widget.options.min : 0;
  document.getElementById('edit-scale-max').value = (widget.options && widget.options.max !== undefined) ? widget.options.max : 100;

  // Resolve bound entities into canonical objects
  let resolvedEnts: Array<{ nodeId: string; entityKey: string }> = [];
  if (widget.entity) {
    const r = window.resolveSensorIdToEntityRef(widget.entity);
    if (r) resolvedEnts.push(r);
  }
  if (Array.isArray(widget.entities)) {
    widget.entities.forEach((e: any) => {
      const r = window.resolveSensorIdToEntityRef(e);
      if (r && !resolvedEnts.some(x => x.nodeId === r.nodeId && x.entityKey === r.entityKey)) {
        resolvedEnts.push(r);
      }
    });
  }
  currentEditingEntities = resolvedEnts;

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
    tabSelect.value = widget.tab || activeTab;
  }

  const searchInput = document.getElementById('edit-entity-search');
  if (searchInput) searchInput.value = '';
  const yamlSearchInput = document.getElementById('card-yaml-entity-search');
  if (yamlSearchInput) yamlSearchInput.value = '';

  window.onEditTypeChange(widget.type || 'sensor', true);
  renderCardYamlEntityChips('');

  window.openModal('widget-editor-modal');

  // Bind initial tab state to UI
  toggleWidgetEditorMode(initialMode);
  updateEditorVisualPreview();

  // Initialize and bind YAML Live Preview
  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (yamlTextarea) {
    setupYamlTextareaTabKey(yamlTextarea);
    updateYamlPreview(yamlTextarea.value);
    yamlTextarea.oninput = () => {
      updateYamlPreview(yamlTextarea.value);
    };
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

  // Sync UI form editor fields to YAML representation if saving from visual editor
  if (widgetEditorMode === 'ui') {
    syncFormFieldsToYAML();
  }

  const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
  if (!yamlTextarea) return;

  let parsedWidget: any = null;
  try {
    parsedWidget = jsyaml.load(yamlTextarea.value);
    if (!parsedWidget || typeof parsedWidget !== 'object' || Array.isArray(parsedWidget)) {
      throw new Error("Card YAML must be a single card mapping object (type, title, entity/entities, options).");
    }

    const finalType = String(parsedWidget.type || widgets[widgetIdx].type || 'sensor').trim();
    if (!finalType || finalType === 'error') {
      throw new Error("Please specify a valid card 'type' (sensor, gauge, control, value, entities, glance, title).");
    }

    const finalTab = String(parsedWidget.tab || widgets[widgetIdx].tab || activeTab || 'main').trim();
    const finalTitle = parsedWidget.title !== undefined ? parsedWidget.title : (parsedWidget.name !== undefined ? parsedWidget.name : '');

    let normalizedEntities: Array<{ nodeId: string; entityKey: string }> = [];
    if (Array.isArray(parsedWidget.entities)) {
      normalizedEntities = parsedWidget.entities
        .map((e: any) => window.resolveSensorIdToEntityRef(e))
        .filter((e: any) => e && e.nodeId && e.entityKey);
    } else if (parsedWidget.entity) {
      const ref = window.resolveSensorIdToEntityRef(parsedWidget.entity);
      if (ref) normalizedEntities.push(ref);
    }

    const opts = { ...(parsedWidget.options || {}) };
    if (parsedWidget.unit !== undefined) opts.unit = parsedWidget.unit;
    if (parsedWidget.color !== undefined) opts.color = parsedWidget.color;
    if (parsedWidget.min !== undefined) opts.min = parseFloat(parsedWidget.min);
    if (parsedWidget.max !== undefined) opts.max = parseFloat(parsedWidget.max);
    if (parsedWidget.gridWidth !== undefined) opts.gridWidth = parseFloat(parsedWidget.gridWidth);
    if (parsedWidget.gridHeight !== undefined) opts.gridHeight = parseInt(parsedWidget.gridHeight, 10);

    parsedWidget = {
      id: id,
      type: finalType,
      tab: finalTab,
      title: finalTitle,
      entities: normalizedEntities,
      options: opts
    };
  } catch (e: any) {
    // Keep modal open with inline error — never overwrite card with a broken error box!
    if (errorBanner) {
      errorBanner.textContent = "Cannot save invalid Card YAML: " + e.message;
      errorBanner.style.display = 'block';
    }
    if (typeof showToast === 'function') {
      showToast("Fix YAML errors before saving.", "error");
    }
    return;
  }

  widgets[widgetIdx] = parsedWidget;
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  // If user switched the card to a different view, keep them informed or switch cleanly
  if (parsedWidget.tab && parsedWidget.tab !== activeTab) {
    activeTab = parsedWidget.tab;
    renderDashboards();
  }

  if (!window.isInEditModeDraft) {
    syncLocalConfigToServer().catch(err => console.error("Failed to sync card to server:", err));
  }

  window.closeModal('widget-editor-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
  if (typeof showToast === 'function') showToast('Card updated.', 'success');
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
    if (uiFields) uiFields.style.display = 'grid';
    if (yamlContainer) yamlContainer.style.display = 'none';

    syncYAMLToFormFields();
    updateEditorVisualPreview();
  } else {
    if (uiFields) uiFields.style.display = 'none';
    if (yamlContainer) yamlContainer.style.display = 'flex';

    syncFormFieldsToYAML();
    const yamlTextarea = document.getElementById('edit-widget-yaml-textarea');
    if (yamlTextarea) updateYamlPreview(yamlTextarea.value);
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

  const chosenType = getEditSelectedCardType();
  const optionsObj: Record<string, any> = {
    ...(widget.options || {}),
    color: document.getElementById('edit-widget-color').value,
    gridWidth: parseFloat(document.getElementById('edit-widget-width').value) || 1,
    gridHeight: parseInt(document.getElementById('edit-widget-height').value, 10) || 1
  };

  const unitVal = document.getElementById('edit-widget-unit').value;
  if (unitVal !== '') {
    optionsObj.unit = unitVal;
  } else {
    delete optionsObj.unit;
  }

  const minInput = document.getElementById('edit-scale-min');
  const maxInput = document.getElementById('edit-scale-max');
  if (minInput && maxInput && (chosenType === 'gauge' || chosenType === 'sensor')) {
    optionsObj.min = parseFloat(minInput.value);
    optionsObj.max = parseFloat(maxInput.value);
  }

  const draftWidget: Record<string, any> = {
    type: chosenType,
    title: document.getElementById('edit-widget-title').value,
    tab: document.getElementById('edit-widget-tab').value || activeTab || 'main',
  };

  if (!isEntitylessCardType(chosenType)) {
    if (currentEditingEntities.length === 1 && chosenType !== 'entities' && chosenType !== 'glance') {
      draftWidget.entity = `${currentEditingEntities[0].nodeId}.${currentEditingEntities[0].entityKey}`;
    } else if (currentEditingEntities.length > 0) {
      draftWidget.entities = currentEditingEntities.map(e => `${e.nodeId}.${e.entityKey}`);
    } else {
      draftWidget.entities = [];
    }
  }

  draftWidget.options = optionsObj;

  try {
    const yamlVal = jsyaml.dump(draftWidget, { indent: 2, noRefs: true, lineWidth: -1 });
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.type && document.getElementById('edit-widget-type')) {
        document.getElementById('edit-widget-type').value = parsed.type;
      }
      if (parsed.title !== undefined || parsed.name !== undefined) {
        document.getElementById('edit-widget-title').value = parsed.title !== undefined ? parsed.title : parsed.name;
      }
      if (parsed.tab !== undefined) document.getElementById('edit-widget-tab').value = parsed.tab;

      const resolved: Array<{ nodeId: string; entityKey: string }> = [];
      if (Array.isArray(parsed.entities)) {
        parsed.entities.forEach((e: any) => {
          const r = window.resolveSensorIdToEntityRef(e);
          if (r) resolved.push(r);
        });
      } else if (parsed.entity) {
        const r = window.resolveSensorIdToEntityRef(parsed.entity);
        if (r) resolved.push(r);
      }
      currentEditingEntities = resolved;

      const opts = parsed.options || {};
      const unitVal = opts.unit !== undefined ? opts.unit : (parsed.unit !== undefined ? parsed.unit : '');
      document.getElementById('edit-widget-unit').value = unitVal;
      if (opts.color !== undefined || parsed.color !== undefined) {
        document.getElementById('edit-widget-color').value = opts.color || parsed.color;
      }
      if (opts.gridWidth !== undefined) document.getElementById('edit-widget-width').value = opts.gridWidth;
      if (opts.gridHeight !== undefined) document.getElementById('edit-widget-height').value = opts.gridHeight;
      if ((opts.min !== undefined || parsed.min !== undefined) && document.getElementById('edit-scale-min')) {
        document.getElementById('edit-scale-min').value = opts.min !== undefined ? opts.min : parsed.min;
      }
      if ((opts.max !== undefined || parsed.max !== undefined) && document.getElementById('edit-scale-max')) {
        document.getElementById('edit-scale-max').value = opts.max !== undefined ? opts.max : parsed.max;
      }

      window.onEditTypeChange(document.getElementById('edit-widget-type')?.value || 'sensor', true);
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error("YAML must represent a valid Lovelace card mapping object.");
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
  } catch (e: any) {
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

function findLiveEntity(ref: { nodeId: string; entityKey: string }) {
  if (!cachedEntities || !ref) return null;
  return Object.values(cachedEntities).find(e => e.node_id === ref.nodeId && e.entity_key === ref.entityKey) || null;
}

function renderRealPreviewCard(widget: any) {
  const title = widget.title || "Untitled Card";
  const type = widget.type || "sensor";
  const opts = widget.options || {};
  const color = opts.color || "var(--color-optimal)";
  const ents: Array<{ nodeId: string; entityKey: string }> = widget.entities || [];

  if (type === 'title') {
    return `
      <div class="card card-title-type" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:12px 16px; display:flex; align-items:center; min-height:48px;">
        <span style="font-size:1rem; font-weight:700; color:${color};">${title}</span>
      </div>
    `;
  }

  const primaryRef = ents[0];
  const primaryItem = primaryRef ? findLiveEntity(primaryRef) : null;
  const resolvedUnit = opts.unit !== undefined && opts.unit !== '' ? opts.unit : (primaryItem?.unit || '');

  if (type === 'entities') {
    const rows = ents.map(r => {
      const item = findLiveEntity(r);
      const val = item ? `${item.value ?? '--'}${item.unit ? ' ' + item.unit : ''}` : 'Offline';
      return `
        <div class="entity-row" style="padding:6px 10px;">
          <span class="entity-row-name" style="font-size:0.75rem;">${item ? (item.name || item.entity_key) : `${r.nodeId}.${r.entityKey}`}</span>
          <span class="entity-row-state" style="font-size:0.75rem; color:${item ? color : '#ef4444'};">${val}</span>
        </div>
      `;
    }).join('');
    return `
      <div class="card grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:14px; min-height:130px; margin:0; width:100%;">
        <div class="card-header" style="margin-bottom:8px;">
          <div class="card-title-area">
            <span class="card-title" style="font-size:0.9rem;">${title}</span>
            <span class="card-subtitle">Multiple Devices Overview</span>
          </div>
        </div>
        <div class="entities-list" style="gap:6px; padding-top:4px;">
          ${rows || '<div style="font-size:0.75rem; color:var(--text-secondary); text-align:center; padding:8px;">Pick entities on the left</div>'}
        </div>
      </div>
    `;
  }

  if (type === 'glance') {
    const items = ents.map(r => {
      const item = findLiveEntity(r);
      const val = item ? `${item.value ?? '--'}${item.unit ? ' ' + item.unit : ''}` : '--';
      return `
        <div class="glance-item" style="padding:8px 4px;">
          <span class="glance-item-name">${item ? (item.name || item.entity_key) : r.entityKey}</span>
          <i data-lucide="${item?.icon || 'activity'}" style="width:15px; height:15px; color:${color}; margin-bottom:4px;"></i>
          <span class="glance-item-state">${val}</span>
        </div>
      `;
    }).join('');
    return `
      <div class="card grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:14px; min-height:120px; margin:0; width:100%;">
        <div class="card-header" style="margin-bottom:6px;">
          <div class="card-title-area">
            <span class="card-title" style="font-size:0.9rem;">${title}</span>
            <span class="card-subtitle">At a glance metrics</span>
          </div>
        </div>
        <div class="glance-grid" style="padding-top:6px;">
          ${items || '<div style="grid-column:1/-1; font-size:0.75rem; color:var(--text-secondary); text-align:center;">Pick entities on the left</div>'}
        </div>
      </div>
    `;
  }

  if (type === 'gauge') {
    const min = parseFloat(opts.min !== undefined ? opts.min : 0);
    const max = parseFloat(opts.max !== undefined ? opts.max : 100);

    if (ents.length > 1) {
      const tilesHtml = ents.map(r => {
        const item = findLiveEntity(r);
        const tileVal = item ? item.value : '--';
        const tileUnit = opts.unit !== undefined && opts.unit !== '' ? opts.unit : (item?.unit || '');
        const tileSvg = typeof window.renderGaugeSVG === 'function'
          ? window.renderGaugeSVG(tileVal, tileUnit, min, max, color)
          : '';
        return `
          <div class="gauge-multi-tile">
            <span class="gauge-tile-label">${item ? (item.name || item.entity_key) : `${r.nodeId}.${r.entityKey}`}</span>
            ${tileSvg}
          </div>
        `;
      }).join('');
      return `
        <div class="card card-gauge card-gauge-multi grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:14px; min-height:175px; margin:0; width:100%;">
          <div class="card-header">
            <div class="card-title-area">
              <span class="card-title" style="font-size:0.9rem;">${widget.title || 'Gauges Overview'}</span>
              <span class="card-subtitle">${ents.length} gauges • live telemetry</span>
            </div>
          </div>
          <div class="gauge-card-body">
            <div class="gauge-multi-grid">
              ${tilesHtml}
            </div>
          </div>
        </div>
      `;
    }

    const dispVal = primaryItem ? primaryItem.value : 50;
    const svgHtml = typeof window.renderGaugeSVG === 'function'
      ? window.renderGaugeSVG(dispVal, resolvedUnit, min, max, color)
      : '';
    return `
      <div class="card card-gauge grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:14px; min-height:175px; margin:0; width:100%;">
        <div class="card-header">
          <div class="card-title-area">
            <span class="card-title" style="font-size:0.9rem;">${widget.title || primaryItem?.name || 'Gauge Card'}</span>
            <span class="card-subtitle">${primaryRef ? `${primaryRef.nodeId}.local` : 'Unbound'} • Gauge</span>
          </div>
          <span class="status-pill ${primaryItem?.status_type || 'default'}">${primaryItem?.status || (primaryRef ? 'Offline' : 'Unbound')}</span>
        </div>
        <div class="gauge-card-body">
          <div class="gauge-container">
            ${svgHtml}
          </div>
        </div>
      </div>
    `;
  }

  const dispVal = primaryItem ? primaryItem.value : '--';
  const bodyHtml = type === 'control'
    ? `<div style="font-size:1.2rem; font-weight:700;">${primaryItem ? (primaryItem.value ? 'ON' : 'OFF') : 'OFF'}</div>`
    : `<div class="card-value" style="font-size:1.35rem;">${dispVal}<span class="card-unit"> ${resolvedUnit}</span></div>`;

  return `
    <div class="card grid-w-1" style="border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-secondary); padding:14px; min-height:130px; margin:0; width:100%; pointer-events:none;">
      <div class="card-header">
        <div class="card-title-area">
          <span class="card-title" style="font-size:0.9rem;">${widget.title || primaryItem?.name || 'Metric Card'}</span>
          <span class="card-subtitle">${primaryRef ? `${primaryRef.nodeId}.local` : 'Select entity'}</span>
        </div>
        <span class="status-pill ${primaryItem?.status_type || 'default'}">${primaryItem?.status || (primaryRef ? 'Offline' : 'Unbound')}</span>
      </div>
      <div class="card-body" style="padding-top:8px;">
        ${bodyHtml}
        <div style="height:3px; background:${color}; margin-top:10px; border-radius:2px; opacity:0.85;"></div>
      </div>
    </div>
  `;
}

function updateEditorVisualPreview() {
  const container = document.getElementById('editor-visual-preview-container');
  const summaryEl = document.getElementById('editor-bound-entities-summary');
  if (!container) return;
  const widgetId = document.getElementById('edit-widget-id')?.value;
  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }
  const widget = widgets.find(w => w.id === widgetId);
  const type = getEditSelectedCardType() || (widget ? widget.type : 'sensor');
  const title = document.getElementById('edit-widget-title')?.value || (widget ? widget.title : 'Widget');
  const unit = document.getElementById('edit-widget-unit')?.value || '';
  const color = document.getElementById('edit-widget-color')?.value || 'var(--color-optimal)';
  const min = parseFloat(document.getElementById('edit-scale-min')?.value || '0');
  const max = parseFloat(document.getElementById('edit-scale-max')?.value || '100');

  container.innerHTML = renderRealPreviewCard({
    type,
    title,
    entities: currentEditingEntities,
    options: { unit, color, min, max }
  });
  if (summaryEl) {
    if (isEntitylessCardType(type)) {
      summaryEl.textContent = `Card type '${type}' requires no bound entities.`;
    } else if (currentEditingEntities.length === 0) {
      summaryEl.textContent = 'Bound Entities: None selected';
    } else {
      summaryEl.textContent = 'Bound Entity IDs: ' + currentEditingEntities.map(e => `${e.nodeId}.${e.entityKey}`).join(', ');
    }
  }
  if (window.lucide) window.lucide.createIcons();
}

function updateCreatorVisualPreview() {
  const container = document.getElementById('creator-visual-preview-container');
  if (!container) return;
  const type = document.getElementById('catalog-card-type')?.value || 'sensor';
  const title = document.getElementById('catalog-widget-title')?.value || (type.charAt(0).toUpperCase() + type.slice(1) + ' Card');
  const unit = document.getElementById('catalog-widget-unit')?.value || '';
  const color = document.getElementById('catalog-widget-color')?.value || 'var(--color-optimal)';
  const min = parseFloat(document.getElementById('creator-scale-min')?.value || '0');
  const max = parseFloat(document.getElementById('creator-scale-max')?.value || '100');

  container.innerHTML = renderRealPreviewCard({
    type,
    title,
    entities: currentCreatorEntities,
    options: { unit, color, min, max }
  });
  if (window.lucide) window.lucide.createIcons();
}

window.cycleWidgetWidth = function (widgetId: string) {
  let widgets: any[] = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { return; }

  const widget = widgets.find(w => w.id === widgetId);
  if (!widget) return;
  if (!widget.options) widget.options = {};
  const steps = [0.5, 1, 2, 3];
  const curW = parseFloat(widget.options.gridWidth) || 1;
  const idx = steps.indexOf(curW);
  const nextW = steps[(idx === -1 ? 2 : idx + 1) % steps.length];
  widget.options.gridWidth = nextW;

  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
  if (typeof showToast === 'function') showToast(`Card width: ${nextW}x`, 'info');
};

window.duplicateWidget = function (widgetId: string) {
  let widgets: any[] = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { return; }

  const idx = widgets.findIndex(w => w.id === widgetId);
  if (idx === -1) return;

  const clone = JSON.parse(JSON.stringify(widgets[idx]));
  clone.id = 'widget_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
  clone.title = clone.title ? `${clone.title} (Copy)` : 'Copy';

  widgets.splice(idx + 1, 0, clone);
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  try {
    const order = JSON.parse(localStorage.getItem('hp_widget_order') || '[]');
    const orderIdx = order.indexOf(`card-${widgetId}`);
    if (orderIdx !== -1) {
      order.splice(orderIdx + 1, 0, `card-${clone.id}`);
      localStorage.setItem('hp_widget_order', JSON.stringify(order));
    }
  } catch (e) { }

  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
  if (typeof showToast === 'function') showToast('Card duplicated.', 'info');
};

window.duplicateEditingWidget = function () {
  const id = document.getElementById('edit-widget-id')?.value;
  if (!id) return;
  window.closeModal('widget-editor-modal');
  window.duplicateWidget(id);
};

window.quickDeleteWidget = async function (widgetId: string) {
  if (!window.isInEditModeDraft && typeof showConfirm === 'function') {
    const ok = await showConfirm('Remove this card from the dashboard?', 'Remove Card');
    if (!ok) return;
  }

  let widgets: any[] = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  widgets = widgets.filter(w => w.id !== widgetId);
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  try {
    const order = JSON.parse(localStorage.getItem('hp_widget_order') || '[]').filter((cId: string) => cId !== `card-${widgetId}`);
    localStorage.setItem('hp_widget_order', JSON.stringify(order));
  } catch (e) { }

  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }
  if (typeof showToast === 'function') {
    showToast(window.isInEditModeDraft ? 'Card removed (Discard to undo).' : 'Card removed.', 'info');
  }
};

async function deleteWidgetSettings() {
  const id = document.getElementById('edit-widget-id').value;
  if (!await showConfirm("Are you sure you want to remove this widget card?", "Delete Widget")) return;

  let widgets = [];
  try {
    widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || '[]');
  } catch (e) { }

  widgets = widgets.filter(w => w.id !== id);
  localStorage.setItem('hp_dashboard_widgets', JSON.stringify(widgets));

  window.closeModal('widget-editor-modal');
  buildDashboardCards(cachedEntities);
  if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
    enableDragAndDrop();
  }

  addAuditEntry('warning', `Widget Card "${id}" deleted from dashboard layout.`);
}

let currentCreatorEntities: Array<{ nodeId: string; entityKey: string }> = [];

function addNewCardPlaceholder() {
  currentCreatorEntities = [];
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

function renderCreatorEntityList(filterText = '') {
  const listEl = document.getElementById('creator-entity-list');
  const hint = document.getElementById('creator-entity-picker-hint');
  const clearBtn = document.getElementById('creator-entity-clear-btn');
  if (!listEl) return;

  const type = document.getElementById('catalog-card-type')?.value || 'sensor';
  const multi = isMultiEntityCardType(type);
  if (hint) {
    hint.textContent = multi
      ? `${currentCreatorEntities.length} selected (multi-entity)`
      : (currentCreatorEntities.length > 0 ? '1 selected' : 'Select 1 entity');
  }
  if (clearBtn) {
    clearBtn.style.display = currentCreatorEntities.length > 0 ? 'inline-flex' : 'none';
  }

  const entities = Object.values(cachedEntities || {}).sort((a, b) =>
    String(a.name || a.entity_key).localeCompare(String(b.name || b.entity_key))
  );
  const filtered = entities.filter(item => matchesEntitySearch(item, filterText));

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding:10px; text-align:center; font-size:0.75rem; color:var(--text-secondary);">No matching live entities</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(item => {
    const canon = `${item.node_id}.${item.entity_key}`;
    const isChecked = currentCreatorEntities.some(e => e.nodeId === item.node_id && e.entityKey === item.entity_key);
    const valStr = item.value !== undefined && item.value !== null ? `${item.value}${item.unit ? ' ' + item.unit : ''}` : '--';
    return `
      <label class="entity-picker-item ${isChecked ? 'selected' : ''}" onclick="toggleCreatorEntitySelection('${item.node_id}', '${item.entity_key}')">
        <div class="entity-picker-left">
          <input type="${multi ? 'checkbox' : 'radio'}" name="creator-entity-pick" ${isChecked ? 'checked' : ''} style="pointer-events:none; margin:0;">
          <div style="display:flex; flex-direction:column; min-width:0;">
            <span class="entity-picker-name">${item.name || item.entity_key}</span>
            <span class="entity-picker-id">${canon}</span>
          </div>
        </div>
        <span class="entity-picker-val">${valStr}</span>
      </label>
    `;
  }).join('');
}

window.filterCreatorEntityList = function (filterText: string) {
  renderCreatorEntityList(filterText);
};

window.toggleCreatorEntitySelection = function (nodeId: string, entityKey: string) {
  const type = document.getElementById('catalog-card-type')?.value || 'sensor';
  const multi = isMultiEntityCardType(type);
  const existingIdx = currentCreatorEntities.findIndex(e => e.nodeId === nodeId && e.entityKey === entityKey);

  if (multi) {
    if (existingIdx !== -1) {
      currentCreatorEntities.splice(existingIdx, 1);
    } else {
      currentCreatorEntities.push({ nodeId, entityKey });
    }
  } else {
    currentCreatorEntities = [{ nodeId, entityKey }];
  }

  const searchVal = document.getElementById('creator-entity-search')?.value || '';
  renderCreatorEntityList(searchVal);
  updateCreatorVisualPreview();
};

window.clearCreatorEntitySelection = function () {
  currentCreatorEntities = [];
  const searchVal = document.getElementById('creator-entity-search')?.value || '';
  renderCreatorEntityList(searchVal);
  updateCreatorVisualPreview();
};

function onCreatorTypeChange(type) {
  const group = document.getElementById('creator-entity-select-group');
  if (!group) return;

  // Toggle scales visibility
  const scaleGroups = document.querySelectorAll('.creator-scale-group');
  scaleGroups.forEach(el => {
    el.style.display = (type === 'gauge' || type === 'sensor') ? 'flex' : 'none';
  });

  if (isEntitylessCardType(type)) {
    group.innerHTML = '<span style="color:var(--text-secondary); font-size:0.75rem; font-style: italic;">No entity binding required for this card type.</span>';
    updateCreatorVisualPreview();
    return;
  }

  if (!isMultiEntityCardType(type) && currentCreatorEntities.length > 1) {
    currentCreatorEntities = [currentCreatorEntities[0]];
  }

  const multi = isMultiEntityCardType(type);
  const labelText = multi ? 'Target Entities' : 'Target Entity';
  const prevSearch = document.getElementById('creator-entity-search')?.value || '';

  group.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
      <label for="creator-entity-search" style="font-size: 0.76rem; font-weight: 600; color: var(--text-primary); margin:0;">${labelText}</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <span id="creator-entity-picker-hint" style="font-size:0.68rem; color:var(--text-secondary);"></span>
        <button type="button" id="creator-entity-clear-btn" class="yaml-copy-mini" style="display:none;" onclick="clearCreatorEntitySelection()">Clear</button>
      </div>
    </div>
    <input type="text" id="creator-entity-search" class="modal-input" placeholder="Search by name or entity ID (e.g. core-mon.cpu-utilization)..." value="${prevSearch}" oninput="filterCreatorEntityList(this.value)">
    <div id="creator-entity-list" class="entity-picker-list"></div>
  `;

  renderCreatorEntityList(prevSearch);
  updateCreatorVisualPreview();
}

function addWidgetToGrid() {
  const type = document.getElementById('catalog-card-type').value;
  const title = document.getElementById('catalog-widget-title').value.trim();
  const unit = document.getElementById('catalog-widget-unit').value.trim();
  const w = parseFloat(document.getElementById('catalog-widget-width').value) || 1;
  const h = parseInt(document.getElementById('catalog-widget-height').value, 10) || 1;
  const color = document.getElementById('catalog-widget-color').value;
  const min = parseFloat(document.getElementById('creator-scale-min').value);
  const max = parseFloat(document.getElementById('creator-scale-max').value);

  const entities = isEntitylessCardType(type)
    ? []
    : currentCreatorEntities.map(e => ({ nodeId: e.nodeId, entityKey: e.entityKey }));

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
  if (window.resolveSensorIdToEntityRef) {
    return window.resolveSensorIdToEntityRef(ent);
  }
  if (typeof ent === 'object') {
    if (ent.nodeId && ent.entityKey) return { nodeId: String(ent.nodeId), entityKey: String(ent.entityKey) };
  } else if (typeof ent === 'string') {
    const s = ent.trim();
    if (!s) return null;
    const dotIdx = s.indexOf('.');
    return dotIdx !== -1
      ? { nodeId: s.slice(0, dotIdx), entityKey: s.slice(dotIdx + 1) }
      : { nodeId: 'core-mon', entityKey: s };
  }
  return null;
}

function normalizeCardObject(rawCard, defaultTab = 'main', index = 0) {
  if (!rawCard || typeof rawCard !== 'object') return null;

  const id = rawCard.id || ('widget-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5) + '-' + index);
  const type = rawCard.type || 'sensor';
  const tab = String(rawCard.tab || rawCard.view || defaultTab || 'main');
  const title = rawCard.title !== undefined ? rawCard.title : (rawCard.name !== undefined ? rawCard.name : (rawCard.header || ''));

  // Extract entities
  let entities: Array<{ nodeId: string; entityKey: string }> = [];
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
  const options: Record<string, any> = { ...(rawCard.options || {}) };
  if (rawCard.unit !== undefined) options.unit = rawCard.unit;
  if (rawCard.unit_of_measurement !== undefined) options.unit = rawCard.unit_of_measurement;
  if (rawCard.color !== undefined) options.color = rawCard.color;
  if (rawCard.gridWidth !== undefined) options.gridWidth = parseFloat(rawCard.gridWidth);
  else if (rawCard.width !== undefined) options.gridWidth = parseFloat(rawCard.width);
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

  let dashboards: Array<{ id: string; name: string; icon: string }> = [];
  let widgets: any[] = [];

  // Case A: Input is an Array of cards/widgets directly
  if (Array.isArray(input)) {
    const currentTabs = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
    dashboards = currentTabs.length > 0 ? currentTabs : [{ id: 'main', name: 'Main', icon: 'layout-dashboard' }];
    const defaultTab = activeTab || dashboards[0].id;
    widgets = input.map((item, idx) => normalizeCardObject(item, defaultTab, idx)).filter(Boolean);
    return { dashboards, widgets, order: widgets.map(w => `card-${w.id}`), remappedCount: 0 };
  }

  if (typeof input !== 'object') {
    throw new Error("YAML layout content must be a structured configuration object or list of cards.");
  }

  // Case B: Lovelace style with `views:` (supports nested `cards:` inside each view)
  if (Array.isArray(input.views)) {
    input.views.forEach((v, vIdx) => {
      if (!v || typeof v !== 'object') return;
      const viewId = String(v.id || v.path || ('view_' + (vIdx + 1))).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const viewName = String(v.title || v.name || ('View ' + (vIdx + 1)));
      const viewIcon = String(v.icon || 'layout-dashboard');
      if (!dashboards.some(existing => existing.id === viewId)) {
        dashboards.push({ id: viewId, name: viewName, icon: viewIcon });
      }

      if (Array.isArray(v.cards)) {
        v.cards.forEach((card, cIdx) => {
          const w = normalizeCardObject(card, viewId, widgets.length + cIdx);
          if (w) widgets.push(w);
        });
      }
    });
  }

  // Case C: Flat HomePulse style with `dashboards:` or `tabs:`
  const rawDashboards = input.dashboards || input.tabs;
  if (Array.isArray(rawDashboards)) {
    rawDashboards.forEach((d, dIdx) => {
      if (!d || typeof d !== 'object') return;
      const dId = String(d.id || d.path || ('view_' + (dIdx + 1))).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const dName = String(d.name || d.title || ('View ' + (dIdx + 1)));
      const dIcon = String(d.icon || 'layout-dashboard');
      if (!dashboards.some(existing => existing.id === dId)) {
        dashboards.push({ id: dId, name: dName, icon: dIcon });
      }
      if (Array.isArray(d.cards)) {
        d.cards.forEach((card, cIdx) => {
          const w = normalizeCardObject(card, dId, widgets.length + cIdx);
          if (w) widgets.push(w);
        });
      }
    });
  }

  if (dashboards.length === 0) {
    const existing = JSON.parse(localStorage.getItem('hp_dashboards') || '[]');
    dashboards = existing.length > 0 ? existing : [{ id: 'main', name: 'Main', icon: 'layout-dashboard' }];
  }

  // Root-level `widgets:` or `cards:` (flat format compatibility)
  const rawWidgets = input.widgets || input.cards;
  if (Array.isArray(rawWidgets)) {
    const defaultTab = dashboards[0].id;
    rawWidgets.forEach((w, idx) => {
      const cardObj = normalizeCardObject(w, defaultTab, widgets.length + idx);
      if (cardObj) widgets.push(cardObj);
    });
  }

  if (widgets.length === 0 && (!input.widgets && !input.cards && !input.views && !input.dashboards && !input.tabs)) {
    throw new Error("YAML does not contain any views or cards ('views:', 'cards:', or 'widgets:').");
  }

  // Remap orphaned card.tab references to first valid view so cards are never lost
  const validTabIds = new Set(dashboards.map(d => d.id));
  let remappedCount = 0;
  widgets.forEach(w => {
    if (!validTabIds.has(w.tab)) {
      w.tab = dashboards[0].id;
      remappedCount++;
    }
  });

  const order = widgets.map(w => `card-${w.id}`);
  return { dashboards, widgets, order, remappedCount };
}

function formatCardForYamlExport(w: any, includeTab = false) {
  const card: Record<string, any> = {
    type: w.type || 'sensor',
    title: w.title !== undefined ? w.title : ''
  };
  if (includeTab) {
    card.tab = w.tab || 'main';
  }

  // Normalize entities into canonical nodeId.entityKey strings
  let rawList: any[] = [];
  if (Array.isArray(w.entities) && w.entities.length > 0) {
    rawList = w.entities;
  } else if (w.entity) {
    rawList = [w.entity];
  }

  const canonStrings = rawList
    .map(e => normalizeEntityRef(e))
    .filter(Boolean)
    .map((ref: any) => `${ref.nodeId}.${ref.entityKey}`);

  if (canonStrings.length === 1 && !isMultiEntityCardType(card.type)) {
    card.entity = canonStrings[0];
  } else if (canonStrings.length > 0) {
    card.entities = canonStrings;
  }

  if (w.options && Object.keys(w.options).length > 0) {
    card.options = w.options;
  }
  return card;
}

function buildCanonicalLovelaceObject(dashboards: any[], widgets: any[], order: string[] = []) {
  const safeDashboards = (dashboards && dashboards.length > 0)
    ? dashboards
    : [{ id: 'main', name: 'Main', icon: 'layout-dashboard' }];

  const sortedWidgets = [...(widgets || [])];
  if (Array.isArray(order) && order.length > 0) {
    sortedWidgets.sort((a, b) => {
      let idxA = order.indexOf(`card-${a.id}`);
      let idxB = order.indexOf(`card-${b.id}`);
      if (idxA === -1) idxA = order.indexOf(a.id);
      if (idxB === -1) idxB = order.indexOf(b.id);
      if (idxA === -1) idxA = 9999;
      if (idxB === -1) idxB = 9999;
      return idxA - idxB;
    });
  }

  const viewsMap: Record<string, any> = {};
  const views = safeDashboards.map(d => {
    const viewObj = {
      id: d.id,
      title: d.name || d.title || d.id,
      icon: d.icon || 'layout-dashboard',
      cards: [] as any[]
    };
    viewsMap[d.id] = viewObj;
    return viewObj;
  });

  sortedWidgets.forEach(w => {
    const targetView = viewsMap[w.tab] || views[0];
    if (targetView) {
      targetView.cards.push(formatCardForYamlExport(w, false));
    }
  });

  return {
    title: "HomePulse Dashboard",
    views
  };
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
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        if (val.substr(lineStart, 2) === '  ') {
          this.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
          this.selectionStart = this.selectionEnd = Math.max(lineStart, start - 2);
        }
      } else {
        this.value = val.substring(0, start) + '  ' + val.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
      this.dispatchEvent(new Event('input'));
    }
  });
}

function updateDashboardYamlValidation(yamlStr) {
  const statusEl = document.getElementById('yaml-config-status');
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
    const remapNote = normalized.remappedCount > 0 ? ` (${normalized.remappedCount} auto-assigned)` : '';

    statusEl.style.background = 'rgba(16, 185, 129, 0.15)';
    statusEl.style.color = '#10b981';
    statusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    statusEl.innerHTML = `<i data-lucide="check-circle" style="width:13px;height:13px;"></i><span>Valid YAML (${viewsCount} view${viewsCount === 1 ? '' : 's'}, ${cardsCount} card${cardsCount === 1 ? '' : 's'})${remapNote}</span>`;

    if (errorBanner) errorBanner.style.display = 'none';
    if (footerStats) {
      footerStats.textContent = `Parsed: ${viewsCount} views, ${cardsCount} cards. Press Tab to indent (2 spaces).`;
    }
    if (window.lucide) window.lucide.createIcons();
  } catch (err: any) {
    statusEl.style.background = 'rgba(244, 63, 94, 0.15)';
    statusEl.style.color = '#f43f5e';
    statusEl.style.borderColor = 'rgba(244, 63, 94, 0.3)';

    let msg = err.message || 'Syntax Error';
    if (err.mark && err.mark.line !== undefined) {
      msg = `Line ${err.mark.line + 1}: ${err.reason || err.message}`;
    }
    statusEl.innerHTML = `<i data-lucide="alert-circle" style="width:13px;height:13px;"></i><span>${escapeHtml(msg.slice(0, 40))}</span>`;

    if (errorBanner) {
      errorBanner.textContent = "YAML Error: " + err.message;
      errorBanner.style.display = 'block';
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

window.toggleYamlEntitySidebar = function () {
  const sidebar = document.getElementById('yaml-entity-sidebar');
  const btn = document.getElementById('btn-toggle-yaml-entities');
  if (!sidebar) return;
  const isHidden = sidebar.style.display === 'none';
  sidebar.style.display = isHidden ? 'flex' : 'none';
  if (btn) btn.classList.toggle('active', isHidden);
};

window.renderYamlEntitySidebar = function (filterText = '') {
  const listEl = document.getElementById('yaml-entity-list');
  if (!listEl) return;

  const entities = Object.values(cachedEntities || {}).sort((a, b) =>
    String(a.name || a.entity_key).localeCompare(String(b.name || b.entity_key))
  );

  const filtered = entities.filter(item => matchesEntitySearch(item, filterText));

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:12px; text-align:center; font-size:0.74rem; color:var(--text-secondary);">No matching live entities</div>';
    return;
  }

  listEl.innerHTML = filtered.map(item => {
    const canon = `${item.node_id}.${item.entity_key}`;
    const val = item.value !== undefined && item.value !== null ? `${item.value}${item.unit ? ' ' + item.unit : ''}` : '--';
    return `
      <div class="yaml-entity-item" onclick="insertEntityIntoYaml('${canon}')" title="Click to insert '${canon}' at cursor">
        <div class="yaml-entity-top">
          <span class="yaml-entity-name">${item.name || item.entity_key}</span>
          <span class="yaml-entity-val">${val}</span>
        </div>
        <div class="yaml-entity-bottom">
          <code>${canon}</code>
          <button type="button" class="yaml-copy-mini" onclick="event.stopPropagation(); navigator.clipboard?.writeText('${canon}'); if(typeof showToast==='function') showToast('Copied ${canon}', 'info')" title="Copy ID">Copy</button>
        </div>
      </div>
    `;
  }).join('');
};

window.insertEntityIntoYaml = function (canonId: string) {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.substring(0, start) + canonId + textarea.value.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + canonId.length;
  textarea.focus();
  updateDashboardYamlValidation(textarea.value);
  if (typeof showToast === 'function') showToast(`Inserted ${canonId}`, 'info');
};

function openYAMLConfigEditor() {
  const errorBanner = document.getElementById('yaml-error-banner');
  if (errorBanner) errorBanner.style.display = 'none';

  const dashboards = JSON.parse(localStorage.getItem('hp_dashboards') || 'null') || [
    { id: 'main', name: 'Main', icon: 'layout-dashboard' }
  ];
  const widgets = JSON.parse(localStorage.getItem('hp_dashboard_widgets') || 'null') || [];
  const order = JSON.parse(localStorage.getItem('hp_widget_order') || 'null') || [];

  const exportObj = buildCanonicalLovelaceObject(dashboards, widgets, order);

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

    const searchInput = document.getElementById('yaml-entity-search');
    if (searchInput) searchInput.value = '';
    window.renderYamlEntitySidebar('');

    window.openModal('yaml-config-modal');
  } catch (e: any) {
    console.error("YAML serialization failed: ", e);
    if (typeof showToast === 'function') showToast("Error serializing to YAML: " + e.message, "error");
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

    // Suppress storage proxy spam, write once, then sync once cleanly
    window.isSyncingFromServer = true;
    localStorage.setItem('hp_dashboards', JSON.stringify(normalized.dashboards));
    localStorage.setItem('hp_dashboard_widgets', JSON.stringify(normalized.widgets));
    localStorage.setItem('hp_widget_order', JSON.stringify(normalized.order));
    window.isSyncingFromServer = false;

    // Reset activeTab if deleted
    const tabExists = normalized.dashboards.some(db => db.id === activeTab);
    if (!tabExists && normalized.dashboards.length > 0) {
      activeTab = normalized.dashboards[0].id;
    }

    // Update editModeSnapshot if user saved explicitly from YAML Studio while in Edit Mode
    if (window.isInEditModeDraft) {
      window.markEditModeDirty?.(false);
    }

    // Persist directly to Postgres database once
    await syncLocalConfigToServer();

    window.closeModal('yaml-config-modal');
    renderDashboards();
    buildDashboardCards(cachedEntities);
    if (document.getElementById('main-content')?.classList.contains('edit-mode')) {
      enableDragAndDrop();
    }

    if (typeof showToast === 'function') showToast("Dashboard YAML configuration applied and saved.", "success");
    addAuditEntry('success', "Dashboard configuration updated and validated via YAML Studio.");

  } catch (e: any) {
    window.isSyncingFromServer = false;
    console.error("YAML parsing error: ", e);
    if (errorBanner) {
      errorBanner.textContent = "Validation Failure: " + e.message;
      errorBanner.style.display = 'block';
    }
    if (typeof showToast === 'function') showToast("YAML validation failed: " + e.message, "error");
  }
}

window.formatDashboardYAML = function () {
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;
  try {
    const parsed = jsyaml.load(textarea.value);
    const normalized = normalizeDashboardConfig(parsed);
    const exportObj = buildCanonicalLovelaceObject(normalized.dashboards, normalized.widgets, normalized.order);

    textarea.value = jsyaml.dump(exportObj, { indent: 2, noRefs: true, lineWidth: -1 });
    updateDashboardYamlValidation(textarea.value);
    if (typeof showToast === 'function') showToast("YAML formatted cleanly.", "success");
  } catch (err: any) {
    if (typeof showToast === 'function') showToast("Cannot format invalid YAML: " + err.message, "error");
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
    if (typeof showToast === 'function') showToast("Dashboard YAML copied to clipboard.", "info");
  }).catch(() => {
    textarea.select();
    document.execCommand('copy');
    if (typeof showToast === 'function') showToast("Copied to clipboard.", "info");
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
  if (typeof showToast === 'function') showToast("Dashboard YAML exported.", "info");
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
      if (typeof showToast === 'function') showToast(`Loaded '${file.name}'. Click 'Save & Apply' to activate.`, "info");
    }
  };
  reader.readAsText(file);
  event.target.value = '';
};

window.insertYamlSnippet = function (type) {
  if (!type) return;
  const textarea = document.getElementById('yaml-editor-textarea');
  if (!textarea) return;

  let snippet = '';
  switch (type) {
    case 'sensor':
      snippet = `\n      - type: sensor\n        title: New Sensor\n        entity: core-mon.cpu-utilization\n        options:\n          unit: '%'\n          color: var(--color-optimal)\n          gridWidth: 1\n          gridHeight: 1\n`;
      break;
    case 'gauge':
      snippet = `\n      - type: gauge\n        title: Resource Gauge\n        entity: core-mon.memory-saturation\n        options:\n          min: 0\n          max: 100\n          unit: '%'\n          color: var(--accent-orange)\n          gridWidth: 1\n          gridHeight: 1\n`;
      break;
    case 'control':
      snippet = `\n      - type: control\n        title: Toggle Control\n        entity: plugins.service-switch\n        options:\n          color: var(--accent-blue)\n          gridWidth: 1\n          gridHeight: 1\n`;
      break;
    case 'entities':
      snippet = `\n      - type: entities\n        title: System Overview\n        entities:\n          - core-mon.cpu-utilization\n          - core-mon.memory-saturation\n          - core-mon.server-room-temp\n        options:\n          gridWidth: 2\n          gridHeight: 1\n`;
      break;
    case 'glance':
      snippet = `\n      - type: glance\n        title: Quick Glance\n        entities:\n          - core-mon.cpu-utilization\n          - core-mon.server-room-temp\n        options:\n          gridWidth: 2\n          gridHeight: 1\n`;
      break;
    case 'title':
      snippet = `\n      - type: title\n        title: Section Header\n        options:\n          color: var(--accent-orange)\n          gridWidth: 3\n          gridHeight: 1\n`;
      break;
    case 'view':
      snippet = `\n  - id: view_${Date.now().toString(36)}\n    title: New View\n    icon: server\n    cards:\n      - type: sensor\n        title: View Metric\n        entity: core-mon.cpu-utilization\n        options:\n          gridWidth: 1\n          gridHeight: 1\n`;
      break;
  }

  if (snippet) {
    const val = textarea.value;
    const pos = textarea.selectionStart ?? val.length;
    textarea.value = val.substring(0, pos) + snippet + val.substring(pos);
    textarea.selectionStart = textarea.selectionEnd = pos + snippet.length;
    textarea.focus();
    updateDashboardYamlValidation(textarea.value);
    if (typeof showToast === 'function') showToast(`Inserted ${type} template.`, "info");
  }
};

