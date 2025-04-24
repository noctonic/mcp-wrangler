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
  ListRootsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const { resourceCache, invalidateResource } = require('./chatRouter.js');

let mcpClient = null;
let supportsResourceSubscribe = false;
let rootsStore = [];
let toolsCache = [];
const mcpInfo = { servers: [{ url: null, capabilities: {}, tools: [], prompts: [], resources: [], templates: [] }] };

// Configuration
const RETRY_INTERVAL_MS = 1000;
const MAX_RETRIES = 5;

// Simple logger utility
const logger = {
  log: (msg, data) => console.log(`[MCP] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[MCP] WARN: ${msg}`, data || ''),
  error: (msg, data) => console.error(`[MCP] ERROR: ${msg}`, data || '')
};

// Retry helper
async function retryWithDelay(fn, delay = RETRY_INTERVAL_MS, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      logger.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms...`, err.message);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

// Transport setup (HTTP -> SSE fallback)
async function setupTransport(baseUrl, client) {
  try {
    await retryWithDelay(() => client.connect(new StreamableHTTPClientTransport(baseUrl)));
    logger.log('Connected using Streamable HTTP transport');
  } catch (err) {
    const status = err.status || err.code || err.response?.status;
    if (String(err).includes('(HTTP 4') || (typeof status === 'number' && status >= 400 && status < 500)) {
      logger.warn('Streamable HTTP 4xx, falling back to SSE', err.message);
      await retryWithDelay(() => client.connect(new SSEClientTransport(baseUrl)));
      logger.log('Connected using SSE transport');
    } else {
      throw err;
    }
  }
}

// Patch progress events into callTool/readResource
function patchProgress(client, broadcastUpdate) {
  const origCallTool = client.callTool.bind(client);
  client.callTool = (params, schema, options = {}) => {
    const controller = new AbortController();
    const onprogress = p => broadcastUpdate('progress', p);
    return origCallTool(params, schema, { ...options, signal: controller.signal, onprogress });
  };

  const origReadResource = client.readResource.bind(client);
  client.readResource = (params, options = {}) => {
    const controller = new AbortController();
    const onprogress = p => broadcastUpdate('progress', p);
    return origReadResource(params, { ...options, signal: controller.signal, onprogress });
  };
}

// Register request handlers
function registerRequestHandlers(client, samplingModel, openai, broadcastUpdate) {
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: rootsStore }));

  client.setRequestHandler(CreateMessageRequestSchema, async request => {
    const { params } = request;
    const reqId = String(request.id);
    logger.log('Sampling requested:', { reqId, params });
    broadcastUpdate('sampling/request', { id: reqId, ...params });

    const decision = await new Promise((resolve, reject) => {
      require('./samplingDecision').once(reqId, resolve, reject);
    });
    if (!decision) {
      const err = new Error('User rejected sampling request'); err.code = -1;
      throw err;
    }

    const messages = [];
    if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt });
    for (const m of params.messages || []) {
      if (m.content?.type === 'text') messages.push({ role: m.role, content: m.content.text });
    }

    const resp = await openai.chat.completions.create({
      model: samplingModel,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stop: params.stopSequences
    });

    const choice = resp.choices?.[0] || {};
    const text = choice.message?.content || '';
    const finish = choice.finish_reason;
    const stopReason = finish === 'stop' ? 'stopSequence' : finish === 'length' ? 'maxTokens' : 'endTurn';

    const result = { role: 'assistant', content: { type: 'text', text }, model: choice.model || samplingModel, stopReason };
    broadcastUpdate('sampling/response', result);
    return result;
  });
}

// Register notification handlers
async function registerNotificationHandlers(client, broadcastUpdate) {
  const caps = client.getServerCapabilities() || {};
  supportsResourceSubscribe = Boolean(caps.resources?.subscribe);

  client.setNotificationHandler(ProgressNotificationSchema, notif => {
    broadcastUpdate('progress', notif.params || {});
  });

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, notif => {
    const { uri } = notif.params || {};
    if (uri) {
      logger.log('Invalidating cache for', uri);
      invalidateResource(uri);
    }
    broadcastUpdate('resources/change', notif.params || {});
  });

  client.setNotificationHandler(ResourceListChangedNotificationSchema, async notif => {
    logger.log('Resource list changed, updating cache');
    try {
      const rl = await client.listResources();
      const newEntries = rl.resources || rl.result?.resources || [];
      const oldUris = (mcpInfo.servers[0].resources || []).map(r => typeof r === 'string' ? r : r.uri);
      const newUris = newEntries.map(r => typeof r === 'string' ? r : r.uri);
      const added = newUris.filter(u => !oldUris.includes(u));
      const removed = oldUris.filter(u => !newUris.includes(u));
      if (supportsResourceSubscribe) {
        for (const uri of removed) {
          try { await client.unsubscribeResource({ uri }); } catch {}
        }
      }
      mcpInfo.servers[0].resources = newEntries;
      broadcastUpdate('resources/list_changed', { resources: newUris, added, removed });
    } catch (err) {
      logger.error('Error handling resource list change', err);
    }
  });

  client.setNotificationHandler(PromptListChangedNotificationSchema, notif => {
    broadcastUpdate('prompts/list_changed', notif.params || {});
  });

  client.setNotificationHandler(ToolListChangedNotificationSchema, notif => {
    broadcastUpdate('tools/list_changed', notif.params || {});
  });
}

// Main initializer
async function startMcpClient({ baseUrl, samplingModel, openai, broadcastUpdate }) {
  mcpClient = new Client(
    { name: 'demo-mcp-host', version: '0.1.0' },
    { capabilities: { roots: { listChanged: true }, sampling: {}, experimental: { ping: {} } } }
  );

  // Basic handlers
  mcpClient.fallbackNotificationHandler = notification => logger.log('Raw MCP notification', notification);
  mcpClient.onerror = err => logger.error('Transport error', err);
  mcpClient.onclose = () => logger.warn('Transport closed');

  registerRequestHandlers(mcpClient, samplingModel, openai, broadcastUpdate);
  await setupTransport(baseUrl, mcpClient);

  // Instrument incoming messages
  if (mcpClient.transport) {
    const orig = mcpClient.transport.onmessage;
    mcpClient.transport.onmessage = (msg, extra) => {
      logger.log('MCP message received', msg);
      if (orig) orig.call(mcpClient.transport, msg, extra);
    };
  }

  // Initial discovery
  try {
    const tl = await mcpClient.listTools();
    const allTools = Array.isArray(tl.tools) ? tl.tools : tl.result?.tools || [];
    mcpInfo.servers[0].tools = allTools.map(t => ({
      type: 'function', name: t.name, description: t.description || '',
      parameters: { type: 'object', properties: t.inputSchema?.properties || {}, required: t.inputSchema?.required || [], additionalProperties: false }, strict: true
    }));
    toolsCache = allTools.map(t => ({ name: t.name, description: t.description || '', enabled: true }));

    const pl = await mcpClient.listPrompts();
    mcpInfo.servers[0].prompts = pl.prompts || pl.result?.prompts || [];
    const rl = await mcpClient.listResources();
    mcpInfo.servers[0].resources = rl.resources || rl.result?.resources || [];
    const tpl = await mcpClient.listResourceTemplates();
    mcpInfo.servers[0].templates = tpl.resourceTemplates || tpl.result?.resourceTemplates || [];

  } catch (err) {
    logger.error('Initial discovery error', err);
  }

  patchProgress(mcpClient, broadcastUpdate);
  await registerNotificationHandlers(mcpClient, broadcastUpdate);

  // Periodic ping
  setInterval(async () => {
    try { await mcpClient.ping(); logger.log('Ping successful'); }
    catch (err) { logger.error('Ping error', err); }
  }, 30000);
}

function getMcpClient() { return mcpClient; }
function getSupportsResourceSubscribe() { return supportsResourceSubscribe; }
function getMcpInfo() { return mcpInfo; }
function addRoot(name, uri) { rootsStore.push({ name, uri }); }
function removeRoot(name) { rootsStore = rootsStore.filter(r => r.name !== name); }
function getRoots() { return rootsStore.slice(); }
function getTools() { return toolsCache; }
function setToolEnabled(name, enabled) {
  const tool = toolsCache.find(t => t.name === name);
  if (!tool) return null;
  tool.enabled = !!enabled;
  return tool;
}
function getEnabledTools() {
  return mcpInfo.servers[0].tools.filter(t => toolsCache.find(ct => ct.name === t.name && ct.enabled));
}

module.exports = {
  startMcpClient,
  getMcpClient,
  getSupportsResourceSubscribe,
  getMcpInfo,
  addRoot,
  removeRoot,
  getRoots,
  getTools,
  setToolEnabled,
  getEnabledTools
};