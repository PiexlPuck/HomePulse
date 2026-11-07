// ============================================================================
// Module: src/06-history-analytics.ts
// Description: Zabbix-Style History Analytics, Combobox & Chart.js Visualizations
// ============================================================================

// Expose loadHistoryAnalytics to window so dropdown shifts can invoke it
window.loadHistoryAnalytics = loadHistoryAnalytics;

function showUptimeHistoryView(): void {
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.classList.contains('edit-mode')) {
    const editToggleBtn = document.getElementById('edit-toggle-btn');
    if (editToggleBtn) editToggleBtn.click();
  }

  const editToggleBtn = document.getElementById('edit-toggle-btn');
  if (editToggleBtn) editToggleBtn.style.display = 'none';

  hideAllViews();

  const uptimeHistoryView = document.getElementById('uptime-history-view');
  if (uptimeHistoryView) uptimeHistoryView.classList.remove('hide');

  const navHistory = document.getElementById('nav-history');
  if (navHistory) navHistory.classList.add('active');

  populateHistoryMonitorsDropdown();
}

function formatDateTimeLocal(d) {
  if (!d || isNaN(d.getTime())) d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

window.historyAllSourceItems = [];
window.historyActiveCategory = 'all';
window.historyComboboxHighlightedIndex = -1;
window.historyCurrentPreset = '1h';

window.openHistoryCombobox = function() {
  const popup = document.getElementById('history-combobox-popup');
  const chevron = document.getElementById('history-combobox-chevron');
  const wrapper = document.getElementById('history-combobox-wrapper');
  if (!popup) return;

  popup.style.display = 'flex';
  if (chevron) chevron.style.transform = 'rotate(180deg)';
  if (wrapper) wrapper.style.borderColor = 'var(--color-primary)';

  renderComboboxCategoryTabs();
  renderComboboxItems();
};

window.closeHistoryCombobox = function() {
  const popup = document.getElementById('history-combobox-popup');
  const chevron = document.getElementById('history-combobox-chevron');
  const wrapper = document.getElementById('history-combobox-wrapper');
  if (popup) popup.style.display = 'none';
  if (chevron) chevron.style.transform = 'rotate(0deg)';
  if (wrapper) wrapper.style.borderColor = 'var(--border-soft)';
  window.historyComboboxHighlightedIndex = -1;
};

window.toggleHistoryCombobox = function() {
  const popup = document.getElementById('history-combobox-popup');
  if (popup && popup.style.display === 'flex') {
    closeHistoryCombobox();
  } else {
    openHistoryCombobox();
    const input = document.getElementById('history-combobox-input');
    if (input) input.focus();
  }
};

window.filterComboboxByCategory = function(categoryKey) {
  window.historyActiveCategory = categoryKey;
  renderComboboxCategoryTabs();
  renderComboboxItems();
  const input = document.getElementById('history-combobox-input');
  if (input) input.focus();
};

window.onHistoryComboboxInput = function(query) {
  openHistoryCombobox();
  const clearBtn = document.getElementById('btn-history-clear-sensor');
  if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
  renderComboboxItems(query);
};

window.clearHistoryComboboxSelection = function() {
  const input = document.getElementById('history-combobox-input');
  const clearBtn = document.getElementById('btn-history-clear-sensor');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (clearBtn) clearBtn.style.display = 'none';
  window.historyActiveCategory = 'all';
  renderComboboxCategoryTabs();
  renderComboboxItems('');
};

window.onHistoryComboboxKeyDown = function(e) {
  const popup = document.getElementById('history-combobox-popup');
  const itemsContainer = document.getElementById('history-combobox-items-list');
  if (!popup || popup.style.display !== 'flex') {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      openHistoryCombobox();
      return;
    }
  }

  if (e.key === 'Escape') {
    closeHistoryCombobox();
    return;
  }

  const renderedItems = itemsContainer ? Array.from(itemsContainer.querySelectorAll('.combobox-item')) : [];
  if (renderedItems.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    window.historyComboboxHighlightedIndex = Math.min(renderedItems.length - 1, window.historyComboboxHighlightedIndex + 1);
    updateComboboxHighlight(renderedItems);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    window.historyComboboxHighlightedIndex = Math.max(0, window.historyComboboxHighlightedIndex - 1);
    updateComboboxHighlight(renderedItems);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (window.historyComboboxHighlightedIndex >= 0 && window.historyComboboxHighlightedIndex < renderedItems.length) {
      const val = renderedItems[window.historyComboboxHighlightedIndex].getAttribute('data-value');
      selectHistoryComboboxOption(val);
    } else if (renderedItems.length > 0) {
      const val = renderedItems[0].getAttribute('data-value');
      selectHistoryComboboxOption(val);
    } else {
      const input = document.getElementById('history-combobox-input');
      if (input && input.value.trim()) {
        selectHistoryComboboxOption(input.value.trim(), true);
      }
    }
  }
};

function updateComboboxHighlight(items) {
  items.forEach((item, idx) => {
    if (idx === window.historyComboboxHighlightedIndex) {
      item.style.background = 'rgba(59, 130, 246, 0.2)';
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.style.background = item.classList.contains('active-item') ? 'rgba(59, 130, 246, 0.12)' : '';
    }
  });
}

function renderComboboxCategoryTabs() {
  const tabsContainer = document.getElementById('history-combobox-category-tabs');
  if (!tabsContainer) return;

  const catMap = {
    'all': { label: 'All', count: window.historyAllSourceItems.length }
  };

  window.historyAllSourceItems.forEach(item => {
    const cat = item.category || 'other';
    if (!catMap[cat]) {
      catMap[cat] = {
        label: item.categoryLabel || cat,
        count: 0
      };
    }
    catMap[cat].count++;
  });

  let tabsHtml = '';
  Object.keys(catMap).forEach(catKey => {
    const info = catMap[catKey];
    const isActive = (window.historyActiveCategory || 'all') === catKey;
    const bg = isActive ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.05)';
    const border = isActive ? '1px solid var(--color-primary)' : '1px solid rgba(255, 255, 255, 0.08)';
    const color = isActive ? '#fff' : 'var(--text-secondary)';
    const fw = isActive ? '600' : 'normal';

    tabsHtml += `
      <button type="button" onclick="event.stopPropagation(); filterComboboxByCategory('${catKey}')"
        style="background: ${bg}; border: ${border}; color: ${color}; font-size: 0.68rem; font-weight: ${fw}; padding: 3px 8px; border-radius: 12px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; transition: all 0.15s;">
        <span>${info.label}</span>
        <span style="opacity: 0.6; font-size: 0.62rem;">(${info.count})</span>
      </button>
    `;
  });

  tabsContainer.innerHTML = tabsHtml;
}

