/**
 * Chat orchestration: handles incoming user input,
 * integrates MCP resources, prompts, tools, and LLM sampling.
 */
// In-memory caches for resources and templates
const resourceCache = {};
const templateCache = {};
const subscribedResources = new Set();

function invalidateResource(uri) {
  if (resourceCache[uri]) resourceCache[uri].stale = true;
}
function invalidateTemplate(uri) {
  if (templateCache[uri]) templateCache[uri].stale = true;
}

/**
 * Handle a user message and return assistant reply.
 * @param {string} message
 * @param {object} context
 * @returns {Promise<{reply: string, toolCalls: Array}>}
 */
async function handleMessage(message, context) {
  const { mcpClient, openai, model, promptName, promptArgs, selectedResources, selectedTemplates, toolRequired } = context;
  const client = mcpClient;
  const toolCalls = [];
  const input = [];

  // 1. System prompt (if any)
  if (promptName) {
    try {
      const pr = await client.getPrompt({ name: promptName, arguments: promptArgs || {} });

      const msgs = pr.messages;

      const first = msgs[0] ?? null;

      // Pull out the actual text
      let content =
        first?.content?.text       ||
        (typeof first?.content === 'string' ? first.content : undefined) ||
        pr.prompt                  ||
        pr.result?.prompt          ||
        '';

      if (typeof content !== 'string') {
        content = JSON.stringify(content);
      }
      if (content) {
        input.push({ role: 'system', content });
      }
    } catch (e) {
      console.error('Failed fetching prompt:', e);
    }
  }


  // 2. Inject resources
  if (Array.isArray(selectedResources)) {
    for (const { uri, useCached } of selectedResources) {
      try {
        let c;
        if (useCached && resourceCache[uri] && !resourceCache[uri].stale) {
          c = resourceCache[uri].content;
        } else {
          const r = await client.readResource({ uri });
          c = r.contents || r.result || '';
          resourceCache[uri] = { content: c, stale: false };
          if (client.getServerCapabilities()?.resources?.subscribe && !subscribedResources.has(uri)) {
            await client.subscribeResource({ uri });
            subscribedResources.add(uri);
          }
        }
        const txt = typeof c === 'string' ? c : JSON.stringify(c);
        input.push({ role: 'system', content: `Resource (${uri}): ${txt}` });
      } catch (e) {
        console.error('Error reading resource', uri, e);
      }
    }
  }

  // 3. Inject templates
  if (Array.isArray(selectedTemplates)) {
    for (const { uri, args } of selectedTemplates) {
      try {
        const r = await client.readResource({ uri, arguments: args || {} });
        const tpl = r.contents || r.result || '';
        const txt = typeof tpl === 'string' ? tpl : JSON.stringify(tpl);
        input.push({ role: 'system', content: `Template (${uri}): ${txt}` });
      } catch (e) {
        console.error('Error reading template', uri, e);
      }
    }
  }

  // 4. User message
  input.push({ role: 'user', content: message });

  // 5. Tools
  const { getEnabledTools } = require('./mcpClient');
  const tools = getEnabledTools();
  console.log('Enabled tools:', tools.map(t => t.name));

  // 6. Build payload
  const payload = { model, input };
  if (tools.length) {
    payload.tools = tools;
    if (toolRequired) payload.tool_choice = 'required';
  }
  console.log('Calling OpenAI with payload', payload);

  // Helper: call the responses endpoint
  async function callOpenAI(p) {
    try {
      return await openai.responses.create(p);
    } catch (err) {
      console.error('OpenAI API error:', err);
      throw err;
    }
  }

  // ** First pass **
  const firstRes = await callOpenAI(payload);

  // If no function calls: pure‐text turn
  if (!Array.isArray(firstRes.output) || firstRes.output.length === 0) {
    const text = firstRes.output_text || '';
    return { reply: text, toolCalls: [] };
  }

  // ** Function‐call turn **
  for (const call of firstRes.output) {
    if (call.type !== 'function_call') continue;

    const args = JSON.parse(call.arguments || '{}');
    toolCalls.push({ name: call.name, args });

    // Execute the function
    const result = await client.callTool({ name: call.name, arguments: args });
    const raw = result.result ?? result.content;
    const resultStr = typeof raw === 'string' ? raw : JSON.stringify(raw);

    // Append the function‐call message
    input.push(
      { type: 'function_call', name: call.name, arguments: call.arguments, call_id: call.call_id },
      { type: 'function_call_output', call_id: call.call_id, output: resultStr }
    );
  }

  // ** Second pass for final reply **
  const finalRes = await callOpenAI({ model, input, tools });
  const replyText = finalRes.output_text || '';
  return { reply: replyText, toolCalls };
}

module.exports = {
  handleMessage,
  invalidateResource,
  invalidateTemplate,
};
