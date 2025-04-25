const express = require('express');

/**
 * OpenAI-related routes: completion proxy and model listing
 * @param {object} options
 * @param {object} options.openai - OpenAI client instance
 * @param {string} options.model - Default model name
 * @returns {Router}
 */
module.exports = function({ openai, model }) {
  const router = express.Router();

  // Proxy completion requests to OpenAI
  router.post('/openai/completion', async (req, res) => {
    try {
      // Log incoming proxy request to OpenAI completion
      console.log('[mcp-wrangler] /openai/completion request:', JSON.stringify(req.body, null, 2));
      const { messages, max_tokens } = req.body;
      const response = await openai.chat.completions.create({
        model,
        messages,
        max_tokens: max_tokens || 100,
      });
      // Log response from OpenAI completion
      try {
        console.log('[mcp-wrangler] /openai/completion response:', JSON.stringify(response, null, 2));
      } catch (e) {
        console.log('[mcp-wrangler] /openai/completion response (unstringifiable):', response);
      }
      res.json({ data: response.choices[0].message });
    } catch (err) {
      console.error('[mcp-wrangler] /openai/completion error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // List available models
  router.get('/models', async (req, res) => {
  try {
      // Log incoming models list request
      console.log('[mcp-wrangler] /models request');
      const list = await openai.models.list();
      const models = Array.isArray(list.data) ? list.data : [];
      // Log response from OpenAI models list
      try {
        console.log('[mcp-wrangler] /models response:', JSON.stringify(models, null, 2));
      } catch (e) {
        console.log('[mcp-wrangler] /models response (unstringifiable):', models);
      }
      res.json({ models });
    } catch (err) {
      console.error('[mcp-wrangler] /models error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};