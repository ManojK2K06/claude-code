# Provider Bridge for Claude Code

Use Claude Code's terminal and local coding tools with ChatGPT plan access, DeepSeek, or Gemini. This is a launcher plus a plugin help command. The launcher routes the entire model conversation; an ordinary slash command cannot change a running session's provider.

Requires **Node.js 22+** and a separately installed **native Claude Code CLI** (`claude --version`). This repository does not include that CLI's complete engine. No npm installation is needed for the bridge. These instructions run from the repository root; use the absolute path to `bridge.mjs` from another project directory. The launcher keeps your current directory as the working project.

## Claude CLI commands

Enable the wrapper in your current PowerShell terminal, from the repository root:

```powershell
. .\plugins\provider-bridge\scripts\enable-cli.ps1
claude provider login chatgpt
claude provider models chatgpt
claude --provider chatgpt
```

For Bash on macOS/Linux:

```bash
source plugins/provider-bridge/scripts/enable-cli.sh
claude provider login chatgpt
claude provider models chatgpt
claude --provider chatgpt
```

The wrapper adds these commands to your current shell. It keeps absolute launcher paths, so you can then change to another project directory. Ordinary commands such as `claude --version`, `claude auth login`, and `claude mcp list` pass through to the installed Claude CLI. The wrapper does not modify your profile or the Claude executable. Open a fresh terminal to return to the original command. An existing Claude function or alias must be resolved before enabling it. To choose an executable in PowerShell, supply `-ClaudeExecutable 'C:\path\to\claude.exe'` when sourcing the script.

DeepSeek and Gemini use the same local API-key setup described below:

```powershell
claude provider models deepseek
claude --provider deepseek
claude provider models gemini
claude --provider gemini
```

All providers fetch their current model catalog before launch. Interactive launches open the live picker. Scripts and piped input require an explicit model from `claude provider models PROVIDER`:

```powershell
claude --provider gemini --model MODEL_ID -p "Explain this project" --output-format json
Get-Content .\notes.txt | claude --provider deepseek --model MODEL_ID -p "Summarize these notes"
```

Place `--provider` first, then bridge options (`--model`, `--claude`), then ordinary Claude arguments. An optional `--` separates bridge options from Claude arguments. Launcher status goes to standard error, preserving Claude's JSON or text on standard output. Arguments, piped input, working directory, and exit status are forwarded to Claude. PowerShell pipelines retain PowerShell's normal text encoding and newline behavior.

Account commands are also available as `claude provider accounts`, `claude provider select ACCOUNT_ID`, `claude provider login chatgpt --new-account`, and `claude provider logout chatgpt`.

For a separate command without wrapping `claude`, run:

```powershell
node plugins/provider-bridge/cli.mjs login chatgpt
node plugins/provider-bridge/cli.mjs models chatgpt
node plugins/provider-bridge/cli.mjs --provider chatgpt
```

The sourced wrappers also provide `claude-provider`. To make that separate command available in other terminals, optionally run `npm link` from `plugins/provider-bridge`, then use `claude-provider login chatgpt`, `claude-provider models PROVIDER`, or `claude-provider --provider PROVIDER`. `claude-provider run PROVIDER` is an equivalent launch syntax. The original `bridge.mjs` commands below remain available.

## ChatGPT Plus / Pro: browser login

```powershell
node plugins/provider-bridge/bridge.mjs login chatgpt
node plugins/provider-bridge/bridge.mjs models chatgpt
node plugins/provider-bridge/bridge.mjs run chatgpt
```

Choose **Continue with ChatGPT**, then allow this app to use your ChatGPT plan. OpenAI's Sign in with ChatGPT flow is a preview for eligible local/personal and open-source clients. Account/workspace availability and permissions determine whether inference is enabled. Usage consumes the plan allowance or credits available to this app, with limits shared across apps. This does not turn a Plus subscription into unrestricted API credits.

The launcher fetches the connected account's current model catalog and opens a numbered picker. Choose a model by number or ID. To choose one explicitly:

```powershell
node plugins/provider-bridge/bridge.mjs run chatgpt --model YOUR_MODEL_SLUG
```

It uses dynamic public-client registration, PKCE, state and nonce validation, signed ID-token validation, automatic token refresh, and the public Responses API. It requests plan usage explicitly, uses `store: false` / `stream: true`, and never falls back to API-key billing. It does not read Codex or browser credentials.

Manage connections:

```powershell
node plugins/provider-bridge/bridge.mjs login chatgpt --new-account
node plugins/provider-bridge/bridge.mjs accounts
node plugins/provider-bridge/bridge.mjs select ACCOUNT_ID
node plugins/provider-bridge/bridge.mjs login chatgpt --account ACCOUNT_ID
node plugins/provider-bridge/bridge.mjs logout chatgpt
```

