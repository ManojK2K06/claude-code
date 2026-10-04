import { randomUUID } from 'node:crypto';
import { fetchChecked, sse, BridgeError } from './http.mjs';
import { toResponses, toChatCompletions, historyKey, bridgeId } from './translate.mjs';

function parseCall(name, args, tools) {
  if (!tools?.some(t => t.name === name)) throw new BridgeError('Provider requested an undeclared tool.', 502);
  let input;
  try { input = JSON.parse(args); } catch { throw new BridgeError('Provider returned invalid tool arguments.', 502); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('Tool arguments must be an object.', 502);
  return input;
}

export function provider({ kind, model, token, fetcher = fetch, allowedModels, refreshModels }) {
  // Per-launch memory preserves opaque reasoning and Gemini thought signatures.
  const cache = new Map();
  let catalog = allowedModels ? new Set(allowedModels) : undefined;
  let refresh;
  return { kind, model, cache, async *run(body, signal) {
    let selectedModel = model;
    if (catalog) {
      selectedModel = (body.model || model).replace(/^models\//, '');
      if (!catalog.has(selectedModel) && refreshModels) {
        // A model selected through /model may have appeared since launch.
        refresh ||= Promise.resolve().then(refreshModels).then(ids => { catalog = new Set(ids); }).finally(() => { refresh = undefined; });
        await refresh;
      }
      if (!catalog.has(selectedModel)) throw new BridgeError('Selected model is unavailable in the current provider catalog. Use /provider-bridge:models to list available IDs.');
    }
    if (kind === 'chatgpt') {
      const request = toResponses(body, selectedModel, cache);
      const response = await fetchChecked('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(request), signal }, fetcher);
      let completed;
      let streamedText = '';
      for await (const event of sse(response.body)) {
        if (event.type === 'response.output_text.delta') {
          streamedText += event.delta;
          yield { type: 'text', text: event.delta };
        } else if (event.type === 'response.failed' || event.type === 'error') {
          const code = event.response?.error?.code || event.code;
          const limit = ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code);
          throw new BridgeError(limit ? 'ChatGPT plan usage is unavailable or its limit was reached. Manage usage in ChatGPT Settings.' : 'ChatGPT inference failed.', limit ? 429 : 502);
        } else if (event.type === 'response.incomplete') throw new BridgeError('ChatGPT returned an incomplete response.', 502);
        else if (event.type === 'response.completed') { completed = event.response; break; }
      }
      if (!completed || (completed.status && completed.status !== 'completed')) throw new BridgeError('ChatGPT stream ended before response.completed.', 502);
      const content = [];
      const finalText = (completed.output || []).filter(i => i.type === 'message').flatMap(i => i.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      if (streamedText && finalText !== streamedText) throw new BridgeError('ChatGPT stream text did not match its completed response.', 502);
      if (!streamedText && finalText) yield { type: 'text', text: finalText };
      if (finalText) content.push({ type: 'text', text: finalText });
      const calls = [];
      const callIds = new Set();
      for (const item of completed.output || []) {
        if (item.type !== 'function_call') continue;
        if (!item.call_id || (item.namespace && item.namespace !== 'claude_code')) throw new BridgeError('Provider returned an unexpected tool namespace or call ID.', 502);
        if (callIds.has(item.call_id)) throw new BridgeError('Provider returned a duplicate tool call ID.', 502);
        callIds.add(item.call_id);
        calls.push({ type: 'tool_use', id: bridgeId(item.call_id), name: item.name, input: parseCall(item.name, item.arguments, body.tools) });
      }
      content.push(...calls);
      cache.set(historyKey(content), completed.output);
      // Release tools only after successful terminal inference, never on failure.
      for (const call of calls) yield { type: 'tool', block: call };
      yield { type: 'finish', stop: calls.length ? 'tool_use' : 'end_turn', usage: { input_tokens: completed.usage?.input_tokens || 0, output_tokens: completed.usage?.output_tokens || 0 } };
      return;
    }
    if (kind !== 'gemini') throw new BridgeError('Unknown provider.');
    const request = toChatCompletions(body, selectedModel, cache);
    const response = await fetchChecked('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(request), signal }, fetcher);
    let text = '', finish, usage = {}, done = false;
    const tools = new Map();
    for await (const event of sse(response.body)) {
      if (event.type === 'done') { done = true; break; }
      if (event.error) throw new BridgeError('Gemini inference failed.', 502);
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) { text += choice.delta.content; yield { type: 'text', text: choice.delta.content }; }
      for (const partial of choice.delta?.tool_calls || []) {
        const call = tools.get(partial.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (partial.id) call.id = partial.id;
        if (partial.function?.name) call.function.name += partial.function.name;
        if (partial.function?.arguments) call.function.arguments += partial.function.arguments;
        // Forward opaque provider metadata intact on subsequent tool turns.
        for (const [key, value] of Object.entries(partial)) if (!['index', 'id', 'type', 'function'].includes(key)) call[key] = value;
        tools.set(partial.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (!done || !finish) throw new BridgeError('Gemini stream ended without its completion marker.', 502);
    if (!['stop', 'tool_calls', 'length'].includes(finish)) throw new BridgeError(`Gemini could not complete this request (${finish}).`, 502);
    if (finish === 'length' && tools.size) throw new BridgeError('Gemini tool arguments were truncated by its token limit.', 502);
    const calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
      call.id ||= `call_${randomUUID().replaceAll('-', '')}`;
      return call;
    });
    if (new Set(calls.map(c => c.id)).size !== calls.length) throw new BridgeError('Provider returned a duplicate tool call ID.', 502);
    const content = text ? [{ type: 'text', text }] : [];
    const translated = calls.map(call => ({ type: 'tool_use', id: bridgeId(call.id), name: call.function.name, input: parseCall(call.function.name, call.function.arguments, body.tools) }));
    content.push(...translated);
    const original = { role: 'assistant', content: text || null };
    if (calls.length) original.tool_calls = calls;
    cache.set(historyKey(content), original);
    for (const call of translated) yield { type: 'tool', block: call };
    yield { type: 'finish', stop: finish === 'length' ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn', usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
  } };
}
