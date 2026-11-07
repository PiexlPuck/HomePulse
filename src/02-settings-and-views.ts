// ============================================================================
// Module: src/02-settings-and-views.ts
// Description: View Router, System Settings, API Keys, Dependencies & DB Prune
// ============================================================================

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

function hideAllViews(): void {
  const dashContent = document.querySelector('.dashboard-content');
  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  const settingsView = document.getElementById('settings-view');
  const probesView = document.getElementById('probes-view');
  const automationsView = document.getElementById('automations-view');
  const channelsView = document.getElementById('channels-view');
  const devtoolsView = document.getElementById('developer-tools-view');
  const uptimeHistoryView = document.getElementById('uptime-history-view');
  const hostsView = document.getElementById('hosts-view');
  const hostDetailView = document.getElementById('host-detail-view');
  const pluginsView = document.getElementById('plugins-view');
  const layoutView = document.getElementById('layout-view');

  if (dashContent) dashContent.style.display = 'none';
  if (dashGrid) dashGrid.style.display = 'none';
  if (bottomSection) bottomSection.style.display = 'none';
  if (settingsView) settingsView.classList.add('hide');
  if (probesView) probesView.classList.add('hide');
  if (automationsView) automationsView.classList.add('hide');
  if (channelsView) channelsView.classList.add('hide');
  if (devtoolsView) devtoolsView.classList.add('hide');
  if (uptimeHistoryView) uptimeHistoryView.classList.add('hide');
  if (hostsView) hostsView.classList.add('hide');
  if (hostDetailView) hostDetailView.classList.add('hide');
  if (pluginsView) pluginsView.classList.add('hide');
  if (layoutView) layoutView.classList.add('hide');

  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'none';

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
}

function showSettingsView(): void {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const settingsView = document.getElementById('settings-view');
  if (settingsView) settingsView.classList.remove('hide');

  const navSettings = document.getElementById('nav-settings');
  if (navSettings) navSettings.classList.add('active');

  loadSettings();
}

function showDashboardView(): void {
  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'flex';

  hideAllViews();

  const dashContent = document.querySelector('.dashboard-content');
  const dashGrid = document.getElementById('dashboard-grid');
  const bottomSection = document.querySelector('.bottom-section');
  if (dashContent) dashContent.style.display = '';
  if (dashGrid) dashGrid.style.display = '';
  if (bottomSection) bottomSection.style.display = '';

  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'flex';

  const navDashboard = document.getElementById('nav-dashboard');
  if (navDashboard) navDashboard.classList.add('active');
}

function showProbesView(): void {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const probesView = document.getElementById('probes-view');
  if (probesView) probesView.classList.remove('hide');

  const navProbes = document.getElementById('nav-probes');
  if (navProbes) navProbes.classList.add('active');

  navigateProbesLevel(1);
}

window.switchAlertRouterTab = function (subTab) {
  const cards = {
    rules: document.getElementById('alert-router-rules-card'),
    channels: document.getElementById('alert-router-channels-card'),
    groups: document.getElementById('alert-router-groups-card'),
    flows: document.getElementById('alert-router-flows-card')
  };
  const btns = {
    rules: document.getElementById('alert-tab-rules'),
    channels: document.getElementById('alert-tab-channels'),
    groups: document.getElementById('alert-tab-groups'),
    flows: document.getElementById('alert-tab-flows')
  };

  if (subTab === 'flows') {
    if (typeof loadFlowsList === 'function') loadFlowsList();
  }

  Object.keys(cards).forEach(key => {
    if (cards[key]) {
      cards[key].style.display = (key === subTab) ? 'block' : 'none';
    }
  });

  Object.keys(btns).forEach(key => {
    const btn = btns[key];
    if (btn) {
      if (key === subTab) {
        btn.classList.add('active');
        btn.style.borderBottom = '2px solid var(--accent-orange)';
        btn.style.color = 'var(--text-primary)';
        btn.style.fontWeight = '700';
      } else {
        btn.classList.remove('active');
        btn.style.borderBottom = 'none';
        btn.style.color = 'var(--text-secondary)';
        btn.style.fontWeight = '500';
      }
    }
  });

  if (subTab === 'rules') {
    const { httpUrl } = getApiUrls();
    fetch(`${httpUrl}/api/monitor-groups`)
      .then(res => res.ok ? res.json() : [])
      .then(grps => {
        window.cachedGroups = grps;
        loadAlertRules();
      })
      .catch(() => loadAlertRules());
  } else if (subTab === 'channels') {
    loadNotificationChannels();
  } else if (subTab === 'groups') {
    loadMonitorGroups();
  }
};

