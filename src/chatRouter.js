/**
 * Chat orchestration: handles incoming user messages,
 * integrates MCP resources, prompts, tools, and LLM sampling.
 */
// We now use MCP SDK client (passed via context)
// In-memory caches for resources and templates
const resourceCache = {};
const templateCache = {};
// Track which resources have been subscribed to (first-use subscriptions)
const subscribedResources = new Set();

// Invalidate resource/template caches on change notifications
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
 * @returns {Promise<string>}
 */
async function handleMessage(message, context) {
  const { mcpClient, openai, model, toolsCache, promptName, promptArgs, selectedResources, selectedTemplates } = context;
  // 1. Use provided SDK client
  const client = mcpClient;
  // Initialize array to record any function calls
  const toolCalls = [];


  // 1. Build OpenAI messages and inject selected prompt
  const messages = [];
    if (promptName) {
    console.log('[Host] Prompt selected:', promptName, 'with args:', promptArgs);
    try {
      // Build arguments for MCP prompt call
      const promptArguments = promptArgs || {};
      const promptResp = await mcpClient.getPrompt({ name: promptName, arguments: promptArguments });
      console.log('[Host] Prompt response from MCP:', promptResp);
      let promptContent = '';
      // New schema: some servers return { messages: [ { role, content } ] }
      if (Array.isArray(promptResp.messages) && promptResp.messages.length > 0) {
        const msg0 = promptResp.messages[0];
        if (typeof msg0.content === 'string') {
          promptContent = msg0.content;
        } else if (msg0.content && typeof msg0.content === 'object') {
          // If content is an object with a text field, extract it
          if ('text' in msg0.content && typeof msg0.content.text === 'string') {
            promptContent = msg0.content.text;
          } else {
            promptContent = JSON.stringify(msg0.content);
          }
        }
      } else if (typeof promptResp.prompt === 'string') {
        promptContent = promptResp.prompt;
      } else if (promptResp.result) {
        if (typeof promptResp.result === 'string') {
          promptContent = promptResp.result;
        } else if (promptResp.result && typeof promptResp.result === 'object' && typeof promptResp.result.prompt === 'string') {
          promptContent = promptResp.result.prompt;
        }
      }
      console.log('[Host] Resolved prompt content:', promptContent);
      if (promptContent) {
        messages.push({ role: 'system', content: promptContent });
      }
    } catch (err) {
      console.error('[Host] Error fetching prompt:', err);
    }
  }
  // 2. Inject selected resources as system messages (with caching)
  if (Array.isArray(selectedResources)) {
    for (const { uri, useCached } of selectedResources) {
      try {
        let content;
        if (useCached && resourceCache[uri] && !resourceCache[uri].stale) {
          content = resourceCache[uri].content;
        } else {
          // Read fresh resource and cache it
          const resp = await client.readResource({ uri });
          content = resp.contents || resp.result || '';
          resourceCache[uri] = { content, stale: false };
          // Subscribe to resource updates on first use
          try {
            const serverCaps = client.getServerCapabilities();
            if (serverCaps.resources?.subscribe && !subscribedResources.has(uri)) {
              subscribedResources.add(uri);
              await client.subscribeResource({ uri });
              console.log('[Host] Subscribed to resource:', uri);
            }
          } catch (subErr) {
            console.error('[Host] Error subscribing to resource:', uri, subErr);
          }
        }
        messages.push({
          role: 'system',
          content: `Resource (${uri}): ${typeof content === 'string' ? content : JSON.stringify(content)}`
        });
      } catch (err) {
        console.error('[Host] Error reading resource:', uri, err);
      }
    }
  }
  // 3. Inject selected templates as system messages (always fresh)
  if (Array.isArray(selectedTemplates)) {
    for (const { uri, args } of selectedTemplates) {
      try {
        const resp = await client.readResource({ uri, arguments: args || {} });
        const content = resp.contents || resp.result || '';
        messages.push({
          role: 'system',
          content: `Template (${uri}): ${typeof content === 'string' ? content : JSON.stringify(content)}`
        });
      } catch (err) {
        console.error('[Host] Error reading template:', uri, err);
      }
    }
  }
  // 4. Add the user message
  messages.push({ role: 'user', content: message });

  // Determine function definitions: use requestedTools override or fetch from SDK
  let functions = [];
  if (Array.isArray(context.requestedTools)) {
    // requestedTools from UI: [{ type, function: { name, description, parameters } }, ...]
    functions = context.requestedTools
      .filter(t => t.type === 'function')
      .map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }));
    console.log('[Host] Using requested functions from UI:', functions.map(f => f.name));
  } else {
    try {
      const tl = await client.listTools();
      const allTools = Array.isArray(tl.tools) ? tl.tools : tl.result?.tools || [];
      functions = allTools
        .filter(t => toolsCache.find(ct => ct.name === t.name && ct.enabled))
        .map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }));
      console.log('[Host] Passing functions to LLM:', functions.map(f => f.name));
    } catch (err) {
      console.error('[Host] Failed to list tools from SDK:', err);
    }
  }

  // 4. Build userPayload (tools/tool_choice) for logging, and aiPayload (functions/function_call) for LLM
  const userPayload = { model, messages };
  if (functions.length > 0) {
    userPayload.tools = functions.map(fn => ({ type: 'function', function: fn }));
    userPayload.tool_choice = context.toolRequired ? 'required' : 'auto';
  }
  // Log user-facing payload
  try {
    console.log('[Host] LLM request payload:', JSON.stringify(userPayload, null, 2));
  } catch {
    console.log('[Host] LLM request payload:', userPayload);
  }
  // Build payload for OpenAI SDK
  const aiPayload = { model, messages };
  if (functions.length > 0) {
    aiPayload.functions = functions;
    aiPayload.function_call = context.toolRequired ? 'auto' : 'none';
  }
  const resp = await openai.chat.completions.create(aiPayload);
  console.log('[Host] LLM response:', JSON.stringify(resp, null, 2));

  const msg = resp.choices[0].message;
  // 5. If LLM calls a function (old style) or a tool (new style), forward to MCP client
  if (msg.function_call || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)) {
    // Determine call info depending on spec
    let name, rawArgs;
    if (msg.function_call) {
      ({ name, arguments: rawArgs } = msg.function_call);
      console.log(`[Host] LLM requested function_call: ${name}(${rawArgs})`);
    } else {
      // new "tool_calls" format
      const call = msg.tool_calls[0];
      name = call.function.name;
      rawArgs = call.function.arguments;
      console.log(`[Host] LLM requested tool_call: ${name}(${rawArgs})`);
    }
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    // Record the tool call for UI
    toolCalls.push({ name, args });
    // Execute the tool on the MCP client
    const result = await client.callTool({ name, arguments: args });
    console.log(`[Host] Received result for ${name}:`, JSON.stringify(result, null, 2));
    // Append the assistant's function_call/tool_calls message and its result
    messages.push(msg);
    // Extract function result content
    let funcContent = '';
    if (typeof result.result === 'string') {
      funcContent = result.result;
    } else if (typeof result.content === 'string') {
      funcContent = result.content;
    } else if (Array.isArray(result.content)) {
      funcContent = result.content.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
    } else if (result.content && typeof result.content === 'object' && 'text' in result.content) {
      funcContent = result.content.text;
    } else {
      funcContent = JSON.stringify(result.content || result.result || result);
    }
    messages.push({ role: 'function', name, content: funcContent });
    // Re-query LLM with function/tool output in context
    const followUp = await openai.chat.completions.create({ model, messages });
    console.log('[Host] LLM follow-up response:', JSON.stringify(followUp, null, 2));
    return { reply: followUp.choices[0].message.content, toolCalls };
  }

  // No function call: return text content
  return { reply: msg.content, toolCalls };
}

module.exports = {
  handleMessage,
  resourceCache,
  invalidateResource,
  invalidateTemplate
};