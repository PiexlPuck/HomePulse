// ============================================================================
// Module: src/09-flow-canvas.ts
// Description: Visual Flow Alert Canvas, Node Inspector & SVG Edge Routing
// ============================================================================

// ==========================================
// ADVANCED FLOW ALERTS CODEBASE ENGINE
// ==========================================
window.flowNodes = [];
window.flowEdges = [];
window.selectedNodeId = null;
window.flowConnectingSourcePort = null; // { nodeId, x, y }
window.flowDragNode = null; // { id, startX, startY, mouseStartX, mouseStartY }
window.activeFlowProfileId = null;

// Available catalog targets cache
window.flowCachedMonitors = [];
window.flowCachedPlugins = [];

window.loadFlowsList = async function () {
  const { httpUrl } = getApiUrls();
  const selectEl = document.getElementById('flow-profile-select');
  if (!selectEl) return;

  try {
    // 1. Fetch available target sources
    const resMon = await fetch(`${httpUrl}/api/monitors`);
    if (resMon.ok) window.flowCachedMonitors = await resMon.json();

    const resPlugins = await fetch(`${httpUrl}/api/plugins/installed`);
    if (resPlugins.ok) window.flowCachedPlugins = await resPlugins.json();

    // 2. Fetch flows list
    const resFlows = await fetch(`${httpUrl}/api/alerts/flows`);
    if (!resFlows.ok) throw new Error("Failed to load Flows from DB");
    const flows = await resFlows.json();

    let options = '<option value="">-- Choose Flow --</option>';
    flows.forEach(flow => {
      options += `<option value="${flow.id}" ${window.activeFlowProfileId == flow.id ? 'selected' : ''}>${escapeHtml(flow.name)} (${flow.enabled ? 'Enabled' : 'Disabled'})</option>`;
    });
    selectEl.innerHTML = options;

    if (!window.activeFlowProfileId && flows.length > 0) {
      window.activeFlowProfileId = flows[0].id;
      selectEl.value = flows[0].id;
      window.onFlowProfileSelected(flows[0].id);
    } else if (window.activeFlowProfileId) {
      const activeFlow = flows.find(f => f.id == window.activeFlowProfileId);
      if (activeFlow) {
        document.getElementById('flow-profile-name').value = activeFlow.name;
        document.getElementById('flow-profile-enabled').checked = activeFlow.enabled;
      }
    }
  } catch (err) {
    showToast(`Flows list load failed: ${err.message}`, "error");
  }
};

window.onFlowProfileSelected = async function (fid) {
  if (!fid) {
    window.createNewFlow();
    return;
  }
  const { httpUrl } = getApiUrls();
  try {
    const resFlows = await fetch(`${httpUrl}/api/alerts/flows`);
    if (!resFlows.ok) throw new Error("API call error");
    const flows = await resFlows.json();
    const flow = flows.find(f => f.id == fid);
    if (!flow) return;

    window.activeFlowProfileId = flow.id;
    document.getElementById('flow-profile-name').value = flow.name;
    document.getElementById('flow-profile-enabled').checked = flow.enabled;

    window.flowNodes = JSON.parse(flow.nodes_json || '[]');
    window.flowEdges = JSON.parse(flow.edges_json || '[]');
    window.selectedNodeId = null;

    document.getElementById('btn-delete-flow').style.display = 'block';

    // Bind interaction logic helper
    window.initFlowWorkspaceListeners();
    window.renderFlowWorkspace();
  } catch (err) {
    showToast(`Failed loading active flow: ${err.message}`, "error");
  }
};

window.createNewFlow = function () {
  window.activeFlowProfileId = null;
  document.getElementById('flow-profile-name').value = 'New Advanced Automation Flow';
  document.getElementById('flow-profile-enabled').checked = true;
  document.getElementById('btn-delete-flow').style.display = 'none';

  window.flowNodes = [];
  window.flowEdges = [];
  window.selectedNodeId = null;

  // Select dropdown reset
  const selectEl = document.getElementById('flow-profile-select');
  if (selectEl) selectEl.value = "";

  window.initFlowWorkspaceListeners();
  window.renderFlowWorkspace();

  // Create first triggers/actions by default
  window.spawnWorkspaceNode('health_trigger', 50, 100);
  window.spawnWorkspaceNode('compare_condition', 280, 100);
  window.spawnWorkspaceNode('notify_action', 510, 100);
};