function showAutomationsView() {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const automationsView = document.getElementById('automations-view');
  if (automationsView) automationsView.classList.remove('hide');

  const navAutomations = document.getElementById('nav-automations');
  if (navAutomations) navAutomations.classList.add('active');

  switchAlertRouterTab('rules');
}

function showChannelsView() {
  showAutomationsView();
  switchAlertRouterTab('channels');
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

  const navLayout = document.getElementById('nav-layout');
  if (navLayout) {
    navLayout.addEventListener('click', (e) => {
      e.preventDefault();
      showLayoutView();
    });
  }

  const navPlugins = document.getElementById('nav-plugins');
  if (navPlugins) {
    navPlugins.addEventListener('click', (e) => {
      e.preventDefault();
      showPluginsView();
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

  const btnInstallMonitors = document.getElementById('btn-install-custom-monitors-hosts');
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

    // Cache settings globally for header theme sync checks
    window.currentSettingsData = data;

    const tzEl = document.getElementById('setting-timezone');
    if (tzEl && data.timezone) {
      tzEl.value = data.timezone;
      currentTimezone = data.timezone;
    }

    const pskEl = document.getElementById('setting-psk');
    if (pskEl && data.preshared_key) pskEl.value = data.preshared_key;

    const compactEl = document.getElementById('setting-compact');
    if (compactEl) compactEl.checked = (data.layout_compact === 'true');

    const monitorsToggleEl = document.getElementById('setting-show-service-monitors');
    if (monitorsToggleEl && data.show_service_monitors !== undefined) {
      monitorsToggleEl.checked = (data.show_service_monitors === 'true');
    }

    // Bind Telemetry Interval
    const telemetryIntervalEl = document.getElementById('setting-telemetry-interval');
    const telemetryIntervalBadge = document.getElementById('setting-telemetry-interval-val');
    const currentInterval = (data.telemetry_interval !== undefined && data.telemetry_interval !== null) ? parseInt(data.telemetry_interval) : 3;
    if (telemetryIntervalEl) telemetryIntervalEl.value = currentInterval;
    if (telemetryIntervalBadge) telemetryIntervalBadge.textContent = `${currentInterval}s`;

    // Bind Gateway Settings
    const gwModeEl = document.getElementById('setting-gateway-mode');
    if (gwModeEl) gwModeEl.checked = (data.gateway_mode === 'true');

    const gwDbEl = document.getElementById('setting-gateway-db-enabled');
    if (gwDbEl) gwDbEl.checked = (data.gateway_db_enabled !== 'false'); // defaults to true

    const gwUrlEl = document.getElementById('setting-gateway-webhook-url');
    if (gwUrlEl) gwUrlEl.value = data.gateway_webhook_url || '';

    const gwHeadersEl = document.getElementById('setting-gateway-webhook-headers');
    if (gwHeadersEl) gwHeadersEl.value = data.gateway_webhook_headers || '';

    // Apply theme
    if (data.theme) applyTheme(data.theme);

    // Load API Keys
    loadApiKeysList();

  } catch (err) {
    console.warn('Could not load settings from API:', err);
  }

  // Always initialize interactive bindings
  initSettingsControls();
  loadPruneDropdowns();
  updateGatewayUIVisibilities();
}

// Bind all interactive settings controls
function initSettingsControls() {
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

  // Show service monitors toggle
  const monitorsToggleEl = document.getElementById('setting-show-service-monitors');
  if (monitorsToggleEl) {
    monitorsToggleEl.addEventListener('change', () => {
      const navProbes = document.getElementById('nav-probes');
      if (navProbes) {
        navProbes.style.display = monitorsToggleEl.checked ? '' : 'none';
      }
    });
  }

  // Save settings button
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const { httpUrl } = getApiUrls();
      const payload: Record<string, any> = {
        timezone: document.getElementById('setting-timezone')?.value || 'UTC',
        preshared_key: document.getElementById('setting-psk')?.value || 'device_pin_12345',
        theme: document.querySelector('.theme-btn.active')?.getAttribute('data-theme') || 'midnight',
        layout_compact: String(document.getElementById('setting-compact')?.checked || false),
        show_service_monitors: String(document.getElementById('setting-show-service-monitors')?.checked || false),
        telemetry_interval: parseInt(document.getElementById('setting-telemetry-interval')?.value || '3'),
        // Gateway settings
        gateway_mode: String(document.getElementById('setting-gateway-mode')?.checked || false),
        gateway_db_enabled: String(document.getElementById('setting-gateway-db-enabled')?.checked || false),
        gateway_webhook_url: document.getElementById('setting-gateway-webhook-url')?.value || '',
        gateway_webhook_headers: document.getElementById('setting-gateway-webhook-headers')?.value || ''
      };

      // Preserve current background telemetry settings if they exist
      if (window.currentSettingsData) {
        if (window.currentSettingsData.telemetry_interval !== undefined) {
          payload.telemetry_interval = parseInt(window.currentSettingsData.telemetry_interval);
        }
        if (window.currentSettingsData.log_retention !== undefined) {
          payload.log_retention = parseInt(window.currentSettingsData.log_retention);
        }
        if (window.currentSettingsData.auto_prune_enabled !== undefined) {
          payload.auto_prune_enabled = String(window.currentSettingsData.auto_prune_enabled);
        }
      }

      try {
        const res = await fetch(`${httpUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast('Settings saved successfully', 'success');
          if (!window.currentSettingsData) window.currentSettingsData = {};
          Object.assign(window.currentSettingsData, payload);
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

// --- Gateway and API Key management ---
window.openGatewayInfoModal = function () {
  openModal('gateway-info-modal');
};

let gatewayHeadersVisible = false;
window.toggleGatewayHeadersVisibility = function () {
  const el = document.getElementById('setting-gateway-webhook-headers');
  const btn = document.getElementById('btn-toggle-gateway-headers');
  if (!el || !btn) return;
  gatewayHeadersVisible = !gatewayHeadersVisible;
  if (gatewayHeadersVisible) {
    el.style.webkitTextSecurity = 'none';
    btn.innerHTML = '<i data-lucide="eye-off" style="width:12px; height:12px;"></i> Hide Headers';
  } else {
    el.style.webkitTextSecurity = 'disc';
    btn.innerHTML = '<i data-lucide="eye" style="width:12px; height:12px;"></i> Show/Hide Headers';
  }
  if (window.lucide) window.lucide.createIcons();
};

window.updateGatewayUIVisibilities = function () {
  const gwModeEl = document.getElementById('setting-gateway-mode');
  const isGw = gwModeEl && gwModeEl.checked;

  const gwDbGroup = document.getElementById('gateway-db-group');
  const gwUrlGroup = document.getElementById('gateway-url-group');
  const gwHeadersGroup = document.getElementById('gateway-headers-group');

  if (gwDbGroup) gwDbGroup.style.display = isGw ? '' : 'none';
  if (gwUrlGroup) gwUrlGroup.style.display = isGw ? '' : 'none';
  if (gwHeadersGroup) gwHeadersGroup.style.display = isGw ? '' : 'none';

  // Toggle navigation tabs display based on Repeater Mode
  const sidebarItemsToToggle = ['nav-dashboard', 'nav-history', 'nav-automations', 'nav-discovery', 'nav-probes'];
  sidebarItemsToToggle.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (isGw) {
        el.style.display = 'none';
      } else {
        if (id === 'nav-probes') {
          const isShowMonitors = window.currentSettingsData?.show_service_monitors === 'true' ||
            (document.getElementById('setting-show-service-monitors')?.checked || false);
          el.style.display = isShowMonitors ? '' : 'none';
        } else {
          el.style.display = '';
        }
      }
    }
  });

  // Switch tab if current tab is hidden under gateway mode
  if (isGw) {
    const activeNav = document.querySelector('.nav-item.active');
    if (activeNav && sidebarItemsToToggle.includes(activeNav.id)) {
      // route to Hosts tab by default
      const navHosts = document.getElementById('nav-hosts');
      if (navHosts) navHosts.click();
    }
  }
};

// Bind checkbox listeners
document.addEventListener('DOMContentLoaded', () => {
  const gwModeEl = document.getElementById('setting-gateway-mode');
  if (gwModeEl) {
    gwModeEl.addEventListener('change', window.updateGatewayUIVisibilities);
  }
});

// Back up listener trigger (in case DOMContentLoaded already fired)
setTimeout(() => {
  const gwModeEl = document.getElementById('setting-gateway-mode');
  if (gwModeEl && !gwModeEl.dataset.listenerBound) {
    gwModeEl.addEventListener('change', window.updateGatewayUIVisibilities);
    gwModeEl.dataset.listenerBound = 'true';
  }
}, 500);

window.loadApiKeysList = async function () {
  const { httpUrl } = getApiUrls();
  const container = document.getElementById('api-keys-list-container');
  if (!container) return;

  try {
    const res = await fetch(`${httpUrl}/api/settings/keys`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const keys = await res.json();

    if (keys.length === 0) {
      container.innerHTML = `<div style="font-size:0.75rem; color:var(--text-secondary); text-align:center; padding:12px; background:rgba(255,255,255,0.02); border:1px dashed var(--border-soft); border-radius:6px;">No API keys generated yet.</div>`;
      return;
    }

    container.innerHTML = keys.map(k => {
      const createdStr = k.created_at ? new Date(k.created_at).toLocaleString() : 'N/A';
      const lastUsedStr = k.last_used ? new Date(k.last_used).toLocaleString() : 'Never';
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:6px; padding:10px 12px; gap:12px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; color:var(--text-primary); font-size:0.8rem; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(k.name)}</div>
            <div style="font-family:monospace; font-size:0.72rem; color:var(--accent-orange); margin-top:2px;">${escapeHtml(k.prefix)}...</div>
            <div style="font-size:0.65rem; color:var(--text-secondary); display:flex; gap:10px; margin-top:4px;">
              <span>Created: ${createdStr}</span>
              <span>Used: ${lastUsedStr}</span>
            </div>
          </div>
          <button type="button" class="btn btn-secondary" onclick="deleteApiKey(${k.id})" style="padding:6px; min-width:auto; border-color:rgba(239,68,68,0.3); color:#fca5a5;">
            <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
          </button>
        </div>
      `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('Failed to load API keys:', err);
    container.innerHTML = `<div style="font-size:0.75rem; color:#fca5a5; text-align:center; padding:12px;">Failed to load API keys.</div>`;
  }
};

window.createNewApiKey = async function () {
  const nameEl = document.getElementById('new-api-key-name');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) {
    alert('Please enter a descriptive name for the API Key.');
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const keyData = await res.json();

    if (nameEl) nameEl.value = '';

    // Populate display key modal
    const keyDisplay = document.getElementById('displayed-raw-api-key');
    if (keyDisplay) keyDisplay.innerText = keyData.key;

    const copyBtn = document.getElementById('btn-copy-generated-api-key');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(keyData.key);
        copyBtn.innerText = 'Copied!';
        setTimeout(() => { copyBtn.innerText = 'Copy'; }, 2000);
      };
    }

    openModal('api-key-display-modal');
    loadApiKeysList();
  } catch (err) {
    console.error('Failed to generate key:', err);
    alert('Failed to generate API Key: ' + err.message);
  }
};

