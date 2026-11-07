// ============================================================================
// Module: src/04-probes-manager.ts
// Description: Service Probes Manager, Toast Notifications & Custom Promise Dialogs
// ============================================================================

// Built-in Background Monitor Client Functions
// Multi-Level Standalone Probes Manager JS Engine
let activeProbeEngineType: string | null = null;
let activeProbeMonitorId: number | null = null;

function navigateProbesLevel(level: any, param?: any) {
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

function isProbeStatusOnline(status: any, type?: string): boolean {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  const num = parseInt(s, 10);
  if (!isNaN(num) && ((num >= 200 && num < 400) || num === 401 || num === 403 || num === 405)) return true;
  return (
    s === 'UP' ||
    s === 'ONLINE' ||
    s === 'HEALTHY' ||
    s === 'STABLE' ||
    s === 'CONNECTED' ||
    s === 'SSL_OK' ||
    s === 'DNS_OK' ||
    s === 'PORT_OK' ||
    s === 'ICMP_OK' ||
    s === '101' ||
    s.includes('REMAINING') ||
    s.includes('DAYS') ||
    s.includes('SELF-SIGNED')
  );
}

function getBaseHostName(name: string): string {
  if (!name) return 'Unknown Target';
  let base = String(name).trim();
  base = base.replace(/\s*\[(Internal|External)\s+[^\]]+\]\s*$/i, '');
  base = base.replace(/\s*\((Ping|HTTP|HTTPS|SSL|Port\s*\d*|DNS|WebSocket)\)\s*$/i, '');
  base = base.replace(/\s*-\s*(Ping|HTTP|HTTPS|SSL|Port\s*\d*|DNS|WebSocket)\s*$/i, '');
  return base.trim();
}

