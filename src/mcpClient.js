const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  ProgressNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema
} = require('@modelcontextprotocol/sdk/types.js');
const { resourceCache, invalidateResource } = require('./chatRouter.js');

let mcpClient = null;
let supportsResourceSubscribe = false;
// In-memory roots store
let rootsStore = [];
// Local cache of tools with enabled/disabled state
let toolsCache = [];
const mcpInfo = {
  servers: [
    {
      url: null,
      capabilities: {},
      tools: [],
      prompts: [],
      resources: [],
      templates: []
    }
  ]
};

/**
 * Initialize and connect the MCP client.
 * @param {object} options
 * @param {URL} options.baseUrl - MCP server URL
 * @param {string} options.samplingModel - model name for sampling
 * @param {object} options.openai - OpenAI client instance
 * @param {function} options.broadcastUpdate - SSE broadcast function
 */
async function startMcpClient({ baseUrl, samplingModel, openai, broadcastUpdate }) {
  mcpClient = new Client(
    { name: 'demo-mcp-host', version: '0.1.0' },
    { capabilities: { roots: { listChanged: true }, sampling: {}, experimental: { ping: {} } } }
  );
  // Logging handlers
  mcpClient.fallbackNotificationHandler = (notification) => {
    console.log('[Host] Raw MCP notification:', notification.method, notification.params);
  };
  mcpClient.onerror = (error) => {
    console.error('[Host] MCP transport error:', error);
  };
  mcpClient.onclose = () => {
    console.warn('[Host] MCP transport closed');
  };
  // Handle server request for roots list
  const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  mcpClient.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: rootsStore }));
  // Handle server-initiated sampling requests
  mcpClient.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const params = request.params;
    const reqId = String(request.id);
    console.log('[Host] Sampling requested by server:', reqId, params);
    broadcastUpdate('sampling/request', { id: reqId, ...params });
    // Wait for decision via /sampling/decision endpoint
    const decision = await new Promise((resolve, reject) => {
      const key = reqId;
      const handlers = require('./samplingDecision');
      handlers.once(key, resolve, reject);
    });
    if (!decision) {
      const err = new Error('User rejected sampling request'); err.code = -1;
      throw err;
    }
    // Build messages and call OpenAI
    const msgs = [];
    if (params.systemPrompt) msgs.push({ role: 'system', content: params.systemPrompt });
    for (const m of params.messages || []) {
      if (m.content?.type === 'text') msgs.push({ role: m.role, content: m.content.text });
    }
    const resp = await openai.chat.completions.create({ model: samplingModel, messages: msgs, temperature: params.temperature, max_tokens: params.maxTokens, stop: params.stopSequences });
    const choice = resp.choices?.[0];
    const text = choice?.message?.content || '';
    const stopReason = choice?.finish_reason === 'stop' ? 'stopSequence' : choice?.finish_reason === 'length' ? 'maxTokens' : 'endTurn';
    const result = { role: 'assistant', content: { type: 'text', text }, model: choice?.model || samplingModel, stopReason };
    broadcastUpdate('sampling/response', result);
    return result;
  });
  // Attempt Streamable HTTP transport, fallback to SSE on HTTP 4xx with retries
  let usingSse = false;
  while (true) {
    try {
      const httpTransport = new StreamableHTTPClientTransport(baseUrl);
      await mcpClient.connect(httpTransport);
      console.log('Connected using Streamable HTTP transport');
      break;
    } catch (err) {
      const msg = err.message || err;
      const status = err.status || err.code || err.response?.status;
      if (msg.includes('(HTTP 4') || (typeof status === 'number' && status >= 400 && status < 500)) {
        console.warn('Streamable HTTP returned 4xx, falling back to SSE transport');
        usingSse = true;
        break;
      }
      console.error('Streamable HTTP transport error, retrying in 1s:', msg);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  // If HTTP failed with 4xx, connect via SSE with retry loop
  if (usingSse) {
    const retryIntervalMs = 1000;
    while (true) {
      try {
        const sseTransport = new SSEClientTransport(baseUrl);
        await mcpClient.connect(sseTransport);
        console.log('Connected using SSE transport');
        break;
      } catch (err2) {
        console.error('SSE transport connect error, retrying in 1s:', err2.message || err2);
        await new Promise(r => setTimeout(r, retryIntervalMs));
      }
    }
  }
  // Instrument incoming messages
  if (mcpClient.transport) {
    const transport = mcpClient.transport;
    const orig = transport.onmessage;
    transport.onmessage = (msg, extra) => {
      try {
        console.log('[Host] MCP message received:', JSON.stringify(msg, null, 2));
      } catch {
        console.log('[Host] MCP message received:', msg);
      }
      if (orig) orig.call(transport, msg, extra);
    };
  }
  // Initial discovery
  try {
    // Discover tools and initialize local cache
    const tl = await mcpClient.listTools();
    const allTools = tl.tools || tl.result?.tools || [];
    mcpInfo.servers[0].tools = allTools;
    toolsCache = allTools.map(t => ({ name: t.name, description: t.description || '', enabled: true }));
    // Discover prompts, resources, and templates
    const pl = await mcpClient.listPrompts(); mcpInfo.servers[0].prompts = pl.prompts || pl.result?.prompts || [];
    const rl = await mcpClient.listResources(); mcpInfo.servers[0].resources = rl.resources || rl.result?.resources || [];
    const tpl = await mcpClient.listResourceTemplates(); mcpInfo.servers[0].templates = tpl.resourceTemplates || tpl.result?.resourceTemplates || [];
  } catch (e) {
    console.error('[Host] Initial discovery error:', e);
  }
  // Monkey-patch callTool and readResource to emit progress events during streaming
  try {
    // Patch callTool for progress
    const origCallTool = mcpClient.callTool.bind(mcpClient);
    mcpClient.callTool = (params, resultSchema, options = {}) => {
      const controller = new AbortController();
      const onprogress = (progressParams) => {
        broadcastUpdate('progress', progressParams);
      };
      return origCallTool(params, resultSchema, { ...options, signal: controller.signal, onprogress });
    };
    // Patch readResource for progress
    const origReadResource = mcpClient.readResource.bind(mcpClient);
    mcpClient.readResource = (params, options = {}) => {
      const controller = new AbortController();
      const onprogress = (progressParams) => {
        broadcastUpdate('progress', progressParams);
      };
      return origReadResource(params, { ...options, signal: controller.signal, onprogress });
    };
  } catch (e) {
    console.warn('[Host] Progress patching skipped:', e);
  }
  // Listen for change notifications
  if (mcpClient.addEventListener) {
    mcpClient.addEventListener('resources/change', p => broadcastUpdate('resources/change', p));
    mcpClient.addEventListener('resourceTemplates/change', p => broadcastUpdate('templates/change', p));
  }
  // Capability negotiation, progress notifications, and ping
  try {
    const caps = mcpClient.getServerCapabilities() || {};
    mcpInfo.servers[0].capabilities = caps;
    supportsResourceSubscribe = Boolean(caps.resources?.subscribe);
    // Register handler for progress notifications
    if (mcpClient.setNotificationHandler) {
      mcpClient.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        const params = notification.params || {};
        broadcastUpdate('progress', params);
      });
    }
    // Periodic ping to keep connection alive
    setInterval(async () => {
      try {
        await mcpClient.ping();
        console.log('[Host] Ping successful');
      } catch (err) {
        console.error('[Host] Ping error:', err);
      }
    }, 30000);
    console.log('[Host] Scheduled ping every 30s');
    // Handle resource update notifications (per-resource)
    if (mcpClient.setNotificationHandler) {
      mcpClient.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        (notification) => {
          const params = notification.params || {};
          console.log('[Host] Resource updated notification:', params);
          // Invalidate the resource cache
          if (params.uri) {
            console.log('[Host] Invalidating cache for resource:', params.uri);
            invalidateResource(params.uri);
          }
          broadcastUpdate('resources/change', params);
        }
      );
      // Handle resource list change notifications
      mcpClient.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async (notification) => {
          console.log('[Host] Resource list changed notification received');
          try {
            const rl = await mcpClient.listResources();
            const newEntries = rl.resources || rl.result?.resources || [];
            console.log('[Host] Updated resources list:', newEntries);
            const oldEntries = mcpInfo.servers[0].resources || [];
            const oldUris = oldEntries.map(r => typeof r === 'string' ? r : r.uri);
            const newUris = newEntries.map(r => typeof r === 'string' ? r : r.uri);
            const added = newUris.filter(u => !oldUris.includes(u));
            const removed = oldUris.filter(u => !newUris.includes(u));
            // Optionally unsubscribe removed resources
            if (caps.resources?.subscribe) {
              for (const uri of removed) {
                try { await mcpClient.unsubscribeResource({ uri }); } catch {}
              }
            }
            mcpInfo.servers[0].resources = newEntries;
            broadcastUpdate('resources/list_changed', { resources: newUris, added, removed });
          } catch (err) {
            console.error('[Host] Error handling resource list change:', err);
          }
        }
      );
      // Handle prompt list change notifications
      mcpClient.setNotificationHandler(
        PromptListChangedNotificationSchema,
        (notification) => {
          const params = notification.params || {};
          console.log('[Host] Prompts list changed:', params);
          broadcastUpdate('prompts/list_changed', params);
        }
      );
      // Handle tool list change notifications
      mcpClient.setNotificationHandler(
        ToolListChangedNotificationSchema,
        (notification) => {
          const params = notification.params || {};
          console.log('[Host] Tools list changed:', params);
          broadcastUpdate('tools/list_changed', params);
        }
      );
    }
  } catch (e) {
    console.error('[Host] Capabilities negotiation error:', e);
  }
}

