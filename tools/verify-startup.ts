import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startServer } from '../apps/server/src/index.js';

const probe = createServer();
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('No local port');
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
process.env.PORT = String(address.port);
process.env.HOST = '127.0.0.1';
const directory = await mkdtemp(join(tmpdir(), 'atlas-startup-'));
let running: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  running = await startServer({ dbPath: join(directory, 'test.db'), startWorker: false, mintingEnabled: false, gateway: undefined, cookieSecure: false, demoMode: false });
  const base = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${base}/api/health`);
  const health = await healthResponse.json() as { network: string; chain: { configured: boolean; mintingEnabled: boolean } };
  if (healthResponse.status !== 200 || health.network !== 'testnet' || health.chain.configured || health.chain.mintingEnabled) throw new Error('Unsafe startup state');
  const page = await fetch(base);
  if (page.status !== 200 || !(await page.text()).includes('Achievement Atlas')) throw new Error('Built frontend not served');
  console.info('Startup smoke passed: real HTTP health 200, built frontend 200, gateway and minting disabled. No browser or blockchain call.');
} finally {
  try { await running?.stop(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