async function loadProbesLevel1() {
  const { httpUrl } = getApiUrls();
  const gridEl = document.getElementById('engines-grid');
  if (!gridEl) return;

  try {
    const res = await fetch(`${httpUrl}/api/monitors`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const monitors = await res.json();

    const counts = { all_grouped: monitors.length, http: 0, websocket: 0, ping: 0, port: 0, dns: 0, ssl: 0 };
    monitors.forEach(m => {
      if (counts[m.type] !== undefined) counts[m.type]++;
    });

    const engines = [
      { type: 'all_grouped', name: 'Grouped Host & Service Probes', desc: 'All probes grouped by Host / Service', icon: 'layers', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.15)' },
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
        <div class="mon-picker-card" onclick="navigateProbesLevel(2, '${eng.type}')" style="display: flex; flex-direction: column; align-items: flex-start; ${eng.type === 'all_grouped' ? 'border:1px solid rgba(96,165,250,0.4); background:rgba(30,58,138,0.15);' : ''}">
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

window.toggleNavGroup = function (group, event) {
  if (event) event.preventDefault();
  const submenu = document.getElementById(`${group}-submenu`);
  const arrow = document.getElementById(`${group}-arrow`);
  if (submenu && arrow) {
    const isHidden = (submenu.style.display === 'none');
    if (isHidden) {
      submenu.style.display = 'flex';
      arrow.setAttribute('data-lucide', 'chevron-down');
    } else {
      submenu.style.display = 'none';
      arrow.setAttribute('data-lucide', 'chevron-right');
    }
    if (window.lucide) window.lucide.createIcons();
  }
};

window.toggleCategoryFolder = function (cat) {
  const content = document.getElementById(`folder-content-${cat}`);
  const arrow = document.getElementById(`folder-arrow-${cat}`);
  if (content && arrow) {
    if (content.style.display === 'none') {
      content.style.display = 'flex';
      arrow.setAttribute('data-lucide', 'chevron-down');
      if (window.lucide) window.lucide.createIcons();
    } else {
      content.style.display = 'none';
      arrow.setAttribute('data-lucide', 'chevron-right');
      if (window.lucide) window.lucide.createIcons();
    }
  }
};

window.toggleHostProbeGroup = function (groupId) {
  const content = document.getElementById(`host-group-content-${groupId}`);
  const arrow = document.getElementById(`host-group-arrow-${groupId}`);
  if (content && arrow) {
    if (content.style.display === 'none') {
      content.style.display = 'flex';
      arrow.setAttribute('data-lucide', 'chevron-down');
    } else {
      content.style.display = 'none';
      arrow.setAttribute('data-lucide', 'chevron-right');
    }
    if (window.lucide) window.lucide.createIcons();
  }
};

async function loadProbesLevel2(type) {
  const { httpUrl } = getApiUrls();
  const listEl = document.getElementById('probes-source-list');
  if (!listEl) return;

  const titles = {
    all_grouped: { title: "Grouped Host & Service Probes", desc: "All system probes grouped together by Host and Service." },
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

    const filtered = (type === 'all_grouped') ? monitors : monitors.filter(m => m.type === type);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <p style="font-size:0.8rem; color:var(--text-secondary); text-align:center; padding:24px; border:1px dashed var(--border-soft); border-radius:6px; margin:0;">
          No active probes for this monitor selection. Click "+ Configure New Probe" to add one.
        </p>`;
      return;
    }

    // Group monitors by base host/service name
    const serviceGroups = {};
    filtered.forEach(m => {
      const baseHost = getBaseHostName(m.name);
      if (!serviceGroups[baseHost]) {
        serviceGroups[baseHost] = [];
      }
      serviceGroups[baseHost].push(m);
    });

    let html = '<div style="display:flex; flex-direction:column; gap:16px;">';

    Object.keys(serviceGroups).sort().forEach((baseHost, idx) => {
      const groupProbes = serviceGroups[baseHost];
      const groupId = `grp_${idx}_${baseHost.replace(/[^a-zA-Z0-9]/g, '_')}`;

      // Calculate status summary
      let total = groupProbes.length;
      let onlineCount = 0;
      let offlineCount = 0;
      let disabledCount = 0;
      let totalLatency = 0;
      let latencyCount = 0;

      groupProbes.forEach(p => {
        const enabled = p.enabled !== false;
        if (!enabled) {
          disabledCount++;
        } else if (isProbeStatusOnline(p.last_status, p.type)) {
          onlineCount++;
        } else {
          offlineCount++;
        }
        if (enabled && p.last_latency !== null && p.last_latency !== undefined) {
          totalLatency += parseFloat(p.last_latency);
          latencyCount++;
        }
      });

      let statusBadgeColor = '#34d399';
      let statusBadgeBg = 'rgba(52, 211, 153, 0.12)';
      let statusBadgeText = 'ALL ONLINE';

      if (offlineCount > 0 && onlineCount > 0) {
        statusBadgeColor = '#f59e0b';
        statusBadgeBg = 'rgba(245, 158, 11, 0.12)';
        statusBadgeText = 'DEGRADED';
      } else if (offlineCount > 0 && onlineCount === 0) {
        statusBadgeColor = '#f43f5e';
        statusBadgeBg = 'rgba(244, 63, 94, 0.12)';
        statusBadgeText = 'OFFLINE';
      } else if (disabledCount === total) {
        statusBadgeColor = '#6b7280';
        statusBadgeBg = 'rgba(107, 114, 128, 0.12)';
        statusBadgeText = 'DISABLED';
      }

      const avgLat = latencyCount > 0 ? `${(totalLatency / latencyCount).toFixed(1)} ms avg` : '--';

      html += `
        <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-soft); border-radius:8px; overflow:hidden;">
          <!-- Host Group Header -->
          <div onclick="toggleHostProbeGroup('${groupId}')" style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:rgba(0,0,0,0.25); cursor:pointer; user-select:none;">
            <div style="display:flex; align-items:center; gap:12px;">
              <div style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.3); padding:8px; border-radius:6px; display:flex; align-items:center; justify-content:center;">
                <i data-lucide="server" style="width:18px; height:18px; color:#60a5fa;"></i>
              </div>
              <div>
                <div style="font-weight:700; font-size:0.9rem; color:#fff;">${baseHost}</div>
                <div style="font-size:0.72rem; color:var(--text-secondary);">${total} Grouped Probe${total > 1 ? 's' : ''}</div>
              </div>
            </div>

            <div style="display:flex; align-items:center; gap:16px;">
              <span style="font-size:0.7rem; font-weight:700; color:${statusBadgeColor}; background:${statusBadgeBg}; padding:4px 10px; border-radius:4px; border:1px solid ${statusBadgeColor}40;">
                ${statusBadgeText}
              </span>
              <span style="font-size:0.72rem; color:var(--text-secondary); font-family:monospace;">${avgLat}</span>
              <i id="host-group-arrow-${groupId}" data-lucide="chevron-down" style="width:16px; height:16px; color:var(--text-secondary); transition:transform 0.2s;"></i>
            </div>
          </div>

          <!-- Grouped Probes Body -->
          <div id="host-group-content-${groupId}" style="display:flex; flex-direction:column; gap:8px; padding:12px 16px; background:rgba(0,0,0,0.15); border-top:1px solid var(--border-soft);">
      `;

      groupProbes.forEach(mon => {
        const isEnabled = mon.enabled !== false;
        const isOnline = isEnabled && isProbeStatusOnline(mon.last_status, mon.type);
        const monStatusColor = !isEnabled ? '#6b7280' : (isOnline ? 'var(--color-optimal)' : '#f43f5e');
        const monStatusText = !isEnabled ? 'DISABLED' : (isOnline ? 'ONLINE' : 'OFFLINE');
        const monLat = isEnabled && mon.last_latency !== null && mon.last_latency !== undefined ? `${mon.last_latency} ms` : '--';

        let probeIcon = 'activity';
        if (mon.type === 'ping') probeIcon = 'shield';
        else if (mon.type === 'http') probeIcon = 'globe';
        else if (mon.type === 'port') probeIcon = 'server';
        else if (mon.type === 'ssl') probeIcon = 'lock';
        else if (mon.type === 'dns') probeIcon = 'globe-2';

        html += `
          <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:6px; padding:10px 14px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <i data-lucide="${probeIcon}" style="width:15px; height:15px; color:${monStatusColor};"></i>
              <div>
                <div style="font-weight:600; font-size:0.82rem; color:var(--text-primary);">${mon.name}</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); font-family:monospace;">${mon.target} [${mon.type.toUpperCase()}]</div>
              </div>
            </div>

            <div style="display:flex; align-items:center; gap:14px;">
              <div style="text-align:right;">
                <div style="font-size:0.72rem; font-weight:700; color:${monStatusColor};">${monStatusText}</div>
                <div style="font-size:0.65rem; color:var(--text-secondary); font-family:monospace;">${monLat}</div>
              </div>

              <label class="switch" title="Enable/Disable Monitor" onclick="event.stopPropagation()">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleMonitorEnabled('${mon.id}', this.checked, event)">
                <span class="slider"></span>
              </label>

              <button class="btn-icon" onclick="openEditMonitor('${mon.id}', event)" style="background:none; border:none; padding:4px; cursor:pointer;" title="Edit Monitor">
                <i data-lucide="edit-3" style="width:14px; height:14px; color:var(--accent-orange);"></i>
              </button>
              <button class="btn-icon" onclick="deleteMonitorSource(${mon.id}, event)" style="background:none; border:none; padding:4px; cursor:pointer;" title="Delete Monitor">
                <i data-lucide="trash-2" style="width:14px; height:14px; color:#f43f5e;"></i>
              </button>
            </div>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });

    html += '</div>';
    listEl.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#f43f5e; font-size:0.8rem;">Failure loading probes: ${err.message}</p>`;
  }
}