window.spawnWorkspaceNode = function (type, x = 120, y = 120) {
  const nodeId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let name = "";
  let config = {};

  if (type === 'health_trigger') {
    name = "Health Trigger";
    config = { target_key: "", trigger_type: "offline", latency_ms: "100" };
  } else if (type === 'sensor_trigger') {
    name = "Sensor Trigger";
    config = { target_key: "", trigger_type: "offline" };
  } else if (type === 'compare_condition') {
    name = "Compare Cond.";
    config = { property: "status", operator: "==", value: "" };
  } else if (type === 'notify_action') {
    name = "Dispatch Alarm";
    config = { channel_id: "" };
  }

  // Smart Node Cascading: Offset coordinates if a node already exists in close proximity
  let spawnX = x;
  let spawnY = y;
  while (window.flowNodes.some(n => Math.abs(n.x - spawnX) < 15 && Math.abs(n.y - spawnY) < 15)) {
    spawnX += 25;
    spawnY += 25;
  }

  const newNode = { id: nodeId, type, x: spawnX, y: spawnY, name, config };
  window.flowNodes.push(newNode);
  window.renderFlowWorkspace();
  window.selectFlowWorkspaceNode(nodeId);
};

window.renderFlowWorkspace = function () {
  const canvas = document.getElementById('flow-canvas-panel');
  if (!canvas) return;

  // Clear previous non-SVG elements
  const prevNodes = canvas.querySelectorAll('.flow-node');
  prevNodes.forEach(n => n.remove());

  // Instantiate each Node
  window.flowNodes.forEach(node => {
    const el = document.createElement('div');
    el.className = `flow-node ${window.selectedNodeId === node.id ? 'selected' : ''}`;
    el.id = `flow-node-${node.id}`;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;

    // Inner detail summary
    let desc = "";
    if (node.type === 'health_trigger') {
      const mon = window.flowCachedMonitors.find(m => `monitor-${m.id}` === node.config.target_key);
      desc = mon ? `Monitor: ${mon.name}` : '(No Target)';
    } else if (node.type === 'sensor_trigger') {
      desc = node.config.target_key ? `Sensor: ${node.config.target_key}` : '(No Sensor)';
    } else if (node.type === 'compare_condition') {
      desc = `${node.config.property} ${node.config.operator} ${node.config.value || '?'}`;
    } else if (node.type === 'notify_action') {
      const chan = window.cachedChannels.find(c => c.id == node.config.channel_id);
      desc = chan ? `Notify: ${chan.name}` : '(No Channel)';
    }

    el.innerHTML = `
      <div class="flow-node-title">
        <span>${escapeHtml(node.name)}</span>
        <span onclick="window.deleteWorkspaceNode('${node.id}', event)" style="color:#d9534f; cursor:pointer; font-weight:bold; font-size:0.8rem; padding: 0 2px;">&times;</span>
      </div>
      <div class="flow-node-desc">${escapeHtml(desc)}</div>
    `;

    // Append Input Dot (Left side) if applicable
    if (node.type === 'compare_condition' || node.type === 'notify_action') {
      const inPort = document.createElement('div');
      inPort.className = 'node-port input-port';
      inPort.dataset.nodeId = node.id;
      el.appendChild(inPort);
    }

    // Append Output Dot (Right side) if applicable
    if (node.type === 'health_trigger' || node.type === 'sensor_trigger' || node.type === 'compare_condition') {
      const outPort = document.createElement('div');
      outPort.className = 'node-port output-port';
      outPort.dataset.nodeId = node.id;
      el.appendChild(outPort);
    }

    // Event registrations
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('node-port')) return; // handled separately
      if (e.target.closest('[onclick*="deleteWorkspaceNode"]')) return;
      e.stopPropagation();
      e.preventDefault();
      window.selectFlowWorkspaceNode(node.id);

      const canvasRect = canvas.getBoundingClientRect();
      window.flowDragNode = {
        id: node.id,
        startX: node.x,
        startY: node.y,
        mouseStartX: e.clientX,
        mouseStartY: e.clientY
      };
    });

    el.addEventListener('dragstart', (e) => {
      e.preventDefault();
    });

    canvas.appendChild(el);
  });

  window.redrawFlowLinks();
};

