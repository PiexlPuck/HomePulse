// ============================================================================
// Module: src/08-plugins-ui.ts
// Description: Plugins Marketplace, Installed Plugins, Logs & Markdown Viewer
// ============================================================================

// ─────────────────────────────────────────
// PLUGINS MANAGEMENT INTEGRATION LOGIC
// ─────────────────────────────────────────

window.checkPluginsForUpdates = async function () {
  const btn = document.getElementById('btn-plugins-check-updates');
  let originalHTML = '';
  if (btn) {
    originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
    btn.innerHTML = `
      <svg class="chart-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: spin-loader 0.85s linear infinite; margin: 0; display: inline-block; vertical-align: middle;">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity:0.25;"></circle>
        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      Checking...
    `;
  }

  showToast("Checking marketplace for plugin updates...", "info");

  try {
    await Promise.all([
      loadInstalledPlugins(true),
      loadMarketplacePlugins(true)
    ]);

    let updateCount = 0;
    const updatePlugins = [];
    if (window.installedPluginsData && window.marketplacePluginsData) {
      window.installedPluginsData.forEach(p => {
        const marketplacePlugin = window.marketplacePluginsData.find(m => m.id === p.id);
        if (marketplacePlugin && marketplacePlugin.version !== p.version) {
          updateCount++;
          updatePlugins.push(p.name);
        }
      });
    }

    if (updateCount > 0) {
      showToast(`Update available for ${updateCount} plugin(s): ${updatePlugins.join(', ')}`, 'success');
    } else {
      showToast("All plugins are up to date.", 'success');
    }
  } catch (err) {
    showToast(`Failed to check for updates: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = 'pointer';
      btn.innerHTML = originalHTML;
    }
  }
};

window.copySensorId = function (text, el) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    if (el) {
      const origHtml = el.innerHTML;
      el.innerHTML = `<i data-lucide="check" style="width:11px; height:11px; color:#10b981;"></i><span style="color:#10b981;">Copied</span>`;
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => {
        el.innerHTML = origHtml;
        if (window.lucide) window.lucide.createIcons();
      }, 1500);
    }
    if (typeof showToast === 'function') {
      showToast(`Copied Sensor ID: ${text}`, "info");
    }
  }).catch(err => {
    console.error("Failed to copy sensor ID:", err);
  });
};

function showPluginsView(initialTab: string = 'installed'): void {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const pluginsView = document.getElementById('plugins-view');
  if (pluginsView) pluginsView.classList.remove('hide');

  const navPlugins = document.getElementById('nav-plugins');
  if (navPlugins) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    navPlugins.classList.add('active');
  }

  // Hook search block on input dynamically
  const searchInput = document.getElementById('plugin-search');
  if (searchInput && !searchInput.dataset.hooked) {
    searchInput.dataset.hooked = 'true';
    searchInput.addEventListener('input', () => {
      const activeTabBtn = document.querySelector('#plugins-view .tab-btn.active');
      const activeTab = activeTabBtn && activeTabBtn.id.includes('marketplace') ? 'marketplace' : 'installed';
      if (activeTab === 'installed') {
        loadInstalledPlugins();
      } else {
        loadMarketplacePlugins();
      }
    });
  }

  // Hook drag prevention loops dynamically on first open
  document.querySelectorAll('.nav-item, #toggle-sidebar, .brand').forEach(el => {
    el.setAttribute('draggable', 'false');
    el.addEventListener('dragstart', (e) => {
      e.preventDefault();
      return false;
    });
  });

  switchPluginTab(initialTab);
}

window.navigateToPluginStore = function () {
  showPluginsView('marketplace');
};

window.switchPluginTab = function (tab) {
  // Clear search query when changing tabs
  const searchInput = document.getElementById('plugin-search');
  if (searchInput) searchInput.value = '';

  const tabs = {
    installed: document.getElementById('plugin-tab-installed'),
    marketplace: document.getElementById('plugin-tab-marketplace')
  };
  const sections = {
    installed: document.getElementById('plugin-sec-installed'),
    marketplace: document.getElementById('plugin-sec-marketplace')
  };

  Object.keys(sections).forEach(key => {
    if (sections[key]) {
      sections[key].style.display = (key === tab) ? 'block' : 'none';
    }
  });

  Object.keys(tabs).forEach(key => {
    const btn = tabs[key];
    if (btn) {
      if (key === tab) {
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

  if (tab === 'installed') {
    loadInstalledPlugins();
  } else if (tab === 'marketplace') {
    loadMarketplacePlugins();
  }
};

window.switchPluginsLayout = function (layout) {
  window.pluginsViewLayout = layout;

  const btnGrid = document.getElementById('btn-plugins-grid');
  const btnList = document.getElementById('btn-plugins-list');

  if (btnGrid && btnList) {
    const iconGrid = btnGrid.querySelector('svg, i');
    const iconList = btnList.querySelector('svg, i');
    if (layout === 'grid') {
      btnGrid.classList.add('active');
      btnGrid.style.background = 'rgba(255,255,255,0.08)';
      if (iconGrid) iconGrid.style.color = '#fff';

      btnList.classList.remove('active');
      btnList.style.background = 'none';
      if (iconList) iconList.style.color = 'var(--text-secondary)';
    } else {
      btnList.classList.add('active');
      btnList.style.background = 'rgba(255,255,255,0.08)';
      if (iconList) iconList.style.color = '#fff';

      btnGrid.classList.remove('active');
      btnGrid.style.background = 'none';
      if (iconGrid) iconGrid.style.color = 'var(--text-secondary)';
    }
  }

  // Rerender active view
  const activeTabBtn = document.querySelector('#plugins-view .tab-btn.active');
  const activeTab = activeTabBtn && activeTabBtn.id.includes('marketplace') ? 'marketplace' : 'installed';
  if (activeTab === 'installed') {
    loadInstalledPlugins();
  } else {
    loadMarketplacePlugins();
  }
};

async function loadInstalledPlugins(forceFetch = false) {
  const listContainer = document.getElementById('installed-plugins-list');
  if (!listContainer) return;

  // Track details open status and current input values before rendering
  const openPluginDetails = new Set();
  const currentInputValues = {};
  let focusedInputSelector = null;
  let selectionStart = null;
  let selectionEnd = null;

  // Query and save states from the existing DOM
  listContainer.querySelectorAll('details').forEach(el => {
    const input = el.querySelector('.plugin-config-input');
    if (input && el.open) {
      const pluginId = input.getAttribute('data-plugin-id');
      if (pluginId) {
        openPluginDetails.add(pluginId);
      }
    }
  });

  listContainer.querySelectorAll('.plugin-config-input').forEach(input => {
    const pluginId = input.getAttribute('data-plugin-id');
    const key = input.getAttribute('data-key');
    if (pluginId && key) {
      currentInputValues[`${pluginId}:${key}`] = input.value;
    }
  });

  if (document.activeElement && document.activeElement.classList.contains('plugin-config-input')) {
    const pluginId = document.activeElement.getAttribute('data-plugin-id');
    const key = document.activeElement.getAttribute('data-key');
    if (pluginId && key) {
      focusedInputSelector = `.plugin-config-input[data-plugin-id="${pluginId}"][data-key="${key}"]`;
      selectionStart = document.activeElement.selectionStart;
      selectionEnd = document.activeElement.selectionEnd;
    }
  }

  const { httpUrl } = getApiUrls();
  if (forceFetch || !window.installedPluginsData || !window.marketplacePluginsData) {
    listContainer.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:24px 0;">Loading installed plugins...</p>`;
    try {
      const [instRes, catRes] = await Promise.all([
        fetch(`${httpUrl}/api/plugins/installed`),
        fetch(`${httpUrl}/api/plugins/marketplace`).catch((e): any => { console.error(e); return { ok: false }; })
      ]);
      if (!instRes.ok) throw new Error(`HTTP ${instRes.status}`);
      window.installedPluginsData = await instRes.json();
      if (catRes && catRes.ok) {
        window.marketplacePluginsData = await catRes.json();
      } else {
        window.marketplacePluginsData = window.marketplacePluginsData || [];
      }
    } catch (err) {
      listContainer.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem; text-align:center; padding:24px 0;">Failed to load installed plugins list: ${err.message}</p>`;
      return;
    }
  }

  // Read search term
  const searchInput = document.getElementById('plugin-search');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = window.installedPluginsData.filter(p => {
    return p.name.toLowerCase().includes(searchVal) ||
      p.id.toLowerCase().includes(searchVal) ||
      (p.description && p.description.toLowerCase().includes(searchVal));
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:32px 0;">No matching installed plugins found.</p>`;
    return;
  }

  const layout = window.pluginsViewLayout || 'grid';
  if (layout === 'grid') {
    listContainer.style.cssText = "display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;";
  } else {
    listContainer.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
  }

  listContainer.innerHTML = filtered.map(p => {
    const entityKeyStatus = `plugin-${p.id}-status`;
    const entityVal = (cachedEntities && cachedEntities[entityKeyStatus]) ? cachedEntities[entityKeyStatus] : null;
    const runningStatus = entityVal ? (entityVal.attributes?.status || 'stopped') : (p.enabled ? 'running' : 'stopped');

    const marketplacePlugin = (window.marketplacePluginsData || []).find(m => m.id === p.id);
    const hasUpdate = marketplacePlugin && marketplacePlugin.version !== p.version;

    let badgeColor = '#ef4444'; // Red for stopped/crashed
    let statusText = runningStatus;
    if (runningStatus === 'running') badgeColor = '#10b981'; // Green
    if (runningStatus === 'crashed') badgeColor = '#f59e0b'; // Amber
    if (hasUpdate) {
      badgeColor = '#eab308'; // Yellow
      statusText = 'update available';
    }

    let cardBg = 'rgba(255,255,255,0.02)';
    let cardBorder = 'var(--border-soft)';
    let updateBtnHTML = '';
    if (hasUpdate) {
      cardBg = 'rgba(234,179,8,0.03)';
      cardBorder = '#eab308';
      updateBtnHTML = `
        <button class="btn btn-primary" onclick="installSelectedPlugin('${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:#eab308; border-color:#eab308; color:#000; font-weight:700;">
          Update to v${marketplacePlugin.version}
        </button>
      `;
    }

    const schema = p.settings_schema || {};
    const config = p.config || {};
    let configFieldsHTML = '';

    if (Object.keys(schema).length > 0) {
      configFieldsHTML = Object.keys(schema).map(key => {
        const field = schema[key];
        const savedVal = currentInputValues[`${p.id}:${key}`];
        const val = savedVal !== undefined ? savedVal : (config[key] !== undefined ? config[key] : (field.default !== undefined ? field.default : ''));
        const label = field.label || key.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const isPassword = field.type === 'password' || field.secret;
        const inputType = isPassword ? 'password' : (field.type === 'integer' ? 'number' : 'text');

        if (isPassword) {
          const uniqueInputId = `secret-${p.id}-${key}`.replace(/[^a-zA-Z0-9-]/g, '_');
          return `
            <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px; width: 100%;">
              <label style="font-size:0.75rem; color:#fff; font-weight:600;">${label}</label>
              <div style="position:relative; width: 100%; display:flex; align-items:center;">
                <input id="${uniqueInputId}" type="password" class="settings-input plugin-config-input" data-plugin-id="${p.id}" data-key="${key}" value="${val}" style="padding: 8px 36px 8px 12px; font-size:0.8rem; width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.22); border: 1px solid var(--border-soft); border-radius: 4px; color:#fff;">
                <button type="button" onclick="window.toggleSecretVisibility('${uniqueInputId}')" style="position:absolute; right:10px; background:none; border:none; cursor:pointer; padding:4px; display:flex; align-items:center; justify-content:center; color:var(--text-secondary); outline:none;">
                  <i id="eye-icon-${uniqueInputId}" data-lucide="eye" style="width:16px; height:16px; pointer-events:none;"></i>
                </button>
              </div>
            </div>
          `;
        }

        return `
          <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px; width: 100%;">
            <label style="font-size:0.75rem; color:#fff; font-weight:600;">${label}</label>
            <input type="${inputType}" class="settings-input plugin-config-input" data-plugin-id="${p.id}" data-key="${key}" value="${val}" style="padding: 8px 12px; font-size:0.8rem; width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.22); border: 1px solid var(--border-soft); border-radius: 4px; color:#fff;">
          </div>
        `;
      }).join('');
    } else {
      configFieldsHTML = `<p style="color:var(--text-secondary); font-size:0.7rem; font-style:italic;">No setup parameters required for this module.</p>`;
    }

    if (layout === 'grid') {
      return `
        <div class="plugin-card" style="background: ${cardBg}; border: 1px solid ${cardBorder}; border-radius: 8px; padding: 18px; display: flex; flex-direction: column; gap: 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <h4 style="margin:0; font-size:0.95rem; font-weight:700; color:#fff;">${p.name} <span style="font-size:0.75rem; color:var(--text-secondary); font-weight:normal;">(v${p.version})</span></h4>
              <p style="margin:4px 0 0 0; font-size:0.75rem; color:var(--text-secondary);">${p.description || ''}</p>
            </div>
            
            <div style="display:flex; align-items:center; gap:12px;">
              <span class="status-pill" style="background:${badgeColor}; color:${hasUpdate ? '#000' : '#fff'}; text-transform:uppercase; font-size:0.6rem; padding: 3px 8px; border-radius: 4px; font-weight:${hasUpdate ? '700' : 'normal'};">${statusText}</span>
              
              <label class="switch">
                <input type="checkbox" ${p.enabled ? 'checked' : ''} onclick="toggleInstalledPlugin('${p.id}')">
                <span class="slider-checkbox round"></span>
              </label>
            </div>
          </div>

          <details ${openPluginDetails.has(p.id) ? 'open' : ''} style="border-top:1px dashed var(--border-soft); padding-top:12px; margin-top:8px;">
            <summary style="font-size:0.75rem; color:var(--accent-orange); cursor:pointer; outline:none; font-weight:600;">Configuration setup & credentials</summary>
            <div style="padding-top:12px; display:flex; flex-direction:column; gap:4px; max-width: 100%;">
              ${configFieldsHTML}
              <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
                ${updateBtnHTML}
                <button class="btn btn-primary" onclick="savePluginConfig('${p.id}')" style="font-size:0.7rem; padding:6px 12px;">Save Params</button>
                <button class="btn btn-secondary" onclick="openHostDetail('plugin-${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.4); color:#93c5fd;">View Telemetry</button>
                ${p.has_readme ? `<button class="btn btn-secondary" onclick="showPluginReadme('${p.id}', false)" style="font-size:0.7rem; padding:6px 12px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">Readme</button>` : ''}
                <button class="btn btn-secondary" onclick="showPluginLogs('${p.id}', '${p.name}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">Logs</button>
                <button class="btn btn-danger" onclick="killPlugin('${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5;">Force Kill</button>
                <button class="btn btn-danger" onclick="uninstallPlugin('${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#fecaca; margin-left:auto;">Uninstall</button>
              </div>
            </div>
          </details>
        </div>
      `;
    } else {
      return `
        <div style="background: ${cardBg}; border: 1px solid ${cardBorder}; border-radius: 8px; padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px;">
          <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
            <h4 style="margin:0; font-size:0.9rem; font-weight:700; color:#fff;">${p.name} <span style="font-size:0.75rem; color:var(--text-secondary); font-weight:normal;">(v${p.version})</span></h4>
            <p style="margin:0; font-size:0.75rem; color:var(--text-secondary);">${p.description || ''}</p>
          </div>
          <div style="display:flex; align-items:center; gap:16px;">
            <span class="status-pill" style="background:${badgeColor}; color:${hasUpdate ? '#000' : '#fff'}; text-transform:uppercase; font-size:0.6rem; padding: 3px 8px; border-radius: 4px; font-weight:${hasUpdate ? '700' : 'normal'};">${statusText}</span>
            <label class="switch">
              <input type="checkbox" ${p.enabled ? 'checked' : ''} onclick="toggleInstalledPlugin('${p.id}')">
              <span class="slider-checkbox round"></span>
            </label>
            <details ${openPluginDetails.has(p.id) ? 'open' : ''} style="position:relative;">
              <summary style="font-size:0.75rem; color:var(--accent-orange); cursor:pointer; outline:none; font-weight:600; list-style:none;">Config</summary>
              <div style="position:absolute; right:0; top:24px; background:#181614; border:1px solid var(--border-soft); border-radius:8px; padding:16px; min-width:320px; z-index:100; box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                ${configFieldsHTML}
                <div style="display:flex; gap:10px; margin-top:8px; justify-content:flex-end; flex-wrap:wrap;">
                  ${updateBtnHTML}
                  <button class="btn btn-primary" onclick="savePluginConfig('${p.id}')" style="font-size:0.7rem; padding:6px 12px;">Save Params</button>
                  <button class="btn btn-secondary" onclick="openHostDetail('plugin-${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.4); color:#93c5fd;">View Telemetry</button>
                  ${p.has_readme ? `<button class="btn btn-secondary" onclick="showPluginReadme('${p.id}', false)" style="font-size:0.7rem; padding:6px 12px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">Readme</button>` : ''}
                  <button class="btn btn-secondary" onclick="showPluginLogs('${p.id}', '${p.name}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">Logs</button>
                  <button class="btn btn-danger" onclick="killPlugin('${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5;">Force Kill</button>
                  <button class="btn btn-danger" onclick="uninstallPlugin('${p.id}')" style="font-size:0.7rem; padding:6px 12px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#fecaca;">Uninstall</button>
                </div>
              </div>
            </details>
          </div>
        </div>
      `;
    }
  }).join('');

  // Restore focus and selection cursor range
  if (focusedInputSelector) {
    const restoreEl = listContainer.querySelector(focusedInputSelector);
    if (restoreEl) {
      restoreEl.focus();
      try {
        if (selectionStart !== null && selectionEnd !== null) {
          restoreEl.setSelectionRange(selectionStart, selectionEnd);
        }
      } catch (e) {
        // Safe fail for number inputs
      }
    }
  }
}

async function loadMarketplacePlugins(forceFetch = false) {
  const storeContainer = document.getElementById('marketplace-plugins-list');
  if (!storeContainer) return;

  const { httpUrl } = getApiUrls();

  // Decoupled installed state: fetch fresh local info on every store view load.
  let installed = [];
  try {
    const instRes = await fetch(`${httpUrl}/api/plugins/installed`);
    if (instRes.ok) installed = await instRes.json();
  } catch (e) {
    console.error("Failed to load active installed list:", e);
  }
  window.installedPluginsListForMarketplace = installed;

  if (forceFetch || !window.marketplacePluginsData) {
    storeContainer.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:24px 0; grid-column:1/-1;">Loading plugins catalog from Github index repository...</p>`;
    try {
      const catRes = await fetch(`${httpUrl}/api/plugins/marketplace`);
      if (!catRes.ok) throw new Error(`HTTP ${catRes.status}`);
      window.marketplacePluginsData = await catRes.json();
    } catch (err) {
      storeContainer.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem; text-align:center; padding:24px 0; grid-column:1/-1;">Could not fetch remote marketplace elements: ${err.message}</p>`;
      return;
    }
  }

  const searchInput = document.getElementById('plugin-search');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = window.marketplacePluginsData.filter(p => {
    return p.name.toLowerCase().includes(searchVal) ||
      p.id.toLowerCase().includes(searchVal) ||
      (p.description && p.description.toLowerCase().includes(searchVal));
  });

  if (filtered.length === 0) {
    storeContainer.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:32px 0; grid-column:1/-1;">No matching marketplace plugins found.</p>`;
    return;
  }

  const targetInstalled = window.installedPluginsListForMarketplace || [];
  const installedIds = targetInstalled.map(i => i.id);

  const layout = window.pluginsViewLayout || 'grid';

  if (layout === 'grid') {
    storeContainer.style.cssText = "display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;";
  } else {
    storeContainer.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
  }

  storeContainer.innerHTML = filtered.map(p => {
    const isInstalled = installedIds.includes(p.id);
    const isOutdated = isInstalled && (targetInstalled.find(i => i.id === p.id)?.version !== p.version);

    let actionBtnHTML = `
      <button class="btn btn-primary" onclick="installSelectedPlugin('${p.id}')" style="width:100%; font-size:0.75rem; padding:8px 0; margin-top:12px;">
        Install Plugin
      </button>
    `;
    if (isInstalled) {
      if (isOutdated) {
        actionBtnHTML = `
          <button class="btn btn-secondary" onclick="installSelectedPlugin('${p.id}')" style="width:100%; font-size:0.75rem; padding:8px 0; margin-top:12px; border-color:var(--accent-orange); color:var(--accent-orange);">
            Update (v${p.version})
          </button>
        `;
      } else {
        actionBtnHTML = `
          <button class="btn btn-secondary" disabled style="width:100%; font-size:0.75rem; padding:8px 0; margin-top:12px; opacity:0.5; cursor:not-allowed;">
            Already Installed
          </button>
        `;
      }
    }

    if (layout === 'grid') {
      const readmeBtnHTML = p.has_readme ? `
        <button class="btn btn-secondary" onclick="showPluginReadme('${p.id}', true)" style="width:100%; font-size:0.75rem; padding:8px 0; margin-top:6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">
          Readme
        </button>
      ` : '';
      return `
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-soft); border-radius: 8px; padding: 18px; display:flex; flex-direction:column; justify-content:space-between;">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h4 style="margin:0; font-size:0.9rem; font-weight:700; color:#fff;">${p.name}</h4>
              <span style="font-size:0.65rem; background:rgba(255,255,255,0.08); color:var(--text-secondary); padding:2px 6px; border-radius:3px;">v${p.version}</span>
            </div>
            <p style="margin:8px 0 0 0; font-size:0.75rem; color:var(--text-secondary); line-height:1.4;">${p.description || ''}</p>
          </div>
          <div style="margin-top:12px; display:flex; flex-direction:column; gap:4px;">
            ${actionBtnHTML.replace('margin-top:12px;', 'margin-top:0;')}
            ${readmeBtnHTML.replace('margin-top:6px;', 'margin-top:0;')}
          </div>
        </div>
      `;
    } else {
      let listActionBtnHTML = actionBtnHTML.replace('margin-top:12px;', 'margin-top:0;');
      const listReadmeBtnHTML = p.has_readme ? `
        <button class="btn btn-secondary" onclick="showPluginReadme('${p.id}', true)" style="font-size:0.75rem; padding:6px 12px; background:rgba(255,255,255,0.05); border:1px solid var(--border-soft); color:#e4e4e7;">
          Readme
        </button>
      ` : '';
      return `
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-soft); border-radius: 8px; padding: 12px 18px; display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; flex-direction:column; gap:4px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <h4 style="margin:0; font-size:0.9rem; font-weight:700; color:#fff;">${p.name}</h4>
              <span style="font-size:0.65rem; background:rgba(255,255,255,0.08); color:var(--text-secondary); padding:2px 6px; border-radius:3px;">v${p.version}</span>
            </div>
            <p style="margin:0; font-size:0.75rem; color:var(--text-secondary);">${p.description || ''}</p>
          </div>
          <div style="min-width:145px; display: flex; justify-content: flex-end; align-items:center; gap:8px;">
            ${listReadmeBtnHTML}
            ${listActionBtnHTML}
          </div>
        </div>
      `;
    }
  }).join('');
}

window.installSelectedPlugin = async function (pluginId) {
  const buttons = Array.from(document.querySelectorAll('button')).filter(btn => {
    const oc = btn.getAttribute('onclick') || '';
    return oc.includes('installSelectedPlugin') && oc.includes(pluginId);
  });

  const originalState = buttons.map(btn => ({
    element: btn,
    innerHTML: btn.innerHTML,
    disabled: btn.disabled,
    opacity: btn.style.opacity,
    cursor: btn.style.cursor
  }));

  buttons.forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
    btn.innerHTML = `
      <span style="display:inline-flex; align-items:center; gap:8px; justify-content:center; width:100%;">
        <svg class="chart-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: spin-loader 0.85s linear infinite; margin: 0; display: inline-block;">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity:0.25;"></circle>
          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        Installing...
      </span>
    `;
  });

  showToast(`Initiating download loop for "${pluginId}"...`, 'info');
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/install/${pluginId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      window.installedPluginsData = null;
      window.marketplacePluginsData = null;
      showToast(`Successfully extracted "${pluginId}" files. Spawning env build...`, 'success');
      switchPluginTab('installed');
    } else {
      const data = await res.json();
      alert(`Installation failure: ${data.detail || 'unknown error'}`);
      originalState.forEach(state => {
        state.element.disabled = state.disabled;
        state.element.innerHTML = state.innerHTML;
        state.element.style.opacity = state.opacity;
        state.element.style.cursor = state.cursor;
      });
    }
  } catch (err) {
    showToast(`Install request failed: ${err.message}`, 'error');
    originalState.forEach(state => {
      state.element.disabled = state.disabled;
      state.element.innerHTML = state.innerHTML;
      state.element.style.opacity = state.opacity;
      state.element.style.cursor = state.cursor;
    });
  }
};

