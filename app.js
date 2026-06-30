// Initialize Lucide icons
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  simulateRealtimeUpdates();
  
  // Set current UTC time in header
  updateHeaderTime();
  setInterval(updateHeaderTime, 1000);
});

// Header refresh time simulation
function updateHeaderTime() {
  const timeText = document.getElementById('refresh-time-text');
  if (timeText) {
    const now = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    const timeStr = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    timeText.textContent = `Last refreshed: ${timeStr} UTC • Live connection active`;
  }
}

// Sidebar Collapsible Toggle
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar');
const sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  
  // Update chevron icon
  sidebarToggleIcon.setAttribute('data-lucide', isCollapsed ? 'chevron-right' : 'chevron-left');
  lucide.createIcons();
});

// Edit Mode Toggle
const editToggleBtn = document.getElementById('edit-toggle-btn');
const mainContent = document.getElementById('main-content');

editToggleBtn.addEventListener('click', () => {
  const isEditMode = mainContent.classList.toggle('edit-mode');
  editToggleBtn.classList.toggle('active');
  
  // Update button content
  const spanText = editToggleBtn.querySelector('span');
  spanText.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Dashboard';
  
  const icon = editToggleBtn.querySelector('i');
  icon.setAttribute('data-lucide', isEditMode ? 'check' : 'edit-3');
  lucide.createIcons();
});

// Smart Outlet Interactivity
const outletToggle = document.getElementById('outlet-toggle');
const outletStatus = document.getElementById('outlet-status');
const smartOutletCard = document.getElementById('smart-outlet-card');
const outletPill = document.getElementById('outlet-pill');
const brightnessSlider = document.getElementById('brightness-slider');

outletToggle.addEventListener('change', (e) => {
  const isOn = e.target.checked;
  outletStatus.textContent = isOn ? 'ON' : 'OFF';
  
  if (isOn) {
    smartOutletCard.classList.add('highlighted');
    outletPill.className = 'status-pill stable';
    outletPill.textContent = 'Stable';
    addAuditEntry('success', 'Living Room Lights outlet state turned ON.');
  } else {
    smartOutletCard.classList.remove('highlighted');
    outletPill.className = 'status-pill caution';
    outletPill.textContent = 'Standby';
    addAuditEntry('info', 'Living Room Lights outlet state turned OFF (Standby).');
  }
});

brightnessSlider.addEventListener('input', (e) => {
  const value = e.target.value;
  // Limit logging to prevent spam
  if (Math.random() > 0.8) {
    addAuditEntry('info', `Living Room Lights brightness adjusted to ${value}%.`);
  }
});

// Tabs filter system
let activeTab = 'main';
function switchTab(tabName) {
  activeTab = tabName;
  
  // Update tab buttons
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('onclick').includes(tabName)) {
      btn.classList.add('active');
    }
  });

  // Filter cards
  const cards = document.querySelectorAll('.dashboard-grid > .card');
  cards.forEach(card => {
    // Keep placeholder visible during edit mode
    if (card.classList.contains('card-placeholder')) return;

    const tags = card.getAttribute('data-tags');
    if (tags && tags.includes(tabName)) {
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  });
}

// Discovery Banner Interaction
const discoveryBanner = document.getElementById('discovery-banner');
const discoveryBadge = document.getElementById('discovery-badge');
const dashboardGrid = document.getElementById('dashboard-grid');

function dismissDiscovery() {
  discoveryBanner.classList.add('hide');
  addAuditEntry('info', 'mDNS discovery alert for smart-plug-01.local dismissed by admin.');
}

function approveDiscovery() {
  discoveryBanner.classList.add('hide');
  
  // Decrement discovery badge count
  let count = parseInt(discoveryBadge.textContent);
  count--;
  if (count <= 0) {
    discoveryBadge.style.opacity = '0';
    discoveryBadge.style.pointerEvents = 'none';
  } else {
    discoveryBadge.textContent = count;
  }

  // Create new card matching the reference theme
  const newCard = document.createElement('div');
  newCard.className = 'card highlighted new-card-anim';
  newCard.setAttribute('data-tags', 'main,power');
  newCard.setAttribute('id', 'new-discovered-card');
  
  newCard.innerHTML = `
    <div class="edit-handle"><i data-lucide="grip-horizontal"></i></div>
    <div class="edit-settings"><i data-lucide="sliders"></i></div>
    <div class="card-header">
      <div class="card-title-area">
        <span class="card-title">Smart Plug 01</span>
        <span class="card-subtitle">smart-plug-01.local</span>
      </div>
      <span class="status-pill optimal" id="plug-pill">Optimal</span>
    </div>
    <div class="card-body">
      <div class="card-value" id="plug-power">
        12.4<span class="card-unit"> W</span>
      </div>
      <div class="control-row" style="margin-top: 14px;">
        <div class="status-indicator">
          <span class="status-dot online"></span>
          <span>Online</span>
        </div>
        <label class="switch">
          <input type="checkbox" id="plug-toggle" checked>
          <span class="slider"></span>
        </label>
      </div>
    </div>
  `;

  // Insert before placeholder card
  const placeholder = document.querySelector('.card-placeholder');
  dashboardGrid.insertBefore(newCard, placeholder);
  
  // Re-run icons initialization for new elements
  lucide.createIcons();
  
  // Toggle feature for new card
  const plugToggle = newCard.querySelector('#plug-toggle');
  const plugPower = newCard.querySelector('#plug-power');
  const plugPill = newCard.querySelector('#plug-pill');
  
  plugToggle.addEventListener('change', (e) => {
    const isOn = e.target.checked;
    newCard.classList.toggle('highlighted', isOn);
    plugPower.innerHTML = isOn ? '12.4<span class="card-unit"> W</span>' : '0.0<span class="card-unit"> W</span>';
    plugPill.className = isOn ? 'status-pill optimal' : 'status-pill caution';
    plugPill.textContent = isOn ? 'Optimal' : 'Standby';
    addAuditEntry(isOn ? 'success' : 'info', `Smart Plug 01 turned ${isOn ? 'ON' : 'OFF'}.`);
  });

  // Log to audit log
  addAuditEntry('success', 'mDNS node smart-plug-01.local approved and added to active monitor list.');
}

