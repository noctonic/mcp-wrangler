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
      const { messages, max_tokens } = req.body;
      const response = await openai.chat.completions.create({
        model,
        messages,
        max_tokens: max_tokens || 100,
      });
      res.json({ data: response.choices[0].message });
    } catch (err) {
      console.error('[Host] /openai/completion error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // List available models
  router.get('/models', async (req, res) => {
    try {
      const list = await openai.models.list();
      const models = Array.isArray(list.data) ? list.data : [];
      res.json({ models });
    } catch (err) {
      console.error('[Host] /models error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};