window.toggleInstalledPlugin = async function (pluginId) {
  const checkbox = document.querySelector(`input[type="checkbox"][onclick*="toggleInstalledPlugin('${pluginId}')"]`) ||
    document.querySelector(`input[type="checkbox"][onclick*="toggleInstalledPlugin(\"${pluginId}\")"]`);

  if (checkbox) {
    checkbox.disabled = true;
  }

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/toggle/${pluginId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      window.installedPluginsData = null;
      const data = await res.json();

      const entKey = `plugin-${pluginId}-status`;
      if (typeof cachedEntities !== 'undefined' && cachedEntities) {
        cachedEntities[entKey] = cachedEntities[entKey] || {
          node_id: 'plugins',
          entity_key: entKey,
          name: `Plugin: ${pluginId}`,
          type: 'binary_sensor'
        };
        cachedEntities[entKey].value = data.enabled ? 'ON' : 'OFF';
        cachedEntities[entKey].attributes = cachedEntities[entKey].attributes || {};
        cachedEntities[entKey].attributes.status = data.enabled ? 'running' : 'stopped';
      }

      showToast(`Plugin toggled successfully. Active: ${data.enabled}`, 'success');
      loadInstalledPlugins();
      if (typeof loadHosts === 'function') {
        loadHosts();
      }
    } else {
      alert("Failed to toggle plugin process.");
      loadInstalledPlugins();
    }
  } catch (err) {
    showToast(`Toggle operation failed: ${err.message}`, 'error');
    loadInstalledPlugins();
  } finally {
    if (checkbox) {
      checkbox.disabled = false;
    }
  }
};