window.selectFlowWorkspaceNode = function (nodeId) {
  window.selectedNodeId = nodeId;
  // Update selection border highlights
  const nodes = document.querySelectorAll('.flow-node');
  nodes.forEach(n => {
    if (n.id === `flow-node-${nodeId}`) {
      n.classList.add('selected');
    } else {
      n.classList.remove('selected');
    }
  });

  window.showNodeProperties(nodeId);
};

window.deleteWorkspaceNode = function (nodeId, event) {
  if (event) event.stopPropagation();
  window.flowNodes = window.flowNodes.filter(n => n.id !== nodeId);
  window.flowEdges = window.flowEdges.filter(e => e.source !== nodeId && e.target !== nodeId);

  if (window.selectedNodeId === nodeId) {
    window.selectedNodeId = null;
    document.getElementById('flow-inspector-content').innerHTML = 'Select a node in the graph workspace to configure parameters.';
  }

  window.renderFlowWorkspace();
};

window.redrawFlowLinks = function () {
  const canvas = document.getElementById('flow-canvas-panel');
  const linksGroup = document.getElementById('flow-links-group');
  if (!canvas || !linksGroup) return;

  linksGroup.innerHTML = "";
  const canvasRect = canvas.getBoundingClientRect();

  window.flowEdges.forEach(edge => {
    // Port elements lookup
    const srcNodeEl = document.getElementById(`flow-node-${edge.source}`);
    const tgtNodeEl = document.getElementById(`flow-node-${edge.target}`);
    if (!srcNodeEl || !tgtNodeEl) return;

    const outPort = srcNodeEl.querySelector('.output-port');
    const inPort = tgtNodeEl.querySelector('.input-port');
    if (!outPort || !inPort) return;

    const outRect = outPort.getBoundingClientRect();
    const inRect = inPort.getBoundingClientRect();

    const x1 = outRect.left - canvasRect.left + outRect.width / 2;
    const y1 = outRect.top - canvasRect.top + outRect.height / 2;
    const x2 = inRect.left - canvasRect.left + inRect.width / 2;
    const y2 = inRect.top - canvasRect.top + inRect.height / 2;

    const dx = Math.abs(x2 - x1) * 0.5;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#e67e22');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('style', 'cursor:pointer;');
    path.setAttribute('title', 'Double-click curve to delete connection');

    // Double click link to remove it!
    path.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      window.flowEdges = window.flowEdges.filter(ed => ed.id !== edge.id);
      window.redrawFlowLinks();
      showToast("Link connection removed.", "warning");
    });

    linksGroup.appendChild(path);
  });
};

