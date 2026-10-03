import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './http.mjs';
import { validateRequest } from './translate.mjs';

export const frame = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const json = (res, status, data, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(data));

function authorized(req, secret) {
  const value = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer /, '');
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new BridgeError('Request exceeds the 16 MB bridge limit.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new BridgeError('Invalid JSON request.'); }
}

export function createGateway(adapter, secret) {
  if (!secret) throw new Error('Gateway requires a local authentication token.');
  return createServer(async (req, res) => {
    // Reject cross-origin browser traffic and DNS rebinding, even on loopback.
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) { json(res, 403, { error: { type: 'permission_error', message: 'Local bridge requests only.' } }); return; }
    if (!authorized(req, secret)) { json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid bridge token.' } }); return; }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'HEAD' && path === '/api/hello') { res.writeHead(200).end(); return; }
    // Returning 404 lets Claude Code use its own documented token estimate.
    if (req.method !== 'POST' || path !== '/v1/messages') { json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Endpoint unavailable.' } }); return; }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let ping;
    try {
      const body = await readJson(req);
      validateRequest(body);
      const result = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: body.model || adapter.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      let textIndex = -1, textOpen = false;
      const streamed = body.stream === true;
      if (streamed) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(frame('message_start', { message: { ...result, content: [] } }));
        ping = setInterval(() => { if (!res.destroyed) res.write(frame('ping')); }, 10_000);
      }
      const closeText = () => {
        if (streamed && textOpen) res.write(frame('content_block_stop', { index: textIndex }));
        textOpen = false;
      };
      let finished = false;
      for await (const event of adapter.run(body, controller.signal)) {
        if (res.destroyed) break;
        if (event.type === 'text') {
          if (!textOpen) {
            textIndex = result.content.length; result.content.push({ type: 'text', text: '' }); textOpen = true;
            if (streamed) res.write(frame('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } }));
          }
          result.content[textIndex].text += event.text;
          if (streamed) res.write(frame('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: event.text } }));
        } else if (event.type === 'tool') {
          closeText();
          const index = result.content.length; result.content.push(event.block);
          if (streamed) {
            res.write(frame('content_block_start', { index, content_block: { ...event.block, input: {} } }));
            res.write(frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.block.input) } }));
            res.write(frame('content_block_stop', { index }));
          }
        } else if (event.type === 'finish') {
          closeText(); finished = true;
          result.stop_reason = event.stop; result.usage = event.usage;
          if (streamed) {
            res.write(frame('message_delta', { delta: { stop_reason: event.stop, stop_sequence: null }, usage: event.usage }));
            res.write(frame('message_stop'));
          }
        }
      }
      if (res.destroyed) return;
      if (!finished) throw new BridgeError('Provider did not complete inference.', 502);
      if (streamed) res.end(); else json(res, 200, result);
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof BridgeError ? error.status : 502;
      const payload = { type: status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: error instanceof BridgeError ? error.message : 'Provider connection failed. Check your network and sign-in.' };
      if (res.headersSent) res.end(frame('error', { error: payload }));
      else json(res, status, { type: 'error', error: payload }, error.retryAfter ? { 'retry-after': error.retryAfter } : {});
    } finally { clearInterval(ping); }
  });
}
