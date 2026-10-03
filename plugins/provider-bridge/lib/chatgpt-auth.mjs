import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fetchChecked, BridgeError } from './http.mjs';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export async function discovery(fetcher = fetch) {
  const config = await (await fetchChecked(`${ISSUER}/.well-known/openid-configuration`, {}, fetcher)).json();
  if (config.issuer !== ISSUER) throw new Error('Unexpected OpenAI identity issuer.');
  for (const key of ['jwks_uri', 'revocation_endpoint']) {
    if (config[key] && !config[key].startsWith(`${ISSUER}/`)) throw new Error('Unexpected OpenAI identity endpoint.');
  }
  return config;
}

export function validateIdentity(token, keys, clientId, nonce, now = Date.now() / 1000) {
  const pieces = token?.split('.') || [];
  if (pieces.length !== 3) throw new Error('Missing or invalid OpenAI ID token.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(pieces[0], 'base64url'));
    claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
  } catch { throw new Error('Invalid OpenAI ID token encoding.'); }
  if (header.alg !== 'RS256') throw new Error('Unsupported ID token signature algorithm.');
  const key = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
  if (!key || !verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(pieces[2], 'base64url'))) throw new Error('OpenAI ID token signature verification failed.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || claims.nonce !== nonce || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf != null && claims.nbf > now + 30) || !claims.sub) throw new Error('OpenAI ID token identity verification failed.');
  return { issuer: claims.iss, subject: claims.sub, email: claims.email || '(email unavailable)' };
}

export function callbackResult(url, state, existingClientId) {
  if (url.searchParams.get('state') !== state) throw new Error('OAuth state verification failed.');
  if (url.searchParams.has('error')) throw new Error('ChatGPT authorization was declined or failed.');
  const returned = url.searchParams.get('client_id');
  if (existingClientId && returned && returned !== existingClientId) throw new Error('OAuth client registration changed unexpectedly.');
  const clientId = returned || existingClientId;
  const code = url.searchParams.get('code');
  if (!code || !clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT registration is incomplete.');
  return { code, clientId };
}

async function tokenRequest(params, fetcher) {
  return (await fetchChecked(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }, fetcher)).json();
}

function credentials(data, previous = {}) {
  if (!data.access_token || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in)) throw new Error('Invalid OpenAI token response.');
  return { ...previous, access_token: data.access_token, refresh_token: data.refresh_token || previous.refresh_token, id_token: data.id_token || previous.id_token, scopes: data.scope != null ? data.scope.split(/\s+/) : previous.scopes || [], expiresAt: Date.now() + data.expires_in * 1000 };
}

export function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not open the sign-in browser.')));
  });
}

export async function signIn(store, { profileId, newAccount = false, fetcher = fetch, browser = openBrowser } = {}) {
  return store.locked(async () => {
    const record = await store.read();
    const previous = newAccount ? undefined : record.profiles.find(p => p.id === (profileId || record.active));
    if (profileId && !previous && !newAccount) throw new Error('Unknown ChatGPT account.');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    let finish, fail;
    const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // Install a handler now so launch errors cannot leave an unhandled rejection.
    result.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
      try {
        const callback = callbackResult(url, state, previous?.client_id);
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization received. Return to your terminal to finish connecting.');
        finish(callback);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization could not be verified.');
        // Ignore unsolicited callbacks with wrong state instead of cancelling login.
        if (url.searchParams.get('state') === state) fail(error);
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const timer = setTimeout(() => fail(new Error('ChatGPT sign-in timed out. Try again.')), 300_000);
    const cancel = () => fail(new Error('ChatGPT sign-in cancelled.'));
    process.on('SIGINT', cancel);
    try {
      const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      await store.write(record); // Persist the host before registering it.
      const params = new URLSearchParams({ client_id: previous?.client_id || 'dynamic_agent_client', ext_agent_host_id: record.hostId, response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      if (!previous?.client_id) params.set('agent_name_hint', 'Claude Code Provider Bridge');
      if (previous?.id_token) params.set('id_token_hint', previous.id_token);
      if (previous?.email && previous.email !== '(email unavailable)') params.set('login_hint', previous.email);
      await browser(`${ISSUER}/api/accounts/authorize?${params}`);
      const { code, clientId } = await result;
      const profile = { ...previous, id: previous?.id || randomUUID(), client_id: clientId };
      // Retain the issued registration even if the code exchange subsequently fails.
      record.profiles = [...record.profiles.filter(p => p.id !== profile.id), profile];
      await store.write(record);
      const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, fetcher);
      const config = await discovery(fetcher);
      const jwks = await (await fetchChecked(config.jwks_uri, {}, fetcher)).json();
      const identity = validateIdentity(data.id_token, jwks.keys, clientId, nonce);
      if (previous?.subject && (previous.subject !== identity.subject || previous.issuer !== identity.issuer)) throw new Error('ChatGPT account identity changed. Add it as a separate account.');
      Object.assign(profile, identity, credentials(data));
      record.active = profile.id;
      await store.write(record);
      return profile;
    } finally { process.off('SIGINT', cancel); clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}

export async function accessToken(store, fetcher = fetch) {
  return store.locked(async () => {
    const record = await store.read();
    let profile = record.profiles.find(p => p.id === record.active);
    if (!profile?.access_token) throw new BridgeError('Run: node plugins/provider-bridge/bridge.mjs login chatgpt', 401);
    if (!profile.scopes.includes('chatgpt.tokens.use.direct')) throw new BridgeError('ChatGPT plan usage permission is disabled. Reconnect and allow plan usage.', 403);
    if (profile.expiresAt <= Date.now() + 60_000) {
      if (!profile.refresh_token) throw new BridgeError('ChatGPT session expired. Sign in again.', 401);
      const data = await tokenRequest({ grant_type: 'refresh_token', client_id: profile.client_id, refresh_token: profile.refresh_token, resource: RESOURCE }, fetcher);
      profile = credentials(data, profile);
      record.profiles = record.profiles.map(p => p.id === profile.id ? profile : p);
      await store.write(record);
      if (!profile.scopes.includes('chatgpt.tokens.use.direct')) throw new BridgeError('ChatGPT plan usage permission is disabled.', 403);
    }
    return profile.access_token;
  });
}

export async function signOut(store, fetcher = fetch) {
  return store.locked(async () => {
    const record = await store.read();
    const profile = record.profiles.find(p => p.id === record.active);
    if (!profile) return true;
    let revoked = true;
    if (profile.refresh_token) {
      try {
        const config = await discovery(fetcher);
        if (!config.revocation_endpoint) throw new Error('No revocation endpoint.');
        await fetchChecked(config.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: profile.client_id }) }, fetcher);
      } catch { revoked = false; }
    }
    for (const key of ['access_token', 'refresh_token', 'id_token', 'scopes', 'expiresAt']) delete profile[key];
    await store.write(record);
    return revoked;
  });
}