window.savePluginConfig = async function (pluginId) {
  const inputs = document.querySelectorAll(`.plugin-config-input[data-plugin-id="${pluginId}"]`);
  const config = {};
  inputs.forEach(inp => {
    const key = inp.getAttribute('data-key');
    config[key] = inp.value;
  });

  showToast(`Saving parameter changes for "${pluginId}"...`, 'info');
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/config/${pluginId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ config })
    });
    if (res.ok) {
      window.installedPluginsData = null;
      showToast("Configuration parameters updated.", 'success');
      loadInstalledPlugins();
    } else {
      alert("Failed to compile configurations parameters update.");
    }
  } catch (err) {
    showToast(`Config save failed: ${err.message}`, 'error');
  }
};

window.uninstallPlugin = async function (pluginId) {
  if (!await showConfirm(`Are you sure you want to stop process and delete all files for "${pluginId}"?`, "Uninstall Plugin")) return;

  showToast(`Pruning entries and directory files for "${pluginId}"...`, 'info');
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/uninstall/${pluginId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      window.installedPluginsData = null;
      window.marketplacePluginsData = null;
      showToast("Plugin uninstalled successfully.", 'success');
      loadInstalledPlugins();
    } else {
      alert("Failed to uninstall plugin.");
    }
  } catch (err) {
    showToast(`Uninstall operations failed: ${err.message}`, 'error');
  }
};

