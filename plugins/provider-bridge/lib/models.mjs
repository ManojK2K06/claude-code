import { createInterface } from 'node:readline/promises';
import { fetchChecked } from './http.mjs';

export const supportedProviders = ['chatgpt', 'deepseek', 'gemini'];

function uniqueModels(models) {
  const seen = new Set();
  return models.filter(model => {
    if (typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    // Provider display strings are data, never terminal control sequences.
    model.name = String(model.name || model.id).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    return true;
  });
}

export async function listModels(kind, { token, fetcher = fetch } = {}) {
  if (!supportedProviders.includes(kind)) throw new Error('Unknown provider. Choose chatgpt, deepseek, or gemini.');
  const credential = await token();
  if (!credential) throw new Error(`Missing ${kind} credentials.`);
  const get = async (url, headers) => {
    const response = await fetchChecked(url, { headers, signal: AbortSignal.timeout(30_000) }, fetcher);
    try { return await response.json(); }
    catch { throw new Error(`Invalid ${kind} model catalog response.`); }
  };
  let models;
  if (kind === 'chatgpt') {
    const catalog = await get('https://api.openai.com/v1/models', { authorization: `Bearer ${credential}` });
    if (!Array.isArray(catalog.models)) throw new Error('Unexpected ChatGPT model catalog.');
    models = catalog.models.filter(m => m && m.visibility === 'list').map(m => ({ id: m.slug, name: m.display_name }));
  } else if (kind === 'deepseek') {
    const catalog = await get('https://api.deepseek.com/models', { authorization: `Bearer ${credential}` });
    if (!Array.isArray(catalog.data)) throw new Error('Unexpected DeepSeek model catalog.');
    models = catalog.data.filter(m => m && (!Array.isArray(m.output_modalities) || m.output_modalities.includes('text')) && (!m.api_capabilities || !Object.hasOwn(m.api_capabilities, 'anthropic_messages') || m.api_capabilities.anthropic_messages)).map(m => ({ id: m.id, name: m.name }));
  } else {
    models = [];
    const pageTokens = new Set();
    let pageToken;
    do {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const catalog = await get(url.href, { 'x-goog-api-key': credential });
      // Google can omit models on an empty page, including the final page.
      if (catalog.models != null && !Array.isArray(catalog.models)) throw new Error('Unexpected Gemini model catalog.');
      for (const m of catalog.models || []) {
        if (!m || typeof m.name !== 'string') continue;
        const id = m.name.replace(/^models\//, '');
        if (!id.startsWith('gemini-') || !Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
        // These endpoints cannot provide this bridge's text-and-tool coding flow.
        if (/(?:^|[-_])(image|tts|audio|live|embedding|robotics)(?:[-_]|$)/i.test(id)) continue;
        models.push({ id, name: m.displayName });
      }
      pageToken = catalog.nextPageToken;
      if (pageToken) {
        if (typeof pageToken !== 'string' || pageTokens.has(pageToken) || pageTokens.size >= 100) throw new Error('Invalid Gemini model catalog pagination.');
        pageTokens.add(pageToken);
      }
    } while (pageToken);
  }
  const available = uniqueModels(models);
  if (!available.length) throw new Error(`No coding models are currently available for this ${kind} account.`);
  // Preserve provider ordering. Catalogs do not promise chronological ordering.
  return available;
}

export function resolveSelection(models, selection) {
  const value = selection.trim();
  if (/^\d+$/.test(value)) return models[Number(value) - 1];
  return models.find(m => m.id === value.replace(/^models\//, ''));
}

export async function chooseModel(models, { requested, input = process.stdin, output = process.stdout, ask } = {}) {
  if (requested) {
    const model = models.find(m => m.id === requested.replace(/^models\//, ''));
    if (!model) throw new Error('Model is unavailable in the current provider catalog. Run models PROVIDER to see available IDs.');
    return model.id;
  }
  if (!ask && (!input.isTTY || !output.isTTY)) throw new Error('A model selection needs an interactive terminal. Run models PROVIDER, then run PROVIDER --model MODEL_ID.');
  output.write('Available models (fetched now):\n');
  models.forEach((m, index) => output.write(`  ${index + 1}. ${m.id}${m.name !== m.id ? ` — ${m.name}` : ''}\n`));
  let rl;
  try {
    if (!ask) { rl = createInterface({ input, output }); ask = prompt => rl.question(prompt); }
    while (true) {
      const answer = await ask('Choose a number or model ID (q to cancel): ');
      if (answer.trim().toLowerCase() === 'q') throw new Error('Model selection cancelled.');
      const selected = resolveSelection(models, answer);
      if (selected) return selected.id;
      output.write('Choose a model from the displayed list.\n');
    }
  } finally { rl?.close(); }
}
