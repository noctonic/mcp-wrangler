document.addEventListener('DOMContentLoaded', () => {
  let conversationEnabled = false;
  let previousResponseId = null;

  const convoToggle = document.getElementById('conversationToggle');
  convoToggle.addEventListener('change', () => {
    conversationEnabled = convoToggle.checked;
  });

  const resetBtn = document.getElementById('resetConversation');
  resetBtn.addEventListener('click', () => {
    previousResponseId = null;
    appendMessage('info', 'Conversation has been reset.');
  });

  const messagesDiv = document.getElementById('messages');
  const input = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  // SSE connection for server updates
  const updates = new EventSource('/updates');
  // Model selector: fetch available models and track current selection
  const modelSelect = document.getElementById('modelSelect');
  let currentModel = null;
  let currentSamplingModel = null;
  async function initModelSelector() {
    try {
      // Fetch default model from server config
      const cfgRes = await fetch('/config');
      const cfg = await cfgRes.json();
      currentModel = cfg.MODEL;
      currentSamplingModel = cfg.SAMPLING_MODEL;
      // Fetch list of models
      const res = await fetch('/models');
      const data = await res.json();
      if (Array.isArray(data.models)) {
        data.models.forEach(m => {
          const opt = document.createElement('option');
          // model id, e.g. 'gpt-4'
          opt.value = m.id || m.model || m.name;
          opt.innerText = m.id || m.model || m.name;
          modelSelect.appendChild(opt);
        });
        // Set default selection
        modelSelect.value = currentModel;
      }
      modelSelect.addEventListener('change', () => {
        currentModel = modelSelect.value;
      });
    } catch (err) {
      console.error('Failed to initialize model selector:', err);
    }
  }
  initModelSelector();
  initSamplingSelector();
  initRootsSection();

  /**
   * Initialize sampling model selector
   */
  async function initSamplingSelector() {
    const sel = document.getElementById('samplingSelect');
    if (!sel) return;
    try {
      const res = await fetch('/models');
      const data = await res.json();
      if (Array.isArray(data.models)) {
        data.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id || m.model || m.name;
          opt.innerText = m.id || m.model || m.name;
          sel.appendChild(opt);
        });
        // Set default sampling model
        if (currentSamplingModel) sel.value = currentSamplingModel;
        sel.addEventListener('change', () => {
          currentSamplingModel = sel.value;
        });
      }
    } catch (err) {
      console.error('Failed to initialize sampling selector:', err);
    }
  }
  
  /**
   * Initialize roots management UI
   */
  function initRootsSection() {
    const nameInput = document.getElementById('rootNameInput');
    const uriInput = document.getElementById('rootUriInput');
    const addBtn = document.getElementById('addRootBtn');
    const listEl = document.getElementById('rootsList');
    if (!nameInput || !uriInput || !addBtn || !listEl) return;
    // Load current roots from server
    async function loadRoots() {
      try {
        const res = await fetch('/roots');
        const data = await res.json();
        renderRoots(data.roots || []);
      } catch (err) {
        console.error('Failed to load roots:', err);
      }
    }
    // Render roots list
    function renderRoots(roots) {
      listEl.innerHTML = '';
      roots.forEach(root => {
        const li = document.createElement('li');
        li.innerText = `${root.name}: ${root.uri}`;
        // Remove button
        const btn = document.createElement('button');
        btn.innerText = '-';
        btn.title = 'Remove root';
        btn.addEventListener('click', async () => {
          try {
            await fetch('/roots', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: root.name })
            });
            loadRoots();
          } catch (err) {
            console.error('Failed to remove root:', err);
          }
        });
        li.appendChild(btn);
        listEl.appendChild(li);
      });
    }
    // Add root
    addBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const uri = uriInput.value.trim();
      if (!name || !uri) return;
      try {
        await fetch('/roots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, uri })
        });
        nameInput.value = '';
        uriInput.value = '';
        loadRoots();
      } catch (err) {
        console.error('Failed to add root:', err);
      }
    });
    // React to SSE roots changes
    updates.addEventListener('roots/list_changed', e => {
      try {
        const data = JSON.parse(e.data);
        renderRoots(data.roots || []);
      } catch (err) {
        console.error('[UI] Failed to parse roots/list_changed:', err);
      }
    });
    // Initial load
    loadRoots();
  }
  // Track URIs that have been fetched and cached by the host
  const cachedUris = new Set();
  // Track URIs that the user has actively selected (survives list re-renders)
  const activeUris = new Set();
  const templateCache = {};
  // Render the list of resources in the table
  function renderResourceList() {
    const tbody = document.querySelector('#resourcesTable tbody');
    tbody.innerHTML = '';
    if (!Array.isArray(window.mcpResources)) return;
    window.mcpResources.forEach((r, idx) => {
      const uri = typeof r === 'string' ? r : r.uri || '';
      const tr = document.createElement('tr');
      // Active column
      const tdActive = document.createElement('td');
      tdActive.className = 'col-active';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; 
      cb.id = `res_${idx}`; 
      cb.dataset.uri = uri;
      // Active column: check based on user selection (activeUris)
      cb.checked = activeUris.has(uri);
      // Keep activeUris in sync when user toggles
      cb.addEventListener('change', () => {
        if (cb.checked) activeUris.add(uri);
        else activeUris.delete(uri);
      });
      tdActive.appendChild(cb);
      tr.appendChild(tdActive);
      // Cache column
      const tdCache = document.createElement('td');
      tdCache.className = 'col-cache';
      const useCb = document.createElement('input');
      useCb.type = 'checkbox'; 
      useCb.id = `useCached_${idx}`; 
      useCb.className = 'use-cached';
      // Enable and check the cache checkbox if this URI was previously cached
      if (cachedUris.has(uri)) {
        useCb.disabled = false;
        useCb.checked = true;
      } else {
        useCb.disabled = true;
        useCb.checked = false;
      }
      tdCache.appendChild(useCb);
      tr.appendChild(tdCache);
      // Name column
      const tdName = document.createElement('td');
      tdName.className = 'col-name';
      tdName.title = uri;
      tdName.innerText = uri;
      tr.appendChild(tdName);
      tbody.appendChild(tr);
    });
  }

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    appendMessage('user', text);
    input.value = '';
    // Gather user selections
    const promptName = document.getElementById('promptSelect').value;
    // Prompt args
    const promptArgs = {};
    if (window.mcpPrompts) {
      const promptDef = window.mcpPrompts.find(p => p.name === promptName);
      if (promptDef && Array.isArray(promptDef.arguments)) {
        promptDef.arguments.forEach(argDef => {
          const key = argDef.name;
          const el = document.getElementById(`promptArg_${key}`);
          if (el) {
            let v = el.value;
            // try convert to number if needed
            if (argDef.type === 'number') v = Number(v);
            promptArgs[key] = v;
          }
        });
      }
    }
    // Resources: collect URI + useCached flag
    const selectedResources = [];
    document.querySelectorAll('#resources input[type=checkbox]').forEach(cb => {
      if (!cb.dataset.uri) return;
      if (cb.checked) {
        const idx = cb.id.split('_')[1];
        const useCb = document.getElementById(`useCached_${idx}`);
        selectedResources.push({ uri: cb.dataset.uri, useCached: useCb ? useCb.checked : false });
      }
    });
    // Templates: collect URI + args + useCached flag
    const selectedTemplates = [];
    document.querySelectorAll('#selectedTemplates .selected-template').forEach(entry => {
      const uriInput = entry.querySelector('input.selected-template-uri');
      if (!uriInput) return;
      const useTplCb = entry.querySelector('input.use-cached');
      selectedTemplates.push({ uri: uriInput.value, args: {}, useCached: useTplCb ? useTplCb.checked : false });
    });
    try {
      const resp = await fetch('/chat/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          promptName,
          promptArgs,
          selectedResources,
          selectedTemplates,
          model: currentModel,
          // Include tool_required flag for whether functions are allowed
          tool_required: document.getElementById('requiredToolsToggle')?.checked === true,
          conversation: conversationEnabled,
          previous_response_id: previousResponseId
        })
      });
      const data = await resp.json();
      if (data.response_id) {
        previousResponseId = data.response_id;
      }
      // Handle cancellation
      if (data.cancelled) {
        appendMessage('info', 'Operation cancelled by user');
        return;
      }
      // Tool-call notifications
      if (Array.isArray(data.toolCalls)) {
        data.toolCalls.forEach(call => {
          appendMessage('info', `[LLM called ${call.name}@server with params ${JSON.stringify(call.args)}]`);
        });
      }
      // Display assistant reply
      appendMessage('assistant', data.reply || '[No reply]');
      // Enable "Use cached" toggles now that resources have been fetched
      document.querySelectorAll('#resourcesTable tr').forEach(tr => {
        const mainCb = tr.querySelector('input[type=checkbox]:not(.use-cached)');
        const useCb = tr.querySelector('input.use-cached');
        if (mainCb && mainCb.checked && useCb) {
          useCb.disabled = false;
          useCb.checked = true;
          // Mark this URI as cached for future list renders
          cachedUris.add(mainCb.dataset.uri);
        }
      });
      // Enable "Use cached" for templates now fetched
      document.querySelectorAll('#selectedTemplates input.use-cached').forEach(useCb => {
        useCb.disabled = false;
        useCb.checked = true;
      });
    } catch (err) {
      appendMessage('error', err.message);
    }
  });

  // Sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('toggleSidebar');
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
  // Right panel toggle
  const rightpanel = document.getElementById('rightpanel');
  const toggleRightBtn = document.getElementById('toggleRightpanel');
  toggleRightBtn.addEventListener('click', () => {
    rightpanel.classList.toggle('collapsed');
  });
  // Load and render available tools (toggles)
  async function loadTools() {
    const toolsDiv = document.getElementById('tools');
    try {
      const res = await fetch('/tools');
      const data = await res.json();
      if (data.tools && data.tools.length) {
        // Header and Required toggle
        const header = document.createElement('div');
        header.className = 'tools-header';
        const h3 = document.createElement('h3');
        h3.innerText = 'Available Tools';
        header.appendChild(h3);
        // Required toggle
        const reqLabel = document.createElement('label'); reqLabel.className = 'switch required-switch';
        const reqCb = document.createElement('input'); reqCb.type = 'checkbox'; reqCb.id = 'requiredToolsToggle';
        const reqSlider = document.createElement('span'); reqSlider.className = 'slider';
        const reqText = document.createElement('span'); reqText.innerText = 'Required'; reqText.className = 'required-text';
        reqLabel.appendChild(reqCb); reqLabel.appendChild(reqSlider); header.appendChild(reqLabel); header.appendChild(reqText);
        toolsDiv.appendChild(header);
      data.tools.forEach(tool => {
        // Container for each tool toggle
        const itemDiv = document.createElement('div');
        // Slider switch
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = tool.enabled;
        cb.addEventListener('change', async () => {
          await fetch('/tools/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: tool.name, enabled: cb.checked })
          });
        });
        const slider = document.createElement('span');
        slider.className = 'slider';
        switchLabel.appendChild(cb);
        switchLabel.appendChild(slider);
        // Tool name with help icon for description
        const nameSpan = document.createElement('span');
        nameSpan.innerText = tool.name;
        // Help icon with custom tooltip for description
        const helpIcon = document.createElement('span');
        helpIcon.className = 'tool-help';
        helpIcon.innerText = '?';
        // Create tooltip text element
        const tooltipSpan = document.createElement('span');
        tooltipSpan.className = 'tooltip-text';
        tooltipSpan.innerText = tool.description;
        helpIcon.appendChild(tooltipSpan);
        // Append to container
        itemDiv.appendChild(switchLabel);
        itemDiv.appendChild(nameSpan);
        itemDiv.appendChild(helpIcon);
        toolsDiv.appendChild(itemDiv);
      });
      }
    } catch (err) {
      console.error('Failed to load tools:', err);
    }
  }
  loadTools();

  // Load and render MCP features: prompts, resources, templates
  async function loadMcpFeatures() {
    try {
      const res = await fetch('/mcp_info');
      const data = await res.json();
      const srv = data.servers[0] || {};
      // Store definitions globally
      window.mcpPrompts = srv.prompts || [];
      console.log('Loaded prompts definitions:', window.mcpPrompts);
      window.mcpResources = srv.resources || [];
      window.mcpTemplates = srv.templates || [];
      // Prompts: select + dynamic form
      const promptSelect = document.getElementById('promptSelect');
      const promptArgsForm = document.getElementById('promptArgsForm');
      // Clear and show placeholder
      promptSelect.innerHTML = '<option value="">No Prompt</option>';
      promptArgsForm.innerHTML = '<p style="opacity:0.6;">Select a prompt to configure arguments</p>';
      // Populate prompt selector
      window.mcpPrompts.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.innerText = p.name;
        promptSelect.appendChild(opt);
      });
      // On change, rebuild args form
      promptSelect.addEventListener('change', () => {
        promptArgsForm.innerHTML = '';
        const name = promptSelect.value;
        const def = window.mcpPrompts.find(p => p.name === name);
        if (!def) return;
        // Filter out internal 'ctx' argument; only show real prompt parameters
        const argsArr = Array.isArray(def.arguments)
          ? def.arguments.filter(arg => arg.name !== 'ctx')
          : [];
        if (argsArr.length === 0) {
          const msg = document.createElement('p');
          msg.style.opacity = '0.6';
          msg.innerText = 'No arguments required for this prompt.';
          promptArgsForm.appendChild(msg);
          return;
        }
        argsArr.forEach(argDef => {
          const key = argDef.name;
          const fld = document.createElement('div');
          const lbl = document.createElement('label');
          lbl.innerText = key + (argDef.required ? ' *' : '');
          const inp = document.createElement('input');
          inp.id = `promptArg_${key}`;
          inp.name = key;
          inp.type = argDef.type === 'number' ? 'number' : 'text';
          if (argDef.default !== undefined) inp.value = argDef.default;
          fld.appendChild(lbl);
          fld.appendChild(inp);
          promptArgsForm.appendChild(fld);
        });
      });
      // Render resource list, preserving existing cache state
      renderResourceList();
      // Templates: available templates + add/remove editable URI list
      const templateSelect = document.getElementById('templateSelect');
      const addBtn = document.getElementById('addTemplateBtn');
      const selectedDiv = document.getElementById('selectedTemplates');
      // Populate available templates dropdown
      templateSelect.innerHTML = '<option value="">-- Select template --</option>';
      window.mcpTemplates.forEach(t => {
        // Show the template 'name', store the uriTemplate for editing
        const nameVal = t.name || t.uriTemplate || t.uri || t.template || JSON.stringify(t);
        const uriVal = t.uriTemplate || t.uri || t.template || t.name || JSON.stringify(t);
        const opt = document.createElement('option');
        opt.value = uriVal;
        opt.innerText = nameVal;
        templateSelect.appendChild(opt);
      });
      // Add selected template instance for editing
      addBtn.addEventListener('click', () => {
        const tmplUri = templateSelect.value;
        if (!tmplUri) return;
        const entry = document.createElement('div');
        entry.className = 'selected-template';
        // Header: editable URI and remove button
        const hdr = document.createElement('div');
        const uriInput = document.createElement('input');
        uriInput.type = 'text';
        uriInput.value = tmplUri;
        uriInput.className = 'selected-template-uri';
        uriInput.style.marginRight = '0.5em';
        const rm = document.createElement('button');
        rm.innerText = '-'; rm.title = 'Remove template';
        rm.addEventListener('click', () => entry.remove());
        hdr.appendChild(uriInput);
        hdr.appendChild(rm);
        entry.appendChild(hdr);
        selectedDiv.appendChild(entry);
      });
    } catch (err) {
      console.error('Failed to load MCP features:', err);
    }
  }
  loadMcpFeatures();
  // Manage tasks with progress bars
  const tasksList = document.getElementById('tasksList');
  const tasksMap = new Map(); // token => {description, status, progress, total}

  function renderTask(task) {
    let bar = document.querySelector(`.task-bar[data-token="${task.token}"]`);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'task-bar';
      bar.dataset.token = task.token;
      const fill = document.createElement('div'); fill.className = 'fill';
      const label = document.createElement('div'); label.className = 'label';
      // Cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'task-cancel';
      cancelBtn.textContent = '×';
      cancelBtn.title = 'Cancel task';
      cancelBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (task.status !== 'running') return;
        try {
          await fetch('/tasks/cancel', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ token: task.token, reason: 'User cancelled' })
          });
          task.status = 'cancelled';
          renderTask(task);
        } catch (err) {
          console.error('Cancel failed', err);
        }
      });
      bar.appendChild(fill);
      bar.appendChild(label);
      bar.appendChild(cancelBtn);
      tasksList.appendChild(bar);
    }
    const fill = bar.querySelector('.fill');
    const label = bar.querySelector('.label');
    // Compute width percent
    const pct = task.total ? Math.round((task.progress/task.total)*100) : 0;
    fill.style.width = `${pct}%`;
    if (task.status === 'running') {
      bar.classList.remove('complete');
      label.innerText = `${task.description}: Running${task.total ? ` ${pct}%` : ''}`;
    } else {
      bar.classList.add('complete');
      const statusText = task.status === 'complete' ? 'Complete' : 'Cancelled';
      label.innerText = `${task.description}: ${statusText}`;
    }
  }


  function appendMessage(role, text) {
    const p = document.createElement('p');
    p.className = role;
    // Display message text only, without role prefix
    p.innerText = text;
    messagesDiv.appendChild(p);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
  // Subscribe to server updates via SSE and refresh UI lists (updates already initialized)
  updates.addEventListener('resources/list_changed', e => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      console.error('[UI] Failed to parse resources/list_changed data:', err);
      return;
    }
    // Update resource list and re-render sidebar
    window.mcpResources = data.resources;
    renderResourceList();
  });
  updates.addEventListener('prompts/list_changed', e => {
    console.log('[UI] SSE prompts/list_changed event:', e);
    console.log('[UI] raw event.data:', e.data);
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch (err) {
      console.warn('[UI] Failed to parse prompts/list_changed data:', err);
      parsed = e.data;
    }
    console.log('[UI] parsed prompts/list_changed data:', parsed);
    loadMcpFeatures();
  });
  updates.addEventListener('tools/list_changed', e => {
    console.log('[UI] SSE tools/list_changed event:', e);
    console.log('[UI] raw event.data:', e.data);
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch (err) {
      console.warn('[UI] Failed to parse tools/list_changed data:', err);
      parsed = e.data;
    }
    console.log('[UI] parsed tools/list_changed data:', parsed);
    loadTools();
  });
  // Progress notifications: update task bars
  updates.addEventListener('progress', e => {
    console.log('[UI] SSE progress event:', e);
    console.log('[UI] raw event.data:', e.data);
    let params;
    try {
      params = JSON.parse(e.data);
    } catch (err) {
      console.error('[UI] Failed to parse progress data:', err);
      return;
    }
    console.log('[UI] parsed progress params:', params);
    try {
      const token = params.progressToken;
      let task = tasksMap.get(token);
      if (!task) {
        task = { token, description: `Task ${token}`, status: 'running', progress: 0, total: params.total };
        tasksMap.set(token, task);
      }
      task.progress = params.progress || 0;
      task.total = params.total || task.total;
      if (task.total && task.progress >= task.total) {
        task.status = 'complete';
      }
      renderTask(task);
    } catch (err) {
      console.error('[UI] Error updating task progress:', err);
    }
  });
  // Handle resource change events: disable "Use cached" toggle
  // Sampling request from server: user approval
  updates.addEventListener('sampling/request', e => {
    console.log('[UI] SSE sampling/request event:', e);
    let params;
    try { params = JSON.parse(e.data); } catch (err) {
      console.error('[UI] Failed to parse sampling/request data:', err);
      return;
    }
    const promptText = 'Sampling requested by server:\n' + JSON.stringify(params, null, 2) + '\n\nApprove request?';
    const approved = window.confirm(promptText);
    fetch('/sampling/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: params.id, approved })
    }).catch(err => console.error('[UI] Failed to send sampling decision:', err));
  });
  // Handle resource change events: disable "Use cached" toggle
  updates.addEventListener('resources/change', e => {
    console.log('[UI] SSE resources/change event:', e);
    console.log('[UI] raw event.data:', e.data);
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      console.error('[UI] Failed to parse resources/change data:', err);
      return;
    }
    console.log('[UI] parsed resources/change data:', data);
    const { uri } = data;
    
    // Remove the URI from the cachedUris set to indicate it's no longer cached
    if (uri && cachedUris.has(uri)) {
      console.log('[UI] Removing URI from cached set:', uri);
      cachedUris.delete(uri);
    }
    
    const idx = window.mcpResources.findIndex(r => (typeof r === 'string' ? r : r.uri) === uri);
    console.log('[UI] resource index matched:', idx);
    const useCb = document.getElementById(`useCached_${idx}`);
    if (useCb) {
      console.log('[UI] disabling useCached checkbox for idx', idx);
      useCb.checked = false;
      useCb.disabled = true;
    }
  });
  // Handle template change events: mark cache stale
  updates.addEventListener('templates/change', e => {
    console.log('[UI] SSE templates/change event:', e);
    console.log('[UI] raw event.data:', e.data);
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      console.error('[UI] Failed to parse templates/change data:', err);
      return;
    }
    console.log('[UI] parsed templates/change data:', data);
    // Templates aren't cached in UI, so no UI update needed.
  });
});