window.deleteApiKey = async function (kid) {
  if (!confirm('Are you sure you want to revoke this API Key? Any scripts using this key will immediately fail authentication.')) {
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/settings/keys/${kid}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('API Key revoked successfully', 'info');
    loadApiKeysList();
  } catch (err) {
    console.error('Failed to revoke API key:', err);
    alert('Failed to revoke API Key: ' + err.message);
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function updateRetentionVisualizer(days) {
  const bar = document.getElementById('visualizer-bar');
  const pctText = document.getElementById('visualizer-load-pct');
  const desc = document.getElementById('visualizer-desc');
  if (!bar || !pctText || !desc) return;

  const pct = Math.min(100, Math.round((days / 30) * 100));
  bar.style.width = `${pct}%`;

  let scale = 'Low';
  let color = 'var(--color-optimal)';
  let impact = 'Minimal';
  let mb = Math.round(days * 6.5);

  if (pct > 75) {
    scale = 'High';
    color = '#ef4444';
    impact = 'Moderate impact on query speed';
    bar.style.background = 'linear-gradient(90deg, #10b981, #f59e0b, #ef4444)';
  } else if (pct > 35) {
    scale = 'Medium';
    color = '#f59e0b';
    impact = 'Negligible';
    bar.style.background = 'linear-gradient(90deg, #10b981, #f59e0b)';
  } else {
    scale = 'Optimized';
    color = 'var(--color-optimal)';
    impact = 'None';
    bar.style.background = 'var(--color-optimal)';
  }

  pctText.textContent = `${scale} (${pct}%)`;
  pctText.style.color = color;
  desc.textContent = `Storing logs for ${days} days. Estimated database storage requirement: ~${mb} MB. Performance impact: ${impact}.`;
}

window.triggerManualPrune = async function (options) {
  const { httpUrl } = getApiUrls();
  const formatText = options.age === 'all' ? 'All historical logs (TRUNCATE)' : `logs older than ${options.age === 'year' ? '1 Year' : '30 Days'}`;

  try {
    // 1. Dry run check
    const checkRes = await fetch(`${httpUrl}/api/support/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, dry_run: true })
    });
    if (!checkRes.ok) throw new Error(`HTTP ${checkRes.status}`);
    const dryData = await checkRes.json();

    const count = parseInt(dryData.deleted_logs) + parseInt(dryData.deleted_audits);
    if (count === 0 && options.age !== 'all') {
      showToast('Dry run check: No matching logs found to prune.', 'info');
      return;
    }

    // 2. Warn user with detailed information
    const userMsg = `Dry run estimation: This will delete approximately ${dryData.deleted_logs} telemetry logs and ${dryData.deleted_audits} system audits. Are you sure you want to permanently prune this data?`;
    if (!await showConfirm(userMsg, "Confirm Manual Database Pruning")) {
      return;
    }

    // 3. Execution
    showToast('Executing manual database pruning...', 'info');
    const pruneRes = await fetch(`${httpUrl}/api/support/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, dry_run: false })
    });
    if (!pruneRes.ok) throw new Error(`HTTP ${pruneRes.status}`);
    const pruneData = await pruneRes.json();
    showToast(`Prune completed. Cleaned ${pruneData.deleted_logs} logs and ${pruneData.deleted_audits} audits.`, 'success');
  } catch (err) {
    alert(`Failed to execute manual database check or prune: ${err.message}`);
  }
};