window.showNodeProperties = function (nodeId) {
  const container = document.getElementById('flow-inspector-content');
  if (!container) return;

  const node = window.flowNodes.find(n => n.id === nodeId);
  if (!node) {
    container.innerHTML = "Node configuration missing.";
    return;
  }

  let html = `<div style="font-weight:700; color:var(--text-primary); margin-bottom:8px;">Configure ${escapeHtml(node.name)}</div>`;

  if (node.type === 'health_trigger') {
    // target_key monitors selection options dropdown
    let targetOptions = `<option value="">-- Choose target monitor --</option>`;
    window.flowCachedMonitors.forEach(m => {
      targetOptions += `<option value="monitor-${m.id}" ${node.config.target_key === `monitor-${m.id}` ? 'selected' : ''}>[${m.type.toUpperCase()}] ${m.name}</option>`;
    });

    html += `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Health Target</label>
        <select id="prop-target-key" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          ${targetOptions}
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Trigger Type</label>
        <select id="prop-trig-type" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="offline" ${node.config.trigger_type === 'offline' ? 'selected' : ''}>Offline / Unknown</option>
          <option value="latency" ${node.config.trigger_type === 'latency' ? 'selected' : ''}>Latency Threshold</option>
          <option value="custom" ${node.config.trigger_type === 'custom' ? 'selected' : ''}>Custom Value Match</option>
        </select>
      </div>
      
      <div id="prop-latency-group" style="display:${node.config.trigger_type === 'latency' ? 'flex' : 'none'}; flex-direction:column; gap:4px;">
        <label>Latency Threshold (ms)</label>
        <input type="number" id="prop-latency-ms" value="${node.config.latency_ms || '100'}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
      </div>

      <div id="prop-custom-group" style="display:${node.config.trigger_type === 'custom' ? 'flex' : 'none'}; flex-direction:column; gap:4px;">
        <label>Value Operator</label>
        <select id="prop-custom-op" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="==" ${node.config.op === '==' ? 'selected' : ''}>== (equal)</option>
          <option value="!=" ${node.config.op === '!=' ? 'selected' : ''}>!= (not equal)</option>
          <option value=">" ${node.config.op === '>' ? 'selected' : ''}>&gt; (greater)</option>
          <option value="<" ${node.config.op === '<' ? 'selected' : ''}>&lt; (smaller)</option>
          <option value="contains" ${node.config.op === 'contains' ? 'selected' : ''}>contains</option>
        </select>
        <label style="margin-top:4px;">Compare Value</label>
        <input type="text" id="prop-custom-val" value="${node.config.val || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
      </div>
    `;
  } else if (node.type === 'sensor_trigger') {
    // Custom plugins catalog selection dropdown
    let targetOptions = `<option value="">-- Choose custom entity --</option>`;

    // Gather all entities from installed plugins (daemon status, manifest entities, and live runtime entities)
    const entities = [];
    const seenFlowEntityKeys = new Set();
    (window.flowCachedPlugins || []).forEach(plugin => {
      const statusKey = `plugin-${plugin.id}-status`;
      if (!seenFlowEntityKeys.has(statusKey)) {
        seenFlowEntityKeys.add(statusKey);
        entities.push({
          key: statusKey,
          name: `Plugin Daemon Status`,
          plugin: plugin.name
        });
      }
      const manifestEntities = (plugin.entities && typeof plugin.entities === 'object') ? plugin.entities : (plugin.manifest && plugin.manifest.entities ? plugin.manifest.entities : {});
      Object.keys(manifestEntities).forEach(ek => {
        if (!seenFlowEntityKeys.has(ek)) {
          seenFlowEntityKeys.add(ek);
          entities.push({
            key: ek,
            name: manifestEntities[ek].name || ek,
            plugin: plugin.name
          });
        }
      });
      Object.values(cachedEntities || {}).forEach(liveEnt => {
        if (!liveEnt || !liveEnt.entity_key || seenFlowEntityKeys.has(liveEnt.entity_key)) return;
        if (liveEnt.plugin_id === plugin.id || liveEnt.node_id === plugin.id || liveEnt.node_id === `plugin-${plugin.id}`) {
          seenFlowEntityKeys.add(liveEnt.entity_key);
          entities.push({
            key: liveEnt.entity_key,
            name: liveEnt.name || liveEnt.entity_key,
            plugin: plugin.name
          });
        }
      });
    });

    entities.forEach(ent => {
      targetOptions += `<option value="${ent.key}" ${node.config.target_key === ent.key ? 'selected' : ''}>${ent.name} (${ent.plugin})</option>`;
    });

    html += `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Sensor Target</label>
        <select id="prop-target-key" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          ${targetOptions}
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Trigger Type</label>
        <select id="prop-trig-type" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="offline" ${node.config.trigger_type === 'offline' ? 'selected' : ''}>Offline / Faulted</option>
          <option value="custom" ${node.config.trigger_type === 'custom' ? 'selected' : ''}>Custom Value Match</option>
        </select>
      </div>

      <div id="prop-custom-group" style="display:${node.config.trigger_type === 'custom' ? 'flex' : 'none'}; flex-direction:column; gap:4px;">
        <label>Value Operator</label>
        <select id="prop-custom-op" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="==" ${node.config.op === '==' ? 'selected' : ''}>==</option>
          <option value="!=" ${node.config.op === '!=' ? 'selected' : ''}>!=</option>
          <option value="contains" ${node.config.op === 'contains' ? 'selected' : ''}>contains</option>
        </select>
        <label style="margin-top:4px;">Compare Value</label>
        <input type="text" id="prop-custom-val" value="${node.config.val || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
      </div>
    `;
  } else if (node.type === 'compare_condition') {
    html += `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Target Property</label>
        <select id="prop-compare-property" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="status" ${node.config.property === 'status' ? 'selected' : ''}>Status State</option>
          <option value="latency" ${node.config.property === 'latency' ? 'selected' : ''}>Latency (ms)</option>
          <option value="value" ${node.config.property === 'value' ? 'selected' : ''}>Custom Value</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Validation Operator</label>
        <select id="prop-compare-op" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          <option value="==" ${node.config.operator === '==' ? 'selected' : ''}>== (equals)</option>
          <option value="!=" ${node.config.operator === '!=' ? 'selected' : ''}>!= (not equals)</option>
          <option value=">" ${node.config.operator === '>' ? 'selected' : ''}>&gt;</option>
          <option value="<" ${node.config.operator === '<' ? 'selected' : ''}>&lt;</option>
          <option value="contains" ${node.config.operator === 'contains' ? 'selected' : ''}>contains</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Value Constraint</label>
        <input type="text" id="prop-compare-val" value="${node.config.value || ''}" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
      </div>
    `;
  } else if (node.type === 'notify_action') {
    let chanOptions = `<option value="">-- Choose Notification Channel --</option>`;
    window.cachedChannels.forEach(c => {
      chanOptions += `<option value="${c.id}" ${node.config.channel_id == c.id ? 'selected' : ''}>${c.name} (${c.type.toUpperCase()})</option>`;
    });

    html += `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <label>Notify Channel</label>
        <select id="prop-channel-id" style="background:#221d16; color:#fff; border:1px solid var(--border-soft); padding:6px; border-radius:4px; font-size:0.75rem;">
          ${chanOptions}
        </select>
      </div>
    `;
  }

  container.innerHTML = html;

  // Reactivity updates mapping listeners
  const inputs = container.querySelectorAll('input, select, textarea');
  inputs.forEach(input => {
    input.addEventListener('change', () => {
      window.updateWorkspaceNodeConfig(nodeId);
    });
    input.addEventListener('input', () => {
      window.updateWorkspaceNodeConfig(nodeId);
    });
  });

  // Watch for specific select elements toggle groups
  const trigSelect = document.getElementById('prop-trig-type');
  if (trigSelect) {
    trigSelect.addEventListener('change', () => {
      const val = trigSelect.value;
      const latGrp = document.getElementById('prop-latency-group');
      const custGrp = document.getElementById('prop-custom-group');
      if (latGrp) latGrp.style.display = (val === 'latency') ? 'flex' : 'none';
      if (custGrp) custGrp.style.display = (val === 'custom') ? 'flex' : 'none';
      window.updateWorkspaceNodeConfig(nodeId);
    });
  }
};

