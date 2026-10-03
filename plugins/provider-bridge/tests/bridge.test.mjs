import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { validateIdentity, callbackResult, signIn, accessToken, signOut } from '../lib/chatgpt-auth.mjs';
import { CredentialStore } from '../lib/storage.mjs';
import { sse } from '../lib/http.mjs';
import { toResponses, toChatCompletions, historyKey, bridgeId } from '../lib/translate.mjs';
import { provider } from '../lib/providers.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { launchEnvironment } from '../lib/launch.mjs';
import { options } from '../bridge.mjs';

const request = { model: 'claude-sonnet', max_tokens: 512, system: [{ type: 'text', text: 'Help with coding.' }], messages: [{ role: 'user', content: 'Read a file.' }], tools: [{ name: 'Read', description: 'Read a local file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function jwt(overrides = {}, algorithm = 'RS256') {
  const payload = { iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'user-test', email: 'test@example.invalid', nonce: 'nonce', exp: Date.now() / 1000 + 3600, ...overrides };
  const data = `${Buffer.from(JSON.stringify({ alg: algorithm, kid: jwk.kid })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
function streamResponse(events, split = false) {
  const data = events.map(event => event === '[DONE]' ? 'data: [DONE]\r\n\r\n' : `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function collect(adapter, body = request) {
  const events = [];
  for await (const event of adapter.run(body, new AbortController().signal)) events.push(event);
  return events;
}
class MemoryStore {
  constructor(record = { hostId: 'urn:uuid:test', profiles: [], active: null }) { this.record = record; this.pending = Promise.resolve(); }
  async read() { return structuredClone(this.record); }
  async write(record) { this.record = structuredClone(record); }
  locked(fn) { const result = this.pending.then(fn); this.pending = result.catch(() => {}); return result; }
}

test('OIDC verifies signature, issuer, audience, nonce and expiration', () => {
  assert.equal(validateIdentity(jwt(), [jwk], 'oaiapp_test', 'nonce').subject, 'user-test');
  for (const claims of [{ iss: 'https://attacker.invalid' }, { aud: 'different-client' }, { nonce: 'wrong' }, { exp: 1 }, { nbf: Date.now() / 1000 + 300 }]) assert.throws(() => validateIdentity(jwt(claims), [jwk], 'oaiapp_test', 'nonce'));
  assert.throws(() => validateIdentity(jwt({}, 'none'), [jwk], 'oaiapp_test', 'nonce'));
  const token = jwt().split('.');
  token[2] = Buffer.alloc(256).toString('base64url');
  assert.throws(() => validateIdentity(token.join('.'), [jwk], 'oaiapp_test', 'nonce'));
  assert.throws(() => validateIdentity(jwt({ aud: ['oaiapp_test', 'second-client'] }), [jwk], 'oaiapp_test', 'nonce'));
});

test('OAuth callback cannot change registration or skip state', () => {
  const callback = value => new URL(`http://127.0.0.1/auth/callback?${value}`);
  assert.deepEqual(callbackResult(callback('state=s&code=c&client_id=oaiapp_test'), 's'), { code: 'c', clientId: 'oaiapp_test' });
  assert.equal(callbackResult(callback('state=s&code=c'), 's', 'oaiapp_test').clientId, 'oaiapp_test');
  for (const query of ['state=bad&code=c&client_id=oaiapp_test', 'state=s&error=access_denied', 'state=s&code=c&client_id=dynamic_agent_client', 'state=s&code=c']) assert.throws(() => callbackResult(callback(query), 's'));
  assert.throws(() => callbackResult(callback('state=s&code=c&client_id=other'), 's', 'oaiapp_test'));
});

test('browser login exchanges the issued client ID and verifies identity before activation', async () => {
  const store = new MemoryStore();
  let authorize, exchanged;
  const fetcher = async (url, opts) => {
    if (url.endsWith('/oauth/token')) {
      exchanged = new URLSearchParams(opts.body);
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: jwt({ nonce: authorize.searchParams.get('nonce') }), token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct offline_access' });
    }
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    throw new Error('Unexpected URL');
  };
  const profile = await signIn(store, { fetcher, browser: async url => {
    authorize = new URL(url);
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'synthetic-code', client_id: 'oaiapp_test' });
    assert.equal((await fetch(callback)).status, 200);
  } });
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(exchanged.get('client_id'), 'oaiapp_test');
  assert.equal(exchanged.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
  assert.equal(profile.subject, 'user-test');
  assert.equal(store.record.active, profile.id);
  assert.equal(await accessToken(store, fetcher), 'synthetic-access');
});

test('concurrent token reads rotate the refresh token once', async () => {
  const store = new MemoryStore({ hostId: 'urn:uuid:test', active: 'a', profiles: [{ id: 'a', client_id: 'oaiapp_test', access_token: 'old', refresh_token: 'old-refresh', expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'] }] });
  let calls = 0;
  const fetcher = async (url, opts) => {
    calls++;
    assert.equal(new URLSearchParams(opts.body).get('refresh_token'), 'old-refresh');
    return Response.json({ access_token: 'replacement', refresh_token: 'replacement-refresh', token_type: 'Bearer', expires_in: 3600 });
  };
  assert.deepEqual(await Promise.all([accessToken(store, fetcher), accessToken(store, fetcher)]), ['replacement', 'replacement']);
  assert.equal(calls, 1);
  assert.equal(store.record.profiles[0].refresh_token, 'replacement-refresh');
});

test('identity-only sign-in cannot perform inference', async () => {
  const store = new MemoryStore({ active: 'a', profiles: [{ id: 'a', access_token: 'synthetic', scopes: ['openid'], expiresAt: Date.now() + 3600_000 }] });
  await assert.rejects(accessToken(store), /permission is disabled/);
});

test('logout clears credentials even when revocation fails', async () => {
  const store = new MemoryStore({ hostId: 'host', active: 'a', profiles: [{ id: 'a', client_id: 'client', subject: 'subject', refresh_token: 'synthetic', access_token: 'synthetic', id_token: 'synthetic' }] });
  assert.equal(await signOut(store, async () => { throw new Error('network'); }), false);
  assert.equal(store.record.profiles[0].client_id, 'client');
  assert.equal(store.record.profiles[0].access_token, undefined);
  assert.equal(store.record.hostId, 'host');
});

test('credential storage protects secrets and serializes updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-bridge-test-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  assert.ok(directory.includes('provider-bridge-test-'));
  try {
    const store = new CredentialStore(directory);
    const record = { hostId: 'urn:uuid:synthetic', active: 'a', profiles: [{ id: 'a', email: 'नमस्ते@example.invalid', access_token: 'synthetic-secret-never-real' }] };
    await store.write(record);
    assert.deepEqual(await store.read(), record);
    if (process.platform === 'win32') assert.ok(!(await readFile(join(directory, 'accounts.json'), 'utf8')).includes(record.profiles[0].access_token));
    const order = [];
    await Promise.all([store.locked(async () => { order.push('first'); await new Promise(resolve => setTimeout(resolve, 10)); order.push('end-first'); }), store.locked(async () => { order.push('second'); })]);
    assert.deepEqual(order, ['first', 'end-first', 'second']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Responses request obeys preview limits and uses namespaced functions', () => {
  const result = toResponses({ ...request, temperature: 0.7, top_p: 1 }, 'account-model');
  assert.equal(result.model, 'account-model');
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.instructions, 'Help with coding.');
  assert.equal(result.tools[0].type, 'namespace');
  for (const key of ['temperature', 'top_p', 'max_output_tokens', 'previous_response_id']) assert.equal(result[key], undefined);
});

test('tool results and images are converted without losing order', () => {
  const body = { ...request, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file contents', is_error: true }, { type: 'text', text: 'Now edit.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic' } }] }] };
  const openai = toResponses(body, 'model');
  assert.equal(openai.input[1].output, 'Tool error: file contents');
  assert.equal(openai.input[2].content[0].text, 'Now edit.');
  assert.equal(openai.input[3].content[0].type, 'input_image');
  const gemini = toChatCompletions(body, 'model');
  assert.equal(gemini.messages[2].role, 'tool');
  assert.equal(gemini.messages[3].content[1].type, 'image_url');
});

test('unsupported capabilities and resumed tool histories fail explicitly', () => {
  assert.throws(() => toResponses({ ...request, tools: [{ type: 'tool_search_tool_regex', name: 'search' }] }, 'model'), /Unsupported provider tool/);
  assert.throws(() => toResponses({ ...request, messages: [{ role: 'user', content: [{ type: 'document' }] }] }, 'model'), /Unsupported content block/);
  assert.throws(() => toChatCompletions({ ...request, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: bridgeId('call_a'), name: 'Read', input: {} }] }] }, 'model'), /Start a fresh/);
});

test('SSE parser handles fragmented UTF-8, CRLF, pings and done markers', async () => {
  const response = streamResponse([{ text: 'नमस्ते 😀' }, '[DONE]'], true);
  const events = [];
  for await (const item of sse(response.body)) events.push(item);
  assert.equal(events[0].text, 'नमस्ते 😀');
  assert.equal(events[1].type, 'done');
});

test('ChatGPT tools wait for completed inference and reasoning is replayed', async () => {
  const raw = [{ type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque' }, { type: 'message', id: 'm_test', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] }, { type: 'function_call', id: 'fc_test', call_id: 'call_test', namespace: 'claude_code', name: 'Read', arguments: '{"path":"file.txt"}' }];
  let outbound;
  const adapter = provider({ kind: 'chatgpt', model: 'model', token: async () => 'synthetic', fetcher: async (url, opts) => {
    outbound = JSON.parse(opts.body);
    return streamResponse([{ type: 'response.output_text.delta', delta: 'Reading.' }, { type: 'response.completed', response: { output: raw, status: 'completed', usage: { input_tokens: 100, output_tokens: 30 } } }]);
  } });
  const events = await collect(adapter);
  assert.deepEqual(events.map(e => e.type), ['text', 'tool', 'finish']);
  const content = [{ type: 'text', text: 'Reading.' }, events[1].block];
  const next = toResponses({ ...request, messages: [...request.messages, { role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: events[1].block.id, content: 'content' }] }] }, 'model', adapter.cache);
  assert.deepEqual(next.input.slice(1, 4), raw);
  assert.equal(next.input.at(-1).call_id, 'call_test');
  assert.equal(outbound.store, false);
});

test('ChatGPT failures and incomplete streams never release pending tool calls', async () => {
  for (const terminal of [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }, { type: 'response.incomplete' }, null]) {
    const events = [{ type: 'response.output_item.done', item: { type: 'function_call', name: 'Read', arguments: '{}' } }];
    if (terminal) events.push(terminal);
    const adapter = provider({ kind: 'chatgpt', model: 'model', token: async () => 'synthetic', fetcher: async () => streamResponse(events) });
    const yielded = [];
    await assert.rejects(async () => { for await (const item of adapter.run(request)) yielded.push(item); });
    assert.equal(yielded.some(e => e.type === 'tool'), false);
  }
});

test('duplicate provider call IDs cannot execute a tool twice', async () => {
  const call = { type: 'function_call', call_id: 'duplicate', namespace: 'claude_code', name: 'Read', arguments: '{}' };
  const adapter = provider({ kind: 'chatgpt', model: 'model', token: async () => 'synthetic', fetcher: async () => streamResponse([{ type: 'response.completed', response: { status: 'completed', output: [call, call] } }]) });
  const events = [];
  await assert.rejects(async () => { for await (const event of adapter.run(request)) events.push(event); }, /duplicate tool call ID/);
  assert.equal(events.some(e => e.type === 'tool'), false);
});

test('Gemini assembles parallel calls and retains opaque thought metadata', async () => {
  const adapter = provider({ kind: 'gemini', model: 'model', token: async () => 'synthetic', fetcher: async () => streamResponse([
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'Read', arguments: '{"path":' } }, { index: 0, id: 'a', function: { name: 'Read', arguments: '{"path":"a"}' }, extra_content: { google: { thought_signature: 'opaque' } } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } }, '[DONE]',
  ]) });
  const events = await collect(adapter);
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.block.input.path), ['a', 'b']);
  const content = events.filter(e => e.type === 'tool').map(e => e.block);
  const cached = adapter.cache.get(historyKey(content));
  assert.equal(cached.tool_calls[0].extra_content.google.thought_signature, 'opaque');
  const next = toChatCompletions({ ...request, messages: [{ role: 'assistant', content }] }, 'model', adapter.cache);
  assert.equal(next.messages.at(-1).tool_calls[0].extra_content.google.thought_signature, 'opaque');
  assert.equal(events.at(-1).usage.input_tokens, 50);
});