// Dynamic host/entity loading for Advanced DB Pruning
async function loadPruneDropdowns() {
  const hostSelect = document.getElementById('prune-host-select');
  const entitySelect = document.getElementById('prune-entity-select');
  if (!hostSelect || !entitySelect) return;

  hostSelect.innerHTML = '<option value="">-- All Hosts --</option>';
  entitySelect.innerHTML = '<option value="">-- All Entities --</option>';

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/hosts`);
    if (res.ok) {
      const hosts = await res.json();
      hosts.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.id;
        opt.textContent = `${h.name} (${h.target})`;
        hostSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error("Failed to load hosts for pruning:", err);
  }

  // Populate entities
  if (window.cachedEntities) {
    Object.keys(window.cachedEntities).forEach(key => {
      const ent = window.cachedEntities[key];
      const opt = document.createElement('option');
      opt.value = ent.entity_key;
      opt.textContent = `${ent.name || ent.entity_key} [${ent.node_id}]`;
      entitySelect.appendChild(opt);
    });
  }
}

window.clearPruneFilters = function () {
  const hostSel = document.getElementById('prune-host-select');
  const entSel = document.getElementById('prune-entity-select');
  const startD = document.getElementById('prune-start-date');
  const endD = document.getElementById('prune-end-date');
  if (hostSel) hostSel.value = "";
  if (entSel) entSel.value = "";
  if (startD) startD.value = "";
  if (endD) endD.value = "";
};

window.executeAdvancedPrune = async function () {
  const hostId = document.getElementById('prune-host-select')?.value;
  const entityKey = document.getElementById('prune-entity-select')?.value;
  const startDate = document.getElementById('prune-start-date')?.value;
  const endDate = document.getElementById('prune-end-date')?.value;

  const payload: Record<string, any> = {};
  if (hostId) payload.host_id = parseInt(hostId);
  if (entityKey) payload.entity_key = entityKey;
  if (startDate) payload.start_date = startDate;
  if (endDate) payload.end_date = endDate;

  if (Object.keys(payload).length === 0) {
    alert("Please select at least one filter (Host, Entity metric, Start date, or End date). To clean the whole DB, please use the TRUNCATE preset button.");
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    // 1. Dry run confirmation
    const checkRes = await fetch(`${httpUrl}/api/support/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, dry_run: true })
    });
    if (!checkRes.ok) throw new Error(`HTTP ${checkRes.status}`);
    const dryData = await checkRes.json();

    const count = parseInt(dryData.deleted_logs) + parseInt(dryData.deleted_audits);
    if (count === 0) {
      showToast('Dry run check: No matching records found for these pruning filters.', 'info');
      return;
    }

    const userMsg = `Dry run estimation: This will delete approximately ${dryData.deleted_logs} telemetry logs and ${dryData.deleted_audits} audits. Are you sure you want to permanently prune this data?`;
    if (!await showConfirm(userMsg, "Confirm Filtered Database Pruning")) {
      return;
    }

    // 2. Real prune execution
    showToast('Executing custom database pruning...', 'info');
    const pruneRes = await fetch(`${httpUrl}/api/support/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, dry_run: false })
    });
    if (!pruneRes.ok) throw new Error(`HTTP ${pruneRes.status}`);
    const pruneData = await pruneRes.json();
    showToast(`Prune completed. Cleaned ${pruneData.deleted_logs} logs and ${pruneData.deleted_audits} audits.`, 'success');
    clearPruneFilters();
  } catch (err) {
    alert(`Failed to execute custom database prune: ${err.message}`);
  }
};

window.cycleTheme = async function () {
  const themes = ['midnight', 'glass', 'cozy', 'cyber'];
  let currentTheme = 'midnight';
  if (document.body.classList.contains('theme-glass')) {
    currentTheme = 'glass';
  } else if (document.body.classList.contains('theme-cozy')) {
    currentTheme = 'cozy';
  } else if (document.body.classList.contains('theme-cyber')) {
    currentTheme = 'cyber';
  }

  const currentIndex = themes.indexOf(currentTheme);
  const nextTheme = themes[(currentIndex + 1) % themes.length];

  applyTheme(nextTheme);

  const { httpUrl } = getApiUrls();
  try {
    let settings: Record<string, any> = {};
    if (window.currentSettingsData) {
      settings = { ...window.currentSettingsData };
    } else {
      const res = await fetch(`${httpUrl}/api/settings`);
      if (res.ok) {
        settings = await res.json();
      }
    }

    settings.theme = nextTheme;
    // ensure defaults are met for backend schema validation
    if (!settings.telemetry_interval) settings.telemetry_interval = 3;
    if (!settings.log_retention) settings.log_retention = 7;
    if (!settings.timezone) settings.timezone = 'UTC';
    if (!settings.preshared_key) settings.preshared_key = 'device_pin_12345';
    if (!settings.layout_compact) settings.layout_compact = 'false';
    if (!settings.auto_prune_enabled) settings.auto_prune_enabled = 'false';

    await fetch(`${httpUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    window.currentSettingsData = settings;
    showToast(`Theme switched to ${nextTheme}`, 'info');
  } catch (err) {
    console.error('Failed to auto-save cycled theme:', err);
  }
};

