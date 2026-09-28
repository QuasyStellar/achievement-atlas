import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Address } from '@ton/core';
import { createApp, type AtlasApp } from '../../apps/server/src/app.js';
import type { TonGateway, MintInspection, PreparedMint } from '../../apps/server/src/application/ports/ton-gateway.js';
import type { MintRow } from '../../apps/server/src/application/service.js';

const collection = new Address(0, Buffer.alloc(32, 11)).toString({ testOnly: true });
const wallet = new Address(0, Buffer.alloc(32, 12)).toString({ testOnly: true });
const recipient = new Address(0, Buffer.alloc(32, 13)).toString({ testOnly: true });
const item = new Address(0, Buffer.alloc(32, 14)).toString({ testOnly: true });
const other = new Address(0, Buffer.alloc(32, 15)).toString({ testOnly: true });
let app: AtlasApp;
let nextIndex: number;
let inspection: MintInspection;
let fake: TonGateway;
const dirs: string[] = [];
async function jobRows() { return app.services.db.read(c => c.all<MintRow>('SELECT * FROM mint_jobs ORDER BY created_at,rowid')); }
async function accountWithRewards() {
  const user = await app.services.register({ email: `mint-${Date.now()}-${Math.random()}@example.test`, password: 'strong-password-123', displayName: 'Tester' });
  await app.services.ingest({ eventId: `event-${user.id}`, playerId: user.id, type: 'match.completed', payload: { won: true }, occurredAt: new Date().toISOString() }, 'fake-test-game');
  const rewards = (await app.services.rewards(user.id)).rewards;
  return { user, rewards };
}
function confirmed(index = 0): MintInspection {
  return { status: 'confirmed', initialized: true, itemAddress: item, transactionHash: 'a'.repeat(64), owner: recipient, collectionAddress: collection, itemIndex: index };
}
beforeEach(async () => {
  nextIndex = 0;
  inspection = { status: 'pending', retrySafe: false };
  fake = {
    nextIndex: vi.fn(async () => nextIndex),
    prepare: vi.fn(async () => ({ signedBoc: 'TEST_ONLY_SIGNED_ENVELOPE', messageHash: 'b'.repeat(64), walletSeqno: 9, deadline: Math.floor(Date.now() / 1000) + 60 })),
    send: vi.fn(async () => {}),
    inspect: vi.fn(async () => inspection),
  };
  app = await createApp({ dbPath: ':memory:', gateway: fake, collectionAddress: collection, walletAddress: wallet, mintingEnabled: true });
});
afterEach(async () => { await app.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('durable sequential mint dispatcher (fake port, no network)', () => {
  it('persists stable index, BOC, hash, seqno and deadline before calling send; confirms only verified getters+actual tx', async () => {
    const { user, rewards } = await accountWithRewards();
    await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    fake.send = vi.fn(async (prepared: PreparedMint) => {
      const row = (await jobRows())[0];
      expect(row.status).toBe('submitted'); expect(row.item_index).toBe(0);
      expect(row.signed_boc).toBe(prepared.signedBoc); expect(row.message_hash).toBe(prepared.messageHash);
      expect(row.wallet_seqno).toBe(prepared.walletSeqno); expect(row.deadline).toBe(prepared.deadline);
      expect(row.transaction_hash).toBeNull();
    });
    await app.mintWorker!.tick();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.prepare).toHaveBeenCalledWith(expect.objectContaining({ itemIndex: 0, recipient, metadata: { name: 'Первый шаг', description: expect.stringContaining('TON testnet') } }));
    expect((await app.services.achievements(user.id)).summary.minted).toBe(0);
    inspection = confirmed(); nextIndex = 1;
    await app.mintWorker!.tick();
    const row = (await jobRows())[0];
    expect(row.status).toBe('confirmed'); expect(row.transaction_hash).toBe('a'.repeat(64)); expect(row.item_address).toBe(item);
    expect((await app.services.achievements(user.id)).summary.minted).toBe(1);
    const publicView = await app.services.rewards(user.id);
    expect(JSON.stringify(publicView)).not.toContain('TEST_ONLY_SIGNED_ENVELOPE');
    expect(JSON.stringify(publicView)).not.toContain('messageHash');
  });
  it('keeps ambiguous send timeouts submitted and blocks later jobs without retrying blindly', async () => {
    const { user, rewards } = await accountWithRewards();
    for (const reward of rewards) await app.services.mint(user.id, reward.unlockId, recipient, true);
    fake.send = vi.fn(async () => { throw new Error('transport timeout; SECRET_DATA_MUST_NOT_ESCAPE'); });
    await app.mintWorker!.tick();
    const rows = await jobRows();
    expect(rows[0].status).toBe('submitted'); expect(rows[0].error).toBe('SUBMISSION_UNCERTAIN');
    expect(rows[1].item_index).toBeNull();
    for (let i = 0; i < 3; i++) await app.mintWorker!.tick();
    expect(fake.send).toHaveBeenCalledTimes(1); expect(fake.prepare).toHaveBeenCalledTimes(1);
    expect(fake.inspect).toHaveBeenCalledWith({ itemIndex: 0, recipient, messageHash: 'b'.repeat(64), walletSeqno: 9, deadline: rows[0].deadline });
    expect((await jobRows())[0].status).toBe('submitted');
    expect(JSON.stringify(await app.services.rewards(user.id))).not.toContain('SECRET');
  });
  it('rejects wrong owner/collection/index or missing transaction proof, retaining uncertainty', async () => {
    const { user, rewards } = await accountWithRewards(); await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    await app.mintWorker!.tick();
    const valid = confirmed(); if (valid.status !== 'confirmed') throw new Error('invalid fixture');
    for (const overrides of [{ owner: other }, { collectionAddress: other }, { itemIndex: 9 }, { transactionHash: '' }, { itemAddress: 'invalid' }, { initialized: false }]) {
      inspection = { ...valid, ...overrides } as MintInspection;
      await app.mintWorker!.tick();
      expect((await jobRows())[0].status).toBe('submitted');
      expect((await jobRows())[0].error).toBe('CHAIN_STATE_MISMATCH');
      expect((await app.services.achievements(user.id)).summary.minted).toBe(0);
    }
  });
  it('reconciles after restart without preparing or sending another transfer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-worker-restart-')); dirs.push(dir);
    const dbPath = join(dir, 'atlas.db');
    await app.close(); app = await createApp({ dbPath, gateway: fake, collectionAddress: collection, walletAddress: wallet, mintingEnabled: true });
    const { user, rewards } = await accountWithRewards();
    const first = await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    await app.mintWorker!.tick();
    await app.close(); app = await createApp({ dbPath, gateway: fake, collectionAddress: collection, walletAddress: wallet, mintingEnabled: true });
    inspection = confirmed(); nextIndex = 1;
    await app.mintWorker!.tick();
    expect(fake.send).toHaveBeenCalledTimes(1); expect(fake.prepare).toHaveBeenCalledTimes(1);
    expect((await jobRows())[0]).toMatchObject({ id: first.id, item_index: 0, status: 'confirmed' });
  });
  it('retries only an authoritatively absent expired message using the SAME job/index/recipient', async () => {
    const { user, rewards } = await accountWithRewards();
    const first = await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    await app.mintWorker!.tick();
    inspection = { status: 'absent', retrySafe: true };
    await app.mintWorker!.tick(); expect(fake.send).toHaveBeenCalledTimes(1); // not expired
    await app.services.db.transaction(c => c.run('UPDATE mint_jobs SET deadline=? WHERE id=?', [Math.floor(Date.now() / 1000) - 1, first.id]));
    inspection = { status: 'absent', retrySafe: false };
    await app.mintWorker!.tick(); expect(fake.send).toHaveBeenCalledTimes(1);
    inspection = { status: 'absent', retrySafe: true };
    await app.mintWorker!.tick(); expect(fake.send).toHaveBeenCalledTimes(2);
    expect((await jobRows())[0]).toMatchObject({ id: first.id, item_index: 0, recipient, status: 'submitted' });
  });
  it('does not retry a supposedly absent transfer if collection index has advanced', async () => {
    const { user, rewards } = await accountWithRewards(); await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    await app.mintWorker!.tick();
    await app.services.db.transaction(c => c.run('UPDATE mint_jobs SET deadline=?', [Math.floor(Date.now() / 1000) - 1]));
    inspection = { status: 'absent', retrySafe: true }; nextIndex = 1;
    await app.mintWorker!.tick();
    expect(fake.send).toHaveBeenCalledTimes(1); expect((await jobRows())[0].error).toBe('CHAIN_INDEX_UNCERTAIN');
  });
  it('allows retry of known preparation failure but blocks subsequent stable indices', async () => {
    const { user, rewards } = await accountWithRewards();
    const first = await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    await app.services.mint(user.id, rewards[1].unlockId, recipient, true);
    const realPrepare = fake.prepare;
    fake.prepare = vi.fn(async () => { throw new Error('cannot sign'); });
    await app.mintWorker!.tick(); await app.mintWorker!.tick();
    expect((await jobRows())[0]).toMatchObject({ status: 'failed', item_index: 0, message_hash: null });
    expect((await jobRows())[1].item_index).toBeNull(); expect(fake.send).not.toHaveBeenCalled();
    fake.prepare = realPrepare;
    const retry = await app.services.mint(user.id, rewards[0].unlockId, recipient, true);
    expect(retry.id).toBe(first.id); expect(retry.status).toBe('pending');
    await app.mintWorker!.tick(); expect(fake.send).toHaveBeenCalledTimes(1);
  });
  it('prevents overlapping ticks and allocates next job only after prior proof', async () => {
    const { user, rewards } = await accountWithRewards();
    for (const reward of rewards) await app.services.mint(user.id, reward.unlockId, recipient, true);
    await Promise.all(Array.from({ length: 20 }, () => app.mintWorker!.tick()));
    expect(fake.prepare).toHaveBeenCalledTimes(1); expect(fake.send).toHaveBeenCalledTimes(1);
    inspection = confirmed(); nextIndex = 1;
    await app.mintWorker!.tick();
    await app.mintWorker!.tick();
    const rows = await jobRows(); expect(rows[0].item_index).toBe(0); expect(rows[1].item_index).toBe(1);
    expect(fake.send).toHaveBeenCalledTimes(2);
  });
  it('holds an exclusive process wallet lock even for different database files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-exclusive-')); dirs.push(dir);
    await app.close(); app = await createApp({ dbPath: join(dir, 'a.db'), gateway: fake, collectionAddress: collection, walletAddress: wallet, mintingEnabled: true });
    await app.mintWorker!.start();
    const otherApp = await createApp({ dbPath: join(dir, 'b.db'), gateway: fake, collectionAddress: collection, walletAddress: wallet, mintingEnabled: true });
    try { await expect(otherApp.mintWorker!.start()).rejects.toThrow('locked'); }
    finally { await otherApp.close(); }
  });
});