// Add Card Placeholder Click Handler
function addNewCardPlaceholder() {
  alert('Entity Configurator: Select discovered entities to mount as grid cards.');
}

// Audit Log Appender
const auditList = document.getElementById('audit-list');
function addAuditEntry(type, message) {
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
  
  auditRow.innerHTML = `
    <span class="audit-time">${timestamp}</span>
    <span class="audit-icon ${iconClass}"><i data-lucide="${iconName}" style="width: 14px; height: 14px;"></i></span>
    <span class="audit-msg">${message}</span>
  `;
  
  auditList.insertBefore(auditRow, auditList.firstChild);
  lucide.createIcons();
  
  // Truncate list
  while (auditList.children.length > 8) {
    auditList.removeChild(auditList.lastChild);
  }
}

// Simulate Fluctuating Metrics
function simulateRealtimeUpdates() {
  const cpuVal = document.getElementById('cpu-value');
  const memVal = document.getElementById('mem-value');
  const netVal = document.getElementById('network-value');
  const dbVal = document.getElementById('db-latency-value');
  const apiVal = document.getElementById('api-value');
  const lakeVal = document.getElementById('lake-value');
  
  setInterval(() => {
    // 1. CPU fluctuation
    if (cpuVal) {
      const current = parseFloat(cpuVal.textContent);
      const shift = (Math.random() - 0.5) * 1.5;
      const newVal = Math.max(38.0, Math.min(48.0, current + shift)).toFixed(1);
      cpuVal.innerHTML = `${newVal}<span class="card-unit"> %</span>`;
    }

    // 2. Memory fluctuation
    if (memVal) {
      const current = parseFloat(memVal.textContent);
      const shift = (Math.random() - 0.5) * 0.4;
      const newVal = Math.max(86.0, Math.min(89.5, current + shift)).toFixed(1);
      memVal.innerHTML = `${newVal}<span class="card-unit"> GB</span>`;
    }

    // 3. Network fluctuation
    if (netVal) {
      const current = parseFloat(netVal.textContent);
      const shift = (Math.random() - 0.5) * 0.15;
      const newVal = Math.max(0.8, Math.min(1.8, current + shift)).toFixed(1);
      netVal.innerHTML = `${newVal}<span class="card-unit"> Gb/s</span>`;
    }

    // 4. DB Latency fluctuation
    if (dbVal) {
      const current = parseInt(dbVal.textContent);
      const shift = Math.floor((Math.random() - 0.5) * 3);
      const newVal = Math.max(9, Math.min(16, current + shift));
      dbVal.innerHTML = `${newVal}<span class="card-unit"> ms</span>`;
    }

    // 5. API Requests fluctuation
    if (apiVal) {
      const current = parseFloat(apiVal.textContent);
      const shift = (Math.random() - 0.5) * 0.15;
      const newVal = Math.max(2.1, Math.min(2.8, current + shift)).toFixed(1);
      apiVal.innerHTML = `${newVal}k<span class="card-unit"> req/m</span>`;
    }

    // 6. Data lake storage fluctuation
    if (lakeVal) {
      const current = parseInt(lakeVal.textContent);
      const shift = Math.random() > 0.85 ? (Math.random() > 0.5 ? 1 : -1) : 0;
      const newVal = Math.max(60, Math.min(65, current + shift));
      lakeVal.innerHTML = `${newVal}<span class="card-unit"> %</span>`;
    }

    // 7. Power consumption fluctuation for discovered card
    const plugPower = document.getElementById('plug-power');
    const plugToggle = document.getElementById('plug-toggle');
    if (plugPower && plugToggle && plugToggle.checked) {
      const current = parseFloat(plugPower.textContent);
      const shift = (Math.random() - 0.5) * 0.6;
      const newVal = Math.max(9.0, Math.min(18.0, current + shift)).toFixed(1);
      plugPower.innerHTML = `${newVal}<span class="card-unit"> W</span>`;
    }

    // 8. Occasional simulated audit event
    if (Math.random() > 0.93) {
      const messages = [
        { type: 'info', msg: 'System check completed. All nodes operational.' },
        { type: 'success', msg: 'mDNS local scanner cached 3 discovery targets.' },
        { type: 'info', msg: 'Database connection pools verified. Uptime stable.' },
        { type: 'security', msg: 'SSH connection attempt from subnet 10.0.1.15 approved.' }
      ];
      const selected = messages[Math.floor(Math.random() * messages.length)];
      addAuditEntry(selected.type, selected.msg);
    }
  }, 3000);
}