test('Gemini truncated tool calls and missing done markers fail', async () => {
  for (const events of [[{ choices: [{ delta: {}, finish_reason: 'stop' }] }], [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{' } }] }, finish_reason: 'length' }] }, '[DONE]']]) {
    await assert.rejects(collect(provider({ kind: 'gemini', model: 'model', token: async () => 'synthetic', fetcher: async () => streamResponse(events) })));
  }
});

test('launch scopes provider credentials to child and preserves permission settings', () => {
  const original = { PATH: 'path', ANTHROPIC_API_KEY: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'old', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_PERMISSION_MODE: 'default' };
  const env = launchEnvironment(original, { baseUrl: 'http://127.0.0.1:1234', token: 'local', model: 'model', translated: true });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'model');
  assert.equal(env.CLAUDE_CODE_PERMISSION_MODE, 'default');
  assert.equal(original.ANTHROPIC_API_KEY, 'old');
  assert.equal(options(['--model', 'm', '--', '-p', 'a b']).forwarded[1], 'a b');
  assert.throws(() => options(['--model']), /Missing value/);
});

test('gateway emits complete Anthropic streams, rejects cross-origin traffic and supports JSON', async () => {
  const adapter = { model: 'model', async *run() { yield { type: 'text', text: 'Hello' }; yield { type: 'tool', block: { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'x' } } }; yield { type: 'finish', stop: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }; } };
  const server = createGateway(adapter, 'local-secret');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/v1/messages?beta=true`;
  const headers = { 'x-api-key': 'local-secret', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(request) })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: JSON.stringify(request) })).status, 403);
    const stream = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...request, stream: true }) });
    const events = [];
    for await (const event of sse(stream.body)) events.push(event);
    assert.deepEqual(events.map(e => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(events[7].delta.stop_reason, 'tool_use');
    const result = await (await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) })).json();
    assert.equal(result.content[1].input.path, 'x');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal((await fetch(url.replace('/messages?beta=true', '/messages/count_tokens'), { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('gateway stream failure emits an error without a success terminal event', async () => {
  const adapter = { model: 'model', async *run() { yield { type: 'text', text: 'Partial' }; throw new Error('synthetic-secret'); } };
  const server = createGateway(adapter, 'secret');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'secret' }, body: JSON.stringify({ ...request, stream: true }) });
    const result = await response.text();
    assert.ok(result.includes('event: error'));
    assert.ok(!result.includes('event: message_stop'));
    assert.ok(!result.includes('synthetic-secret'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