function goLvl3(monId: any, e?: any) {
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

      combinedLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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
  populateMonitorGroupCheckboxes('add-mon-groups-container', []);

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
  const category = document.getElementById('mon-category').value.trim() || 'General';

  const checkedGroupIds = Array.from(document.querySelectorAll('#add-mon-groups-container .mon-group-chk:checked')).map(c => parseInt(c.value));

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
            timeout,
            category,
            group_ids: checkedGroupIds
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
            timeout,
            category,
            group_ids: checkedGroupIds
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
            timeout,
            category,
            group_ids: checkedGroupIds
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
        body: JSON.stringify({ name, type: type, target, check_interval: interval, timeout, category, group_ids: checkedGroupIds })
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

async function deleteMonitorSource(monId: any, e?: any) {
  if (e) e.stopPropagation();
  const confirmed = await showConfirm("Are you sure you want to remove this probe?", "Remove Monitor");
  if (!confirmed) return;

  const { httpUrl } = getApiUrls();
  try {
    const resList = await fetch(`${httpUrl}/api/monitors`);
    if (!resList.ok) throw new Error(`HTTP ${resList.status}`);
    const monitors = await resList.json();

    let idsToDelete = String(monId).split(',');

    if (idsToDelete.length === 1) {
      const singleId = idsToDelete[0];
      const targetMon = monitors.find(m => String(m.id) === String(singleId));
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
    }

    for (const deleteId of idsToDelete) {
      const res = await fetch(`${httpUrl}/api/monitors/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    loadProbesLevel1();
    if (activeProbeEngineType) {
      loadProbesLevel2(activeProbeEngineType);
    }
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

async function openEditMonitor(monId: any, event?: any) {
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
      document.getElementById('edit-mon-category').value = mon1.category || 'General';

      document.getElementById('edit-mon-target').value = mon1.target.replace(/^(https?:\/\/)+/i, '');
      document.getElementById('edit-mon-interval').value = mon1.check_interval;
      document.getElementById('edit-mon-timeout').value = mon1.timeout;
      await populateMonitorGroupCheckboxes('edit-mon-groups-container', mon1.group_ids || []);
    } else {
      const mon = monitors.find(m => String(m.id) === String(monId));
      if (!mon) {
        alert("Monitor not found.");
        return;
      }

      document.getElementById('edit-mon-id').value = monId;
      document.getElementById('edit-mon-name').value = mon.name;
      document.getElementById('edit-mon-type').value = mon.type;
      document.getElementById('edit-mon-category').value = mon.category || 'General';

      if (mon.type === 'http') {
        const hasHttps = mon.target.startsWith('https://');
        document.getElementById('edit-mon-proto').value = hasHttps ? 'https' : 'http';
        document.getElementById('edit-mon-target').value = mon.target.replace(/^(https?:\/\/)+/i, '');
      } else {
        document.getElementById('edit-mon-target').value = mon.target;
      }

      document.getElementById('edit-mon-interval').value = mon.check_interval;
      document.getElementById('edit-mon-timeout').value = mon.timeout;
      await populateMonitorGroupCheckboxes('edit-mon-groups-container', mon.group_ids || []);
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
  const category = document.getElementById('edit-mon-category').value.trim() || 'General';

  const checkedGroupIds = Array.from(document.querySelectorAll('#edit-mon-groups-container .mon-group-chk:checked')).map(c => parseInt(c.value));

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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
              timeout: timeout,
              category,
              group_ids: checkedGroupIds
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
          timeout: timeout,
          category,
          group_ids: checkedGroupIds
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

let confirmResolver = null;
window.showConfirm = function (message, title = "Confirm Action") {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    const modal = document.getElementById('custom-confirm-modal');
    if (!modal) {
      resolve(confirm(message));
      return;
    }
    document.getElementById('custom-confirm-title').textContent = title;
    document.getElementById('custom-confirm-body').textContent = message;
    openModal('custom-confirm-modal');
  });
};

window.closeConfirmModal = function (result) {
  closeModal('custom-confirm-modal');
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
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

