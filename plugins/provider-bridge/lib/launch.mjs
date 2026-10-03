import { spawn } from 'node:child_process';

export function launchEnvironment(original, { baseUrl, token, model, translated = false }) {
  const env = { ...original };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']) delete env[key];
  Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model });
  if (translated) Object.assign(env, { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: '1', ENABLE_TOOL_SEARCH: 'false', DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' });
  return env;
}

export function launchClaude(executable, args, env) {
  if (/\.(cmd|bat)$/i.test(executable)) throw new Error('Use a native Claude Code executable; Windows batch launchers are unsupported.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit', windowsHide: true });
    const interrupt = () => { /* The foreground terminal sends Ctrl+C to Claude too. */ };
    process.on('SIGINT', interrupt);
    child.once('error', () => { process.off('SIGINT', interrupt); reject(new Error('Claude Code could not start. Install Claude Code or supply --claude with its executable path.')); });
    child.once('exit', (code, signal) => { process.off('SIGINT', interrupt); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}