function getMcpClient() { return mcpClient; }
function getSupportsResourceSubscribe() { return supportsResourceSubscribe; }
function getMcpInfo() { return mcpInfo; }
/**
 * Add a root to the client store
 * @param {string} name
 * @param {string} uri
 */
function addRoot(name, uri) {
  rootsStore.push({ name, uri });
}
/**
 * Remove a root by name
 * @param {string} name
 */
function removeRoot(name) {
  const idx = rootsStore.findIndex(r => r.name === name);
  if (idx !== -1) rootsStore.splice(idx, 1);
}
/**
 * Get a copy of the roots list
 * @returns {Array<{name:string,uri:string}>}
 */
function getRoots() { return rootsStore.slice(); }
/**
 * Get the list of tools with enabled state
 * @returns {Array<{name:string,description:string,enabled:boolean}>}
 */
function getTools() { return toolsCache; }
/**
 * Enable or disable a tool by name
 * @param {string} name
 * @param {boolean} enabled
 * @returns {{name:string,description:string,enabled:boolean}|null}
 */
function setToolEnabled(name, enabled) {
  const tool = toolsCache.find(t => t.name === name);
  if (!tool) return null;
  tool.enabled = !!enabled;
  return tool;
}
module.exports = {
  startMcpClient,
  getMcpClient,
  getSupportsResourceSubscribe,
  getMcpInfo,
  getTools,
  setToolEnabled,
  addRoot,
  removeRoot,
  getRoots
};