window.activeLogPluginId = null;
window.activeLogPluginName = '';
window.logRefreshInterval = null;

window.showPluginLogs = function (pluginId, pluginName) {
  window.activeLogPluginId = pluginId;
  window.activeLogPluginName = pluginName;

  const title = document.getElementById('plugin-log-title');
  if (title) title.textContent = `Execution Logs: ${pluginName}`;

  window.openModal('plugin-log-modal');
  refreshPluginLogs();

  // Auto refresh every 3 seconds
  if (window.logRefreshInterval) clearInterval(window.logRefreshInterval);
  window.logRefreshInterval = setInterval(refreshPluginLogs, 3000);
};

window.closePluginLogModal = function () {
  window.closeModal('plugin-log-modal');
};

const originalCloseModal = window.closeModal;
window.closeModal = function (modalId) {
  if (modalId === 'plugin-log-modal') {
    if (window.logRefreshInterval) {
      clearInterval(window.logRefreshInterval);
      window.logRefreshInterval = null;
    }
  }
  if (originalCloseModal) originalCloseModal(modalId);
};

window.refreshPluginLogs = async function () {
  if (!window.activeLogPluginId) return;
  const body = document.getElementById('plugin-log-body');
  if (!body) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/logs/${window.activeLogPluginId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      const logs = data.logs || [];
      if (logs.length === 0) {
        body.textContent = 'No logs captured yet.';
      } else {
        body.textContent = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
        // Scroll to bottom
        body.scrollTop = body.scrollHeight;
      }
    } else {
      body.textContent = 'Failed to fetch logs from server.';
    }
  } catch (err) {
    body.textContent = `Error: ${err.message}`;
  }
};

