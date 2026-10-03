import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Secrets travel through stdin, never command arguments or environment variables.
function dpapi(value, decrypt = false) {
  const script = `[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=${decrypt ? '[Convert]::FromBase64String($v)' : '[Text.Encoding]::UTF8.GetBytes($v)'}; $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${decrypt ? '[Text.Encoding]::UTF8.GetString($r)' : '[Convert]::ToBase64String($r)'})`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('Windows credential protection failed.')));
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export class CredentialStore {
  constructor(directory = process.env.PROVIDER_BRIDGE_HOME || join(homedir(), '.config', 'claude-provider-bridge')) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async read() {
    try {
      let record;
      try { record = JSON.parse(await readFile(join(this.directory, 'accounts.json'), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') throw error;
        throw new Error('Could not read the bridge credential record.');
      }
      if (record.protection === 'dpapi') return JSON.parse(await dpapi(record.data, true));
      if (process.platform === 'win32') throw new Error('Unprotected Windows credentials refused.');
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { hostId: `urn:uuid:${randomUUID()}`, profiles: [], active: null };
    }
  }
  async write(record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const value = process.platform === 'win32'
      ? JSON.stringify({ protection: 'dpapi', data: await dpapi(JSON.stringify(record)) })
      : JSON.stringify(record);
    const temporary = join(this.directory, `accounts.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, 'accounts.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  // Cross-process locking protects rotating refresh tokens and account mutations.
  locked(action) {
    const next = this.pending.then(() => this.withFileLock(action));
    this.pending = next.catch(() => {});
    return next;
  }
  async withFileLock(action) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, 'accounts.lock');
    let lock;
    const deadline = Date.now() + 30_000;
    while (!lock) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Another bridge is updating this account. Retry shortly. If it crashed, remove accounts.lock from the bridge credential directory.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try { return await action(); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
}
