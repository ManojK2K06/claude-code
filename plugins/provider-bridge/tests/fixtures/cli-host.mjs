import { fileURLToPath } from 'node:url';
import { dispatch } from '../../cli.mjs';
import { main } from '../../bridge.mjs';
import { launchClaude } from '../../lib/launch.mjs';

const fixture = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const launch = (executable, args, env) => launchClaude(process.execPath, [fixture, ...args], env);
dispatch(process.argv.slice(2), {
  nativeLaunch: launch,
  bridge: args => main(args, {
    env: { ...process.env, DEEPSEEK_API_KEY: 'synthetic-key' },
    fetcher: async () => Response.json({ data: [{ id: 'deepseek-cli-test' }] }),
    launch,
  }),
}).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
