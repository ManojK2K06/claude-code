import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch, runArguments } from '../cli.mjs';

const host = fileURLToPath(new URL('./fixtures/cli-host.mjs', import.meta.url));
function runProcess(executable, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const runHost = (args, input) => runProcess(process.execPath, [host, ...args], input);

test('CLI exposes all existing authentication and model management commands', async () => {
  for (const args of [['login', 'chatgpt', '--new-account'], ['logout', 'chatgpt'], ['accounts'], ['select', 'account-id'], ['models', 'gemini']]) {
    let received;
    assert.equal(await dispatch(args, { bridge: async value => { received = value; return 0; } }), 0);
    assert.deepEqual(received, args);
  }
});

test('provider option and run syntax share live model selection and forward Claude flags', async () => {
  for (const args of [['--provider', 'chatgpt', '--model', 'account-model', '-p', 'explain'], ['run', 'chatgpt', '--model=account-model', '--', '-p', 'explain'], ['--provider=chatgpt', '--model', 'account-model', '-p', 'explain']]) {
    let received;
    await dispatch(args, { bridge: async value => { received = value; return 0; } });
    assert.deepEqual(received, ['run', 'chatgpt', '--model', 'account-model', '--', '-p', 'explain']);
  }
});

test('shell wrapper delegates ordinary native commands without changing arguments', async () => {
  for (const args of [[], ['--version'], ['auth', 'login'], ['mcp', 'list'], ['-p', '--provider'], ['--', '--provider', 'literal-prompt']]) {
    let received;
    const env = { PATH: 'test-path' };
    assert.equal(await dispatch(['--wrap', '--native', 'C:/Claude Folder/claude.exe', ...args], { env, bridge: async () => { throw new Error('Provider routing was not requested.'); }, nativeLaunch: async (...value) => { received = value; return 7; } }), 7);
    assert.deepEqual(received, ['C:/Claude Folder/claude.exe', args, env]);
  }
});

test('shell wrapper routes provider commands to the bridge and carries the native path', async () => {
  let received;
  const bridge = async args => { received = args; return 0; };
  await dispatch(['--wrap', '--native', '/opt/Claude Folder/claude', 'provider', 'models', 'deepseek'], { bridge });
  assert.deepEqual(received, ['models', 'deepseek']);
  await dispatch(['--wrap', '--native', '/opt/Claude Folder/claude', '--provider', 'deepseek', '--model', 'new-model', '-p', 'prompt'], { bridge });
  assert.deepEqual(received, ['run', 'deepseek', '--model', 'new-model', '--claude', '/opt/Claude Folder/claude', '--', '-p', 'prompt']);
  await dispatch(['--wrap', '--native', '/opt/default', 'provider', 'run', 'gemini', '--claude', '/opt/override'], { bridge });
  assert.deepEqual(received, ['run', 'gemini', '--claude', '/opt/override']);
});

test('arguments containing spaces and shell syntax remain literal', () => {
  const prompt = 'Unicode नमस्ते, "quotes", $(), `text`, & | ; %PATH%';
  assert.deepEqual(runArguments('gemini', ['--model', 'gemini-next', '-p', prompt, '--output-format', 'json']), ['run', 'gemini', '--model', 'gemini-next', '--', '-p', prompt, '--output-format', 'json']);
  assert.deepEqual(runArguments('chatgpt', ['--model', 'account-model', '--', '--model', 'native-override']), ['run', 'chatgpt', '--model', 'account-model', '--', '--model', 'native-override']);
});

test('encoded PowerShell arguments retain quotes, Unicode and empty strings', async () => {
  const args = ['--wrap', '-p', 'Explain "quotes" नमस्ते & $()', ''];
  let received;
  await dispatch(['--shell-args', Buffer.from(JSON.stringify(args)).toString('base64')], { nativeLaunch: async (executable, value) => { received = value; return 0; } });
  assert.deepEqual(received, args.slice(1));
  for (const value of ['null', '{}', '[1]', 'not json']) {
    await assert.rejects(dispatch(['--shell-args', Buffer.from(value).toString('base64')]));
  }
});

test('invalid provider options fail before requesting credentials or launching Claude', async () => {
  for (const args of [['--provider'], ['--provider='], ['--provider', 'unknown'], ['--provider', 'chatgpt', '--model'], ['run', 'deepseek', '--claude=']]) {
    await assert.rejects(dispatch(args, { bridge: async () => { assert.fail('Should not invoke the bridge'); } }));
  }
});

test('noninteractive provider CLI preserves stdin, JSON stdout and exit status', async () => {
  const prompt = 'Explain "quoted text" & pipes; $() नमस्ते';
  const result = await runHost(['--provider', 'deepseek', '--model', 'deepseek-cli-test', '-p', prompt, '--output-format', 'json', '--fixture-exit', '7'], 'piped file content\n');
  assert.equal(result.code, 7);
  const output = JSON.parse(result.stdout);
  assert.equal(output.input, 'piped file content\n');
  assert.ok(output.args.includes(prompt));
  assert.equal(output.model, 'deepseek-cli-test');
  assert.equal(output.cwd, process.cwd());
  assert.ok(result.stderr.includes('Fetching current deepseek models'));
  assert.ok(!result.stdout.includes('Fetching current'));
});

test('native CLI passthrough preserves streamed input and output', async () => {
  const result = await runHost(['--wrap', '-p', 'native prompt', '--output-format', 'json'], 'native stdin\n');
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['-p', 'native prompt', '--output-format', 'json']);
  assert.equal(output.input, 'native stdin\n');
  assert.equal(result.stderr, '');
});

test('Windows PowerShell wrapper preserves pipeline input, quotes, empty arguments and exit status', { skip: process.platform !== 'win32' }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/shell-host.ps1', import.meta.url));
  const shells = [join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')].filter(existsSync);
  assert.ok(shells.length);
  for (const shell of shells) {
    const result = await runProcess(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, process.execPath]);
    assert.equal(result.code, 7, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['-p', 'Explain "quoted text" & literal $()', '', '--fixture-exit', '7']);
    assert.equal(output.input.trim(), 'pipeline content');
    assert.equal(result.stderr, '');
  }
});

const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '/bin/bash';
test('Bash wrapper preserves pipeline input, quotes, empty arguments and exit status', { skip: !existsSync(bash) }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/shell-host.sh', import.meta.url));
  const result = await runProcess(bash, [fixture]);
  assert.equal(result.code, 7, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['-p', 'Explain "quoted text" & literal $()', '', '--fixture-exit', '7']);
  assert.equal(output.input, 'pipeline content\n');
  assert.ok(result.stderr.includes('Provider CLI enabled'));
});
