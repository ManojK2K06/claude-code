import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, chooseModel, resolveSelection } from '../lib/models.mjs';
import { provider } from '../lib/providers.mjs';
import { main } from '../bridge.mjs';

const token = async () => 'synthetic-key';
const output = { write() {} };

test('ChatGPT discovery uses the active account catalog and preserves ordering', async () => {
  const models = await listModels('chatgpt', { token, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.headers.authorization, 'Bearer synthetic-key');
    return Response.json({ models: [{ slug: 'future-coding-model', display_name: 'Future Coding', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }, { slug: 'future-coding-model', visibility: 'list' }, { slug: '--bad', visibility: 'list' }] });
  } });
  assert.deepEqual(models, [{ id: 'future-coding-model', name: 'Future Coding' }]);
});

test('DeepSeek discovers new IDs without any built-in default list', async () => {
  let call = 0;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.headers.authorization, 'Bearer synthetic-key');
    return Response.json({ data: [{ id: `deepseek-future-${++call}`, name: 'New Model', api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } } }, { id: 'unsupported', api_capabilities: { anthropic_messages: null } }] });
  };
  assert.equal((await listModels('deepseek', { token, fetcher }))[0].id, 'deepseek-future-1');
  assert.equal((await listModels('deepseek', { token, fetcher }))[0].id, 'deepseek-future-2');
});

test('Gemini reads all pages, normalizes IDs and excludes non-coding endpoints', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    seen.push(parsed);
    assert.equal(options.headers['x-goog-api-key'], 'synthetic-key');
    assert.ok(!url.includes('synthetic-key'));
    if (!parsed.searchParams.has('pageToken')) return Response.json({ models: [
      { name: 'models/gemini-future-pro', displayName: 'Gemini Future Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-next', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-future-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-future-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-invalid', supportedGenerationMethods: 'generateContent' },
    ], nextPageToken: 'next page/+' });
    assert.equal(parsed.searchParams.get('pageToken'), 'next page/+');
    return Response.json({ models: [{ name: 'models/gemini-future-flash', displayName: 'Future Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-future-pro', supportedGenerationMethods: ['generateContent'] }] });
  };
  const models = await listModels('gemini', { token, fetcher });
  assert.deepEqual(models.map(m => m.id), ['gemini-future-pro', 'gemini-future-flash']);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].searchParams.get('pageSize'), seen[1].searchParams.get('pageSize'));
});

test('Gemini pagination loops fail instead of hanging or returning a partial catalog', async () => {
  await assert.rejects(listModels('gemini', { token, fetcher: async () => Response.json({ models: [], nextPageToken: 'same' }) }), /pagination/);
});

test('empty, invalid, unauthorized and unavailable catalogs fail without fallback', async () => {
  await assert.rejects(listModels('chatgpt', { token, fetcher: async () => Response.json({ models: [] }) }), /No coding models/);
  await assert.rejects(listModels('deepseek', { token, fetcher: async () => Response.json({ data: {} }) }), /Unexpected DeepSeek/);
  await assert.rejects(listModels('deepseek', { token, fetcher: async () => new Response('synthetic-key', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(listModels('gemini', { token, fetcher: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
});

test('picker accepts a fetched ID or number and rejects invalid choices', async () => {
  const models = [{ id: 'gemini-future-pro', name: 'Pro' }, { id: 'gemini-future-flash', name: 'Flash' }];
  assert.equal(resolveSelection(models, '2').id, 'gemini-future-flash');
  assert.equal(resolveSelection(models, 'models/gemini-future-pro').id, 'gemini-future-pro');
  assert.equal(resolveSelection(models, '0'), undefined);
  const answers = ['invalid', '3', '2'];
  assert.equal(await chooseModel(models, { output, ask: async () => answers.shift() }), 'gemini-future-flash');
  assert.equal(await chooseModel(models, { requested: 'models/gemini-future-pro' }), 'gemini-future-pro');
  await assert.rejects(chooseModel(models, { requested: 'retired-model' }), /unavailable/);
  await assert.rejects(chooseModel(models, { output, ask: async () => 'q' }), /cancelled/);
  await assert.rejects(chooseModel(models, { input: { isTTY: false }, output }), /interactive terminal/);
});

test('DeepSeek launch uses the fetched selection in every Claude model setting', async () => {
  let launched = false;
  const code = await main(['run', 'deepseek', '--model', 'deepseek-future', '--', '-p', 'hello'], {
    env: { DEEPSEEK_API_KEY: 'synthetic-key' },
    fetcher: async () => Response.json({ data: [{ id: 'deepseek-future' }] }),
    launch: async (executable, args, env) => {
      launched = true;
      assert.equal(executable, 'claude');
      assert.deepEqual(args.slice(-2), ['-p', 'hello']);
      for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[key], 'deepseek-future');
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(launched, true);
});

test('removed models cannot launch Claude Code', async () => {
  let launched = false;
  await assert.rejects(main(['run', 'deepseek', '--model', 'retired'], { env: { DEEPSEEK_API_KEY: 'synthetic-key' }, fetcher: async () => Response.json({ data: [{ id: 'available' }] }), launch: async () => { launched = true; } }), /unavailable/);
  assert.equal(launched, false);
});

test('a Gemini selection reaches the live gateway request and Claude launch', async () => {
  let receivedModel;
  await main(['run', 'gemini', '--model', 'gemini-future-pro'], {
    env: { GEMINI_API_KEY: 'synthetic-key' },
    fetcher: async (url, options) => {
      if (url.includes('/chat/completions')) {
        receivedModel = JSON.parse(options.body).model;
        return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }
      return Response.json({ models: [{ name: 'models/gemini-future-pro', supportedGenerationMethods: ['generateContent'] }] });
    },
    launch: async (executable, args, env) => {
      assert.equal(env.ANTHROPIC_MODEL, 'gemini-future-pro');
      const result = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_AUTH_TOKEN }, body: JSON.stringify({ model: env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: 'hello' }] }) });
      assert.equal(result.status, 200);
      assert.equal((await result.json()).content[0].text, 'Hello');
      return 0;
    },
  });
  assert.equal(receivedModel, 'gemini-future-pro');
});

test('model changes honor discovered IDs and refresh unfamiliar IDs once', async () => {
  let refreshes = 0;
  const requested = [];
  const adapter = provider({ kind: 'chatgpt', model: 'initial', token, allowedModels: ['initial', 'alternate'], refreshModels: async () => { refreshes++; return ['initial', 'alternate', 'new-model']; }, fetcher: async (url, options) => {
    requested.push(JSON.parse(options.body).model);
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
  } });
  const run = async model => { for await (const event of adapter.run({ model, messages: [{ role: 'user', content: 'hello' }] })) { /* Consume terminal inference. */ } };
  await run('alternate');
  await Promise.all([run('new-model'), run('new-model')]);
  assert.equal(refreshes, 1);
  assert.deepEqual(requested, ['alternate', 'new-model', 'new-model']);
  await assert.rejects(run('unavailable'), /unavailable/);
  assert.equal(requested.length, 3);
});
