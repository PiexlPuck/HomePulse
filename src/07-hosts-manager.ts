// ============================================================================
// Module: src/07-hosts-manager.ts
// Description: Host Manager Grid/List Views, Host Modals & Telemetry Detail View
// ============================================================================

// ─────────────────────────────────────────
// HOST MANAGER PAGE LOGIC
// ─────────────────────────────────────────

window.hostsViewLayout = localStorage.getItem('hp_hosts_layout') || 'grid';

window.setHostsLayout = function (layout) {
  window.hostsViewLayout = layout;
  localStorage.setItem('hp_hosts_layout', layout);

  const btnGrid = document.getElementById('btn-hosts-grid');
  const btnList = document.getElementById('btn-hosts-list');
  if (btnGrid && btnList) {
    const gridIcon = btnGrid.querySelector('i, svg');
    const listIcon = btnList.querySelector('i, svg');
    if (layout === 'grid') {
      btnGrid.style.background = 'rgba(255, 255, 255, 0.08)';
      if (gridIcon) gridIcon.style.color = '#fff';
      btnList.style.background = 'none';
      if (listIcon) listIcon.style.color = 'var(--text-secondary)';
    } else {
      btnList.style.background = 'rgba(255, 255, 255, 0.08)';
      if (listIcon) listIcon.style.color = '#fff';
      btnGrid.style.background = 'none';
      if (gridIcon) gridIcon.style.color = 'var(--text-secondary)';
    }
  }

  loadHosts();
};

function showHostsView() {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const hostsView = document.getElementById('hosts-view');
  if (hostsView) hostsView.classList.remove('hide');

  const navHosts = document.getElementById('nav-hosts');
  if (navHosts) navHosts.classList.add('active');

  // Set visual toggle active style on load based on cached preference
  const layout = window.hostsViewLayout;
  const btnGrid = document.getElementById('btn-hosts-grid');
  const btnList = document.getElementById('btn-hosts-list');
  if (btnGrid && btnList) {
    const gridIcon = btnGrid.querySelector('i, svg');
    const listIcon = btnList.querySelector('i, svg');
    if (layout === 'grid') {
      btnGrid.style.background = 'rgba(255, 255, 255, 0.08)';
      if (gridIcon) gridIcon.style.color = '#fff';
      btnList.style.background = 'none';
      if (listIcon) listIcon.style.color = 'var(--text-secondary)';
    } else {
      btnList.style.background = 'rgba(255, 255, 255, 0.08)';
      if (listIcon) listIcon.style.color = '#fff';
      btnGrid.style.background = 'none';
      if (gridIcon) gridIcon.style.color = 'var(--text-secondary)';
    }
  }

  window.currentHostsData = null;
  window.currentActivePluginsData = null;
  loadHosts();
}

window.showLayoutView = function () {
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const layoutView = document.getElementById('layout-view');
  if (layoutView) layoutView.classList.remove('hide');

  const navLayout = document.getElementById('nav-layout');
  if (navLayout) navLayout.classList.add('active');

  loadLayoutHierarchy();
};

