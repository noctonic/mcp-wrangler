const express = require('express');
const path = require('path');
const cors = require('cors');
const OpenAI = require('openai');

const {
  startMcpClient,
  getMcpClient,
  getSupportsResourceSubscribe,
  getTools,
  setToolEnabled,
  addRoot,
  removeRoot,
  getRoots
} = require('./mcpClient');
const { initSSE, broadcastUpdate } = require('./sse');
const openaiRoutes = require('./routes/openaiRoutes');
const resourceRoutes = require('./routes/resourceRoutes');
const tasks = require('./tasks');
const chatRouter = require('./chatRouter');
require('dotenv').config();
const fs = require('fs');
const yaml = require('js-yaml');

// Load config.yaml
let config = {};
try {
  const cfg = fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8');
  config = yaml.load(cfg) || {};
} catch (err) {
  console.warn('config.yaml not found or invalid:', err.message);
}

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize SSE endpoints
initSSE(app);

// Resolve configuration
const mcpServerUrl = process.env.MCP_SERVER_URL || config.MCP_SERVER_URL || 'http://localhost:8080';
const apiKey = process.env.OPENAI_API_KEY || config.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY: please set via environment variable or config.yaml');
  process.exit(1);
}
const baseURL = process.env.OPENAI_BASE_URL || config.OPENAI_BASE_URL;
const openai = new OpenAI({ apiKey, baseURL });
const model = process.env.MODEL || config.MODEL || 'gpt-4.1-nano';
const samplingModel = process.env.SAMPLING_MODEL || config.SAMPLING_MODEL || model;

// Start MCP client
(async () => {
  try {
    await startMcpClient({
      baseUrl: new URL(mcpServerUrl),
      samplingModel,
      openai,
      broadcastUpdate
    });
    console.log('Connected to MCP server at', mcpServerUrl);
  } catch (err) {
    console.error('Error starting MCP client:', err);
  }
})();

// Mount grouped routes
app.use(openaiRoutes({ openai, model }));
app.use(resourceRoutes);

// Configuration endpoint
app.get('/config', (req, res) => {
  res.json({
    MCP_SERVER_URL: mcpServerUrl,
    MODEL: model,
    SAMPLING_MODEL: samplingModel
  });
});

// Tools endpoints
app.get('/tools', (req, res) => {
  res.json({ tools: getTools() });
});
app.post('/tools/config', (req, res) => {
  const { name, enabled } = req.body;
  const tool = setToolEnabled(name, enabled);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json({ tool });
});

// Roots endpoints
app.get('/roots', (req, res) => {
  res.json({ roots: getRoots() });
});
app.post('/roots', async (req, res) => {
  const { name, uri } = req.body;
  if (!name || !uri) return res.status(400).json({ error: 'Name and URI required' });
  const exists = getRoots().find(r => r.name === name || r.uri === uri);
  if (exists) return res.status(400).json({ error: 'Root already exists' });
  const newRoot = { name, uri };
  addRoot(name, uri);
  const roots = getRoots();
  broadcastUpdate('roots/list_changed', { roots, added: [newRoot], removed: [] });
  try { await getMcpClient().sendRootsListChanged(); } catch (err) { console.error('[Host] roots list_changed to server failed:', err); }
  res.json({ roots });
});
app.delete('/roots', async (req, res) => {
  const { name } = req.body;
  const exists = getRoots().find(r => r.name === name);
  if (!exists) return res.status(404).json({ error: 'Root not found' });
  removeRoot(name);
  const roots = getRoots();
  broadcastUpdate('roots/list_changed', { roots, added: [], removed: [exists] });
  try { await getMcpClient().sendRootsListChanged(); } catch (err) { console.error('[Host] roots list_changed to server failed:', err); }
  res.json({ roots });
});

// Chat endpoint
app.post('/chat/openai', async (req, res) => {
  try {
    const {
      message,
      promptName,
      promptArgs,
      selectedResources,
      selectedTemplates,
      model: requested,
      tools: requestedTools,
      tool_required,
      conversation = false,
      previous_response_id = null
    } = req.body;

    const usedModel = requested || model;
    const context = {
      mcpClient: getMcpClient(),
      openai,
      model: usedModel,
      toolsCache: getTools(),
      promptName,
      promptArgs,
      selectedResources,
      selectedTemplates,
      requestedTools: Array.isArray(requestedTools) ? requestedTools : null,
      toolRequired: tool_required === true,
      conversationEnabled: Boolean(conversation),
      previousResponseId: previous_response_id
    };

    // Invoke chat logic
    const { reply, toolCalls, responseId } = await chatRouter.handleMessage(message, context);

    // Return snake_case previous_response_id
    res.json({
      reply,
      toolCalls,
      response_id: responseId
    });
  } catch (err) {
    console.error('[Host] /chat/openai error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Tasks endpoints
app.get('/tasks', (req, res) => res.json({ tasks: tasks.listTasks() }));
app.post('/tasks/cancel', (req, res) => {
  const { token, reason } = req.body;
  if (tasks.cancelTask(token, reason)) return res.json({ success: true, token });
  res.status(404).json({ error: 'Task not found' });
});

// Sampling decision endpoint
app.post('/sampling/decision', (req, res) => {
  const { id, approved } = req.body;
  const handlers = require('./samplingDecision');
  if (!handlers.resolve(id, approved)) {
    return res.status(404).json({ error: 'No sampling request with that id.' });
  }
  res.json({ success: true });
});

// Start the server
app.listen(port, () => {
  console.log(`Host server listening on http://localhost:${port}`);
});