window.updateWorkspaceNodeConfig = function (nodeId) {
  const node = window.flowNodes.find(n => n.id === nodeId);
  if (!node) return;

  if (node.type === 'health_trigger') {
    node.config.target_key = document.getElementById('prop-target-key').value;
    node.config.trigger_type = document.getElementById('prop-trig-type').value;
    const latIn = document.getElementById('prop-latency-ms');
    if (latIn) node.config.latency_ms = latIn.value.trim();
    const opIn = document.getElementById('prop-custom-op');
    if (opIn) node.config.op = opIn.value;
    const valIn = document.getElementById('prop-custom-val');
    if (valIn) node.config.val = valIn.value.trim();
  } else if (node.type === 'sensor_trigger') {
    node.config.target_key = document.getElementById('prop-target-key').value;
    node.config.trigger_type = document.getElementById('prop-trig-type').value;
    const opIn = document.getElementById('prop-custom-op');
    if (opIn) node.config.op = opIn.value;
    const valIn = document.getElementById('prop-custom-val');
    if (valIn) node.config.val = valIn.value.trim();
  } else if (node.type === 'compare_condition') {
    node.config.property = document.getElementById('prop-compare-property').value;
    node.config.operator = document.getElementById('prop-compare-op').value;
    node.config.value = document.getElementById('prop-compare-val').value.trim();
  } else if (node.type === 'notify_action') {
    node.config.channel_id = document.getElementById('prop-channel-id').value;
  }

  // Refresh descriptive texts immediately
  const nodeEl = document.getElementById(`flow-node-${nodeId}`);
  if (nodeEl) {
    const descEl = nodeEl.querySelector('.flow-node-desc');
    if (descEl) {
      let desc = "";
      if (node.type === 'health_trigger') {
        const mon = window.flowCachedMonitors.find(m => `monitor-${m.id}` === node.config.target_key);
        desc = mon ? `Monitor: ${mon.name}` : '(No Target)';
      } else if (node.type === 'sensor_trigger') {
        desc = node.config.target_key ? `Sensor: ${node.config.target_key}` : '(No Sensor)';
      } else if (node.type === 'compare_condition') {
        desc = `${node.config.property} ${node.config.operator} ${node.config.value || '?'}`;
      } else if (node.type === 'notify_action') {
        const chan = window.cachedChannels.find(c => c.id == node.config.channel_id);
        desc = chan ? `Notify: ${chan.name}` : '(No Channel)';
      }
      descEl.textContent = desc;
    }
  }
};

