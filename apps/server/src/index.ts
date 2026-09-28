import dotenv from 'dotenv';
dotenv.config({ path: process.env.ATLAS_ENV_FILE ?? '/etc/achievement-atlas/service.env' });
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppOptions } from './app.js';
import { configuredGateway } from './runtime.js';

function mintLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid MINT_LIMIT');
  return limit;
}
/** Compose the real testnet gateway only behind explicit dispatch gates. */
export async function startServer(overrides: Partial<AppOptions> = {}) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const options: AppOptions = {
    startWorker: true,
    dbPath: resolve(process.env.DB_PATH ?? 'data/atlas.db'),
    gameKey: process.env.GAME_API_KEY,
    gameSource: process.env.GAME_SOURCE ?? 'trusted-game',
    demoMode: process.env.DEMO_MODE === 'true',
    mintingEnabled: process.env.MINTING_ENABLED === 'true',
    mintLimit: mintLimit(process.env.MINT_LIMIT),
    collectionAddress: process.env.TON_COLLECTION_ADDRESS,
    walletAddress: process.env.TON_WALLET_ADDRESS,
    cookieSecure: process.env.COOKIE_SECURE === undefined ? undefined : process.env.COOKIE_SECURE === 'true',
    allowedOrigins: (process.env.APP_ORIGIN ?? `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map(value => value.trim()),
    ...overrides,
  };
  options.gateway = await configuredGateway(options);
  const app = await createApp(options);
  const server = app.listen(port, process.env.HOST ?? '127.0.0.1');
  try {
    await new Promise<void>((resolveReady, reject) => { server.once('listening', resolveReady); server.once('error', reject); });
  } catch (error) { await app.close(); throw error; }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    await app.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void stop().catch(() => { process.exitCode = 1; });
  });
  console.info(`Achievement Atlas listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}; TON testnet minting ${app.mintWorker ? 'enabled' : 'disabled'}`);
  return { app, server, stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(() => { console.error('Achievement Atlas startup failed; check local configuration and database access.'); process.exitCode = 1; });
}
