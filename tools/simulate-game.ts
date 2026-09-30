import dotenv from 'dotenv';
dotenv.config({ path: process.env.ATLAS_ENV_FILE ?? '/etc/achievement-atlas/service.env' });
import { randomUUID } from 'node:crypto';
import { eventSchema } from '../apps/server/src/application/service.js';

/** Trusted game emulator. Sends real ingestion HTTP requests, never writes counters directly. */
async function main(): Promise<void> {
  const playerId = process.argv[2];
  const scenario = process.argv[3] ?? 'victory';
  const key = process.env.GAME_API_KEY;
  if (!key) throw new Error('Game source key is not configured');
  const base = { eventId: process.env.EVENT_ID ?? `simulator:${randomUUID()}`, playerId, occurredAt: new Date().toISOString() };
  const event = eventSchema.parse(scenario === 'hundred-kills'
    ? { ...base, type: 'combat.completed', payload: { kills: 100 } }
    : scenario === 'thousand-xp' ? { ...base, type: 'xp.earned', payload: { xp: 1000 } }
      : ['victory', 'first-match'].includes(scenario) ? { ...base, type: 'match.completed', payload: { won: scenario === 'victory' } } : null);
  const baseUrl = new URL(process.env.SERVER_URL ?? 'http://127.0.0.1:3000');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) throw new Error('Simulator is restricted to localhost');
  const response = await fetch(new URL('/api/events/ingest', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Key': key }, body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
  const body: unknown = await response.json();
  if (!response.ok) { console.error(`Ingestion rejected (${response.status})`); process.exitCode = 1; return; }
  console.info(JSON.stringify(body, null, 2));
}
main().catch(() => { console.error('Simulator failed. Usage: npm run simulator -- playerUuid [victory|first-match|hundred-kills|thousand-xp]. Configure GAME_API_KEY locally.'); process.exitCode = 1; });