window.initFlowWorkspaceListeners = function () {
  const canvas = document.getElementById('flow-canvas-panel');
  if (!canvas || canvas.dataset.listenersBound === 'true') return;

  canvas.dataset.listenersBound = 'true';

  // Move drag listener bound on document-level so dragging remains active even outside the canvas boundaries
  document.addEventListener('mousemove', (e) => {
    const canvas = document.getElementById('flow-canvas-panel');
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();

    if (window.flowDragNode) {
      const dx = e.clientX - flowDragNode.mouseStartX;
      const dy = e.clientY - flowDragNode.mouseStartY;

      const node = window.flowNodes.find(n => n.id === flowDragNode.id);
      if (node) {
        node.x = Math.max(0, Math.min(canvasRect.width - 150, flowDragNode.startX + dx));
        node.y = Math.max(0, Math.min(canvasRect.height - 60, flowDragNode.startY + dy));

        const el = document.getElementById(`flow-node-${node.id}`);
        if (el) {
          el.style.left = `${node.x}px`;
          el.style.top = `${node.y}px`;
        }
        window.redrawFlowLinks();
      }
    }

    if (window.flowConnectingSourcePort) {
      const tempPath = document.getElementById('temp-link-path');
      if (tempPath) {
        const x1 = flowConnectingSourcePort.x;
        const y1 = flowConnectingSourcePort.y;
        const x2 = e.clientX - canvasRect.left;
        const y2 = e.clientY - canvasRect.top;

        const dx = Math.abs(x2 - x1) * 0.5;
        const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

        tempPath.setAttribute('d', d);
        tempPath.style.display = 'block';
      }
    }
  });

  // Release mousedowns
  document.addEventListener('mouseup', (e) => {
    const canvas = document.getElementById('flow-canvas-panel');
    if (!canvas) return;

    if (window.flowConnectingSourcePort) {
      // Find output port target
      const targets = document.elementsFromPoint(e.clientX, e.clientY);
      let portEl = targets.find(el => el.classList.contains('node-port') && el.classList.contains('input-port'));
      let targetNodeId = portEl ? portEl.dataset.nodeId : null;

      // Lenient drop mode: allow dropping anywhere on target node containing input port
      if (!targetNodeId) {
        const nodeEl = targets.find(el => el.classList.contains('flow-node') || el.closest('.flow-node'));
        if (nodeEl) {
          const actualNodeEl = nodeEl.classList.contains('flow-node') ? nodeEl : nodeEl.closest('.flow-node');
          if (actualNodeEl && actualNodeEl.id) {
            targetNodeId = actualNodeEl.id.replace('flow-node-', '');
          }
        }
      }

      if (targetNodeId) {
        const tgtNode = window.flowNodes.find(n => n.id === targetNodeId);
        if (tgtNode && (tgtNode.type === 'compare_condition' || tgtNode.type === 'notify_action')) {
          const sourceNodeId = flowConnectingSourcePort.nodeId;
          if (sourceNodeId && targetNodeId !== sourceNodeId) {
            const alreadyLinked = window.flowEdges.some(edge => edge.source === sourceNodeId && edge.target === targetNodeId);
            if (!alreadyLinked) {
              window.flowEdges.push({
                id: `edge_${Date.now()}`,
                source: sourceNodeId,
                target: targetNodeId
              });
            }
          }
        }
      }

      window.flowConnectingSourcePort = null;
      const tempPath = document.getElementById('temp-link-path');
      if (tempPath) tempPath.style.display = 'none';

      window.renderFlowWorkspace();
    }

    window.flowDragNode = null;
  });

  // Clicking canvas port dot triggers link composition
  canvas.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('node-port') && e.target.classList.contains('output-port')) {
      e.stopPropagation();
      e.preventDefault();
      const canvasRect = canvas.getBoundingClientRect();
      const portRect = e.target.getBoundingClientRect();

      window.flowConnectingSourcePort = {
        nodeId: e.target.dataset.nodeId,
        x: portRect.left - canvasRect.left + portRect.width / 2,
        y: portRect.top - canvasRect.top + portRect.height / 2
      };
    }
  });

  canvas.addEventListener('dragstart', (e) => {
    e.preventDefault();
  });
};

