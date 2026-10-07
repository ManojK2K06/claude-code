#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './bridge.mjs';
import { supportedProviders } from './lib/models.mjs';
import { launchClaude } from './lib/launch.mjs';

const usage = `Claude Provider CLI

  claude-provider login chatgpt [--new-account]
  claude-provider accounts
  claude-provider select ACCOUNT_ID
  claude-provider logout chatgpt
  claude-provider models chatgpt|deepseek|gemini
  claude-provider run PROVIDER [--model MODEL] [Claude arguments]
  claude-provider --provider PROVIDER [--model MODEL] [Claude arguments]

With the optional shell wrapper enabled:
  claude provider login chatgpt
  claude provider models PROVIDER
  claude --provider PROVIDER [--model MODEL] [Claude arguments]

Place --model and --claude before Claude arguments. An optional -- separates them.
Omit --model for the live model picker; supply it for scripts and piped input.
DeepSeek uses DEEPSEEK_API_KEY; Gemini uses GEMINI_API_KEY.
The Claude CLI must be installed separately. Run --help for this help.
`;

export function runArguments(kind, args, native) {
  if (!supportedProviders.includes(kind)) throw new Error('Choose chatgpt, deepseek, or gemini.');
  const bridge = ['run', kind];
  let hasExecutable = false;
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '--') { index++; break; }
    const option = argument.split('=')[0];
    if (!['--model', '--claude'].includes(option)) break;
    const equals = argument.indexOf('=');
    const value = equals >= 0 ? argument.slice(equals + 1) : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
    bridge.push(option, value);
    hasExecutable ||= option === '--claude';
    index++;
  }
  if (native && !hasExecutable) bridge.push('--claude', native);
  if (index < args.length) bridge.push('--', ...args.slice(index));
  return bridge;
}

export async function dispatch(argv = process.argv.slice(2), dependencies = {}) {
  let args = [...argv];
  // PowerShell 5.1 drops embedded quotes when passing native argument arrays.
  // Its wrapper sends one encoded array so prompts survive that boundary.
  if (args[0] === '--shell-args') {
    if (args.length !== 2) throw new Error('Invalid shell arguments.');
    args = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('Invalid shell arguments.');
  }
  let wrapper = false;
  let native = 'claude';
  if (args[0] === '--wrap') {
    wrapper = true;
    args.shift();
    if (args[0] === '--native') {
      args.shift();
      native = args.shift();
      if (!native || native.startsWith('--')) throw new Error('Missing native Claude executable path.');
    }
  }
  const bridge = dependencies.bridge || main;
  if (wrapper && args[0] === 'provider') {
    args.shift();
    if (!args.length || ['--help', '-h', 'help'].includes(args[0])) { console.log(usage); return 0; }
    if (args[0] === 'run') return bridge(runArguments(args[1], args.slice(2), native));
    return bridge(args);
  }
  if (args[0] === '--provider' || args[0]?.startsWith('--provider=')) {
    const first = args.shift();
    const kind = first === '--provider' ? args.shift() : first.slice('--provider='.length);
    return bridge(runArguments(kind, args, wrapper ? native : undefined));
  }
  if (wrapper) return (dependencies.nativeLaunch || launchClaude)(native, args, dependencies.env || process.env);
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) { console.log(usage); return 0; }
  if (args[0] === 'run') return bridge(runArguments(args[1], args.slice(2)));
  if (!['login', 'accounts', 'select', 'logout', 'models'].includes(args[0])) throw new Error('Unknown provider command. Run claude-provider --help.');
  return bridge(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatch().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