window.killPlugin = async function (pluginId) {
  if (!await showConfirm(`Are you sure you want to force terminate the plugin "${pluginId}" process immediately?`, "Force Kill Plugin")) return;

  showToast(`Killing plugin process "${pluginId}"...`, 'info');
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/plugins/kill/${pluginId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      window.installedPluginsData = null;
      showToast("Plugin force killed.", 'success');
      loadInstalledPlugins();
    } else {
      const data = await res.json();
      alert(`Kill failure: ${data.detail || 'unknown error'}`);
    }
  } catch (err) {
    showToast(`Kill request failed: ${err.message}`, 'error');
  }
};

window.showPluginReadme = async function (pluginId, isMarketplace) {
  const title = document.getElementById('plugin-readme-title');
  const body = document.getElementById('plugin-readme-body');

  if (title) title.textContent = `Documentation: ${pluginId}`;
  if (body) body.innerHTML = '<p style="color:var(--text-secondary); font-style:italic;">Loading documentation...</p>';

  window.openModal('plugin-readme-modal');

  const { httpUrl } = getApiUrls();
  try {
    let url = '';
    if (isMarketplace) {
      const p = (window.marketplacePluginsData || []).find(m => m.id === pluginId);
      if (p && p.readme_url) {
        url = p.readme_url;
      } else {
        throw new Error("Online README URL not found. The plugin might not have documentation.");
      }
    } else {
      url = `${httpUrl}/api/plugins/readme/${pluginId}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load README file: ${res.statusText}`);
    }

    let markdown = '';
    if (isMarketplace) {
      markdown = await res.text();
    } else {
      const data = await res.json();
      markdown = data.content;
    }

    if (body) {
      body.innerHTML = parseMarkdownToHTML(markdown);
    }
  } catch (err) {
    if (body) {
      body.innerHTML = `<p style="color:#f87171; font-weight:600;">Error: ${err.message}</p>`;
    }
  }
};

