// ============================================================================
// Module: src/05-alert-router.ts
// Description: Alert Router Engine, Rule Composer, Channels & Monitor Target Groups
// ============================================================================

// ==========================================
// ALERT ROUTER ENGINE & RULES COMPOSER LOGIC
// ==========================================
window.cachedChannels = [];
window.activeAlertRuleId = null;
window.activeAlertChannelId = null;

function switchAlertSubView(viewName: string): void {
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

window.cachedGroups = [];

async function loadMonitorGroups() {
  const { httpUrl } = getApiUrls();
  const listEl = document.getElementById('alert-groups-list');
  if (!listEl) return;

  try {
    const res = await fetch(`${httpUrl}/api/monitor-groups`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.cachedGroups = data;

    if (data.length === 0) {
      listEl.innerHTML = `<p style="color:var(--text-secondary); font-size:0.8rem; text-align:center; padding:24px 0;">No target groups configured yet.</p>`;
    } else {
      listEl.innerHTML = data.map(grp => `
        <div class="channel-card" style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:16px; border:1px solid var(--border-soft); border-radius:8px;">
          <div>
            <h4 style="margin:0; font-size:0.95rem; color:var(--text-primary); font-weight:600;">${grp.name}</h4>
            <span style="font-size:0.75rem; color:var(--text-secondary); display:flex; align-items:center; gap:6px; margin-top:4px;">
              <i class="fa-solid fa-server" style="color:var(--accent-orange); font-size:0.7rem;"></i>
              ${grp.monitor_count === 1 ? '1 Monitor mapped' : `${grp.monitor_count} Monitors mapped`}
            </span>
          </div>
          <button class="btn btn-secondary" onclick="deleteMonitorGroup(${grp.id})" style="padding:6px 12px; font-size:0.72rem; color:var(--semantic-red); border-color:rgba(239, 68, 68, 0.2); background:rgba(239, 68, 68, 0.05); cursor:pointer;">
            Remove Group
          </button>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error("Failed to load monitor groups:", err);
    listEl.innerHTML = `<p style="color:var(--semantic-red); font-size:0.8rem; text-align:center; padding:24px 0;">Failed to fetch monitor groups: ${err.message}</p>`;
  }
}

async function createMonitorGroup() {
  const inputEl = document.getElementById('new-group-name');
  if (!inputEl) return;
  const name = inputEl.value.trim();
  if (!name) {
    alert("Group Name cannot be empty.");
    return;
  }

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitor-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.detail || `HTTP ${res.status}`);
    }
    inputEl.value = '';
    await loadMonitorGroups();
  } catch (err) {
    alert(`Failed to create Target Group: ${err.message}`);
  }
}

async function deleteMonitorGroup(gid) {
  if (!await showConfirm("Are you sure you want to delete this target group? This will unmap any monitors assigned to it.", "Delete Target Group")) {
    return;
  }
  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitor-groups/${gid}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadMonitorGroups();
  } catch (err) {
    alert(`Failed to delete Target Group: ${err.message}`);
  }
}

async function populateMonitorGroupCheckboxes(targetContainerId, selectedGroupIds = []) {
  const container = document.getElementById(targetContainerId);
  if (!container) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/monitor-groups`);
    if (res.ok) {
      window.cachedGroups = await res.json();
    }
  } catch (err) {
    console.error("Failed to sync group checkboxes:", err);
  }

  if (window.cachedGroups.length === 0) {
    container.innerHTML = `<span style="color:var(--text-secondary); font-size:0.75rem;">No target groups defined yet. Go to Alert Router > Target Groups to add.</span>`;
    return;
  }

  container.innerHTML = window.cachedGroups.map(grp => `
    <label style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer;">
      <input type="checkbox" class="mon-group-chk" value="${grp.id}" ${selectedGroupIds.includes(grp.id) ? 'checked' : ''} style="accent-color:var(--accent-orange);">
      <span>${grp.name}</span>
    </label>
  `).join('');
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
      // Build Target description
      let targetDesc = '';
      if (rule.targets_list && rule.targets_list.length > 0) {
        targetDesc = `${rule.targets_list.length} Targets`;
      } else if (rule.target_type === 'all') {
        targetDesc = 'All Monitors';
      } else if (rule.target_type.startsWith('type_')) {
        targetDesc = `All ${rule.target_type.slice(5).toUpperCase()} Probes`;
      } else if (rule.target_type.startsWith('category_')) {
        targetDesc = `Category: ${rule.target_type.slice(9)}`;
      } else if (rule.target_type === 'custom') {
        targetDesc = `${rule.monitors_list ? rule.monitors_list.length : 0} Monitors`;
      } else if (rule.target_type === 'custom_groups') {
        const grpNames = (rule.target_groups || []).map(gid => {
          const match = window.cachedGroups.find(g => g.id === gid);
          return match ? match.name : `Group #${gid}`;
        }).join(', ') || 'No groups selected';
        const opLabel = (rule.target_groups_operator === 'all') ? 'ALL' : 'ANY';
        targetDesc = `Groups (${opLabel}): ${grpNames}`;
      }

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
                ${condsText} <span style="color:var(--text-muted); font-size:0.7rem; margin-left: 8px;">(Cooldown: ${rule.cooldown_interval || '5m'})</span>
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
          
          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-soft); padding-top:10px; margin-top:4px; flex-wrap:wrap; gap:8px;">
            <div style="display:flex; flex-direction:column; gap:4px;">
              <span style="font-size:0.68rem; color:var(--text-secondary);"><i data-lucide="target" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Target: <strong style="color:var(--text-primary);">${targetDesc}</strong></span>
              <span style="font-size:0.68rem; color:var(--text-secondary);"><i data-lucide="send" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Channels: <strong style="color:var(--text-primary);">${chanNames}</strong></span>
            </div>
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

function renderChannelConfigFields(currentConfig: Record<string, any> = {}) {
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
  } else if (type === 'webhook') {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Webhook URL Endpoint</label>
        <input type="text" id="webhook-url" placeholder="https://api.my-domain.com/alerts" value="${currentConfig.url || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">HTTP Request Method</label>
        <select id="webhook-method" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
          <option value="POST" ${currentConfig.method === 'POST' ? 'selected' : ''}>POST</option>
          <option value="PUT" ${currentConfig.method === 'PUT' ? 'selected' : ''}>PUT</option>
          <option value="GET" ${currentConfig.method === 'GET' ? 'selected' : ''}>GET</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Custom Headers (JSON string - Optional)</label>
        <input type="text" id="webhook-headers" placeholder='{"Authorization": "Bearer key"}' value='${currentConfig.headers ? (typeof currentConfig.headers === "string" ? currentConfig.headers : JSON.stringify(currentConfig.headers)) : ""}' style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem;">
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label style="font-size:0.7rem; color:var(--text-secondary);">Payload Template (JSON - Use {{message}}, {{title}})</label>
        <textarea id="webhook-template" placeholder='{"text": "{{message}}", "topic": "{{title}}"}' style="background:#221d16; color:#fff; border:1px solid var(--border-soft); border-radius:4px; padding:6px; font-size:0.75rem; min-height:80px; font-family:monospace;">${currentConfig.payload_template || ""}</textarea>
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
  let cfg: Record<string, any> = {};

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
  } else if (type === 'webhook') {
    cfg = {
      url: document.getElementById('webhook-url').value.trim(),
      method: document.getElementById('webhook-method').value,
      headers: document.getElementById('webhook-headers').value.trim(),
      payload_template: document.getElementById('webhook-template').value.trim()
    };
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
  if (!await showConfirm("Are you sure you want to permanently delete this notification channel? Custom rules routing to it will lose reference.", "Delete Channel")) return;

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

function onRuleTargetTypeChange(val) {
  const monWrapper = document.getElementById('rule-monitors-selection-wrapper');
  const grpsWrapper = document.getElementById('rule-groups-selection-wrapper');
  const label = document.getElementById('rule-monitors-selection-label');

  if (val === 'custom_groups') {
    if (monWrapper) monWrapper.style.display = 'none';
    if (grpsWrapper) grpsWrapper.style.display = 'flex';
  } else {
    if (monWrapper) monWrapper.style.display = 'flex';
    if (grpsWrapper) grpsWrapper.style.display = 'none';
    if (label) {
      if (val === 'custom') {
        label.textContent = 'Include Specific Monitors (Selected targets only)';
      } else {
        label.textContent = 'Exclude Specific Monitors (Applies to all but checked targets)';
      }
    }
  }
}

async function openRuleComposer(rid = null) {
  window.activeAlertRuleId = rid;
  const modal = document.getElementById('rule-modal');
  const titleEl = document.getElementById('rule-modal-title');
  const nameInput = document.getElementById('rule-name');

  if (!modal) return;

  // Reset inputs to default values
  nameInput.value = '';
  document.getElementById('rule-trigger-offline').checked = true;
  document.getElementById('rule-trigger-latency').checked = false;
  document.getElementById('rule-trigger-latency-ms').value = '100';
  document.getElementById('rule-trigger-custom').checked = false;
  document.getElementById('rule-trigger-custom-op').value = '==';
  document.getElementById('rule-trigger-custom-val').value = '';
  document.getElementById('rule-cooldown').value = '5m';

  // Render linked channel checkboxes
  const channelsContainer = document.getElementById('rule-channels-list-container');
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

  // Load and build the unified Mapped Alert Targets catalog (Monitors + Plugins)
  const targetsListContainer = document.getElementById('rule-targets-selector-list');
  if (targetsListContainer) {
    targetsListContainer.innerHTML = `<span style="font-size:0.72rem; color:var(--text-secondary);">Loading available targets...</span>`;
  }

  let monitors = [];
  let plugins = [];
  const { httpUrl } = getApiUrls();

  try {
    const resMon = await fetch(`${httpUrl}/api/monitors`);
    if (resMon.ok) monitors = await resMon.json();

    const resPlugins = await fetch(`${httpUrl}/api/plugins/installed`);
    if (resPlugins.ok) plugins = await resPlugins.json();
    window.currentActivePluginsData = plugins;
  } catch (err) {
    console.error("Failed to load targets in rule composer:", err);
  }

  let selectHtml = '';
  // 1. Add health check monitors
  monitors.forEach(m => {
    const tKey = `monitor-${m.id}`;
    selectHtml += `
      <label class="rule-target-item" data-key="${tKey}" style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer; padding: 4px 0;">
        <input type="checkbox" class="rule-target-chk" value="${tKey}" style="accent-color:var(--accent-orange);">
        <span>Health Checker: <strong>${m.name}</strong> (${m.type.toUpperCase()}) - ${m.target}</span>
      </label>
    `;
  });

  // 2. Add plugin daemon status, manifest entities, and live runtime plugin entities
  const addedRuleEntityKeys = new Set();
  plugins.forEach(p => {
    const statusKey = `plugin-${p.id}-status`;
    addedRuleEntityKeys.add(statusKey);
    selectHtml += `
      <label class="rule-target-item" data-key="${statusKey}" style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer; padding: 4px 0;">
        <input type="checkbox" class="rule-target-chk" value="${statusKey}" style="accent-color:var(--accent-orange);">
        <span>Plugin Daemon: <strong>${p.name}</strong> [${statusKey}]</span>
      </label>
    `;
    const manifestEntities = (p.entities && typeof p.entities === 'object' && !Array.isArray(p.entities)) ? p.entities : {};
    Object.keys(manifestEntities).forEach(entityKey => {
      if (addedRuleEntityKeys.has(entityKey)) return;
      addedRuleEntityKeys.add(entityKey);
      const ent = manifestEntities[entityKey];
      selectHtml += `
        <label class="rule-target-item" data-key="${entityKey}" style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer; padding: 4px 0;">
          <input type="checkbox" class="rule-target-chk" value="${entityKey}" style="accent-color:var(--accent-orange);">
          <span>Plugin Sensor (${p.name}): <strong>${ent.name || entityKey}</strong> [${entityKey}]</span>
        </label>
      `;
    });
    // Also add live runtime entities reported by this plugin
    Object.values(cachedEntities || {}).forEach(liveEnt => {
      if (!liveEnt || !liveEnt.entity_key || addedRuleEntityKeys.has(liveEnt.entity_key)) return;
      if (liveEnt.plugin_id === p.id || liveEnt.node_id === p.id || liveEnt.node_id === `plugin-${p.id}`) {
        addedRuleEntityKeys.add(liveEnt.entity_key);
        selectHtml += `
          <label class="rule-target-item" data-key="${liveEnt.entity_key}" style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-primary); cursor:pointer; padding: 4px 0;">
            <input type="checkbox" class="rule-target-chk" value="${liveEnt.entity_key}" style="accent-color:var(--accent-orange);">
            <span>Plugin Sensor (${p.name}): <strong>${liveEnt.name || liveEnt.entity_key}</strong> [${liveEnt.entity_key}]</span>
          </label>
        `;
      }
    });
  });

  if (targetsListContainer) {
    targetsListContainer.innerHTML = selectHtml || `<span style="font-size:0.72rem; color:var(--text-secondary);">No active targets found.</span>`;
  }

  // If in edit mode, populate saved values
  if (rid) {
    titleEl.textContent = 'Edit Alert Rule';
    try {
      const res = await fetch(`${httpUrl}/api/alerts/rules`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const list = await res.json();
      const rule = list.find(r => r.id === rid);
      if (rule) {
        nameInput.value = rule.name;
        document.getElementById('rule-cooldown').value = rule.cooldown_interval || '5m';

        let offlineChecked = false;
        let latencyChecked = false;
        let customChecked = false;

        rule.rules_json.forEach(cond => {
          if (cond.entity_key === 'status' && cond.operator === '!=' && cond.value === 'ONLINE') {
            offlineChecked = true;
          } else if (cond.entity_key === 'latency' && cond.operator === '>') {
            latencyChecked = true;
            document.getElementById('rule-trigger-latency-ms').value = cond.value;
          } else {
            customChecked = true;
            document.getElementById('rule-trigger-custom-op').value = cond.operator;
            document.getElementById('rule-trigger-custom-val').value = cond.value;
          }
        });

        document.getElementById('rule-trigger-offline').checked = offlineChecked;
        document.getElementById('rule-trigger-latency').checked = latencyChecked;
        document.getElementById('rule-trigger-custom').checked = customChecked;

        // Toggle selected channels
        document.querySelectorAll('.rule-channel-chk').forEach(c => {
          c.checked = rule.channel_ids.includes(parseInt(c.value));
        });

        // Toggle selected targets
        const ruleTargets = rule.targets_list || [];
        if (ruleTargets.length === 0 && rule.monitors_list) {
          rule.monitors_list.forEach(mid => ruleTargets.push(`monitor-${mid}`));
        }
        document.querySelectorAll('.rule-target-chk').forEach(c => {
          c.checked = ruleTargets.includes(c.value);
        });
      }
    } catch (err) {
      alert(`Failed to load rule detail: ${err.message}`);
    }
  } else {
    titleEl.textContent = 'Create Alert Rule';
  }

  const searchInput = document.getElementById('rule-target-search');
  if (searchInput) searchInput.value = '';

  openModal('rule-modal');
}

window.filterRuleTargetsSelector = function () {
  const query = document.getElementById('rule-target-search').value.toLowerCase().trim();
  const items = document.querySelectorAll('.rule-target-item');
  items.forEach(item => {
    const text = item.textContent.toLowerCase();
    if (text.includes(query)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
};

async function submitSaveRule() {
  const name = document.getElementById('rule-name').value.trim();
  if (!name) {
    alert("Warning rule must have a name!");
    return;
  }

  // Gather conditions array from simplified checkboxes
  const conditions = [];

  if (document.getElementById('rule-trigger-offline').checked) {
    conditions.push({ entity_key: 'status', operator: '!=', value: 'ONLINE', join_type: 'OR' });
  }

  if (document.getElementById('rule-trigger-latency').checked) {
    const lval = document.getElementById('rule-trigger-latency-ms').value.trim();
    if (!lval) {
      alert("Latency threshold limit cannot be empty!");
      return;
    }
    conditions.push({ entity_key: 'latency', operator: '>', value: lval, join_type: 'OR' });
  }

  if (document.getElementById('rule-trigger-custom').checked) {
    const cval = document.getElementById('rule-trigger-custom-val').value.trim();
    if (!cval) {
      alert("Custom trigger threshold check value cannot be empty!");
      return;
    }
    conditions.push({
      entity_key: 'status',
      operator: document.getElementById('rule-trigger-custom-op').value,
      value: cval,
      join_type: 'OR'
    });
  }

  if (conditions.length === 0) {
    alert("Please enable at least 1 trigger condition!");
    return;
  }

  // Clear first join type connector
  conditions[0].join_type = '';

  // Gather channel IDs
  const channel_ids = [];
  document.querySelectorAll('.rule-channel-chk:checked').forEach(c => {
    channel_ids.push(parseInt(c.value));
  });

  if (channel_ids.length === 0) {
    alert("Please select at least 1 destination notification channel!");
    return;
  }

  // Gather target keys list
  const targets_list = [];
  document.querySelectorAll('.rule-target-chk:checked').forEach(c => {
    targets_list.push(c.value);
  });

  if (targets_list.length === 0) {
    alert("Please select at least 1 target health checker or plugin sensor!");
    return;
  }

  // Backward compatibility parsing
  const monitors_list = [];
  targets_list.forEach(tk => {
    if (tk.startsWith('monitor-')) {
      monitors_list.push(parseInt(tk.split('-')[1]));
    }
  });

  const cooldown_interval = document.getElementById('rule-cooldown').value || '5m';

  const { httpUrl } = getApiUrls();
  const rid = window.activeAlertRuleId;
  const method = rid ? 'PUT' : 'POST';
  const url = rid ? `${httpUrl}/api/alerts/rules/${rid}` : `${httpUrl}/api/alerts/rules`;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        rules_json: conditions,
        channel_ids,
        enabled: true,
        target_type: 'custom',
        monitors_list,
        target_groups: [],
        target_groups_operator: 'any',
        targets_list,
        cooldown_interval
      })
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
  if (!await showConfirm("Are you sure you want to delete this warning rule definition?", "Delete Alert Rule")) return;

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
        enabled: enabled,
        target_type: rule.target_type || 'all',
        monitors_list: rule.monitors_list || [],
        target_groups: rule.target_groups || [],
        target_groups_operator: rule.target_groups_operator || 'any',
        targets_list: rule.targets_list || [],
        cooldown_interval: rule.cooldown_interval || '5m'
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