window.toggleFlowFullscreen = function () {
  const wrapper = document.querySelector('.flow-workspace-wrapper');
  const icon = document.getElementById('flow-fullscreen-icon');
  const text = document.getElementById('flow-fullscreen-text');
  if (!wrapper) return;

  const isFullscreen = wrapper.classList.toggle('fullscreen-mode');
  if (isFullscreen) {
    if (icon) icon.setAttribute('data-lucide', 'minimize');
    if (text) text.textContent = 'Exit';
  } else {
    if (icon) icon.setAttribute('data-lucide', 'maximize');
    if (text) text.textContent = 'Full Screen';
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Resizing and redrawing connection lines dynamically on changes
  setTimeout(() => {
    window.redrawFlowLinks();
  }, 100);
};

// Bind Escape key to exit fullscreen mode organically
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const wrapper = document.querySelector('.flow-workspace-wrapper');
    if (wrapper && wrapper.classList.contains('fullscreen-mode')) {
      window.toggleFlowFullscreen();
    }
  }
});

window.saveCurrentFlow = async function () {
  const name = document.getElementById('flow-profile-name').value.trim();
  const enabled = document.getElementById('flow-profile-enabled').checked;

  if (!name) {
    alert("Flow profile needs a name!");
    return;
  }

  const payload = {
    name,
    enabled,
    nodes_json: JSON.stringify(window.flowNodes),
    edges_json: JSON.stringify(window.flowEdges)
  };

  const { httpUrl } = getApiUrls();
  const fid = window.activeFlowProfileId;
  const method = fid ? 'PUT' : 'POST';
  const url = fid ? `${httpUrl}/api/alerts/flows/${fid}` : `${httpUrl}/api/alerts/flows`;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    showToast("Advanced Flow alerts setup committed.", "success");

    // Reload lists to populate select IDs
    const commitIdObj = !fid ? await res.json() : null;
    if (commitIdObj && commitIdObj.id) {
      window.activeFlowProfileId = commitIdObj.id;
    }
    window.loadFlowsList();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
};

window.deleteCurrentFlow = async function () {
  const fid = window.activeFlowProfileId;
  if (!fid) return;

  if (!await showConfirm("Confirm permanent deletion of this advanced flow routing configuration? All nodes and edges will be removed.", "Delete Flow")) return;

  const { httpUrl } = getApiUrls();
  try {
    const res = await fetch(`${httpUrl}/api/alerts/flows/${fid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("Deleted advanced flow.", "success");
    window.activeFlowProfileId = null;
    window.loadFlowsList();
    window.createNewFlow();
  } catch (err) {
    showToast(`Deletion failed: ${err.message}`, "error");
  }
};