Logout applies to the selected account; other connections remain separate. It attempts remote session revocation and clears local tokens while retaining the registration. [Manage plan usage and app access in ChatGPT](https://chatgpt.com/settings/usage).

## DeepSeek

Set your API key **locally**, then launch:

```powershell
$env:DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY'
node plugins/provider-bridge/bridge.mjs run deepseek
```

The launcher fetches DeepSeek's current model catalog and opens a picker; there is no fixed default model. Use `--model MODEL_ID` to skip the picker. DeepSeek already exposes an Anthropic-compatible endpoint, so the launcher connects directly to `https://api.deepseek.com/anthropic`. Usage is billed to your DeepSeek API account.

## Google Gemini

```powershell
$env:GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY'
node plugins/provider-bridge/bridge.mjs run gemini
```

Choose a model from the fetched picker, or pass `--model MODEL_ID`. The bridge translates Anthropic messages and local tool calls to Gemini's documented OpenAI-compatible Chat Completions endpoint. Usage follows Gemini API quotas/billing; this does not use a Gemini consumer-app subscription login.

On macOS/Linux, set keys with `export DEEPSEEK_API_KEY='...'` or `export GEMINI_API_KEY='...'` instead of PowerShell syntax. Never commit real keys or paste them into chat.

## Live model discovery and selection

List the current models for any connected provider:

```powershell
node plugins/provider-bridge/bridge.mjs models chatgpt
node plugins/provider-bridge/bridge.mjs models deepseek
node plugins/provider-bridge/bridge.mjs models gemini
```

Every `models` and `run` command fetches a fresh catalog using your provider credentials. New model IDs appear without a plugin update. Lists preserve provider ordering; the catalogs do not guarantee release-date order, so the first entry is not labeled the newest model. Requests fail explicitly if the catalog cannot be fetched or your requested model is no longer listed.

Gemini discovery follows all catalog pages and lists Gemini models supporting content generation, excluding embedding, image-generation, audio, live, and other specialized endpoints. It removes Google's `models/` prefix for Claude and the Chat Completions API. Provider listing does not guarantee support for every local tool or Claude capability; inference still follows provider and account restrictions.

In an interactive terminal, `run PROVIDER` opens the picker. Without an interactive terminal, supply `--model MODEL_ID`. The selected ID is applied to Claude's main model, default Opus/Sonnet/Haiku models, and subagents.

Inside a launched bridge session:

```text
/provider-bridge:models chatgpt
/model MODEL_ID
```

Replace `chatgpt` with `deepseek` or `gemini` for that provider. The plugin command fetches the live list and displays usable IDs. Enter `/model` yourself to select one for the same provider. ChatGPT/Gemini gateways honor the requested ID and refresh the catalog when the ID was not known at launch. DeepSeek receives model selections directly through its native endpoint. To change providers, launch a fresh session.

## Claude options and plugin installation

Forward Claude options after `--`:

```powershell
node plugins/provider-bridge/bridge.mjs run chatgpt -- --permission-mode default
node plugins/provider-bridge/bridge.mjs run deepseek --claude 'C:\path\to\claude.exe'
```

The launcher loads the bundled plugin automatically. Inside Claude, `/provider-bridge:help` explains setup and `/provider-bridge:models PROVIDER` fetches the current model list. To load these commands separately: `claude --plugin-dir ./plugins/provider-bridge`. To install from this repository's marketplace, use `/plugin install provider-bridge@claude-code-plugins` after adding the repository as a marketplace.

## Compatibility and credential storage

- ChatGPT and Gemini support streamed text, base64/HTTPS images, local function calls, multiple tool calls, tool results, and nonstreaming clients. Tool execution and permission prompts stay in Claude Code. Provider failure or an interrupted stream never releases pending tool calls.
- Opaque Responses reasoning items and Gemini tool-call metadata are kept in memory for subsequent turns. **Start a fresh Claude session after each launcher restart.** Resuming a prior bridge session with tool history is rejected because its reasoning cache is gone. Changing providers in a previous conversation is unsupported.
- ChatGPT preview rejects output-token caps and sampling parameters, so the bridge omits them. Claude's `max_tokens` cannot enforce an output cap on this route. ChatGPT plan limits still apply.
- Hosted Anthropic tools, deferred tool search, structured output formats, document/audio/video blocks, and server-side context management are unsupported by the translated routes. These fail explicitly. The launcher disables experimental betas, tool search, structured outputs, and prompt caching for these routes. This can reduce Claude features; ordinary local coding tools remain available. Organization policy may override these settings.
- `/v1/messages/count_tokens` returns 404 so Claude uses its own approximate token estimate. No estimate is presented as an exact provider count.
- The gateway binds only to `127.0.0.1`, uses a random per-launch local token, rejects browser-origin requests, sends pings during pauses, and closes when Claude exits. It does not log prompts, API keys, or token responses.
- ChatGPT records are stored outside the repository in `~/.config/claude-provider-bridge/accounts.json`. Windows uses user-bound DPAPI encryption; Unix uses owner-only files/directories. `PROVIDER_BRIDGE_HOME` can change this directory. Keep it outside source control. A file lock serializes account writes and rotating token refreshes across processes. If the process crashes while holding that lock, verify no bridge is updating accounts before removing `accounts.lock`.
- Provider selection is scoped to the child process. Existing terminal variables and user/project settings files are not edited. Conflicting inherited Claude provider credentials are cleared in the child. Managed organization settings can still prevent alternate providers.
- Windows `.cmd`/`.bat` launchers are unsupported; install the native Claude CLI or pass `--claude` with its executable path.

## Verification

```powershell
node --test plugins/provider-bridge/tests/*.test.mjs
```

Tests use simulated providers and synthetic credentials; they do not spend account credits. Live browser sign-in and real Claude sessions require an installed Claude CLI, network access, and an eligible account or provider key. The implementation has not yet been validated against live provider accounts.

Official protocol references (checked October 3, 2026):

- [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI sessions and token refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Claude Code gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol)
- [DeepSeek Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

Model discovery references (checked October 4, 2026):

- [OpenAI account-specific model catalog](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [DeepSeek models endpoint](https://api-docs.deepseek.com/api/list-models/)
- [Gemini models and pagination](https://ai.google.dev/api/models)
