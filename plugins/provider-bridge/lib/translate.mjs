import { createHash } from 'node:crypto';
import { BridgeError } from './http.mjs';

export function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  throw new BridgeError('Message content must be a string or block array.');
}

export function textContent(content) {
  return blocks(content).map(block => {
    if (block.type !== 'text') throw new BridgeError(`Unsupported content block: ${block.type}.`);
    return block.text;
  }).join('\n');
}

export function historyKey(content) {
  const normalized = blocks(content).filter(b => !['thinking', 'redacted_thinking'].includes(b.type)).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    return b;
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export const bridgeId = id => `bridge_${Buffer.from(id).toString('base64url')}`;
export const upstreamId = id => id.startsWith('bridge_') ? Buffer.from(id.slice(7), 'base64url').toString() : id;

function imageUrl(block) {
  if (block.source?.type === 'base64' && /^image\//.test(block.source.media_type)) return `data:${block.source.media_type};base64,${block.source.data}`;
  if (block.source?.type === 'url' && /^https:\/\//.test(block.source.url)) return block.source.url;
  throw new BridgeError('Unsupported image source. Use base64 or HTTPS images.');
}

function toolDefinitions(body) {
  return (body.tools || []).map(tool => {
    if (tool.type && tool.type !== 'custom') throw new BridgeError(`Unsupported provider tool type: ${tool.type}. Disable tool search and server tools for this provider.`);
    if (!tool.name || !tool.input_schema) throw new BridgeError('Provider tools require a name and input_schema.');
    return { type: 'function', name: tool.name, description: tool.description || '', parameters: tool.input_schema, strict: false };
  });
}

export function validateRequest(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) throw new BridgeError('A nonempty messages array is required.');
  if (body.stream != null && typeof body.stream !== 'boolean') throw new BridgeError('stream must be a boolean.');
  for (const message of body.messages) {
    if (!['user', 'assistant', 'system'].includes(message.role)) throw new BridgeError('Unsupported message role.');
    blocks(message.content);
  }
  if (body.output_config?.format || body.output_format) throw new BridgeError('Structured output formats are unsupported by this bridge.');
  if (body.context_management || body.container || body.mcp_servers) throw new BridgeError('Server-side context management, containers, and hosted MCP are unsupported.');
}

function cachedHistory(message, cache) {
  const cached = cache.get(historyKey(message.content));
  if (!cached && blocks(message.content).some(b => b.type === 'tool_use' && b.id?.startsWith('bridge_'))) throw new BridgeError('Provider reasoning history is no longer available. Start a fresh Claude Code session; bridge sessions cannot resume after the launcher restarts.');
  return cached;
}

export function toResponses(body, model, cache = new Map()) {
  validateRequest(body);
  const input = [];
  const instructions = body.system ? [textContent(body.system)] : [];
  for (const message of body.messages) {
    if (message.role === 'system') { instructions.push(textContent(message.content)); continue; }
    if (message.role === 'assistant') {
      const cached = cachedHistory(message, cache);
      if (cached) { input.push(...cached); continue; }
    }
    for (const block of blocks(message.content)) {
      if (block.type === 'text') input.push({ role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text }] });
      else if (block.type === 'image' && message.role === 'user') input.push({ role: 'user', content: [{ type: 'input_image', image_url: imageUrl(block) }] });
      else if (block.type === 'tool_use' && message.role === 'assistant') input.push({ type: 'function_call', call_id: upstreamId(block.id), namespace: 'claude_code', name: block.name, arguments: JSON.stringify(block.input) });
      else if (block.type === 'tool_result' && message.role === 'user') input.push({ type: 'function_call_output', call_id: upstreamId(block.tool_use_id), output: `${block.is_error ? 'Tool error: ' : ''}${typeof block.content === 'string' ? block.content : textContent(block.content || [])}` });
      else if (!['thinking', 'redacted_thinking'].includes(block.type)) throw new BridgeError(`Unsupported content block: ${block.type}.`);
    }
  }
  const request = { model, input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  if (instructions.length) request.instructions = instructions.join('\n\n');
  const definitions = toolDefinitions(body);
  if (definitions.length) request.tools = [{ type: 'namespace', name: 'claude_code', description: 'Tools executed locally by Claude Code with its permission checks.', tools: definitions }];
  if (body.tool_choice?.type === 'none') request.tool_choice = 'none';
  else if (body.tool_choice?.type === 'any') request.tool_choice = 'required';
  else if (body.tool_choice?.type === 'tool') {
    if (!definitions.some(t => t.name === body.tool_choice.name)) throw new BridgeError('Requested tool is not available.');
    request.tool_choice = { type: 'function', namespace: 'claude_code', name: body.tool_choice.name };
  }
  // Preview rejects temperature, top_p, max_output_tokens and previous_response_id.
  return request;
}

export function toChatCompletions(body, model, cache = new Map()) {
  validateRequest(body);
  const messages = body.system ? [{ role: 'system', content: textContent(body.system) }] : [];
  for (const message of body.messages) {
    if (message.role === 'system') { messages.push({ role: 'system', content: textContent(message.content) }); continue; }
    if (message.role === 'assistant') {
      const cached = cachedHistory(message, cache);
      if (cached) { messages.push(cached); continue; }
    }
    let content = [], calls = [];
    const flush = () => {
      if (!content.length && !calls.length) return;
      const entry = { role: message.role, content: content.length ? content : null };
      if (calls.length) entry.tool_calls = calls;
      messages.push(entry); content = []; calls = [];
    };
    for (const block of blocks(message.content)) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && message.role === 'user') content.push({ type: 'image_url', image_url: { url: imageUrl(block) } });
      else if (block.type === 'tool_use' && message.role === 'assistant') calls.push({ id: upstreamId(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      else if (block.type === 'tool_result' && message.role === 'user') {
        flush();
        messages.push({ role: 'tool', tool_call_id: upstreamId(block.tool_use_id), content: `${block.is_error ? 'Tool error: ' : ''}${typeof block.content === 'string' ? block.content : textContent(block.content || [])}` });
      } else if (!['thinking', 'redacted_thinking'].includes(block.type)) throw new BridgeError(`Unsupported content block: ${block.type}.`);
    }
    flush();
  }
  const request = { model, messages, stream: true, stream_options: { include_usage: true } };
  const definitions = toolDefinitions(body);
  if (definitions.length) request.tools = definitions.map(({ type, ...definition }) => ({ type, function: definition }));
  if (body.max_tokens != null) request.max_tokens = body.max_tokens;
  if (body.temperature != null) request.temperature = body.temperature;
  if (body.stop_sequences?.length) request.stop = body.stop_sequences;
  if (body.tool_choice?.type === 'none') request.tool_choice = 'none';
  else if (body.tool_choice?.type === 'any') request.tool_choice = 'required';
  else if (body.tool_choice?.type === 'tool') request.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  return request;
}
