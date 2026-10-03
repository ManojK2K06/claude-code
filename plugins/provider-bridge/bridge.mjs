#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { CredentialStore } from './lib/storage.mjs';
import { signIn, signOut, accessToken } from './lib/chatgpt-auth.mjs';
import { fetchChecked } from './lib/http.mjs';
import { provider } from './lib/providers.mjs';
import { createGateway } from './lib/gateway.mjs';
import { launchEnvironment, launchClaude } from './lib/launch.mjs';

const usage = `Claude Code Provider Bridge (Node.js 22+)

  node plugins/provider-bridge/bridge.mjs login chatgpt [--new-account]
  node plugins/provider-bridge/bridge.mjs accounts
  node plugins/provider-bridge/bridge.mjs select ACCOUNT_ID
  node plugins/provider-bridge/bridge.mjs logout chatgpt
  node plugins/provider-bridge/bridge.mjs models chatgpt
  node plugins/provider-bridge/bridge.mjs run chatgpt [--model MODEL]
  node plugins/provider-bridge/bridge.mjs run deepseek [--model MODEL]
  node plugins/provider-bridge/bridge.mjs run gemini --model MODEL

Options for run: --claude EXECUTABLE, then -- followed by Claude arguments.
DeepSeek: set DEEPSEEK_API_KEY. Gemini: set GEMINI_API_KEY.
ChatGPT: browser login with eligible plan usage; no API-key fallback.
Manage ChatGPT plan usage: https://chatgpt.com/settings/usage
`;

export function options(args) {
  const result = { forwarded: [] };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { result.forwarded = args; break; }
    if (arg === '--new-account') result.newAccount = true;
    else if (['--model', '--claude', '--account'].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      result[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}. Put Claude arguments after --.`);
  }
  return result;
}

async function chatgptModels(store) {
  const response = await fetchChecked('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${await accessToken(store)}` } });
  const catalog = await response.json();
  if (!Array.isArray(catalog.models)) throw new Error('Unexpected ChatGPT model catalog.');
  return catalog.models.filter(m => m.visibility === 'list' && m.slug);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, kind, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return 0; }
  const store = new CredentialStore();
  if (command === 'accounts') {
    const record = await store.read();
    for (const p of record.profiles) console.log(`${p.id === record.active ? '*' : ' '} ${p.id}  ${p.email || '(registration pending)'}  ${p.access_token ? 'connected' : 'signed out'}  ${p.scopes?.includes('chatgpt.tokens.use.direct') ? 'plan usage enabled' : 'plan usage disabled'}`);
    if (!record.profiles.length) console.log('No accounts connected. Run login chatgpt.');
    return 0;
  }
  if (command === 'select') {
    await store.locked(async () => {
      const record = await store.read();
      if (!record.profiles.some(p => p.id === kind)) throw new Error('Unknown account ID. Run accounts to list connections.');
      record.active = kind; await store.write(record);
    });
    console.log('ChatGPT account selected.'); return 0;
  }
  const opts = options(rest);
  if (command === 'login' && kind === 'chatgpt') {
    console.log('Continue with ChatGPT. Opening your browser to request account and plan usage permission.');
    const profile = await signIn(store, { profileId: opts.account, newAccount: opts.newAccount });
    console.log(`Connected: ${profile.email}. ChatGPT plan usage ${profile.scopes.includes('chatgpt.tokens.use.direct') ? 'enabled' : 'disabled; reconnect and grant permission to run inference'}.`);
    console.log('Manage usage: https://chatgpt.com/settings/usage'); return 0;
  }
  if (command === 'logout' && kind === 'chatgpt') {
    const revoked = await signOut(store);
    console.log(revoked ? 'Signed out of the selected ChatGPT account.' : 'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.'); return 0;
  }
  if (command === 'models' && kind === 'chatgpt') {
    for (const model of await chatgptModels(store)) console.log(`${model.slug}  ${model.display_name || ''}`);
    return 0;
  }
  if (command !== 'run' || !['chatgpt', 'deepseek', 'gemini'].includes(kind)) throw new Error('Unknown command or provider. Run --help.');
  if (opts.account || opts.newAccount) throw new Error('Use login --account, accounts, and select to manage accounts.');
  const executable = opts.claude || 'claude';
  const pluginDirectory = dirname(fileURLToPath(import.meta.url));
  let model = opts.model;
  if (kind === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY in your terminal first.');
    model ||= 'deepseek-flash';
    const env = launchEnvironment(process.env, { baseUrl: 'https://api.deepseek.com/anthropic', token: process.env.DEEPSEEK_API_KEY, model });
    console.log(`Launching Claude Code with DeepSeek (${model}). Usage follows your DeepSeek API account.`);
    return launchClaude(executable, ['--plugin-dir', pluginDirectory, ...opts.forwarded], env);
  }
  let token;
  if (kind === 'chatgpt') {
    const models = await chatgptModels(store);
    model ||= models[0]?.slug;
    if (!model || !models.some(m => m.slug === model)) throw new Error('Model is unavailable for this ChatGPT account. Run models chatgpt.');
    token = () => accessToken(store);
    const record = await store.read();
    console.log(`ChatGPT account: ${record.profiles.find(p => p.id === record.active)?.email}. Plan usage enabled.`);
    console.log('Manage usage: https://chatgpt.com/settings/usage');
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY in your terminal first.');
    if (!model) throw new Error('Choose a Gemini model using --model (see Google AI Studio for available models).');
    token = async () => process.env.GEMINI_API_KEY;
    console.log('Usage follows your Gemini API account.');
  }
  const secret = randomBytes(32).toString('hex');
  const gateway = createGateway(provider({ kind, model, token }), secret);
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  try {
    const env = launchEnvironment(process.env, { baseUrl: `http://127.0.0.1:${gateway.address().port}`, token: secret, model, translated: true });
    console.log(`Launching Claude Code with ${kind} (${model}).`);
    return await launchClaude(executable, ['--plugin-dir', pluginDirectory, ...opts.forwarded], env);
  } finally { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
