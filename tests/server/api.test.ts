import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Address } from '@ton/core';
import { createApp, type AppOptions, type AtlasApp } from '../../apps/server/src/app.js';
import type { TonGateway } from '../../apps/server/src/application/ports/ton-gateway.js';

const key = 'test-game-key-not-a-real-secret';
const recipient = new Address(0, Buffer.alloc(32, 1)).toString({ testOnly: true });
const otherRecipient = new Address(0, Buffer.alloc(32, 2)).toString({ testOnly: true });
const gateway: TonGateway = {
  nextIndex: async () => 0,
  prepare: async () => { throw new Error('API tests must not prepare/send chain requests'); },
  send: async () => { throw new Error('No chain calls in API tests'); },
  inspect: async () => ({ status: 'pending', retrySafe: false }),
};
let app: AtlasApp;
const tempDirs: string[] = [];
async function registered(email = `player-${randomUUID()}@example.test`) {
  const agent = request.agent(app);
  const anonymous = await agent.get('/api/auth/me').expect(200);
  const result = await agent.post('/api/auth/register').set('X-CSRF-Token', anonymous.body.csrfToken).send({ email, password: 'strong-password-123', displayName: 'Игрок' }).expect(201);
  const me = await agent.get('/api/auth/me').expect(200);
  return { agent, user: result.body.user as { id: string; email: string; role: string }, csrf: me.body.csrfToken as string, oldCsrf: anonymous.body.csrfToken as string,
    cookie: (result.headers['set-cookie'] as unknown as string[])[0].split(';')[0] };
}
function event(playerId: string, eventId: string = randomUUID()) {
  return { eventId, playerId, type: 'match.completed', payload: { won: true }, occurredAt: '2026-09-30T12:00:00.000Z' };
}
const ingest = (data: object) => request(app).post('/api/events/ingest').set('X-Game-Key', key).send(data);
async function unlock(playerId: string) { await ingest(event(playerId)).expect(201); return (await app.services.rewards(playerId)).rewards[0].unlockId; }
async function reopen(options: Partial<AppOptions>) {
  await app.close();
  app = await createApp({ dbPath: ':memory:', gameKey: key, ...options });
}
beforeEach(async () => { app = await createApp({ dbPath: ':memory:', gameKey: key }); });
afterEach(async () => { await app.close(); for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('auth, boundaries and errors', () => {
  it('initializes anonymous HttpOnly SameSite session, stores only its token hash, rotates after login and logout', async () => {
    const account = await registered('auth@example.test');
    expect(account.user.role).toBe('player');
    expect(account.csrf).not.toBe(account.oldCsrf);
    await account.agent.post('/api/auth/logout').set('X-CSRF-Token', account.oldCsrf).expect(403);
    const me = await account.agent.get('/api/auth/me').expect(200);
    expect(me.body.user.id).toBe(account.user.id);
    await account.agent.post('/api/auth/logout').set('X-CSRF-Token', account.csrf).expect(200);
    await account.agent.get('/api/achievements').expect(401);
    const anonymous = await account.agent.get('/api/auth/me');
    await account.agent.post('/api/auth/login').set('X-CSRF-Token', anonymous.body.csrfToken).send({ email: account.user.email, password: 'wrong' }).expect(401);
    const login = await account.agent.post('/api/auth/login').set('X-CSRF-Token', anonymous.body.csrfToken).send({ email: account.user.email, password: 'strong-password-123' }).expect(200);
    const cookie: string = (login.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax');
    const sessionToken = cookie.split(';')[0].split('=')[1];
    const rows = await app.services.db.read(c => c.all<{ token_hash: string }>('SELECT token_hash FROM sessions'));
    expect(rows.every(r => /^[a-f0-9]{64}$/.test(r.token_hash) && r.token_hash !== sessionToken)).toBe(true);
    const newMe = await account.agent.get('/api/auth/me');
    expect(newMe.body.csrfToken).not.toBe(anonymous.body.csrfToken);
    const stored = await app.services.db.read(c => c.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', [account.user.id]));
    expect(stored!.password_hash).toMatch(/^scrypt\$/); expect(stored!.password_hash).not.toContain('strong-password');
  });
  it('requires CSRF before register; public registration cannot set operator role', async () => {
    await request(app).post('/api/auth/register').send({}).expect(403);
    const agent = request.agent(app); const me = await agent.get('/api/auth/me');
    await agent.post('/api/auth/register').set('X-CSRF-Token', me.body.csrfToken).send({ email: 'op@example.test', password: 'strong-password-123', displayName: 'Op', role: 'operator' }).expect(400);
    expect((await app.services.users()).length).toBe(0);
  });
  it('rejects foreign origin and isolates all account views', async () => {
    const a = await registered(); const b = await registered();
    await ingest(event(a.user.id)).expect(201);
    await b.agent.get('/api/events').expect(200).then(r => expect(r.body.events).toEqual([]));
    await b.agent.get('/api/rewards').expect(200).then(r => expect(r.body.rewards).toEqual([]));
    await b.agent.get('/api/achievements').expect(200).then(r => expect(r.body.summary).toEqual({ matches: 0, wins: 0, kills: 0, xp: 0, unlocked: 0, total: 6, minted: 0 }));
    await a.agent.post('/api/auth/logout').set('Origin', 'https://evil.example').set('X-CSRF-Token', a.csrf).expect(403);
    await a.agent.get('/api/operator/users').expect(403);
    await request(app).get('/api/rewards').expect(401);
  });
  it('returns uniform JSON errors with requestId, protects size, hides exception stacks', async () => {
    const result = await request(app).get('/api/unknown').expect(404);
    expect(result.body.error).toEqual({ code: 'NOT_FOUND', message: expect.any(String), requestId: expect.any(String) });
    expect(result.headers['x-request-id']).toBe(result.body.error.requestId);
    await request(app).post('/api/events/ingest').set('Content-Type', 'application/json').send('{bad').expect(400);
    const oversized = await request(app).post('/api/events/ingest').send({ value: 'x'.repeat(20000) }).expect(413);
    expect(JSON.stringify(oversized.body)).not.toMatch(/stack|SyntaxError|sqlite/);
  });
  it('limits abusive auth attempts per IP', async () => {
    await reopen({ rateLimits: { auth: 2 } });
    await request(app).get('/api/auth/me').expect(200);
    await request(app).get('/api/auth/me').expect(200);
    await request(app).get('/api/auth/me').expect(429);
  });
  it('rejects duplicate normalized emails without creating a second counter row', async () => {
    await registered('same@example.test');
    const agent = request.agent(app); const me = await agent.get('/api/auth/me');
    await agent.post('/api/auth/register').set('X-CSRF-Token', me.body.csrfToken).send({ email: 'SAME@example.test', password: 'another-password', displayName: 'Second' }).expect(409);
    expect((await app.services.users()).length).toBe(1);
  });
});

describe('trusted atomic event processing', () => {
  it('rejects key401 and exact type/payload400; browser CSRF is not an ingestion credential', async () => {
    const account = await registered();
    await request(app).post('/api/events/ingest').send(event(account.user.id)).expect(401);
    await request(app).post('/api/events/ingest').set('X-Game-Key', 'bad').send(event(account.user.id)).expect(401);
    await account.agent.post('/api/events/ingest').set('X-CSRF-Token', account.csrf).send(event(account.user.id)).expect(401);
    for (const data of [
      { ...event(account.user.id), payload: { won: true, kills: 9 } },
      { ...event(account.user.id), type: 'combat.completed', payload: { kills: -1 } },
      { ...event(account.user.id), type: 'xp.earned', payload: { xp: 1.5 } },
      { ...event(account.user.id), type: 'match.completed', payload: { won: 'true' } },
      { ...event(account.user.id), extra: 'client-source' },
      { ...event(account.user.id), occurredAt: 'yesterday' },
    ]) await ingest(data).expect(400);
    await ingest(event(randomUUID())).expect(404);
    expect((await app.services.achievements(account.user.id)).summary.matches).toBe(0);
  });
  it('returns original result for canonical duplicate, conflicts on differing payload, and unlocks once', async () => {
    const { user, agent } = await registered();
    const data = event(user.id, 'deduplicated');
    const first = await ingest(data).expect(201);
    const retry = await ingest({ occurredAt: data.occurredAt, payload: { won: true }, type: data.type, playerId: data.playerId, eventId: data.eventId }).expect(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body.unlocked).toEqual(['first_match', 'first_win']);
    await ingest({ ...data, payload: { won: false } }).expect(409);
    const view = await agent.get('/api/achievements').expect(200);
    expect(view.body.summary).toMatchObject({ matches: 1, wins: 1, unlocked: 2, minted: 0, total: 6 });
    const history = await agent.get('/api/events').expect(200);
    expect(history.body.events).toHaveLength(1);
    expect(Object.keys(history.body.events[0])).toEqual(['id', 'eventId', 'type', 'occurredAt', 'payload', 'createdAt', 'unlocked']);
    expect(history.body.events[0].unlocked).toEqual(expect.any(Array));
  });
  it('serializes concurrent retries and different events on one async connection', async () => {
    const { user } = await registered();
    const data = event(user.id, 'parallel');
    const results = await Promise.all(Array.from({ length: 12 }, () => ingest(data)));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 200)).toHaveLength(11);
    await Promise.all(Array.from({ length: 10 }, () => ingest(event(user.id))));
    const view = await app.services.achievements(user.id);
    expect(view.summary).toMatchObject({ matches: 11, wins: 11, unlocked: 4 });
    expect(new Set((await app.services.rewards(user.id)).rewards.map(r => r.achievementId)).size).toBe(4);
  });
  it('implements all six metrics using actual stored counters', async () => {
    const { user } = await registered();
    for (let i = 0; i < 10; i++) await ingest({ ...event(user.id), payload: { won: i < 5 } }).expect(201);
    await ingest({ ...event(user.id), type: 'combat.completed', payload: { kills: 100 } }).expect(201);
    await ingest({ ...event(user.id), type: 'xp.earned', payload: { xp: 1000 } }).expect(201);
    const data = await app.services.achievements(user.id);
    expect(data.summary).toEqual({ matches: 10, wins: 5, kills: 100, xp: 1000, unlocked: 6, total: 6, minted: 0 });
    expect(data.achievements.every(a => a.unlocked && a.unlockId && a.progress === a.target)).toBe(true);
  });
  it('rolls back every write on a transaction failure and remains usable', async () => {
    const { user } = await registered();
    await expect(app.services.db.transaction(async c => {
      await c.run('UPDATE counters SET kills=100 WHERE user_id=?', [user.id]);
      await c.run('INSERT INTO counters(user_id) VALUES(?)', ['missing-player']);
    })).rejects.toThrow();
    expect((await app.services.achievements(user.id)).summary.kills).toBe(0);
    await ingest(event(user.id)).expect(201);
    const pragmas = await app.services.db.read(async c => ({ foreign: await c.get<{ foreign_keys: number }>('PRAGMA foreign_keys'), busy: await c.get<{ timeout: number }>('PRAGMA busy_timeout') }));
    expect(pragmas.foreign!.foreign_keys).toBe(1); expect(pragmas.busy!.timeout).toBe(5000);
  });
  it('persists session, original idempotency response, unlocks and WAL schema across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-restart-')); tempDirs.push(dir);
    const dbPath = join(dir, 'atlas.db');
    await reopen({ dbPath });
    const { user, cookie, csrf } = await registered(); const data = event(user.id, 'restart');
    const first = await ingest(data).expect(201);
    await app.close(); app = await createApp({ dbPath, gameKey: key });
    const duplicate = await ingest(data).expect(200); expect(duplicate.body).toEqual(first.body);
    expect((await app.services.rewards(user.id)).rewards).toHaveLength(2);
    const state = await app.services.db.read(async c => ({ journal: await c.get<{ journal_mode: string }>('PRAGMA journal_mode'), count: await c.get<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations') }));
    expect(state.journal!.journal_mode).toBe('wal'); expect(state.count!.n).toBe(1);
    // Stored hashed sessions survive restart, without depending on the old Express instance.
    const sessions = await app.services.db.read(c => c.all('SELECT token_hash FROM sessions WHERE user_id=?', [user.id]));
    expect(sessions).toHaveLength(1);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.id).toBe(user.id); expect(me.body.csrfToken).toBe(csrf);
  });
});

describe('operator and mint API', () => {
  it('requires operator AND demo flag; generates trusted unique server-side events', async () => {
    await reopen({ demoMode: true });
    const account = await registered();
    await account.agent.post('/api/operator/simulate').set('X-CSRF-Token', account.csrf).send({ userId: account.user.id, scenario: 'victory' }).expect(403);
    await app.services.db.transaction(c => c.run('UPDATE users SET role=\'operator\' WHERE id=?', [account.user.id]));
    await account.agent.get('/api/operator/users').expect(200);
    const result = await account.agent.post('/api/operator/simulate').set('X-CSRF-Token', account.csrf).send({ userId: account.user.id, scenario: 'ten-matches' }).expect(200);
    expect(result.body).toEqual({ processed: 10, unlocked: ['first_match', '10_matches'] });
    const events = (await app.services.events(account.user.id)).events;
    expect(events).toHaveLength(10); expect(new Set(events.map(e => e.eventId)).size).toBe(10);
    await account.agent.post('/api/operator/simulate').send({ userId: account.user.id, scenario: 'victory' }).expect(403);
  });
  it('keeps demo controls off by default even for an operator', async () => {
    const a = await registered(); await app.services.db.transaction(c => c.run('UPDATE users SET role=\'operator\' WHERE id=?', [a.user.id]));
    await a.agent.post('/api/operator/simulate').set('X-CSRF-Token', a.csrf).send({ userId: a.user.id, scenario: 'victory' }).expect(403);
  });
  it('default disabled and absent gateway return503, never fabricate a confirmation', async () => {
    const a = await registered(); const unlockId = await unlock(a.user.id);
    const result = await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient }).expect(503);
    expect(result.body.error.code).toBe('MINTING_UNAVAILABLE');
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.chain).toEqual({ configured: false, collectionAddress: null, walletAddress: null, mintingEnabled: false });
    expect(app.mintWorker).toBeNull();
    await reopen({ mintingEnabled: true, collectionAddress: recipient, walletAddress: otherRecipient });
    const b = await registered(); const second = await unlock(b.user.id);
    await b.agent.post(`/api/rewards/${second}/mint`).set('X-CSRF-Token', b.csrf).send({ recipient }).expect(503);
  });
  it('queues unique owned reward, freezes canonical recipient and hides BOC/message hash/seqno', async () => {
    await reopen({ gateway, mintingEnabled: true, collectionAddress: recipient, walletAddress: otherRecipient });
    const a = await registered(); const b = await registered(); const unlockId = await unlock(a.user.id);
    await b.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', b.csrf).send({ recipient }).expect(404);
    await a.agent.post(`/api/rewards/${unlockId}/mint`).send({ recipient }).expect(403);
    await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient: 'not-an-address' }).expect(400);
    const first = await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient }).expect(202);
    const second = await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient: Address.parse(recipient).toRawString() }).expect(202);
    expect(second.body).toEqual(first.body);
    expect(first.body.mint).toMatchObject({ status: 'pending', itemIndex: null, itemAddress: null, transactionHash: null });
    expect(Object.keys(first.body.mint)).toEqual(['id', 'status', 'recipient', 'itemIndex', 'itemAddress', 'transactionHash', 'error', 'createdAt', 'updatedAt']);
    await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient: otherRecipient }).expect(409);
    expect((await app.services.achievements(a.user.id)).summary.minted).toBe(0);
    expect((await app.services.rewards(b.user.id)).rewards).toEqual([]);
  });
  it('stand mint limit rejects a new job beyond the cap but still replays an existing one', async () => {
    await reopen({ gateway, mintingEnabled: true, mintLimit: 1, collectionAddress: recipient, walletAddress: otherRecipient });
    const account = await registered(); await unlock(account.user.id);
    const rewards = (await app.services.rewards(account.user.id)).rewards;
    const first = await account.agent.post(`/api/rewards/${rewards[0].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient }).expect(202);
    const denied = await account.agent.post(`/api/rewards/${rewards[1].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient }).expect(503);
    expect(denied.body.error.code).toBe('MINT_LIMIT_REACHED');
    const repeat = await account.agent.post(`/api/rewards/${rewards[0].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient }).expect(202);
    expect(repeat.body).toEqual(first.body);
    expect(await app.services.db.read(c => c.all('SELECT id FROM mint_jobs'))).toHaveLength(1);
  });
  it('regular enabled queue accepts multiple owned rewards and user-selected recipients without demo caps', async () => {
    await reopen({ gateway, mintingEnabled: true, collectionAddress: recipient, walletAddress: otherRecipient });
    const account = await registered(); await unlock(account.user.id);
    const rewards = (await app.services.rewards(account.user.id)).rewards;
    const first = await account.agent.post(`/api/rewards/${rewards[0].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient }).expect(202);
    const second = await account.agent.post(`/api/rewards/${rewards[1].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient: otherRecipient }).expect(202);
    expect(second.body.mint.id).not.toBe(first.body.mint.id);
    const repeat = await account.agent.post(`/api/rewards/${rewards[0].unlockId}/mint`).set('X-CSRF-Token', account.csrf).send({ recipient }).expect(202);
    expect(repeat.body).toEqual(first.body);
    expect(await app.services.db.read(c => c.all('SELECT id FROM mint_jobs'))).toHaveLength(2);
    const health = (await request(app).get('/api/health')).body;
    expect(health.chain.mintingEnabled).toBe(true);
    expect(health.chain).not.toHaveProperty('permission');
  });
  it('configured adapter still requires explicit enablement', async () => {
    await reopen({ gateway, collectionAddress: recipient, walletAddress: otherRecipient });
    const a = await registered(); const unlockId = await unlock(a.user.id);
    await a.agent.post(`/api/rewards/${unlockId}/mint`).set('X-CSRF-Token', a.csrf).send({ recipient }).expect(503);
    const health = await request(app).get('/api/health');
    expect(health.body.chain.configured).toBe(true); expect(health.body.chain.mintingEnabled).toBe(false);
  });
  it('serves built SPA navigation but API unknowns remain JSON404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-spa-')); tempDirs.push(dir);
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>Atlas SPA</title>');
    await reopen({ webDistPath: dir });
    await request(app).get('/catalog').expect(200).then(r => expect(r.text).toContain('Atlas SPA'));
    await request(app).get('/api/unknown').expect(404).then(r => expect(r.headers['content-type']).toContain('application/json'));
  });
});
