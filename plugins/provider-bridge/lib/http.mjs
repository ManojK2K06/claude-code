export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function fetchChecked(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(120_000) });
  if (!response.ok) {
    // Never echo upstream bodies: they may contain prompts or credentials.
    const error = new BridgeError(`Provider request failed (HTTP ${response.status}). Check account access, model, usage limits, and credentials.`, response.status);
    error.retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    throw error;
  }
  return response;
}

export async function* sse(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
        else if (data === '[DONE]') yield { type: 'done' };
      }
      if (buffer.length > 16 * 1024 * 1024) throw new BridgeError('Provider stream frame is too large.', 502);
      if (done) break;
    }
    if (buffer.trim()) throw new BridgeError('Provider stream ended with an incomplete event.', 502);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
