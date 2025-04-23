const express = require('express');
const router = express.Router();
const { getMcpClient, getSupportsResourceSubscribe, getMcpInfo } = require('../mcpClient');

/**
 * GET /resources/list
 */
router.get('/resources/list', (req, res) => {
  const info = getMcpInfo();
  res.json({ resources: info.servers[0]?.resources || [] });
});

/**
 * POST /resources/read
 * body: { uri: string }
 */
router.post('/resources/read', async (req, res) => {
  const { uri } = req.body;
  try {
    const client = getMcpClient();
    const resp = await client.readResource({ uri });
    // subscribe on first read if supported
    if (getSupportsResourceSubscribe() && client.subscribeResource) {
      await client.subscribeResource({ uri });
    }
    res.json({ content: resp.contents || resp.result });
  } catch (err) {
    console.error('[Host] /resources/read error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /templates/list
 */
router.get('/templates/list', (req, res) => {
  const info = getMcpInfo();
  res.json({ templates: info.servers[0]?.templates || [] });
});

/**
 * POST /templates/read
 * body: { uri: string, args?: object }
 */
router.post('/templates/read', async (req, res) => {
  const { uri, args } = req.body;
  try {
    const client = getMcpClient();
    // replace placeholders if any
    let resolved = uri;
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args)) {
        resolved = resolved.replace(`{${k}}`, v);
      }
    }
    const resp = await client.readResource({ uri: resolved });
    res.json({ content: resp.contents || resp.result });
  } catch (err) {
    console.error('[Host] /templates/read error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /mcp_info
 */
router.get('/mcp_info', (req, res) => {
  res.json(getMcpInfo());
});

/**
 * GET /prompts/list
 */
router.get('/prompts/list', (req, res) => {
  const info = getMcpInfo();
  res.json({ prompts: info.servers[0]?.prompts || [] });
});

/**
 * POST /prompts/get
 * body: { name: string, args?: object }
 */
router.post('/prompts/get', async (req, res) => {
  const { name, args } = req.body;
  try {
    const client = getMcpClient();
    const resp = await client.getPrompt({ name, arguments: args || {} });
    res.json({ prompt: resp.prompt || resp.result || resp });
  } catch (err) {
    console.error('[Host] /prompts/get error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;