function parseMarkdownToHTML(md: string): string {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    return `<pre style="background:rgba(0,0,0,0.3); padding:12px; border-radius:6px; border:1px solid var(--border-soft); overflow-x:auto; margin:12px 0;"><code style="font-family:monospace; font-size:0.8rem; color:#fca5a5;">${code.trim()}</code></pre>`;
  });

  html = html.replace(/`([^`]+)`/g, '<code style="font-family:monospace; background:rgba(255,255,255,0.08); padding:2px 4px; border-radius:3px; font-size:0.85em; color:#fca5a5;">$1</code>');

  html = html.replace(/^# (.*$)/gim, '<h2 style="margin:20px 0 10px 0; color:#fff; font-size:1.4rem; border-bottom:1px solid var(--border-soft); padding-bottom:6px;">$1</h2>');
  html = html.replace(/^## (.*$)/gim, '<h3 style="margin:16px 0 8px 0; color:#fff; font-size:1.15rem;">$1</h3>');
  html = html.replace(/^### (.*$)/gim, '<h4 style="margin:12px 0 6px 0; color:#fff; font-size:1rem;">$1</h4>');

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#fff;">$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const lines = html.split('\n');
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('* ') || line.startsWith('- ')) {
      if (!inList) {
        lines[i] = '<ul style="margin:8px 0; padding-left:20px; list-style-type:disc;">\n<li style="margin:4px 0; font-size:0.8rem; color:var(--text-secondary);">' + line.substring(2) + '</li>';
        inList = true;
      } else {
        lines[i] = '<li style="margin:4px 0; font-size:0.8rem; color:var(--text-secondary);">' + line.substring(2) + '</li>';
      }
    } else {
      if (inList) {
        lines[i - 1] = lines[i - 1] + '\n</ul>';
        inList = false;
      }
      if (line !== '' && !line.startsWith('<h') && !line.startsWith('<pre') && !line.startsWith('<ul') && !line.startsWith('</ul') && !line.startsWith('<li')) {
        lines[i] = `<p style="margin:8px 0; font-size:0.8rem; line-height:1.5; color:var(--text-secondary);">${line}</p>`;
      }
    }
  }
  if (inList) {
    lines[lines.length - 1] = lines[lines.length - 1] + '\n</ul>';
  }
  html = lines.join('\n');
  return html;
}

window.filterEmbedTable = function (tableId) {
  const input = document.getElementById(`search-input-${tableId}`);
  if (!input) return;
  const filter = input.value.toLowerCase().trim();
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr.table-row');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(filter) ? '' : 'none';
  });
};

window.toggleSecretVisibility = function (inputId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(`eye-icon-${inputId}`);
  if (!input || !icon) return;

  if (input.type === 'password') {
    input.type = 'text';
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    icon.setAttribute('data-lucide', 'eye');
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
};