function renderComboboxItems(searchQuery: string = '') {
  const container = document.getElementById('history-combobox-items-list');
  if (!container) return;

  const q = (searchQuery !== undefined ? searchQuery : (document.getElementById('history-combobox-input')?.value || '')).trim().toLowerCase();
  const select = document.getElementById('history-monitor-select');
  const currentVal = select ? select.value : '';

  let filtered = window.historyAllSourceItems || [];

  if (window.historyActiveCategory && window.historyActiveCategory !== 'all') {
    filtered = filtered.filter(item => item.category === window.historyActiveCategory);
  }

  if (q) {
    filtered = filtered.filter(item => {
      const name = (item.name || '').toLowerCase();
      const sId = (item.sensorId || '').toLowerCase();
      const key = (item.key || '').toLowerCase();
      const id = String(item.id || '').toLowerCase();
      const cat = (item.categoryLabel || '').toLowerCase();
      return name.includes(q) || sId.includes(q) || key.includes(q) || id === q || cat.includes(q);
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding: 16px 12px; text-align: center; color: var(--text-secondary); font-size: 0.75rem;">
        No sensors found for <strong>"${q}"</strong>. Press <kbd style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 3px; font-family: monospace;">Enter</kbd> to search custom ID directly.
      </div>
    `;
    window.historyComboboxHighlightedIndex = -1;
    return;
  }

  window.historyComboboxHighlightedIndex = -1;

  let itemsHtml = '';
  filtered.forEach(item => {
    const isSelected = item.value === currentVal;
    const bg = isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent';
    const borderLeft = isSelected ? '3px solid var(--color-primary)' : '3px solid transparent';
    const activeClass = isSelected ? 'active-item' : '';

    let badgeBg = 'rgba(255, 255, 255, 0.08)';
    let badgeColor = 'var(--text-secondary)';
    if (item.category === 'monitors') {
      badgeBg = 'rgba(59, 130, 246, 0.15)';
      badgeColor = '#60a5fa';
    } else if (item.category === 'core') {
      badgeBg = 'rgba(16, 185, 129, 0.15)';
      badgeColor = '#34d399';
    } else {
      badgeBg = 'rgba(245, 158, 11, 0.15)';
      badgeColor = '#fbbf24';
    }

    itemsHtml += `
      <div class="combobox-item ${activeClass}" data-value="${item.value}" onclick="selectHistoryComboboxOption('${item.value}')"
        onmouseenter="if(!this.classList.contains('active-item')) this.style.background='rgba(255,255,255,0.06)'"
        onmouseleave="if(!this.classList.contains('active-item')) this.style.background='transparent'"
        style="display: flex; flex-direction: column; gap: 3px; padding: 7px 10px; border-radius: 6px; cursor: pointer; transition: background 0.12s; background: ${bg}; border-left: ${borderLeft};">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
            <span style="font-size: 0.6rem; padding: 1px 6px; border-radius: 3px; font-weight: 700; text-transform: uppercase; background: ${badgeBg}; color: ${badgeColor}; flex-shrink: 0;">${item.categoryLabel}</span>
            <span style="font-size: 0.78rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</span>
          </div>
          <span style="font-size: 0.65rem; color: var(--text-secondary); font-family: monospace; flex-shrink: 0;">${item.typeStr || ''}</span>
        </div>
        <div style="font-size: 0.66rem; color: var(--text-secondary); font-family: monospace; display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <span style="opacity: 0.6;">ID:</span>
          <span style="color: var(--accent-orange);">${item.sensorId || item.key}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = itemsHtml;
}

window.selectHistoryComboboxOption = function(val, isCustom = false) {
  const select = document.getElementById('history-monitor-select');
  const input = document.getElementById('history-combobox-input');
  const clearBtn = document.getElementById('btn-history-clear-sensor');

  let item = (window.historyAllSourceItems || []).find(i => i.value === val);

  if (!item && isCustom) {
    item = {
      value: `direct-${val}`,
      name: `Custom ID: ${val}`,
      category: 'other',
      categoryLabel: 'Custom',
      sensorId: val,
      key: val,
      source: 'direct'
    };
    window.historyAllSourceItems.unshift(item);
  }

  if (item) {
    if (select) {
      let opt: any = Array.from(select.options).find((o: any) => o.value === item.value);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = item.value;
        opt.setAttribute('data-source', item.source);
        opt.setAttribute('data-key', item.key);
        opt.setAttribute('data-name', item.name);
        opt.setAttribute('data-sensor-id', item.sensorId);
        if (item.id) opt.setAttribute('data-id', item.id);
        if (item.type) opt.setAttribute('data-type', item.type);
        select.appendChild(opt);
      }
      select.value = item.value;
    }

    if (input) {
      input.value = item.name;
    }
    if (clearBtn) clearBtn.style.display = 'block';

    updateActiveQueryBanner(item.name, item.sensorId);
    closeHistoryCombobox();
    loadHistoryAnalytics();
  }
};

// Global click outside listener to close combobox popup
document.addEventListener('click', function(e) {
  const popup = document.getElementById('history-combobox-popup');
  const wrapper = document.getElementById('history-combobox-wrapper');
  if (popup && popup.style.display === 'flex') {
    if (!popup.contains(e.target as Node) && !wrapper.contains(e.target as Node)) {
      closeHistoryCombobox();
    }
  }
});

window.applyHistoryPreset = function(preset, triggerLoad = true) {
  const chips = document.querySelectorAll('.btn-preset-chip');
  chips.forEach(chip => {
    const isMatch = chip.getAttribute('data-preset') === preset;
    chip.classList.toggle('active', isMatch);
    if (isMatch) {
      chip.style.background = 'rgba(59, 130, 246, 0.2)';
      chip.style.borderColor = 'var(--color-primary)';
      chip.style.color = '#fff';
      chip.style.fontWeight = '600';
    } else {
      chip.style.background = 'rgba(255, 255, 255, 0.06)';
      chip.style.borderColor = 'var(--border-soft)';
      chip.style.color = '#e2e8f0';
      chip.style.fontWeight = 'normal';
    }
  });

  let hours = 1;
  if (preset === '1h') hours = 1;
  else if (preset === '3h') hours = 3;
  else if (preset === '12h') hours = 12;
  else if (preset === '24h') hours = 24;
  else if (preset === '7d') hours = 168;
  else if (preset === '30d') hours = 720;

  const now = new Date();
  const start = new Date(now.getTime() - hours * 3600 * 1000);

  const startInput = document.getElementById('history-custom-start');
  const endInput = document.getElementById('history-custom-end');
  if (startInput) startInput.value = formatDateTimeLocal(start);
  if (endInput) endInput.value = formatDateTimeLocal(now);

  window.historyCurrentPreset = preset;
  updateShiftButtonsState();
  if (triggerLoad) {
    loadHistoryAnalytics();
  }
};

window.onCustomDateRangeChanged = function() {
  window.historyCurrentPreset = 'custom';
  const chips = document.querySelectorAll('.btn-preset-chip');
  chips.forEach(chip => {
    chip.classList.remove('active');
    chip.style.background = 'rgba(255, 255, 255, 0.06)';
    chip.style.borderColor = 'var(--border-soft)';
    chip.style.color = '#e2e8f0';
    chip.style.fontWeight = 'normal';
  });
  updateShiftButtonsState();
};

window.shiftHistoryTimeWindow = function(direction) {
  const startInput = document.getElementById('history-custom-start');
  const endInput = document.getElementById('history-custom-end');
  if (!startInput || !endInput || !startInput.value || !endInput.value) return;

  let sTime = new Date(startInput.value).getTime();
  let eTime = new Date(endInput.value).getTime();
  if (isNaN(sTime) || isNaN(eTime)) return;
  if (sTime > eTime) { const t = sTime; sTime = eTime; eTime = t; }

  let duration = eTime - sTime;
  if (duration <= 0) duration = 3600 * 1000;

  let newStart, newEnd;
  const now = Date.now();
  if (direction === -1) {
    newStart = new Date(sTime - duration);
    newEnd = new Date(eTime - duration);
  } else {
    newStart = new Date(sTime + duration);
    newEnd = new Date(eTime + duration);
    if (newEnd.getTime() > now) {
      newEnd = new Date(now);
      newStart = new Date(now - duration);
    }
  }

  startInput.value = formatDateTimeLocal(newStart);
  endInput.value = formatDateTimeLocal(newEnd);
  onCustomDateRangeChanged();
  loadHistoryAnalytics();
};

window.shiftHistoryTime = function(direction) {
  shiftHistoryTimeWindow(direction);
};

window.resetHistoryTimeOffset = function() {
  applyHistoryPreset('1h');
};

function updateShiftButtonsState() {
  const btnForward = document.getElementById('btn-history-shift-forward');
  const endInput = document.getElementById('history-custom-end');
  if (btnForward && endInput && endInput.value) {
    const eTime = new Date(endInput.value).getTime();
    const isAtPresent = (Date.now() - eTime) < 60000;
    btnForward.disabled = isAtPresent;
    btnForward.style.opacity = isAtPresent ? '0.5' : '1.0';
    btnForward.style.cursor = isAtPresent ? 'default' : 'pointer';
    const icon = btnForward.querySelector('i, svg');
    if (icon) {
      icon.style.color = isAtPresent ? 'var(--text-secondary)' : '#fff';
    }
  }
}

function updateActiveQueryBanner(metricName: any, sensorId?: any, recordCount?: any) {
  const select = document.getElementById('history-monitor-select');
  const opt = select ? select.options[select.selectedIndex] : null;

  const name = metricName || (opt ? (opt.getAttribute('data-name') || opt.text) : '--');
  const sId = sensorId || (opt ? (opt.getAttribute('data-sensor-id') || opt.getAttribute('data-key')) : null);

  const nameEl = document.getElementById('history-query-target-name');
  const idTextEl = document.getElementById('history-query-sensor-id-text');
  const idPill = document.getElementById('history-query-sensor-id-pill');
  const rangeEl = document.getElementById('history-query-date-range');
  const countEl = document.getElementById('history-query-record-count');

  if (nameEl) nameEl.textContent = name;
  if (idTextEl && idPill) {
    if (sId) {
      idTextEl.textContent = sId;
      idPill.style.display = 'inline-flex';
      window.currentActiveHistorySensorId = sId;
    } else {
      idPill.style.display = 'none';
      window.currentActiveHistorySensorId = null;
    }
  }

  const startInput = document.getElementById('history-custom-start');
  const endInput = document.getElementById('history-custom-end');
  if (rangeEl && startInput && endInput && startInput.value && endInput.value) {
    const s = new Date(startInput.value);
    const e = new Date(endInput.value);
    const formatDt = (d) => {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + 
             d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };
    rangeEl.textContent = `Range: ${formatDt(s)} → ${formatDt(e)}`;
  }

  if (countEl && recordCount !== undefined) {
    countEl.textContent = `${recordCount} record${recordCount === 1 ? '' : 's'}`;
  }
  if (window.lucide) window.lucide.createIcons();
}

window.copyActiveSensorId = function() {
  if (window.currentActiveHistorySensorId) {
    navigator.clipboard.writeText(window.currentActiveHistorySensorId).then(() => {
      showToast(`Copied Sensor ID: ${window.currentActiveHistorySensorId}`, 'success');
    }).catch(() => {
      prompt("Copy Sensor ID:", window.currentActiveHistorySensorId);
    });
  }
};

window.openHistoryForSensor = function(sensorId) {
  if (!sensorId) return;
  showUptimeHistoryView();
  setTimeout(() => {
    const clean = sensorId.trim().toLowerCase();
    const matched = (window.historyAllSourceItems || []).find(item => {
      const sId = (item.sensorId || '').toLowerCase();
      const key = (item.key || '').toLowerCase();
      return sId === clean || key === clean || item.value === clean;
    });

    if (matched) {
      selectHistoryComboboxOption(matched.value);
    } else {
      selectHistoryComboboxOption(sensorId, true);
    }
  }, 100);
};

async function populateHistoryMonitorsDropdown() {
  const select = document.getElementById('history-monitor-select');
  if (!select) return;

  const previousSelected = select.value;
  const { httpUrl } = getApiUrls();

  try {
    // 1. Fetch configured prober monitors
    const monitorsRes = await fetch(`${httpUrl}/api/monitors`);
    const monitors = monitorsRes.ok ? await monitorsRes.json() : [];
    window.allMonitorsCache = monitors;

    // 2. Fetch active entities (plugins and core telemetry)
    let entities = {};
    try {
      const entitiesRes = await fetch(`${httpUrl}/api/entities`);
      if (entitiesRes.ok) {
        entities = await entitiesRes.json();
      }
    } catch (e) {
      entities = window.cachedEntities || {};
    }

    window.historyAllSourceItems = [];
    let optionsHtml = '';

    // A. Probers & Monitors group
    if (monitors.length > 0) {
      monitors.forEach(mon => {
        const typeStr = (mon.type || 'ping').toUpperCase();
        const sensorIdStatus = window.getSensorIdForEntity ? window.getSensorIdForEntity('monitors', `monitor-${mon.id}-status`, mon.name, mon.type) : `ping.${mon.name}`;
        const sensorIdLatency = window.getSensorIdForEntity ? window.getSensorIdForEntity('monitors', `monitor-${mon.id}-latency`, mon.name, mon.type) : `sensor.${mon.name}_latency`;
        const optVal = `mon-${mon.id}`;

        window.historyAllSourceItems.push({
          value: optVal,
          name: mon.name,
          typeStr: typeStr,
          category: 'monitors',
          categoryLabel: 'Prober',
          sensorId: sensorIdLatency,
          key: `monitor-${mon.id}-latency`,
          source: 'monitor',
          id: mon.id,
          type: mon.type
        });

        optionsHtml += `<option value="${optVal}" data-source="monitor" data-id="${mon.id}" data-type="${mon.type}" data-name="${mon.name}" data-sensor-id="${sensorIdLatency}">${mon.name} (${typeStr})</option>`;
      });
    }

    // B. Plugin Sensors grouped by plugin
    const pluginGroups = {};
    const coreTelemetry = [];

    Object.values((entities || {}) as Record<string, any>).forEach((ent: any) => {
      const key = ent.entity_key || '';
      const nodeId = ent.node_id || '';

      if (key.startsWith('monitor-') && (key.endsWith('-status') || key.endsWith('-latency'))) {
        return;
      }

      if (nodeId === 'core-mon' || ['cpu-utilization', 'database-latency', 'database-storage-pct'].includes(key)) {
        coreTelemetry.push(ent);
        return;
      }

      if (nodeId !== 'core-mon' && nodeId !== 'monitors') {
        let rawPluginId = ent.plugin_id || nodeId;
        if (rawPluginId === 'plugins' && key.startsWith('plugin-') && key.endsWith('-status')) {
          rawPluginId = key.slice('plugin-'.length, -'-status'.length);
        }
        const matchedPlugin = (window.currentActivePluginsData || []).find(pl => pl.id === rawPluginId);
        let pName = matchedPlugin ? matchedPlugin.name : rawPluginId.replace(/^plugin-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        if (!pluginGroups[pName]) {
          pluginGroups[pName] = [];
        }
        pluginGroups[pName].push(ent);
      }
    });

    // Render Plugin Sensors
    Object.keys(pluginGroups).sort().forEach(pName => {
      const pEntities = pluginGroups[pName].sort((a, b) => (a.name || a.entity_key).localeCompare(b.name || b.entity_key));
      pEntities.forEach(ent => {
        const unit = (ent.attributes && ent.attributes.unit) || ent.unit || '';
        const displayName = ent.name || ent.entity_key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const sensorId = window.getSensorIdForEntity ? window.getSensorIdForEntity(ent.node_id, ent.entity_key, ent.name, ent.type) : `${ent.node_id}.${ent.entity_key}`;
        const optVal = `ent-${ent.entity_key}`;

        window.historyAllSourceItems.push({
          value: optVal,
          name: displayName,
          typeStr: (ent.type || 'sensor').toUpperCase(),
          category: `plugin-${ent.node_id}`,
          categoryLabel: pName,
          sensorId: sensorId,
          key: ent.entity_key,
          source: 'entity',
          unit: unit
        });

        optionsHtml += `<option value="${optVal}" data-source="entity" data-key="${ent.entity_key}" data-type="${ent.type || 'sensor'}" data-unit="${unit}" data-name="${displayName}" data-sensor-id="${sensorId}">${displayName}</option>`;
      });
    });

    // C. Core System Telemetry
    if (coreTelemetry.length > 0) {
      coreTelemetry.sort((a, b) => (a.name || a.entity_key).localeCompare(b.name || b.entity_key)).forEach(ent => {
        const unit = (ent.attributes && ent.attributes.unit) || ent.unit || '';
        const displayName = ent.name || ent.entity_key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const sensorId = window.getSensorIdForEntity ? window.getSensorIdForEntity(ent.node_id || 'core-mon', ent.entity_key, ent.name, ent.type) : `sensor.${ent.entity_key}`;
        const optVal = `ent-${ent.entity_key}`;

        window.historyAllSourceItems.push({
          value: optVal,
          name: displayName,
          typeStr: (ent.type || 'sensor').toUpperCase(),
          category: 'core',
          categoryLabel: 'Core',
          sensorId: sensorId,
          key: ent.entity_key,
          source: 'entity',
          unit: unit
        });

        optionsHtml += `<option value="${optVal}" data-source="entity" data-key="${ent.entity_key}" data-type="${ent.type || 'sensor'}" data-unit="${unit}" data-name="${displayName}" data-sensor-id="${sensorId}">${displayName}</option>`;
      });
    }

    select.innerHTML = optionsHtml;

    // Set initial selected item
    let activeItem = null;
    if (previousSelected) {
      activeItem = window.historyAllSourceItems.find(i => i.value === previousSelected);
    }
    if (!activeItem && window.historyAllSourceItems.length > 0) {
      activeItem = window.historyAllSourceItems[0];
    }

    if (activeItem) {
      select.value = activeItem.value;
      const input = document.getElementById('history-combobox-input');
      const clearBtn = document.getElementById('btn-history-clear-sensor');
      if (input) input.value = activeItem.name;
      if (clearBtn) clearBtn.style.display = 'block';
      updateActiveQueryBanner(activeItem.name, activeItem.sensorId);
    }

    // Ensure default date range initialized
    const startInput = document.getElementById('history-custom-start');
    const endInput = document.getElementById('history-custom-end');
    if (!startInput || !endInput || !startInput.value || !endInput.value) {
      applyHistoryPreset('1h', false);
    }

    renderComboboxCategoryTabs();
    renderComboboxItems();
    loadHistoryAnalytics();
  } catch (err) {
    console.error('Failed to populate history sources list:', err);
  }
}

let historyChartInstance = null;

function formatMetricValue(num, unit) {
  if (typeof num !== 'number' || isNaN(num)) return '--';
  let formatted = '';
  if (Math.abs(num) >= 100) {
    formatted = num.toFixed(1);
  } else if (num % 1 === 0) {
    formatted = num.toFixed(0);
  } else {
    formatted = num.toFixed(2);
  }
  return unit ? `${formatted} ${unit}` : formatted;
}

function isSensorStatusHealthy(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).toLowerCase().trim();
  return ['online', 'ok', 'healthy', 'active', 'running', 'optimal', 'up', 'true', '1', 'on'].includes(s);
}

async function loadHistoryAnalytics() {
  const select = document.getElementById('history-monitor-select');
  const tableBody = document.getElementById('history-logs-table-body');
  if (!select || !select.value || !tableBody) return;

  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) return;

  const source = selectedOpt.getAttribute('data-source') || (select.value.startsWith('mon-') ? 'monitor' : 'entity');

  // Compute date range from start & end inputs
  const startInput = document.getElementById('history-custom-start');
  const endInput = document.getElementById('history-custom-end');

  let queryParams = '';
  let hoursCount = 1;

  if (startInput && endInput && startInput.value && endInput.value) {
    let sTime = new Date(startInput.value).getTime();
    let eTime = new Date(endInput.value).getTime();
    if (isNaN(sTime) || isNaN(eTime)) {
      applyHistoryPreset('1h', false);
      sTime = new Date(startInput.value).getTime();
      eTime = new Date(endInput.value).getTime();
    }
    if (sTime > eTime) {
      const tmp = startInput.value;
      startInput.value = endInput.value;
      endInput.value = tmp;
      sTime = new Date(startInput.value).getTime();
      eTime = new Date(endInput.value).getTime();
    }
    const startISO = new Date(sTime).toISOString();
    const endISO = new Date(eTime).toISOString();
    queryParams = `?start_time=${encodeURIComponent(startISO)}&end_time=${encodeURIComponent(endISO)}`;
    hoursCount = Math.max(0.1, (eTime - sTime) / (1000 * 60 * 60));
  } else {
    applyHistoryPreset('1h', false);
    const startISO = new Date(startInput.value).toISOString();
    const endISO = new Date(endInput.value).toISOString();
    queryParams = `?start_time=${encodeURIComponent(startISO)}&end_time=${encodeURIComponent(endISO)}`;
    hoursCount = 1;
  }

  tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:var(--text-secondary);">Loading analytics...</td></tr>`;

  const loaderEl = document.getElementById('analytics-chart-loader');
  if (loaderEl) loaderEl.style.display = 'flex';

  await new Promise(resolve => setTimeout(resolve, 30));

  const { httpUrl } = getApiUrls();

  // Reference dynamic UI label elements
  const lblCard1 = document.getElementById('history-stat-1-label');
  const lblCard2 = document.getElementById('history-stat-2-label');
  const lblCard3 = document.getElementById('history-stat-3-label');
  const lblCard4 = document.getElementById('history-stat-4-label');
  const chartUnitLbl = document.getElementById('history-chart-unit-label');
  const tblHeader2 = document.getElementById('history-table-header-2');
  const tblHeader3 = document.getElementById('history-table-header-3');

  try {
    if (source === 'monitor') {
      // ═════════════════════════════════════════════
      // CASE 1: PROBERS & HEALTH MONITORS
      // ═════════════════════════════════════════════
      const monId = selectedOpt.getAttribute('data-id') || select.value.replace(/^mon-/, '');
      const type = selectedOpt.getAttribute('data-type') || 'ping';

      // Reset standard labels
      if (lblCard1) lblCard1.textContent = 'Uptime Ratio';
      if (lblCard2) lblCard2.textContent = 'Average Response';
      if (lblCard3) lblCard3.textContent = 'Peak Latency';
      if (lblCard4) lblCard4.textContent = 'Outages Detected';
      if (chartUnitLbl) chartUnitLbl.textContent = 'LATENCY (MS) OVER TIME';
      if (tblHeader2) tblHeader2.textContent = 'Event Status';
      if (tblHeader3) tblHeader3.textContent = 'Response Latency';

      const statusKey = `monitor-${monId}-status`;
      const latencyKey = `monitor-${monId}-latency`;

      const resStatus = await fetch(`${httpUrl}/api/monitors/logs/${statusKey}${queryParams}`);
      const statusLogs = resStatus.ok ? await resStatus.json() : [];

      const resLatency = await fetch(`${httpUrl}/api/monitors/logs/${latencyKey}${queryParams}`);
      const latencyLogs = resLatency.ok ? await resLatency.json() : [];

      if (statusLogs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:var(--text-secondary);">No log records found for this prober in the selected range.</td></tr>`;
        updateHistoryStats(0, 0, 0, 100);
        drawHistoryChart([], [], [], 0, [], { mode: 'latency', label: 'Ping Response Latency', unit: 'ms' });
        updateActiveQueryBanner(selectedOpt.text, selectedOpt.getAttribute('data-sensor-id'), 0);
        if (loaderEl) loaderEl.style.display = 'none';
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 5));

      let totalLatency = 0;
      let maxLatency = 0;
      let healthyCount = 0;
      let outages = 0;
      let prevUp = true;

      const sortedStatus = [...statusLogs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const sortedLatency = [...latencyLogs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const chronologicalDetails = [];
      const latencyTimes = sortedLatency.map(log => ({
        time: new Date(log.timestamp).getTime(),
        value: log.value
      }));

      let latIdx = 0;
      sortedStatus.forEach(statusLog => {
        const statusTime = new Date(statusLog.timestamp).getTime();
        while (latIdx < latencyTimes.length - 1) {
          const thisDiff = Math.abs(latencyTimes[latIdx].time - statusTime);
          const nextDiff = Math.abs(latencyTimes[latIdx + 1].time - statusTime);
          if (nextDiff < thisDiff) {
            latIdx++;
          } else {
            break;
          }
        }

        const closestLat = latencyTimes[latIdx];
        const minDiff = closestLat ? Math.abs(closestLat.time - statusTime) : Infinity;
        const latVal = (closestLat && minDiff < 5000) ? parseFloat(closestLat.value) : 0.0;
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

      updateHistoryStats(avgLatency, maxLatency, outages, uptimePct);

      let tableRows = '';
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

      const includeDate = hoursCount >= 24;
      const labels = chronologicalDetails.map(log => {
        const d = new Date(log.timestamp);
        if (includeDate) {
          const month = d.toLocaleDateString([], { month: 'short' });
          const day = d.toLocaleDateString([], { day: 'numeric' });
          const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          return `${month} ${day} ${timeStr}`;
        } else {
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
      });
      const latencies = chronologicalDetails.map(log => log.latency);
      const healthBooleans = chronologicalDetails.map(log => log.isUp);

      drawHistoryChart(labels, latencies, healthBooleans, avgLatency, chronologicalDetails, {
        mode: 'latency',
        label: `${selectedOpt.text} Latency`,
        unit: 'ms'
      });
      updateActiveQueryBanner(selectedOpt.text, selectedOpt.getAttribute('data-sensor-id'), chronologicalDetails.length);

    } else {
      // ═════════════════════════════════════════════
      // CASE 2: PLUGIN SENSORS & TELEMETRY ENTITIES
      // ═════════════════════════════════════════════
      const entityKey = selectedOpt.getAttribute('data-key') || select.value.replace(/^ent-/, '').replace(/^direct-/, '');
      const metricName = selectedOpt.getAttribute('data-name') || selectedOpt.text;
      const unit = selectedOpt.getAttribute('data-unit') || '';

      const res = await fetch(`${httpUrl}/api/monitors/logs/${entityKey}${queryParams}`);
      const logs = res.ok ? await res.json() : [];

      if (logs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:var(--text-secondary);">No telemetry records found for <strong>${metricName}</strong> in the selected range.</td></tr>`;
        const uptimeEl = document.getElementById('history-stat-uptime');
        const avgEl = document.getElementById('history-stat-avg-latency');
        const maxEl = document.getElementById('history-stat-max-latency');
        const outagesEl = document.getElementById('history-stat-outages');
        if (uptimeEl) { uptimeEl.textContent = '--'; uptimeEl.style.color = 'var(--text-secondary)'; }
        if (avgEl) avgEl.textContent = '--';
        if (maxEl) maxEl.textContent = '--';
        if (outagesEl) { outagesEl.textContent = '--'; outagesEl.style.color = 'var(--text-secondary)'; }
        drawHistoryChart([], [], [], 0, [], { mode: 'numeric', label: metricName, unit });
        updateActiveQueryBanner(metricName, selectedOpt.getAttribute('data-sensor-id') || entityKey, 0);
        if (loaderEl) loaderEl.style.display = 'none';
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 5));

      // Determine whether this sensor is numeric or binary/status
      const numericCount = logs.filter(l => !isNaN(parseFloat(l.value))).length;
      const isNumeric = numericCount >= (logs.length * 0.5);

      const sortedLogs = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const includeDate = hoursCount >= 24;
      const labels = sortedLogs.map(log => {
        const d = new Date(log.timestamp);
        if (includeDate) {
          const month = d.toLocaleDateString([], { month: 'short' });
          const day = d.toLocaleDateString([], { day: 'numeric' });
          const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          return `${month} ${day} ${timeStr}`;
        } else {
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
      });

      if (isNumeric) {
        // ─────────────────────────────────────────
        // SUBCASE 2A: NUMERIC TELEMETRY SENSOR
        // ─────────────────────────────────────────
        if (lblCard1) lblCard1.textContent = 'Current Reading';
        if (lblCard2) lblCard2.textContent = 'Average Value';
        if (lblCard3) lblCard3.textContent = 'Peak / Maximum';
        if (lblCard4) lblCard4.textContent = 'Minimum / Samples';
        if (chartUnitLbl) chartUnitLbl.textContent = `${(unit || 'METRIC VALUE').toUpperCase()} OVER TIME`;
        if (tblHeader2) tblHeader2.textContent = 'Recorded Value';
        if (tblHeader3) tblHeader3.textContent = 'Metric Source';

        const numericVals = sortedLogs.map(l => parseFloat(l.value) || 0);
        const latestVal = numericVals[numericVals.length - 1];
        const sumVal = numericVals.reduce((acc, v) => acc + v, 0);
        const avgVal = numericVals.length > 0 ? (sumVal / numericVals.length) : 0;
        const maxVal = Math.max(...numericVals);
        const minVal = Math.min(...numericVals);

        const uptimeEl = document.getElementById('history-stat-uptime');
        const avgEl = document.getElementById('history-stat-avg-latency');
        const maxEl = document.getElementById('history-stat-max-latency');
        const outagesEl = document.getElementById('history-stat-outages');

        if (uptimeEl) {
          uptimeEl.textContent = formatMetricValue(latestVal, unit);
          uptimeEl.style.color = 'var(--color-optimal)';
        }
        if (avgEl) avgEl.textContent = formatMetricValue(avgVal, unit);
        if (maxEl) maxEl.textContent = formatMetricValue(maxVal, unit);
        if (outagesEl) {
          outagesEl.textContent = `${formatMetricValue(minVal, unit)} (${numericVals.length} pts)`;
          outagesEl.style.color = '#38bdf8';
        }

        let tableRows = '';
        const reversedLogs = [...sortedLogs].reverse();
        reversedLogs.forEach(log => {
          const dt = new Date(log.timestamp).toLocaleString();
          const numV = parseFloat(log.value) || 0;
          const dev = numV - avgVal;
          const devSign = dev > 0 ? '+' : '';
          const devStr = Math.abs(dev) > 0.01 ? `${devSign}${dev.toFixed(2)}${unit ? ' ' + unit : ''}` : 'Avg Baseline';

          tableRows += `
            <tr style="border-bottom:1px solid var(--border-soft);">
              <td style="padding:10px 14px; font-family:monospace; color:var(--text-secondary);">${dt}</td>
              <td style="padding:10px 14px; font-weight:700; color:#fff; font-family:monospace;">${formatMetricValue(numV, unit)}</td>
              <td style="padding:10px 14px; color:var(--text-secondary); font-size:0.75rem;">${metricName} <span style="opacity:0.6; font-size:0.7rem;">(${devStr})</span></td>
            </tr>`;
        });
        tableBody.innerHTML = tableRows;

        const healthBooleans = sortedLogs.map(() => true);

        drawHistoryChart(labels, numericVals, healthBooleans, avgVal, sortedLogs, {
          mode: 'numeric',
          label: `${metricName}${unit ? ' (' + unit + ')' : ''}`,
          unit: unit
        });
        updateActiveQueryBanner(metricName, selectedOpt.getAttribute('data-sensor-id') || entityKey, sortedLogs.length);

      } else {
        // ─────────────────────────────────────────
        // SUBCASE 2B: BINARY / STATUS SENSOR
        // ─────────────────────────────────────────
        if (lblCard1) lblCard1.textContent = 'Current State';
        if (lblCard2) lblCard2.textContent = 'Optimal Ratio';
        if (lblCard3) lblCard3.textContent = 'State Transitions';
        if (lblCard4) lblCard4.textContent = 'Alert Incidents';
        if (chartUnitLbl) chartUnitLbl.textContent = 'STATE TIMELINE (1=ONLINE/OK, 0=ALERT)';
        if (tblHeader2) tblHeader2.textContent = 'Reported State';
        if (tblHeader3) tblHeader3.textContent = 'Assessment';

        let transitions = 0;
        let prevVal = null;
        let healthyCount = 0;

        sortedLogs.forEach((l, idx) => {
          const isH = isSensorStatusHealthy(l.value);
          if (isH) healthyCount++;
          if (idx > 0 && String(l.value) !== String(prevVal)) {
            transitions++;
          }
          prevVal = l.value;
        });

        const latestState = sortedLogs[sortedLogs.length - 1].value;
        const isLatestHealthy = isSensorStatusHealthy(latestState);
        const optimalRatio = sortedLogs.length > 0 ? (healthyCount / sortedLogs.length) * 100 : 100.0;
        const alertIncidents = sortedLogs.length - healthyCount;

        const uptimeEl = document.getElementById('history-stat-uptime');
        const avgEl = document.getElementById('history-stat-avg-latency');
        const maxEl = document.getElementById('history-stat-max-latency');
        const outagesEl = document.getElementById('history-stat-outages');

        if (uptimeEl) {
          uptimeEl.textContent = String(latestState).toUpperCase();
          uptimeEl.style.color = isLatestHealthy ? 'var(--color-optimal)' : '#f43f5e';
        }
        if (avgEl) avgEl.textContent = `${optimalRatio.toFixed(1)}%`;
        if (maxEl) maxEl.textContent = String(transitions);
        if (outagesEl) {
          outagesEl.textContent = String(alertIncidents);
          outagesEl.style.color = alertIncidents > 0 ? '#f43f5e' : 'var(--color-optimal)';
        }

        let tableRows = '';
        const reversedLogs = [...sortedLogs].reverse();
        reversedLogs.forEach(log => {
          const dt = new Date(log.timestamp).toLocaleString();
          const isH = isSensorStatusHealthy(log.value);
          const color = isH ? 'var(--color-optimal)' : '#f43f5e';
          const badgeText = String(log.value).toUpperCase();
          const noteText = isH ? 'Healthy / Normal' : 'Alert / Degraded State';

          tableRows += `
            <tr style="border-bottom:1px solid var(--border-soft);">
              <td style="padding:10px 14px; font-family:monospace; color:var(--text-secondary);">${dt}</td>
              <td style="padding:10px 14px; font-weight:700; color:${color};">${badgeText}</td>
              <td style="padding:10px 14px; color:var(--text-secondary); font-size:0.75rem;">${noteText}</td>
            </tr>`;
        });
        tableBody.innerHTML = tableRows;

        const binaryVals = sortedLogs.map(l => isSensorStatusHealthy(l.value) ? 1 : 0);
        const healthBooleans = binaryVals.map(v => v === 1);

        drawHistoryChart(labels, binaryVals, healthBooleans, null, sortedLogs, {
          mode: 'status',
          label: `${metricName} State`,
          unit: 'State'
        });
        updateActiveQueryBanner(metricName, selectedOpt.getAttribute('data-sensor-id') || entityKey, sortedLogs.length);
      }
    }

    if (loaderEl) loaderEl.style.display = 'none';
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="3" style="padding:24px; text-align:center; color:#f43f5e;">Error loading analytics: ${err.message}</td></tr>`;
    if (loaderEl) loaderEl.style.display = 'none';
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

window.filterLogsTableToHighlight = function (timestampStr) {
  const tableBody = document.getElementById('history-logs-table-body');
  if (!tableBody) return;
  const refTime = new Date(timestampStr).getTime();

  const rows = tableBody.querySelectorAll('tr');
  rows.forEach(row => {
    const cell = row.querySelector('td');
    if (!cell) return;
    const rowTime = new Date(cell.textContent.trim()).getTime();
    if (isNaN(rowTime)) return;

    if (Math.abs(refTime - rowTime) <= 120000) {
      row.style.display = '';
      if (Math.abs(refTime - rowTime) <= 15000) {
        row.style.background = 'rgba(59, 130, 246, 0.18)';
      } else {
        row.style.background = '';
      }
    } else {
      row.style.display = 'none';
    }
  });
};

window.clearLogsTableFilter = function () {
  const tableBody = document.getElementById('history-logs-table-body');
  if (!tableBody) return;
  const rows = tableBody.querySelectorAll('tr');
  rows.forEach(row => {
    row.style.display = '';
    row.style.background = '';
  });
};

function drawHistoryChart(labels: any, values: any, healths: any, avgValue: any, chronologicalDetails: any, options: Record<string, any> = {}) {
  const canvas = document.getElementById('analytics-chart-canvas');
  if (!canvas) return;

  if (typeof Chart === 'undefined') {
    console.warn("Chart.js is not loaded. Skipping chart rendering.");
    return;
  }

  if (historyChartInstance) {
    historyChartInstance.destroy();
  }

  const mode = options.mode || 'latency';
  const label = options.label || 'Metric Value';
  const unit = options.unit || '';

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);

  let borderColor = '#3b82f6';
  if (mode === 'numeric') {
    borderColor = '#06b6d4';
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
  } else if (mode === 'status') {
    borderColor = '#10b981';
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
  } else {
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
  }

  const pointColors = healths.map(h => h ? 'var(--color-optimal)' : '#f43f5e');

  const mainDataset = {
    label: label,
    data: values,
    borderColor: borderColor,
    borderWidth: 2,
    backgroundColor: gradient,
    fill: true,
    tension: mode === 'status' ? 0.0 : 0.3,
    stepped: mode === 'status' ? 'before' : false,
    pointBackgroundColor: pointColors,
    pointBorderColor: pointColors,
    pointHoverRadius: 6,
    pointRadius: values.length > 50 ? 2 : 4
  };

  const datasets: any[] = [mainDataset];

  if (typeof avgValue === 'number' && values.length > 0 && mode !== 'status') {
    datasets.push({
      label: `Average (${formatMetricValue(avgValue, unit)})`,
      data: Array(values.length).fill(avgValue),
      borderColor: 'rgba(244, 63, 94, 0.5)',
      borderWidth: 1.5,
      borderDash: [5, 5],
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 0
    });
  }

  const yAxisConfig: Record<string, any> = {
    grid: { color: 'rgba(255,255,255,0.06)' },
    ticks: {
      color: '#cbd5e1',
      font: {
        family: "'Inter', system-ui, -apple-system, sans-serif",
        size: 11,
        weight: '500'
      },
      callback: function (val) {
        if (mode === 'status') {
          return val === 1 ? 'ONLINE' : (val === 0 ? 'ALERT' : '');
        }
        return unit ? `${val} ${unit}` : val;
      }
    },
    suggestedMin: 0
  };

  if (mode === 'status') {
    yAxisConfig.min = -0.2;
    yAxisConfig.max = 1.2;
    yAxisConfig.ticks.stepSize = 1;
  }

  historyChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (event, activeElements) => {
        const detailsEl = document.getElementById('history-logs-advanced-details');
        if (!detailsEl || !detailsEl.open) return;

        if (activeElements && activeElements.length > 0) {
          const idx = activeElements[0].index;
          const selectedLog = chronologicalDetails[idx];
          if (selectedLog && selectedLog.timestamp) {
            window.filterLogsTableToHighlight(selectedLog.timestamp);
          }
        } else {
          window.clearLogsTableFilter();
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#fff',
          bodyColor: '#e2e8f0',
          callbacks: {
            title: function (context) {
              const idx = context[0].dataIndex;
              const logItem = chronologicalDetails[idx];
              if (logItem && logItem.timestamp) {
                const date = new Date(logItem.timestamp);
                return date.toLocaleString([], {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false
                });
              }
              return context[0].label;
            },
            label: function (context) {
              const idx = context.dataIndex;
              const logItem = chronologicalDetails[idx];
              if (mode === 'status' && logItem) {
                return ` State: ${String(logItem.value || (logItem.status)).toUpperCase()}`;
              }
              if (mode === 'latency') {
                return ` Latency: ${context.parsed.y.toFixed(2)} ms`;
              }
              return ` ${label}: ${context.parsed.y} ${unit}`.trim();
            }
          },
          titleFont: {
            family: "'Inter', system-ui, -apple-system, sans-serif",
            weight: '600',
            size: 11
          },
          bodyFont: {
            family: "'Inter', system-ui, -apple-system, sans-serif",
            size: 11
          },
          borderColor: 'var(--border-soft)',
          borderWidth: 1,
          padding: 10,
          displayColors: true
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#cbd5e1',
            font: {
              family: "'Inter', system-ui, -apple-system, sans-serif",
              size: 11,
              weight: '500'
            },
            maxRotation: 0,
            maxTicksLimit: 8
          }
        },
        y: yAxisConfig
      }
    }
  });
}

