---
description: Fetch the current ChatGPT, DeepSeek, or Gemini model catalog
argument-hint: chatgpt | deepseek | gemini
allowed-tools: Bash(node *)
---

Fetch the current provider model list for the user. Determine the provider from `$ARGUMENTS` or the current conversation. Only accept the literal provider names `chatgpt`, `deepseek`, and `gemini`. Do not interpolate arbitrary user input into a shell command. If the provider is missing or unclear, ask which provider to list.

Run `node "${CLAUDE_PLUGIN_ROOT}/bridge.mjs" models PROVIDER`, replacing PROVIDER with the validated literal name. Display the fetched model IDs and names. If the command fails, explain the returned error; do not invent a model list. Never request credentials in chat.

To use a returned model in a running provider-bridge session for the same provider, tell the user to enter `/model MODEL_ID` themselves. ChatGPT/Gemini gateways validate the requested model and refresh the catalog when an unfamiliar ID is requested. DeepSeek sessions connect directly to the provider. A model catalog is not a promise that every model supports every Claude capability. Do not select or switch models automatically.

To change providers or launch a new session, show `node "${CLAUDE_PLUGIN_ROOT}/bridge.mjs" run PROVIDER --model MODEL_ID` in a new terminal. Without `--model`, the launcher displays an interactive picker populated from a fresh catalog. Do not launch an interactive child Claude process from inside Claude Code.