async function loadLayoutHierarchy() {
  const container = document.getElementById('layout-tree-container');
  if (!container) return;

  const { httpUrl } = getApiUrls();
  container.innerHTML = `
    <div style="text-align:center; padding:32px; color:var(--text-secondary);">
      <i data-lucide="loader" class="spin" style="width:24px; height:24px; margin-bottom:8px;"></i>
      <p>Loading infrastructure hierarchy...</p>
    </div>
  `;

  try {
    const [depsRes, hostsRes, monRes, plugRes] = await Promise.all([
      fetch(`${httpUrl}/api/dependencies`),
      fetch(`${httpUrl}/api/hosts`),
      fetch(`${httpUrl}/api/monitors`),
      fetch(`${httpUrl}/api/plugins/installed`)
    ]);

    const deps = depsRes.ok ? await depsRes.json() : [];
    const hosts = hostsRes.ok ? await hostsRes.json() : [];
    const monitors = monRes.ok ? await monRes.json() : [];
    const plugins = plugRes.ok ? await plugRes.json() : [];

    // Maps for lookups
    const targetMap = {};
    const hostMonitorsMap = {};

    hosts.forEach(h => {
      targetMap[`host-${h.id}`] = { id: h.id, name: h.name, type: 'Host', target: h.target, icon: 'server' };
      hostMonitorsMap[h.id] = [];
    });

    monitors.forEach(m => {
      targetMap[`monitor-${m.id}`] = { id: m.id, name: m.name, type: m.type.toUpperCase(), target: m.target, icon: 'activity', host_id: m.host_id };
      if (m.host_id && hostMonitorsMap[m.host_id]) {
        hostMonitorsMap[m.host_id].push(m);
      }
    });

    plugins.forEach(p => {
      const pTargetInfo = { id: p.id, name: `Plugin: ${p.name}`, type: 'Plugin', target: `v${p.version}`, icon: 'puzzle' };
      targetMap[`plugin-${p.id}-status`] = pTargetInfo;
      targetMap[`plugin-${p.id}`] = pTargetInfo;
    });

    if (deps.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px; color:var(--text-secondary); border: 1px dashed var(--border-soft); border-radius: 8px;">
          <i data-lucide="git-branch" style="width:36px; height:36px; opacity:0.5; margin-bottom:12px; color:var(--accent-blue);"></i>
          <h4 style="font-weight:600; color:var(--text-primary); margin-bottom:4px;">No Dependencies Configured</h4>
          <p style="font-size:0.8rem; max-width:400px; margin:0 auto 16px auto;">
            Link network gateways, hypervisor hosts, and child services to organize your infrastructure into a dependency tree.
          </p>
          <button class="btn btn-primary" onclick="openAddDependencyModal()" style="font-size:0.75rem; padding:8px 16px; display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
            <i data-lucide="plus" style="width:14px; height:14px;"></i> Create First Dependency Link
          </button>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // Group dependencies by parent target key
    const parentGroups = {};
    deps.forEach(dep => {
      if (!parentGroups[dep.parent_target]) {
        parentGroups[dep.parent_target] = [];
      }
      parentGroups[dep.parent_target].push(dep);
    });

    let html = `<div style="display:flex; flex-direction:column; gap:20px;">`;

    Object.keys(parentGroups).forEach(parentKey => {
      const parentObj = targetMap[parentKey] || { name: parentKey, type: 'Node', icon: 'hard-drive' };
      const childDeps = parentGroups[parentKey];

      html += `
        <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-soft); border-radius:10px; padding:16px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
          <!-- Parent Target Header -->
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid var(--border-soft);">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.3); padding:8px; border-radius:8px; display:flex; align-items:center; justify-content:center;">
                <i data-lucide="${parentObj.icon}" style="width:20px; height:20px; color:#60a5fa;"></i>
              </div>
              <div>
                <div style="font-weight:700; font-size:0.95rem; color:#fff;">${parentObj.name}</div>
                <div style="font-size:0.72rem; color:var(--accent-blue); font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Parent Node (${parentObj.type})</div>
              </div>
            </div>
            <span style="font-size:0.7rem; background:rgba(59,130,246,0.1); color:var(--accent-blue); padding:3px 8px; border-radius:4px; font-weight:600;">
              ${childDeps.length} Dependent Target${childDeps.length > 1 ? 's' : ''}
            </span>
          </div>

          <!-- Nested Child Nodes Tree -->
          <div style="display:flex; flex-direction:column; gap:10px; padding-left:12px; border-left:2px solid rgba(59,130,246,0.2); margin-left:14px;">
      `;

      childDeps.forEach(dep => {
        const childObj = targetMap[dep.child_target] || { name: dep.child_target, type: 'Node', icon: 'cpu' };
        const isHost = dep.child_target.startsWith('host-');
        const hostId = isHost ? parseInt(dep.child_target.split('-')[1]) : null;
        const probes = hostId && hostMonitorsMap[hostId] ? hostMonitorsMap[hostId] : [];

        html += `
          <div style="background:rgba(0,0,0,0.3); border:1px solid var(--border-soft); border-radius:8px; padding:12px 14px;">
            <div style="display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; align-items:center; gap:10px;">
                <i data-lucide="${childObj.icon}" style="width:16px; height:16px; color:${isHost ? '#34d399' : '#a7f3d0'};"></i>
                <div>
                  <div style="font-weight:600; font-size:0.85rem; color:#f3f4f6;">${childObj.name}</div>
                  <div style="font-size:0.7rem; color:#9ca3af;">${childObj.type} ${childObj.target ? `(${childObj.target})` : ''}</div>
                </div>
              </div>
              <button onclick="deleteDependencyLink(${dep.id})" title="Remove Dependency Link" style="background:none; border:none; color:var(--semantic-red); opacity:0.8; cursor:pointer; padding:6px; border-radius:4px; display:flex; align-items:center;">
                <i data-lucide="trash-2" style="width:15px; height:15px;"></i>
              </button>
            </div>
        `;

        // Render associated probes grouped under host
        if (isHost && probes.length > 0) {
          html += `
            <div style="margin-top:10px; padding-top:8px; border-top:1px dashed var(--border-soft); display:flex; flex-direction:column; gap:6px; padding-left:12px;">
              <div style="font-size:0.68rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; display:flex; align-items:center; gap:4px;">
                <i data-lucide="zap" style="width:12px; height:12px; color:var(--accent-orange);"></i> Grouped Associated Probes (${probes.length})
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:6px;">
          `;
          probes.forEach(p => {
            html += `
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); padding:4px 8px; border-radius:4px; font-size:0.72rem; color:#e5e7eb;">
                <i data-lucide="activity" style="width:12px; height:12px; color:var(--accent-blue);"></i>
                <span>${p.name}</span>
                <span style="font-size:0.65rem; color:var(--text-secondary); text-transform:uppercase;">[${p.type}]</span>
              </div>
            `;
          });
          html += `
              </div>
            </div>
          `;
        }

        html += `</div>`;
      });

      html += `
          </div>
        </div>
      `;
    });

    html += `</div>`;
    container.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();

  } catch (err) {
    console.error("Failed to load layout hierarchy:", err);
    container.innerHTML = `<p style="color:var(--semantic-red); text-align:center; padding:16px;">Error loading infrastructure hierarchy: ${err.message}</p>`;
  }
}

// State for custom dependency dropdowns
window.depModalState = {
  targets: [],
  parent: null,
  child: null
};

window.openAddDependencyModal = async function () {
  const { httpUrl } = getApiUrls();
  
  // Reset state
  window.depModalState.parent = null;
  window.depModalState.child = null;
  
  const parentInput = document.getElementById('dep-modal-parent-select');
  const childInput = document.getElementById('dep-modal-child-select');
  if (parentInput) parentInput.value = '';
  if (childInput) childInput.value = '';
  
  // Reset trigger displays
  const parentDisplay = document.getElementById('dep-parent-selected-display');
  const childDisplay = document.getElementById('dep-child-selected-display');
  if (parentDisplay) {
    parentDisplay.innerHTML = `
      <div style="background:rgba(255,255,255,0.06); border-radius:6px; padding:6px; display:flex; align-items:center; justify-content:center;">
        <i data-lucide="server" style="width:15px; height:15px; color:var(--text-secondary);"></i>
      </div>
      <div style="display:flex; flex-direction:column;">
        <span style="font-size:0.84rem; font-weight:600; color:#94a3b8;">Choose parent node...</span>
        <span style="font-size:0.7rem; color:#64748b;">Hypervisor or Gateway Host</span>
      </div>`;
  }
  if (childDisplay) {
    childDisplay.innerHTML = `
      <div style="background:rgba(255,255,255,0.06); border-radius:6px; padding:6px; display:flex; align-items:center; justify-content:center;">
        <i data-lucide="cpu" style="width:15px; height:15px; color:var(--text-secondary);"></i>
      </div>
      <div style="display:flex; flex-direction:column;">
        <span style="font-size:0.84rem; font-weight:600; color:#94a3b8;">Choose dependent child node...</span>
        <span style="font-size:0.7rem; color:#64748b;">VM or Managed Host</span>
      </div>`;
  }
  
  document.getElementById('dep-parent-trigger')?.classList.remove('active');
  document.getElementById('dep-child-trigger')?.classList.remove('active');
  const livePreview = document.getElementById('dep-topology-live-preview');
  if (livePreview) livePreview.style.display = 'none';
  
  // Close any open popovers
  document.getElementById('dep-parent-dropdown-menu')?.classList.remove('open');
  document.getElementById('dep-child-dropdown-menu')?.classList.remove('open');
  
  openModal('modal-add-dependency');

  const parentList = document.getElementById('dep-parent-items-list');
  const childList = document.getElementById('dep-child-items-list');
  if (parentList) parentList.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:0.78rem;">Loading targets...</div>';
  if (childList) childList.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:0.78rem;">Loading targets...</div>';

  try {
    const [hostsRes, monRes, plugRes] = await Promise.all([
      fetch(`${httpUrl}/api/hosts`),
      fetch(`${httpUrl}/api/monitors`),
      fetch(`${httpUrl}/api/plugins/installed`)
    ]);

    const hosts = hostsRes.ok ? await hostsRes.json() : [];
    const monitors = monRes.ok ? await monRes.json() : [];
    const plugins = plugRes.ok ? await plugRes.json() : [];

    // Filter standalone probes only
    const standaloneProbes = monitors.filter(m => {
      if (m.host_id) return false;
      const baseName = typeof getBaseHostName === 'function' ? getBaseHostName(m.name) : m.name;
      return !hosts.some(h => h.name.toLowerCase().trim() === baseName.toLowerCase().trim());
    });

    // Compile list of available targets
    const availableTargets = [];
    hosts.forEach(h => {
      availableTargets.push({
        id: `host-${h.id}`,
        name: h.name,
        target: h.target,
        type: 'host',
        category: 'Hosts & Hypervisors (Grouped VMs)',
        icon: 'server',
        badge: 'VM / Host'
      });
    });

    plugins.forEach(p => {
      availableTargets.push({
        id: `plugin-${p.id}-status`,
        name: `Plugin: ${p.name}`,
        target: `Local Daemon (v${p.version})`,
        type: 'plugin',
        category: 'Installed Plugins & Hypervisor Integrations',
        icon: 'puzzle',
        badge: 'PLUGIN'
      });
    });

    standaloneProbes.forEach(m => {
      availableTargets.push({
        id: `monitor-${m.id}`,
        name: m.name,
        target: m.target || m.type.toUpperCase(),
        type: 'monitor',
        category: 'Standalone Unbound Probes',
        icon: 'activity',
        badge: m.type.toUpperCase()
      });
    });

    window.depModalState.targets = availableTargets;

    // Render options for parent and child
    renderDepDropdownItems('parent', availableTargets);
    renderDepDropdownItems('child', availableTargets);

  } catch (e) {
    console.error("Failed to populate dependency modal:", e);
    if (parentList) parentList.innerHTML = `<div style="padding:12px; text-align:center; color:var(--semantic-red); font-size:0.78rem;">Failed to load targets: ${e.message}</div>`;
    if (childList) childList.innerHTML = `<div style="padding:12px; text-align:center; color:var(--semantic-red); font-size:0.78rem;">Failed to load targets: ${e.message}</div>`;
  }
};

function renderDepDropdownItems(type, targets, filter = '') {
  const container = document.getElementById(`dep-${type}-items-list`);
  if (!container) return;

  const currentVal = document.getElementById(`dep-modal-${type}-select`)?.value;
  const q = (filter || '').toLowerCase().trim();

  const filtered = (targets || []).filter(t => {
    if (!q) return true;
    return (t.name && t.name.toLowerCase().includes(q)) || 
           (t.target && t.target.toLowerCase().includes(q)) || 
           (t.category && t.category.toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:16px; text-align:center; color:#64748b; font-size:0.75rem;">No matching targets found</div>';
    return;
  }

  // Group by category
  const groups = {};
  filtered.forEach(t => {
    if (!groups[t.category]) groups[t.category] = [];
    groups[t.category].push(t);
  });

  let html = '';
  Object.keys(groups).forEach(cat => {
    html += `
      <div class="custom-dep-group-header">
        <i data-lucide="${cat.includes('Host') ? 'server' : 'radio'}" style="width:12px; height:12px; color:#60a5fa;"></i>
        <span>${cat}</span>
      </div>`;
    
    groups[cat].forEach(t => {
      const isSelected = t.id === currentVal;
      const safeName = (t.name || '').replace(/'/g, "\\'");
      const safeTarget = (t.target || '').replace(/'/g, "\\'");
      
      html += `
        <div class="custom-dep-option ${isSelected ? 'selected' : ''}" onclick="selectCustomDepTarget('${type}', '${t.id}', '${safeName}', '${safeTarget}', '${t.icon}', '${t.badge}')">
          <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
            <div style="background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.25); border-radius:6px; padding:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <i data-lucide="${t.icon}" style="width:15px; height:15px; color:#60a5fa;"></i>
            </div>
            <div style="display:flex; flex-direction:column; overflow:hidden;">
              <span class="target-name" style="text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${t.name}</span>
              <span style="font-size:0.68rem; color:#64748b; font-family:monospace; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${t.target}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
            <span class="target-addr">${t.badge}</span>
            ${isSelected ? '<i data-lucide="check" style="width:14px; height:14px; color:#3b82f6;"></i>' : ''}
          </div>
        </div>`;
    });
  });

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

window.toggleDepDropdown = function (type, event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById(`dep-${type}-dropdown-menu`);
  const chevron = document.getElementById(`dep-${type}-chevron`);
  const trigger = document.getElementById(`dep-${type}-trigger`);
  if (!menu) return;

  const isOpen = menu.classList.contains('open');

  // Close all
  document.querySelectorAll('.custom-dep-popover').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.custom-dep-trigger').forEach(t => t.classList.remove('active'));
  const pChev = document.getElementById('dep-parent-chevron');
  const cChev = document.getElementById('dep-child-chevron');
  if (pChev) pChev.style.transform = 'rotate(0deg)';
  if (cChev) cChev.style.transform = 'rotate(0deg)';

  if (!isOpen) {
    menu.classList.add('open');
    if (trigger) trigger.classList.add('active');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    
    // Focus search input
    const searchInput = menu.querySelector('input');
    if (searchInput) {
      searchInput.value = '';
      setTimeout(() => searchInput.focus(), 50);
      renderDepDropdownItems(type, window.depModalState.targets || []);
    }
  }
};

window.filterDepDropdown = function (type, query) {
  renderDepDropdownItems(type, window.depModalState.targets || [], query);
};

window.selectCustomDepTarget = function (type, id, name, target, icon, badge) {
  const hiddenInput = document.getElementById(`dep-modal-${type}-select`);
  if (hiddenInput) hiddenInput.value = id;

  window.depModalState[type] = { id, name, target, icon, badge };

  const displayEl = document.getElementById(`dep-${type}-selected-display`);
  if (displayEl) {
    displayEl.innerHTML = `
      <div style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.3); border-radius:6px; padding:6px; display:flex; align-items:center; justify-content:center;">
        <i data-lucide="${icon}" style="width:16px; height:16px; color:#60a5fa;"></i>
      </div>
      <div style="display:flex; flex-direction:column; overflow:hidden;">
        <span style="font-size:0.86rem; font-weight:700; color:#fff; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${name}</span>
        <span style="font-size:0.7rem; color:#94a3b8; font-family:monospace;">${target || badge}</span>
      </div>`;
  }

  // Close dropdown
  document.getElementById(`dep-${type}-dropdown-menu`)?.classList.remove('open');
  document.getElementById(`dep-${type}-trigger`)?.classList.remove('active');
  const chev = document.getElementById(`dep-${type}-chevron`);
  if (chev) chev.style.transform = 'rotate(0deg)';

  updateDepLivePreview();
  if (window.lucide) window.lucide.createIcons();
};

function updateDepLivePreview() {
  const previewCard = document.getElementById('dep-topology-live-preview');
  const parentObj = window.depModalState.parent;
  const childObj = window.depModalState.child;

  if (!previewCard) return;

  if (!parentObj || !childObj) {
    previewCard.style.display = 'none';
    return;
  }

  previewCard.style.display = 'flex';

  const previewParent = document.getElementById('preview-parent-text');
  const previewChild = document.getElementById('preview-child-text');
  const previewBadge = document.getElementById('preview-status-badge');
  const previewDesc = document.getElementById('preview-explanation-text');

  if (parentObj.id === childObj.id) {
    if (previewParent) previewParent.innerHTML = `<i data-lucide="server" style="width:14px; height:14px;"></i> ${parentObj.name}`;
    if (previewChild) previewChild.innerHTML = `<i data-lucide="server" style="width:14px; height:14px;"></i> ${childObj.name}`;
    if (previewBadge) {
      previewBadge.textContent = 'Invalid Selection';
      previewBadge.style.color = '#f87171';
      previewBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      previewBadge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
    if (previewDesc) {
      previewDesc.innerHTML = `<span style="color:#f87171;">⚠️ A node cannot be configured as its own parent.</span>`;
    }
  } else {
    if (previewParent) previewParent.innerHTML = `<i data-lucide="server" style="width:14px; height:14px;"></i> ${parentObj.name}`;
    if (previewChild) previewChild.innerHTML = `<i data-lucide="server" style="width:14px; height:14px;"></i> ${childObj.name}`;
    if (previewBadge) {
      previewBadge.textContent = 'Ready to Link';
      previewBadge.style.color = '#4ade80';
      previewBadge.style.background = 'rgba(34, 197, 94, 0.15)';
      previewBadge.style.borderColor = 'rgba(34, 197, 94, 0.3)';
    }
    if (previewDesc) {
      previewDesc.innerHTML = `When <strong>${parentObj.name}</strong> goes offline, alerts for <strong>${childObj.name}</strong> and its child services will be held.`;
    }
  }
}

// Close custom dropdowns when clicking outside
window.addEventListener('click', function (e) {
  if (!e.target.closest('.custom-dep-select-wrapper')) {
    document.querySelectorAll('.custom-dep-popover').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.custom-dep-trigger').forEach(t => t.classList.remove('active'));
    const pChev = document.getElementById('dep-parent-chevron');
    const cChev = document.getElementById('dep-child-chevron');
    if (pChev) pChev.style.transform = 'rotate(0deg)';
    if (cChev) cChev.style.transform = 'rotate(0deg)';
  }
});

window.saveDependencyLinkFromModal = async function () {
  const { httpUrl } = getApiUrls();
  const parentVal = document.getElementById('dep-modal-parent-select')?.value;
  const childVal = document.getElementById('dep-modal-child-select')?.value;

  if (!parentVal || !childVal) {
    alert("Please select both a Parent Target and a Child Target.");
    return;
  }

  if (parentVal === childVal) {
    alert("A target cannot be assigned as its own parent.");
    return;
  }

  try {
    const res = await fetch(`${httpUrl}/api/dependencies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_target: parentVal,
        child_target: childVal
      })
    });

    if (res.ok) {
      closeModal('modal-add-dependency');
      showToast("Infrastructure dependency established", "success");
      loadLayoutHierarchy();
    } else {
      const err = await res.json();
      alert(`Failed to establish dependency: ${err.detail || 'Error'}`);
    }
  } catch (e) {
    alert(`Error creating dependency link: ${e.message}`);
  }
};

window.deleteDependencyLink = async function (depId) {
  if (!await showConfirm("Are you sure you want to remove this dependency link?", "Remove Link")) return;
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/dependencies/${depId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast("Dependency link removed", "success");
      loadLayoutHierarchy();
    } else {
      alert("Failed to remove dependency link.");
    }
  } catch (e) {
    alert(`Error removing dependency link: ${e.message}`);
  }
};

window.currentHostsData = null;
window.currentActivePluginsData = null;

window.filterHostsList = function () {
  loadHosts(false);
};

async function loadHosts(forceFetch = false) {
  const { httpUrl } = getApiUrls();
  const container = document.getElementById('hosts-list-container');
  if (!container) return;

  try {
    if (forceFetch || !window.currentHostsData || !window.currentActivePluginsData) {
      container.innerHTML = `<p style="grid-column: 1/-1; text-align:center; padding:32px; color:var(--text-secondary);">Loading hosts and plugins...</p>`;
      const [hostsRes, pluginsRes, monitorsRes] = await Promise.all([
        fetch(`${httpUrl}/api/hosts`),
        fetch(`${httpUrl}/api/plugins/installed`).catch((e): any => { console.error(e); return { ok: false }; }),
        fetch(`${httpUrl}/api/monitors`).catch((e): any => { console.error(e); return { ok: false }; })
      ]);

      if (!hostsRes.ok) throw new Error(`HTTP ${hostsRes.status}`);
      const rawHosts = await hostsRes.json();
      const seenHostIds = new Set();
      window.currentHostsData = (Array.isArray(rawHosts) ? rawHosts : []).filter(h => {
        if (!h || !h.id) return false;
        if (seenHostIds.has(h.id)) return false;
        seenHostIds.add(h.id);
        return true;
      });
      window.currentHosts = window.currentHostsData; // Keep reference for edit forms

      let plugins = [];
      if (pluginsRes && pluginsRes.ok) {
        plugins = await pluginsRes.json();
      }
      window.currentActivePluginsData = plugins;
      console.log("loadHosts: fetched installed plugins from API. Installed plugins found:", window.currentActivePluginsData.map(p => p.id));

      let monitors = [];
      if (monitorsRes && monitorsRes.ok) {
        monitors = await monitorsRes.json();
      }
      window.currentMonitorsData = monitors;
    }

    console.log("loadHosts: current active plugins in cache:", window.currentActivePluginsData ? window.currentActivePluginsData.map(p => p.id) : null);

    // Read search term
    const searchInput = document.getElementById('host-search');
    const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const filteredHosts = window.currentHostsData.filter(host => {
      const intTgt = (host.target_internal || host.target || '').toLowerCase();
      const extTgt = (host.target_external || '').toLowerCase();
      return host.name.toLowerCase().includes(searchVal) ||
        intTgt.includes(searchVal) || extTgt.includes(searchVal);
    });

    const filteredActivePlugins = window.currentActivePluginsData.filter(p => {
      return p.name.toLowerCase().includes(searchVal) ||
        p.id.toLowerCase().includes(searchVal) ||
        (p.description && p.description.toLowerCase().includes(searchVal));
    });
    console.log("loadHosts: filtered active plugins count:", filteredActivePlugins.length);

    if (filteredHosts.length === 0 && filteredActivePlugins.length === 0) {
      container.innerHTML = `
      <div style="grid-column: 1/-1; text-align:center; padding:48px 24px; border: 1px dashed var(--border-soft); border-radius: 8px;">
        <p style="color:var(--text-secondary); margin-bottom: 16px;">No matching hosts or plugins found.</p>
        <button class="btn btn-primary" onclick="openAddHostModal()" style="font-size:0.75rem; padding: 8px 16px;">+ Add New Host</button>
      </div>`;
      return;
    }

    const layout = window.hostsViewLayout || 'grid';

    // Render hosts HTML
    const hostsHtmlList = filteredHosts.map(host => {
      const activeCheckers = [];
      if (host.ping_enabled) activeCheckers.push('Ping');
      if (host.http_enabled) activeCheckers.push('HTTP');
      if (host.https_enabled) activeCheckers.push('HTTPS');
      if (host.ssl_enabled) activeCheckers.push('SSL');
      if (host.port_enabled) activeCheckers.push(`Port ${host.port_number || ''}`);

      const checkersHtml = activeCheckers.length > 0
        ? activeCheckers.map(c => `<span style="font-size:0.65rem; background:rgba(255,255,255,0.05); color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:3px 8px; font-weight:600; text-transform:uppercase;">${c}</span>`).join(' ')
        : `<span style="font-size:0.65rem; color:var(--text-secondary); font-style:italic;">No active checks</span>`;

      // Smart status evaluation (Internal vs External)
      const hostMonitors = (window.currentMonitorsData || []).filter(m => m.host_id === host.id);
      const internalMonitors = hostMonitors.filter(m => !m.name.includes('[External') && !m.name.includes('(SSL)'));
      const externalMonitors = hostMonitors.filter(m => m.name.includes('[External') || m.name.includes('(SSL)'));

      function isProbeOnline(m) {
        const ent = (cachedEntities && cachedEntities[`monitor-${m.id}-status`]) ? cachedEntities[`monitor-${m.id}-status`].value : m.last_status;
        return isProbeStatusOnline(ent || m.last_status, m.type);
      }

      const internalPass = internalMonitors.filter(isProbeOnline).length;
      const internalTotal = internalMonitors.length;
      const internalUp = internalTotal > 0 ? (internalPass === internalTotal) : null;
      const internalAny = internalTotal > 0 && internalPass > 0;

      const externalPass = externalMonitors.filter(isProbeOnline).length;
      const externalTotal = externalMonitors.length;
      const externalUp = externalTotal > 0 ? (externalPass === externalTotal) : null;
      const externalAny = externalTotal > 0 && externalPass > 0;

      let statusPillHtml = '';
      if (internalTotal > 0 && externalTotal > 0) {
        if (internalUp && externalUp) {
          statusPillHtml = `<span class="status-pill stable" style="font-size:0.6rem; padding:2px 7px; font-weight:700;">🟢 ALL ONLINE</span>`;
        } else if (internalAny && externalAny) {
          statusPillHtml = `<span class="status-pill caution" style="font-size:0.6rem; padding:2px 7px; font-weight:700;" title="${internalPass}/${internalTotal} internal and ${externalPass}/${externalTotal} external probes passing">🟡 DEGRADED</span>`;
        } else if (internalAny && !externalAny) {
          statusPillHtml = `<span class="status-pill caution" style="font-size:0.6rem; padding:2px 7px; font-weight:700;" title="LAN is online, but external domain is failing">🟡 EXTERNAL DOWN</span>`;
        } else if (!internalAny && externalAny) {
          statusPillHtml = `<span class="status-pill caution" style="font-size:0.6rem; padding:2px 7px; font-weight:700;" title="External domain responding, but internal LAN IP is unreachable">🟡 INTERNAL DOWN</span>`;
        } else {
          statusPillHtml = `<span class="status-pill critical" style="font-size:0.6rem; padding:2px 7px; font-weight:700;">🔴 OFFLINE</span>`;
        }
      } else if (internalTotal > 0) {
        if (internalUp) {
          statusPillHtml = `<span class="status-pill stable" style="font-size:0.6rem; padding:2px 7px;">🟢 ONLINE</span>`;
        } else if (internalAny) {
          statusPillHtml = `<span class="status-pill caution" style="font-size:0.6rem; padding:2px 7px; font-weight:700;" title="${internalPass}/${internalTotal} probes passing">🟡 DEGRADED</span>`;
        } else {
          statusPillHtml = `<span class="status-pill critical" style="font-size:0.6rem; padding:2px 7px;">🔴 OFFLINE</span>`;
        }
      } else if (externalTotal > 0) {
        if (externalUp) {
          statusPillHtml = `<span class="status-pill stable" style="font-size:0.6rem; padding:2px 7px;">🟢 ONLINE</span>`;
        } else if (externalAny) {
          statusPillHtml = `<span class="status-pill caution" style="font-size:0.6rem; padding:2px 7px; font-weight:700;" title="${externalPass}/${externalTotal} probes passing">🟡 DEGRADED</span>`;
        } else {
          statusPillHtml = `<span class="status-pill critical" style="font-size:0.6rem; padding:2px 7px;">🔴 OFFLINE</span>`;
        }
      } else {
        statusPillHtml = `<span class="status-pill default" style="font-size:0.6rem; padding:2px 7px;">STANDBY</span>`;
      }

      const internalTarget = host.target_internal || (!host.target_external ? host.target : '') || '';
      const externalTarget = host.target_external || '';

      const outageBannerHtml = (internalAny && !externalAny && externalTotal > 0) ? `
        <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); border-radius:5px; padding:4px 8px; margin-bottom:8px; font-size:0.68rem; color:#fde047; display:flex; align-items:center; gap:6px;">
          <i data-lucide="alert-triangle" style="width:13px; height:13px; color:#fbbf24; flex-shrink:0;"></i>
          <span>External WAN domain unreachable. Internal LAN is operational.</span>
        </div>` : (!internalAny && externalAny && internalTotal > 0) ? `
        <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); border-radius:5px; padding:4px 8px; margin-bottom:8px; font-size:0.68rem; color:#fde047; display:flex; align-items:center; gap:6px;">
          <i data-lucide="alert-triangle" style="width:13px; height:13px; color:#fbbf24; flex-shrink:0;"></i>
          <span>Internal LAN IP unreachable. External proxy is responding.</span>
        </div>` : '';

      const targetsDisplayHtml = `
        <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:10px;">
          ${internalTarget ? `
          <div style="display:flex; align-items:center; gap:6px; font-size:0.75rem; color:#e2e8f0; font-family:monospace;">
            <span style="font-size:0.62rem; background:rgba(59,130,246,0.15); color:var(--accent-blue); padding:1px 5px; border-radius:3px; font-weight:700; font-family:sans-serif; letter-spacing:0.5px;">LAN</span>
            <span>${internalTarget}</span>
          </div>` : ''}
          ${externalTarget ? `
          <div style="display:flex; align-items:center; gap:6px; font-size:0.75rem; color:#94a3b8; font-family:monospace;">
            <span style="font-size:0.62rem; background:rgba(16,185,129,0.15); color:#34d399; padding:1px 5px; border-radius:3px; font-weight:700; font-family:sans-serif; letter-spacing:0.5px;">WAN</span>
            <span>${externalTarget}</span>
          </div>` : ''}
        </div>
      `;

      if (layout === 'grid') {
        return `
        <div class="host-card-item" style="padding: 16px; margin: 0; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; justify-content:space-between; min-height:160px; border-radius:8px; border:1px solid var(--border-soft); cursor:pointer; box-sizing:border-box;" onclick="openHostDetail(${host.id})">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">${host.name}</h4>
              <div style="display:flex; gap:6px; align-items:center;">
                ${statusPillHtml}
                <button class="btn-icon" onclick="event.stopPropagation(); openEditHostModal(${host.id})" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Edit Host">
                  <i data-lucide="edit-3" style="width:14px; height:14px; color:#94a3b8;"></i>
                </button>
                <button class="btn-icon" onclick="event.stopPropagation(); deleteHost(${host.id})" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Delete Host">
                  <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
                </button>
              </div>
            </div>
            ${targetsDisplayHtml}
            ${outageBannerHtml}
          </div>
          <div style="border-top:1px solid var(--border-soft); padding-top:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${checkersHtml}
          </div>
        </div>`;
      } else {
        return `
        <div class="host-card-item" style="padding: 14px 18px; margin: 0; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; border-radius:8px; border:1px solid var(--border-soft); gap:10px; min-height:unset; cursor:pointer; box-sizing:border-box;" onclick="openHostDetail(${host.id})">
          <div style="display:flex; justify-content:space-between; align-items:center; width: 100%; flex-wrap:wrap; gap:10px;">
            <div style="display:flex; flex-direction:column; gap:4px; min-width:200px; flex:1;">
              <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">${host.name}</h4>
              ${targetsDisplayHtml}
              ${outageBannerHtml}
            </div>
            <div style="display:flex; align-items:center; gap:16px;">
              ${statusPillHtml}
              <div style="display:flex; gap:6px; border-left:1px solid var(--border-soft); padding-left:16px;">
                <button class="btn-icon" onclick="event.stopPropagation(); openEditHostModal(${host.id})" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Edit Host">
                  <i data-lucide="edit-3" style="width:14px; height:14px; color:#94a3b8;"></i>
                </button>
                <button class="btn-icon" onclick="event.stopPropagation(); deleteHost(${host.id})" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Delete Host">
                  <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
                </button>
              </div>
            </div>
          </div>
          <div style="border-top:1px solid var(--border-soft); padding-top:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; width: 100%;">
            ${checkersHtml}
          </div>
        </div>`;
      }
    });

    // Render running plugins HTML
    const pluginsHtmlList = filteredActivePlugins.map(p => {
      // Find all entity values published by this plugin
      const entities = Object.values(cachedEntities || {}).filter(item =>
        item.plugin_id === p.id ||
        item.node_id === p.id ||
        item.node_id === `plugin-${p.id}` ||
        (item.node_id === 'plugins' && item.entity_key.includes(p.id))
      );

      const activeCheckers = entities.map(e => e.name || e.entity_key);
      let checkersHtml = '';
      if (activeCheckers.length > 0) {
        const visibleCheckers = activeCheckers.slice(0, 3);
        const remainingCount = activeCheckers.length - visibleCheckers.length;
        checkersHtml = visibleCheckers.map(c => `<span style="font-size:0.65rem; background:rgba(239, 108, 0, 0.15); color:var(--accent-orange); border:1px solid rgba(239, 108, 0, 0.3); border-radius:4px; padding:3px 8px; font-weight:600; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px;" title="${c}">${c}</span>`).join(' ');
        if (remainingCount > 0) {
          checkersHtml += ` <span style="font-size:0.65rem; background:rgba(255,255,255,0.06); color:var(--text-secondary); border:1px solid var(--border-soft); border-radius:4px; padding:3px 8px; font-weight:600;" title="${remainingCount} more entities reported">+${remainingCount} more</span>`;
        }
      } else {
        checkersHtml = `<span style="font-size:0.65rem; color:var(--text-secondary); font-style:italic;">No active entries reported</span>`;
      }

      const pluginHostId = `'plugin-${p.id}'`;
      const entityKeyStatus = `plugin-${p.id}-status`;
      const entityVal = (cachedEntities && cachedEntities[entityKeyStatus]) ? cachedEntities[entityKeyStatus] : null;

      let statusLabel = 'STOPPED';
      let statusClass = 'default';

      const runningStatus = entityVal ? (entityVal.attributes?.status || entityVal.value || 'stopped').toLowerCase() : (p.enabled ? 'running' : 'stopped');

      if (runningStatus === 'running' || runningStatus === 'on') {
        statusLabel = 'RUNNING';
        statusClass = 'stable';
      } else if (runningStatus === 'idle') {
        statusLabel = 'IDLE';
        statusClass = 'caution';
      } else if (runningStatus === 'crashed') {
        statusLabel = 'CRASHED';
        statusClass = 'critical';
      } else {
        statusLabel = 'STOPPED';
        statusClass = 'default';
      }

      const isStopped = (statusLabel === 'STOPPED' || statusLabel === 'CRASHED');
      const opacityStyle = isStopped ? 'opacity: 0.6; filter: grayscale(40%);' : '';

      if (layout === 'grid') {
        return `
          <div class="host-card-item" style="padding: 16px; margin: 0; background:rgba(239, 108, 0, 0.03); display:flex; flex-direction:column; justify-content:space-between; min-height:160px; border-radius:8px; border:1px solid rgba(239, 108, 0, 0.25); cursor:pointer; box-sizing:border-box; ${opacityStyle}" onclick="openHostDetail(${pluginHostId})">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">Plugin: ${p.name}</h4>
                <div style="display:flex; gap:6px; align-items:center;">
                  <span class="status-pill ${statusClass}" style="font-size:0.6rem; padding: 2px 7px; font-weight:700;">${statusLabel}</span>
                  <button class="btn-icon" onclick="event.stopPropagation(); showPluginLogs('${p.id}', '${p.name}')" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="View Logs">
                    <i data-lucide="terminal" style="width:14px; height:14px; color:#94a3b8;"></i>
                  </button>
                  <button class="btn-icon" onclick="event.stopPropagation(); killPlugin('${p.id}')" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Force Kill">
                    <i data-lucide="power" style="width:14px; height:14px; color:#f43f5e;"></i>
                  </button>
                </div>
              </div>
              <p style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px; font-family:monospace;">Local Daemon (v${p.version})</p>
            </div>
            <div style="border-top:1px dashed rgba(239, 108, 0, 0.25); padding-top:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              ${checkersHtml}
            </div>
          </div>`;
      } else {
        return `
          <div class="host-card-item" style="padding: 14px 18px; margin: 0; background:rgba(239, 108, 0, 0.03); display:flex; flex-direction:column; border-radius:8px; border:1px solid rgba(239, 108, 0, 0.25); gap:10px; min-height:unset; cursor:pointer; box-sizing:border-box; ${opacityStyle}" onclick="openHostDetail(${pluginHostId})">
            <div style="display:flex; justify-content:space-between; align-items:center; width: 100%; flex-wrap:wrap; gap:10px;">
              <div style="display:flex; flex-direction:column; gap:4px; min-width:200px; flex:1;">
                <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">Plugin: ${p.name}</h4>
                <p style="font-size:0.75rem; color:var(--text-secondary); margin:0; font-family:monospace;">Local Daemon (v${p.version})</p>
              </div>
              <div style="display:flex; align-items:center; gap:16px;">
                <span class="status-pill ${statusClass}" style="font-size:0.6rem; padding: 2px 7px; font-weight:700;">${statusLabel}</span>
                <div style="display:flex; gap:6px; border-left:1px solid var(--border-soft); padding-left:16px; align-items:center;">
                  <button class="btn-icon" onclick="event.stopPropagation(); showPluginLogs('${p.id}', '${p.name}')" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="View Logs">
                    <i data-lucide="terminal" style="width:14px; height:14px; color:#94a3b8;"></i>
                  </button>
                  <button class="btn-icon" onclick="event.stopPropagation(); killPlugin('${p.id}')" style="padding:4px; opacity:0.8; background:none; border:none; cursor:pointer;" title="Force Kill">
                    <i data-lucide="power" style="width:14px; height:14px; color:#f43f5e;"></i>
                  </button>
                </div>
              </div>
            </div>
            <div style="border-top:1px dashed rgba(239, 108, 0, 0.25); padding-top:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; width: 100%;">
              ${checkersHtml}
            </div>
          </div>`;
      }
    });

    if (layout === 'grid') {
      container.style.cssText = "display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;";
    } else {
      container.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
    }

    container.innerHTML = [...hostsHtmlList, ...pluginsHtmlList].join('');

    if (window.lucide) window.lucide.createIcons();

  } catch (err) {
    container.innerHTML = `<p style="grid-column: 1/-1; text-align:center; padding:32px; color:#f43f5e;">Failed to load hosts: ${err.message}</p>`;
  }
}

window.showHostsView = showHostsView;
window.toggleHostPollingInterval = function (useDefault) {
  const slider = document.getElementById('host-polling-interval');
  const badge = document.getElementById('host-polling-interval-val');
  const desc = document.getElementById('host-polling-interval-desc');
  const defaultVal = (window.currentSettingsData && window.currentSettingsData.telemetry_interval !== undefined)
    ? parseInt(window.currentSettingsData.telemetry_interval)
    : 3;

  if (slider) {
    slider.disabled = useDefault;
    slider.style.opacity = useDefault ? '0.5' : '1';
    if (useDefault) {
      slider.value = defaultVal;
      if (badge) badge.textContent = `${defaultVal}s`;
    }
  }
  if (desc) {
    desc.textContent = useDefault
      ? 'Currently adopting the global baseline telemetry interval configured in Settings.'
      : 'Custom manual stats collection frequency for this specific host device.';
  }
};

window.openAddHostModal = function () {
  const defaultVal = (window.currentSettingsData && window.currentSettingsData.telemetry_interval !== undefined)
    ? parseInt(window.currentSettingsData.telemetry_interval)
    : 3;

  document.getElementById('host-modal-title').textContent = 'Configure New Host';
  document.getElementById('host-modal-id').value = '';
  document.getElementById('host-name').value = '';
  document.getElementById('host-target').value = '';
  const intInput = document.getElementById('host-target-internal');
  if (intInput) intInput.value = '';
  const extInput = document.getElementById('host-target-external');
  if (extInput) extInput.value = '';
  const legInput = document.getElementById('host-target');
  if (legInput) legInput.value = '';

  document.getElementById('host-check-ping').checked = false;
  document.getElementById('host-check-http').checked = false;
  document.getElementById('host-check-https').checked = false;
  document.getElementById('host-check-ssl').checked = false;
  document.getElementById('host-check-port').checked = false;
  document.getElementById('host-port-number').value = '';
  document.getElementById('host-port-number').disabled = true;

  const pingTarget = document.getElementById('host-check-ping-target');
  if (pingTarget) pingTarget.value = 'both';
  const httpTarget = document.getElementById('host-check-http-target');
  if (httpTarget) httpTarget.value = 'both';
  const httpsTarget = document.getElementById('host-check-https-target');
  if (httpsTarget) httpsTarget.value = 'both';
  const sslTarget = document.getElementById('host-check-ssl-target');
  if (sslTarget) sslTarget.value = 'external';
  const portTarget = document.getElementById('host-check-port-target');
  if (portTarget) portTarget.value = 'internal';

  const intervalEl = document.getElementById('host-polling-interval');
  if (intervalEl) {
    intervalEl.value = 3;
    document.getElementById('host-polling-interval-val').textContent = '3s';
  }
  const defaultCheckbox = document.getElementById('host-use-default-interval');
  if (defaultCheckbox) defaultCheckbox.checked = true;

  const defaultLabel = document.getElementById('host-system-default-label');
  if (defaultLabel) defaultLabel.textContent = `${defaultVal}s`;

  toggleHostPollingInterval(true);

  window.openModal('host-modal');
};

window.openEditHostModal = function (hostId) {
  const host = (window.currentHosts || []).find(h => h.id === hostId);
  if (!host) return;

  const defaultVal = (window.currentSettingsData && window.currentSettingsData.telemetry_interval !== undefined)
    ? parseInt(window.currentSettingsData.telemetry_interval)
    : 3;

  document.getElementById('host-modal-title').textContent = 'Modify Host Device';
  document.getElementById('host-modal-id').value = host.id;
  document.getElementById('host-name').value = host.name;
  document.getElementById('host-target').value = host.target || '';
  
  const intTarget = host.target_internal || (!host.target_external ? host.target : '') || '';
  const extTarget = host.target_external || '';
  const intInput = document.getElementById('host-target-internal');
  if (intInput) intInput.value = intTarget;
  const extInput = document.getElementById('host-target-external');
  if (extInput) extInput.value = extTarget;
  const legInput = document.getElementById('host-target');
  if (legInput) legInput.value = intTarget || extTarget;

  document.getElementById('host-check-ping').checked = host.ping_enabled;
  document.getElementById('host-check-http').checked = host.http_enabled;
  document.getElementById('host-check-https').checked = host.https_enabled;
  document.getElementById('host-check-ssl').checked = host.ssl_enabled;
  document.getElementById('host-check-port').checked = host.port_enabled;
  document.getElementById('host-port-number').value = host.port_number || '';
  document.getElementById('host-port-number').disabled = !host.port_enabled;

  const editPingTarget = document.getElementById('host-check-ping-target');
  if (editPingTarget) editPingTarget.value = host.ping_target || 'both';
  const editHttpTarget = document.getElementById('host-check-http-target');
  if (editHttpTarget) editHttpTarget.value = host.http_target || 'both';
  const editHttpsTarget = document.getElementById('host-check-https-target');
  if (editHttpsTarget) editHttpsTarget.value = host.https_target || 'both';
  const editSslTarget = document.getElementById('host-check-ssl-target');
  if (editSslTarget) editSslTarget.value = host.ssl_target || 'external';
  const editPortTarget = document.getElementById('host-check-port-target');
  if (editPortTarget) editPortTarget.value = host.port_target || 'internal';

  const isDefault = (!host.polling_interval || host.polling_interval === defaultVal);
  const defaultCheckbox = document.getElementById('host-use-default-interval');
  if (defaultCheckbox) defaultCheckbox.checked = isDefault;

  const defaultLabel = document.getElementById('host-system-default-label');
  if (defaultLabel) defaultLabel.textContent = `${defaultVal}s`;

  const intervalEl = document.getElementById('host-polling-interval');
  if (intervalEl) {
    intervalEl.value = host.polling_interval || 3;
    document.getElementById('host-polling-interval-val').textContent = (host.polling_interval || 3) + 's';
    intervalEl.value = host.polling_interval || defaultVal;
    document.getElementById('host-polling-interval-val').textContent = (host.polling_interval || defaultVal) + 's';
  }

  toggleHostPollingInterval(isDefault);

  window.openModal('host-modal');
};

window.submitSaveHost = async function () {
  const { httpUrl } = getApiUrls();
  const id = document.getElementById('host-modal-id').value;
  const name = document.getElementById('host-name').value.trim();
  const targetInternal = (document.getElementById('host-target-internal')?.value || '').trim() || null;
  const targetExternal = (document.getElementById('host-target-external')?.value || '').trim() || null;

  if (!name || (!targetInternal && !targetExternal)) {
    alert("Host Name and at least one Target address (Internal or External) are required.");
    return;
  }

  const useDefault = document.getElementById('host-use-default-interval')?.checked ?? false;
  const defaultVal = (window.currentSettingsData && window.currentSettingsData.telemetry_interval !== undefined)
    ? parseInt(window.currentSettingsData.telemetry_interval)
    : 3;
  const pollingInterval = useDefault ? defaultVal : parseInt(document.getElementById('host-polling-interval')?.value || defaultVal);

  const payload = {
    name: name,
    target: targetInternal || targetExternal,
    target_internal: targetInternal,
    target_external: targetExternal,
    use_default_interval: useDefault,
    polling_interval: pollingInterval,
    ping_enabled: document.getElementById('host-check-ping').checked,
    ping_target: document.getElementById('host-check-ping-target')?.value || 'both',
    http_enabled: document.getElementById('host-check-http').checked,
    http_target: document.getElementById('host-check-http-target')?.value || 'both',
    https_enabled: document.getElementById('host-check-https').checked,
    https_target: document.getElementById('host-check-https-target')?.value || 'both',
    ssl_enabled: document.getElementById('host-check-ssl').checked,
    ssl_target: document.getElementById('host-check-ssl-target')?.value || 'external',
    port_enabled: document.getElementById('host-check-port').checked,
    port_target: document.getElementById('host-check-port-target')?.value || 'internal',
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
    window.currentHostsData = null;
    loadHosts(true);
    if (typeof showToast === 'function') {
      showToast(id ? "Host configuration updated" : "New host added successfully", "success");
    }
  } catch (err) {
    alert(`Failed to save host details: ${err.message}`);
  }
};

window.deleteHost = async function (id) {
  if (!await showConfirm("Are you sure you want to delete this host? This will also remove all its monitored check probes.", "Delete Host")) return;

  const { httpUrl } = getApiUrls();
  try {
    const response = await fetch(`${httpUrl}/api/hosts/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    window.currentHostsData = null;
    loadHosts();
  } catch (err) {
    alert(`Failed to delete host: ${err.message}`);
  }
};

window.generateSupportLogs = async function () {
  if (typeof showToast === 'function') showToast("Compiling support logs...", "info");
  try {
    const { httpUrl } = getApiUrls();
    const res = await fetch(`${httpUrl}/api/support/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `homepulse-support-logs-${dateStr}.json`;

    // Download JSON file
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    if (typeof showToast === 'function') showToast("Support logs downloaded successfully!", "success");
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Support log generation failed: ${err.message}`, "error");
    else alert(`Support log generation failed: ${err.message}`);
  }
};

window.getSensorIdForEntity = function (nodeId, entityKey, name, type) {
  if (nodeId === 'core-mon') {
    if (entityKey === 'cpu-utilization') return 'sensor.cpu_utilization';
    if (entityKey === 'memory-saturation') return 'sensor.memory_saturation';
    if (entityKey === 'network-throughput') return 'sensor.network_throughput';
    if (entityKey === 'server-room-temp') return 'sensor.cpu_temperature';
    if (entityKey === 'database-status') return 'sensor.database_status';
    if (entityKey === 'database-latency') return 'sensor.database_latency';
    if (entityKey === 'database-storage-pct') return 'sensor.database_storage_pct';
  }

  if (nodeId === 'monitors') {
    const match = entityKey.match(/^monitor-(\d+)-(status|latency)$/);
    if (match) {
      const monId = match[1];
      const category = match[2];

      const slugify = (str) => {
        return str
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/[\s_-]+/g, '_')
          .replace(/^-+|-+$/g, '');
      };

      let monNameSlug = `monitor_${monId}`;
      let monType = 'ping';

      if (name) {
        monNameSlug = slugify(name
          .replace(/\s+Status$/i, '')
          .replace(/\s+Latency$/i, '')
          .replace(/\s+Check$/i, '')
          .replace(/\s*\(Ping\)$/i, '')
          .replace(/\s*\(HTTP\)$/i, '')
          .replace(/\s*\(HTTPS\)$/i, '')
          .replace(/\s*\(SSL\)$/i, '')
          .replace(/\s*\(Port\)$/i, '')
        );
      }
      if (type) {
        monType = type;
      }

      if (category === 'status') {
        const domain = (monType === 'ping') ? 'ping' : 'binary_sensor';
        return `${domain}.${monNameSlug}`;
      } else {
        return `sensor.${monNameSlug}_latency`;
      }
    }
  }

  return `${nodeId}.${entityKey}`.replace(/-/g, '_');
};

window.resolveSensorIdToEntityRef = function (sensorId) {
  if (!cachedEntities) return null;
  const matched = Object.keys(cachedEntities).find(key => {
    const item = cachedEntities[key];
    const id = window.getSensorIdForEntity(item.node_id, item.entity_key, item.name, item.type);
    return id === sensorId;
  });

  if (matched) {
    const item = cachedEntities[matched];
    return { nodeId: item.node_id, entityKey: item.entity_key };
  }

  const parts = sensorId.split('.');
  if (parts.length === 2) {
    const slug = parts[1];
    if (slug === 'cpu_utilization') return { nodeId: 'core-mon', entityKey: 'cpu-utilization' };
    if (slug === 'memory_saturation') return { nodeId: 'core-mon', entityKey: 'memory-saturation' };
    if (slug === 'network_throughput') return { nodeId: 'core-mon', entityKey: 'network-throughput' };
    if (slug === 'cpu_temperature') return { nodeId: 'core-mon', entityKey: 'server-room-temp' };
    if (slug === 'database_status') return { nodeId: 'core-mon', entityKey: 'database-status' };
    if (slug === 'database_latency') return { nodeId: 'core-mon', entityKey: 'database-latency' };
    if (slug === 'database_storage_pct') return { nodeId: 'core-mon', entityKey: 'database-storage-pct' };
  }
  return null;
};

window.openHostDetail = async function (hostId) {
  if (typeof hostId === 'string' && hostId.startsWith('plugin-')) {
    const pluginId = hostId.substring(7);

    // Fetch installed list to get details
    let plugin = null;
    try {
      const { httpUrl } = getApiUrls();
      const res = await fetch(`${httpUrl}/api/plugins/installed`);
      if (res.ok) {
        const plugins = await res.json();
        plugin = plugins.find(p => p.id === pluginId);
      }
    } catch (e) {
      console.error("Failed to load plugin details inside host manager:", e);
    }

    if (!plugin) {
      plugin = { id: pluginId, name: pluginId, version: '1.0.0' };
    }

    document.getElementById('host-detail-title-full').textContent = `Plugin: ${plugin.name}`;
    document.getElementById('host-detail-target-full').textContent = `Local Daemon (v${plugin.version})`;

    // Hide system telemetry stats panel
    const statsSection = document.getElementById('host-detail-stats-section-full');
    if (statsSection) statsSection.style.display = 'none';

    // Fetch and populate probers/entries list for this plugin
    const probersList = document.getElementById('host-detail-probers-list-full');
    if (probersList) {
      // Find all custom entities reported by this plugin
      const entities = Object.values(cachedEntities || {}).filter(item =>
        item.plugin_id === pluginId ||
        item.node_id === pluginId ||
        item.node_id === `plugin-${pluginId}` ||
        (item.node_id === 'plugins' && item.entity_key.includes(pluginId))
      );

      if (entities.length === 0) {
        probersList.innerHTML = `<span style="font-size:0.75rem; color:var(--text-secondary); font-style:italic;">No entity telemetry reported by this plugin yet.</span>`;
      } else {
        probersList.innerHTML = entities.map(m => {
          const statusVal = m.value !== undefined ? m.value : 'unknown';
          const sValUpper = String(statusVal).trim().toUpperCase();
          const isOnline = isProbeStatusOnline(statusVal) || sValUpper === 'ON' || sValUpper === 'ACTIVE' || sValUpper === 'RUNNING' || sValUpper === 'OK' || sValUpper === 'IDLE' || sValUpper === 'PASSED';
          const statusClass = isOnline ? 'online' : 'offline';
          const statusLabel = typeof statusVal === 'string' ? statusVal.toUpperCase() : statusVal;

          const sensorIdStatus = window.getSensorIdForEntity(m.node_id, m.entity_key, m.name, m.type);

          // Get extra details from attributes if present
          let detailsHtml = '';
          if (m.attributes && Object.keys(m.attributes).length > 0) {
            const formatBytes = (bytes) => {
              if (bytes === 0) return '0 B';
              if (!bytes || isNaN(bytes)) return bytes;
              const k = 1024;
              const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
              let i = Math.floor(Math.log(bytes) / Math.log(k));
              if (i < 0) i = 0;
              if (i >= sizes.length) i = sizes.length - 1;
              return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            };

            detailsHtml = Object.keys(m.attributes)
              .filter(attr => attr !== 'status' && attr !== 'version')
              .map(attr => {
                let val = m.attributes[attr];
                const keyLower = attr.toLowerCase();
                // Format sizes/bytes to human readable form
                if (typeof val === 'number' && (keyLower.includes('bytes') || keyLower === 'size' || keyLower.includes('_size') || keyLower.includes('capacity') || keyLower.includes('bandwidth'))) {
                  val = formatBytes(val);
                } else if (typeof val === 'object' && val !== null) {
                  // Table rendering for arrays of objects
                  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
                    const uniqueId = `table-${m.node_id}-${m.entity_key}-${attr}`.replace(/[^a-zA-Z0-9-]/g, '_');

                    const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    // Look up parent manifest to see if a schema matches
                    let columns = [];
                    const lookupPluginId = m.plugin_id || m.node_id;
                    const p = window.currentActivePluginsData ? window.currentActivePluginsData.find(pl => pl.id === lookupPluginId) : null;
                    if (p && p.entities && p.entities[m.entity_key] && p.entities[m.entity_key].ui_schema && p.entities[m.entity_key].ui_schema.columns) {
                      columns = p.entities[m.entity_key].ui_schema.columns;
                    } else {
                      columns = Object.keys(val[0]);
                    }

                    // Headers
                    const headersHtml = columns.map(k => `<th style="text-align: left; padding: 6px; font-size: 0.7rem; text-transform: capitalize; border-bottom: 1px solid var(--border-soft); color: var(--text-secondary);">${escapeHtml(String(k).replace(/_/g, ' '))}</th>`).join('');

                    // Rows
                    const rowsHtml = val.map(row => {
                      const cellsHtml = columns.map(k => {
                        let cellVal = row[k];
                        if (cellVal === undefined || cellVal === null) cellVal = '-';
                        if (typeof cellVal === 'object' && cellVal !== null) {
                          if (cellVal.$date) {
                            cellVal = new Date(cellVal.$date).toLocaleString();
                          } else {
                            cellVal = JSON.stringify(cellVal);
                          }
                        }
                        if (typeof cellVal === 'number' && (k.toLowerCase().includes('bytes') || k.toLowerCase().includes('size'))) {
                          cellVal = formatBytes(cellVal);
                        }
                        return `<td style="padding: 6px; font-size: 0.72rem; vertical-align: top; border-bottom: 1px dashed rgba(255,255,255,0.05); color: #e2e8f0; font-family: monospace;">${escapeHtml(cellVal)}</td>`;
                      }).join('');
                      return `<tr class="table-row" style="transition: background 0.15s;">${cellsHtml}</tr>`;
                    }).join('');

                    // Search input
                    const searchInputHtml = val.length > 1 ? `
                      <div style="margin-bottom: 8px;">
                        <input id="search-input-${uniqueId}" type="text" placeholder="Query filtered ${attr}..." 
                               style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-soft); border-radius: 4px; padding: 4px 8px; font-size: 0.72rem; color: #fff; width: 100%; box-sizing: border-box;"
                               onkeyup="window.filterEmbedTable('${uniqueId}')">
                      </div>
                    ` : '';

                    val = `
                      <div id="wrapper-${uniqueId}" style="margin-top: 6px; background: rgba(0,0,0,0.15); border: 1px solid var(--border-soft); border-radius: 6px; padding: 8px; width: 100%; box-sizing: border-box;">
                        ${searchInputHtml}
                        <div style="overflow-x: auto; width: 100%;">
                          <table id="${uniqueId}" style="width: 100%; border-collapse: collapse; text-wrap: wrap;">
                            <thead>
                              <tr>${headersHtml}</tr>
                            </thead>
                            <tbody>
                              ${rowsHtml}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    `;
                  } else {
                    const safeJson = String(JSON.stringify(val, null, 2) ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    val = `<pre style="margin: 2px 0 0 0; white-space: pre-wrap; word-break: break-all; font-family: monospace; font-size: 0.65rem; color: #fff; background: rgba(0,0,0,0.22); padding: 5px; border-radius: 4px; line-height: 1.3;">${safeJson}</pre>`;
                  }
                } else {
                  const safeVal = String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  val = `<span style="color:#fff; word-break: break-all;">${safeVal}</span>`;
                }
                const isEmbed = typeof val === 'string' && (val.includes('<pre') || val.includes('<div'));
                return `<div style="margin-top: 6px; line-height: 1.4;">${attr}: ${isEmbed ? val : val}</div>`;
              })
              .join('');
          }

          return `
            <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-soft); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:0.8rem; font-weight:700; color:#fff;">${m.name}</span>
                <span class="status-pill ${statusClass === 'online' ? 'stable' : 'critical'}" style="font-size:0.6rem; padding: 2px 6px;">${statusLabel}</span>
              </div>
              <div style="font-size:0.7rem; color:var(--text-secondary); display:flex; flex-direction:column; gap:2px;">
                <div>Type: <span style="color:#fff;">${m.type}</span></div>
                ${detailsHtml}
              </div>
              <div style="border-top: 1px dashed var(--border-soft); padding-top:4px; margin-top:2px; font-size:0.65rem; color:var(--text-secondary);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
                  <span style="word-break:break-all;">Sensor ID: <code style="color:var(--accent-orange); word-break:break-all; user-select:all;">${sensorIdStatus}</code></span>
                  <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                    <button class="btn-icon" onclick="event.stopPropagation(); openHistoryForSensor('${sensorIdStatus}')" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="View Telemetry History">
                      <i data-lucide="history" style="width:11px; height:11px; color:var(--color-primary);"></i>
                      <span>History</span>
                    </button>
                    <button class="btn-icon" onclick="event.stopPropagation(); copySensorId('${sensorIdStatus}', this)" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="Copy Sensor ID">
                      <i data-lucide="copy" style="width:11px; height:11px;"></i>
                      <span>Copy</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('');
        if (window.lucide) window.lucide.createIcons();
      }
    }

    // Repurpose edit button for plugins to jump directly to the plugin configuration
    const editBtn = document.getElementById('btn-edit-host-from-detail-full');
    if (editBtn) {
      editBtn.style.display = 'inline-flex';
      editBtn.innerHTML = '<i data-lucide="settings" style="width:14px; height:14px;"></i> Configure Plugin';
      editBtn.onclick = () => {
        showPluginsView();
        setTimeout(() => {
          const card = Array.from(document.querySelectorAll('#installed-plugins-list .plugin-card')).find(el => el.innerHTML.includes(`'${pluginId}'`));
          if (card) {
            const det = card.querySelector('details');
            if (det) det.open = true;
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 150);
      };
      if (window.lucide) window.lucide.createIcons();
    }

    // Show host detail view full page
    hideAllViews();
    const hostDetailView = document.getElementById('host-detail-view');
    if (hostDetailView) {
      hostDetailView.classList.remove('hide');
    }
    return;
  }

  if (!window.currentHosts) return;
  const host = window.currentHosts.find(h => h.id === hostId);
  if (!host) return;

  const editBtnRestore = document.getElementById('btn-edit-host-from-detail-full');
  if (editBtnRestore) {
    editBtnRestore.style.display = 'inline-flex';
    editBtnRestore.innerHTML = '<i data-lucide="edit-2" style="width:14px; height:14px;"></i> Edit Host';
    editBtnRestore.onclick = () => editHostFromDetail();
  }

  document.getElementById('host-detail-title-full').textContent = host.name;
  document.getElementById('host-detail-target-full').textContent = host.target;
  const intTgt = host.target_internal || host.target || '';
  const extTgt = host.target_external ? ` • External: ${host.target_external}` : '';
  document.getElementById('host-detail-target-full').textContent = `LAN: ${intTgt}${extTgt}`;

  // Show system telemetry stats if Core Monitor Host (127.0.0.1)
  const isCore = host.target === '127.0.0.1' || host.name.includes("Core Monitor");
  const statsSection = document.getElementById('host-detail-stats-section-full');
  if (statsSection) {
    if (isCore) {
      statsSection.style.display = 'block';

      const cpu = (cachedEntities && cachedEntities['cpu-utilization']) ? cachedEntities['cpu-utilization'].value : '--';
      const mem = (cachedEntities && cachedEntities['memory-saturation']) ? cachedEntities['memory-saturation'].value : '--';
      const net = (cachedEntities && cachedEntities['network-throughput']) ? cachedEntities['network-throughput'].value : '--';
      const temp = (cachedEntities && cachedEntities['server-room-temp']) ? cachedEntities['server-room-temp'].value : '--';

      document.getElementById('host-detail-cpu-val-full').textContent = `${cpu}%`;
      document.getElementById('host-detail-mem-val-full').textContent = `${mem}%`;
      document.getElementById('host-detail-net-val-full').textContent = `${net} MB/s`;
      document.getElementById('host-detail-temp-val-full').textContent = `${temp}°C`;
    } else {
      statsSection.style.display = 'none';
    }
  }

  // Fetch checkers linked to this host ID
  const probersList = document.getElementById('host-detail-probers-list-full');
  if (probersList) {
    probersList.innerHTML = `<p style="font-size:0.75rem; color:var(--text-secondary); font-style:italic;">Querying probers list...</p>`;

    try {
      const { httpUrl } = getApiUrls();
      const res = await fetch(`${httpUrl}/api/monitors`);
      if (res.ok) {
        const monitors = await res.json();
        const hostMonitors = monitors.filter(m => m.host_id === hostId);

        if (hostMonitors.length === 0) {
          probersList.innerHTML = `<span style="font-size:0.75rem; color:var(--text-secondary); font-style:italic;">No checkers configured for this host node.</span>`;
        } else {
          probersList.innerHTML = hostMonitors.map(m => {
            const statusVal = (cachedEntities && cachedEntities[`monitor-${m.id}-status`]) ? cachedEntities[`monitor-${m.id}-status`].value : (m.last_status || 'unknown');
            const latencyVal = (cachedEntities && cachedEntities[`monitor-${m.id}-latency`]) ? cachedEntities[`monitor-${m.id}-latency`].value : (m.last_latency !== null && m.last_latency !== undefined ? m.last_latency : '--');

            const sensorIdStatus = window.getSensorIdForEntity('monitors', `monitor-${m.id}-status`, m.name, m.type);
            const sensorIdLatency = window.getSensorIdForEntity('monitors', `monitor-${m.id}-latency`, m.name, m.type);

            const isOnline = isProbeStatusOnline(statusVal, m.type);
            const statusClass = isOnline ? 'online' : 'offline';
            const statusLabel = isOnline ? (statusVal === 'up' || statusVal === 'online' ? 'Online' : statusVal.toUpperCase()) : statusVal.toUpperCase();

            return `
              <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-soft); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="font-size:0.8rem; font-weight:700; color:#fff;">${m.name}</span>
                  <span class="status-pill ${statusClass === 'online' ? 'stable' : 'critical'}" style="font-size:0.6rem; padding: 2px 6px;">${statusLabel}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.7rem; color:var(--text-secondary);">
                  <span>Target: <span style="font-family:monospace; color:#fff;">${m.target}</span></span>
                  <span>Latency: <span style="color:#fff;">${latencyVal} ms</span></span>
                </div>
                <div style="border-top: 1px dashed var(--border-soft); padding-top:4px; margin-top:2px; font-size:0.65rem; color:var(--text-secondary); display:flex; flex-direction:column; gap:4px;">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
                    <span style="word-break:break-all;">Status Sensor: <code style="color:var(--accent-orange); word-break:break-all; user-select:all;">${sensorIdStatus}</code></span>
                    <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                      <button class="btn-icon" onclick="event.stopPropagation(); openHistoryForSensor('${sensorIdStatus}')" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="View Telemetry History">
                        <i data-lucide="history" style="width:11px; height:11px; color:var(--color-primary);"></i>
                        <span>History</span>
                      </button>
                      <button class="btn-icon" onclick="event.stopPropagation(); copySensorId('${sensorIdStatus}', this)" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="Copy Sensor ID">
                        <i data-lucide="copy" style="width:11px; height:11px;"></i>
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
                    <span style="word-break:break-all;">Latency Sensor: <code style="color:var(--accent-orange); word-break:break-all; user-select:all;">${sensorIdLatency}</code></span>
                    <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                      <button class="btn-icon" onclick="event.stopPropagation(); openHistoryForSensor('${sensorIdLatency}')" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="View Telemetry History">
                        <i data-lucide="history" style="width:11px; height:11px; color:var(--color-primary);"></i>
                        <span>History</span>
                      </button>
                      <button class="btn-icon" onclick="event.stopPropagation(); copySensorId('${sensorIdLatency}', this)" style="padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); border-radius:3px; cursor:pointer; font-size:0.65rem; color:#94a3b8; display:inline-flex; align-items:center; gap:4px;" title="Copy Sensor ID">
                        <i data-lucide="copy" style="width:11px; height:11px;"></i>
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            `;
          }).join('');
          if (window.lucide) window.lucide.createIcons();
        }
      } else {
        probersList.innerHTML = `<span style="font-size:0.75rem; color:#f43f5e;">Failed to fetch host prober elements.</span>`;
      }
    } catch (e) {
      probersList.innerHTML = `<span style="font-size:0.75rem; color:#f43f5e;">Error processing checkers: ${e.message}</span>`;
    }
  }

  // Connect Edit Configuration Button inside overview
  const editBtn = document.getElementById('btn-edit-host-from-detail-full');
  if (editBtn) {
    editBtn.style.display = ''; // restore visibility
    editBtn.onclick = function () {
      openEditHostModal(hostId);
    };
  }

  // Hide other views and show the host-detail-view full page
  hideAllViews();
  const hostDetailView = document.getElementById('host-detail-view');
  if (hostDetailView) {
    hostDetailView.classList.remove('hide');
  }
};

