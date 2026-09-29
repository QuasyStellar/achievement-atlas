import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { Address, beginCell, external, internal, SendMode, storeMessage, toNano } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { SingleMintPermission, sourceFeeTotal } from '../../contracts/service/single-mint-permission.js';
import { mintBody } from '../../contracts/wrappers.js';
import type { TonGateway, PreparedMint } from '../../contracts/service/ton-gateway.js';
import { createApp, type AtlasApp } from '../../apps/server/src/app.js';

// Local fake wallet envelopes only. No real wallet, RPC or network send is used.
const wallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.alloc(32, 9) });
const walletAddress = wallet.address.toString({ testOnly: true });
const collectionAddress = new Address(0, Buffer.alloc(32, 10)).toString({ testOnly: true });
const recipient = new Address(0, Buffer.alloc(32, 11)).toString({ testOnly: true });
const other = new Address(0, Buffer.alloc(32, 12)).toString({ testOnly: true });
const metadata = { name: 'Test', description: 'Fake port only' };
let directory: string;
let options: Parameters<typeof SingleMintPermission.open>[0];
let gate: SingleMintPermission;
let fake: TonGateway;
let app: AtlasApp | undefined;
let jobId: string;
let input: { userId: string; unlockId: string; recipient: string };
function envelope(owner = recipient, index = 1): PreparedMint {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const body = wallet.createTransfer({ seqno: 1, secretKey: Buffer.alloc(64, 7), timeout: deadline, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: collectionAddress, value: toNano('0.12'), body: mintBody(index, Address.parse(owner), metadata) })] });
  const cell = beginCell().store(storeMessage(external({ to: wallet.address, body }))).endCell();
  return { signedBoc: cell.toBoc().toString('base64'), messageHash: cell.hash().toString('hex'), walletSeqno: 1, deadline };
}
async function claim() { return gate.request(input, async () => ({ id: jobId, status: 'pending' })); }
async function prepare() { return gate.prepare({ jobId, itemIndex: 1, recipient, metadata }); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-single-permission-'));
  jobId = randomUUID(); input = { userId: randomUUID(), unlockId: randomUUID(), recipient };
  fake = { nextIndex: vi.fn(async () => 1), prepare: vi.fn(async () => envelope()), send: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ status: 'absent' as const, retrySafe: true })) };
  options = { statePath: join(directory, 'permission.json'), walletAddress, collectionAddress, recipient, itemIndex: 1, maxSpendTon: '0.20',
    gateway: fake, estimateSourceFees: vi.fn(async () => toNano('0.001')), balance: vi.fn(async () => toNano('1')) };
  gate = await SingleMintPermission.open(options);
});
afterEach(async () => { await app?.close(); app = undefined; await rm(directory, { recursive: true, force: true }); });

