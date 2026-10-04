---
description: Explain how to connect Claude Code to ChatGPT, DeepSeek, or Gemini
---

Read `${CLAUDE_PLUGIN_ROOT}/README.md` and explain the exact launcher commands for the user's provider and operating system. The launcher must be run in a new terminal or after exiting the current Claude session. This command does not replace the provider inside an already running session.

For ChatGPT, explain Continue with ChatGPT and the separate permission to use an eligible ChatGPT plan. For DeepSeek and Gemini, explain provider API keys and billing. Never request passwords, cookies, bearer tokens, or API keys in the conversation. Show how to set API keys locally in the terminal. Do not run login or launch an interactive child Claude session on behalf of the user from inside Claude Code.

Explain that every models/run command fetches the current provider catalog. The launcher presents a picker unless --model is supplied. Mention `/provider-bridge:models PROVIDER` to fetch model IDs inside Claude, and `/model MODEL_ID` to select a fetched model for the current provider.