describe('bounded website permission, fake port and no network', () => {
  it('opening the permission enables one website request without preparing or sending', async () => {
    expect(gate.status()).toEqual({ recipient, maxSpendTon: '0.20', remainingMints: 1, automaticRetryAllowed: false });
    expect(fake.prepare).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled();
    expect((await stat(options.statePath)).mode & 0o777).toBe(0o600);
  });
  it('rejects invalid/foreign recipients before creating a job or consuming permission', async () => {
    const create = vi.fn(async () => ({ id: jobId, status: 'pending' }));
    await expect(gate.request({ ...input, recipient: 'invalid' }, create)).rejects.toMatchObject({ status: 400 });
    await expect(gate.request({ ...input, recipient: other }, create)).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled(); expect(gate.status().remainingMints).toBe(1);
  });
  it('an unauthorized/nonexistent reward does not consume the permission', async () => {
    await expect(gate.request(input, async () => { throw new Error('REWARD_NOT_FOUND'); })).rejects.toThrow('REWARD_NOT_FOUND');
    expect(gate.status().remainingMints).toBe(1);
  });
  it('serializes competing requests and permits only an identical owned reward replay', async () => {
    const results = await Promise.allSettled([claim(), gate.request({ ...input, unlockId: randomUUID() }, async () => ({ id: randomUUID(), status: 'pending' }))]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(gate.status().remainingMints).toBe(0);
    expect(await claim()).toEqual({ id: jobId, status: 'pending' });
    await expect(gate.request({ ...input, userId: randomUUID() }, async () => ({ id: jobId, status: 'pending' }))).rejects.toMatchObject({ status: 409 });
  });
  it('prevents signing an unclaimed job or unexpected index', async () => {
    await expect(prepare()).rejects.toThrow(); expect(fake.prepare).not.toHaveBeenCalled();
    await claim();
    await expect(gate.prepare({ jobId, itemIndex: 2, recipient, metadata })).rejects.toThrow();
    expect(fake.prepare).not.toHaveBeenCalled();
  });
  it('checks the actual serialized recipient, not just the input string', async () => {
    await claim(); fake.prepare = vi.fn(async () => envelope(other));
    await expect(prepare()).rejects.toThrow(); expect(fake.send).not.toHaveBeenCalled();
  });
  it('blocks excessive fee reservation or insufficient balance before any send', async () => {
    const response = { '@type': 'fees', in_fwd_fee: 100, storage_fee: 200, gas_fee: 300, fwd_fee: 400 };
    expect(sourceFeeTotal(response)).toBe(1000n);
    expect(() => sourceFeeTotal({ ...response, gas_fee: -1 })).toThrow();
    expect(() => sourceFeeTotal({ ...response, gas_fee: 0.5 })).toThrow();
    await claim(); options.estimateSourceFees = async () => toNano('0.04');
    await expect(prepare()).rejects.toThrow('Approved budget or balance insufficient');
    options.estimateSourceFees = async () => toNano('0.001'); options.balance = async () => toNano('0.10');
    await expect(prepare()).rejects.toThrow('Approved budget or balance insufficient');
    expect(fake.send).not.toHaveBeenCalled();
  });
  it('durably consumes the sole send before delegation; a timeout/restart cannot resend or re-sign', async () => {
    await claim(); const prepared = await prepare();
    fake.send = vi.fn(async () => {
      const state = JSON.parse(await readFile(options.statePath, 'utf8'));
      expect(state.sendAttempted).toBe(true); expect(state.reservedTon).toBe('0.132');
      expect((await readFile(options.statePath + '.sent', 'utf8')).trim()).toBe(prepared.messageHash);
      expect(state).not.toHaveProperty('signedBoc');
      throw new Error('Ambiguous transport timeout');
    });
    await expect(gate.send(prepared)).rejects.toThrow('Ambiguous transport timeout');
    const reopened = await SingleMintPermission.open(options);
    await expect(reopened.send(prepared)).rejects.toThrow();
    await expect(reopened.prepare({ jobId, itemIndex: 1, recipient, metadata })).rejects.toThrow();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(await reopened.inspect({ itemIndex: 1, recipient, messageHash: prepared.messageHash, deadline: prepared.deadline, walletSeqno: 1 }))
      .toEqual({ status: 'absent', retrySafe: false });
  });
  it('rejects a changed permission scope on restart', async () => {
    await claim(); await expect(SingleMintPermission.open({ ...options, recipient: other })).rejects.toThrow();
  });
  it('real HTTP gates recipient, ownership, CSRF, second reward and duplicate; worker persists before fake send', async () => {
    app = await createApp({ dbPath: ':memory:', gameKey: 'fake-test-key', gateway: gate, mintPermission: gate, mintingEnabled: true,
      collectionAddress, walletAddress, startWorker: false });
    const agent = request.agent(app);
    const anonymous = await agent.get('/api/auth/me');
    const register = await agent.post('/api/auth/register').set('X-CSRF-Token', anonymous.body.csrfToken)
      .send({ email: 'bounded@example.test', password: 'fake-test-password', displayName: 'Tester' }).expect(201);
    const me = await agent.get('/api/auth/me');
    await request(app).post('/api/events/ingest').set('X-Game-Key', 'fake-test-key')
      .send({ eventId: randomUUID(), playerId: register.body.user.id, type: 'match.completed', payload: { won: true }, occurredAt: new Date().toISOString() }).expect(201);
    const rewards = (await agent.get('/api/rewards')).body.rewards;
    const path = `/api/rewards/${rewards[0].unlockId}/mint`;
    expect((await request(app).get('/api/health')).body.chain.mintingEnabled).toBe(true);
    await agent.post(path).send({ recipient }).expect(403);
    await agent.post(path).set('X-CSRF-Token', me.body.csrfToken).send({ recipient: other }).expect(403);
    await agent.post(`/api/rewards/${randomUUID()}/mint`).set('X-CSRF-Token', me.body.csrfToken).send({ recipient }).expect(404);
    expect(gate.status().remainingMints).toBe(1);
    const first = await agent.post(path).set('X-CSRF-Token', me.body.csrfToken).send({ recipient }).expect(202);
    const repeat = await agent.post(path).set('X-CSRF-Token', me.body.csrfToken).send({ recipient }).expect(202);
    expect(repeat.body).toEqual(first.body);
    await agent.post(`/api/rewards/${rewards[1].unlockId}/mint`).set('X-CSRF-Token', me.body.csrfToken).send({ recipient }).expect(409);
    const health = (await request(app).get('/api/health')).body;
    expect(health.chain.mintingEnabled).toBe(false); expect(health.chain.permission.remainingMints).toBe(0);
    fake.send = vi.fn(async prepared => {
      const row = await app!.services.db.read(c => c.get<{ status: string; message_hash: string }>('SELECT status,message_hash FROM mint_jobs WHERE id=?', [first.body.mint.id]));
      expect(row).toEqual({ status: 'submitted', message_hash: prepared.messageHash });
    });
    await app.mintWorker!.tick(); await app.mintWorker!.tick();
    expect(fake.send).toHaveBeenCalledTimes(1); expect(fake.prepare).toHaveBeenCalledTimes(1);
    const jobs = await app.services.db.read(c => c.all('SELECT id FROM mint_jobs'));
    expect(jobs).toHaveLength(1);
  });
});
