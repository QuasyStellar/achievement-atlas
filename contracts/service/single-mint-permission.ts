import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Address, Cell, fromNano, loadMessage, loadMessageRelaxed, toNano } from '@ton/core';
import { z } from 'zod';
import { ApiError } from '../../apps/server/src/application/errors.js';
import { Mutex } from '../../apps/server/src/infrastructure/database.js';
import type { MintPermission } from '../../apps/server/src/application/ports/mint-permission.js';
import type { PreparedMint, TonGateway } from './ton-gateway.js';

const stateSchema = z.object({
  network: z.literal('testnet'), walletAddress: z.string(), collectionAddress: z.string(), recipient: z.string(),
  maxSpendTon: z.string(), itemIndex: z.number().int().nonnegative(),
  claim: z.object({ userId: z.string().uuid(), unlockId: z.string().uuid(), jobId: z.string().uuid() }).strict().nullable(),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), reservedTon: z.string().nullable(), sendAttempted: z.boolean(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Options = {
  statePath: string; walletAddress: string; collectionAddress: string; recipient: string; itemIndex: number; maxSpendTon: string;
  gateway: TonGateway;
  estimateSourceFees(message: ReturnType<typeof loadMessage>): Promise<bigint>;
  balance(): Promise<bigint>;
};

/** A durable one-message permission for the website, not an unlimited wallet dispatcher. */
export class SingleMintPermission implements TonGateway, MintPermission {
  private readonly mutex = new Mutex();
  private constructor(private readonly options: Options, private state: State) {}
  static async open(options: Options): Promise<SingleMintPermission> {
    assert(toNano(options.maxSpendTon) > 0n && toNano(options.maxSpendTon) <= toNano('0.20'));
    for (const address of [options.walletAddress, options.collectionAddress, options.recipient]) assert.equal(Address.parse(address).workChain, 0);
    assert(Number.isSafeInteger(options.itemIndex) && options.itemIndex >= 0);
    const initial: State = { network: 'testnet', walletAddress: options.walletAddress, collectionAddress: options.collectionAddress,
      recipient: options.recipient, itemIndex: options.itemIndex, maxSpendTon: options.maxSpendTon,
      claim: null, messageHash: null, reservedTon: null, sendAttempted: false };
    try {
      const file = await open(options.statePath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(initial) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await syncDirectory(dirname(options.statePath));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assert.equal((await stat(options.statePath)).mode & 0o777, 0o600);
    const state = stateSchema.parse(JSON.parse(await readFile(options.statePath, 'utf8')));
    for (const field of ['network', 'walletAddress', 'collectionAddress', 'recipient', 'itemIndex', 'maxSpendTon'] as const) assert.equal(state[field], initial[field]);
    assert(!state.messageHash || state.claim);
    assert(!state.sendAttempted || (state.messageHash && state.reservedTon));
    return new SingleMintPermission(options, state);
  }
  status() {
    return { recipient: this.state.recipient, maxSpendTon: this.state.maxSpendTon,
      remainingMints: this.state.claim || this.state.sendAttempted ? 0 : 1, automaticRetryAllowed: false as const };
  }
  async request<T extends { id: string; status: string }>(input: { userId: string; unlockId: string; recipient: string }, create: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      let recipient: Address;
      try { recipient = Address.parse(input.recipient); }
      catch { throw new ApiError(400, 'INVALID_ADDRESS', 'Некорректный адрес TON'); }
      if (!recipient.equals(Address.parse(this.state.recipient))) throw new ApiError(403, 'RECIPIENT_NOT_APPROVED', 'Для этого запуска разрешён только указанный оператором адрес получателя.');
      const claim = this.state.claim;
      if (claim && (claim.userId !== input.userId || claim.unlockId !== input.unlockId)) {
        throw new ApiError(409, 'MINT_LIMIT_REACHED', 'Лимит этого запуска — один новый NFT. Дополнительный выпуск отключён.');
      }
      const mint = await create(); // Ownership and unlock checks must pass before consuming permission.
      if (claim) assert.equal(mint.id, claim.jobId);
      else if (mint.status !== 'confirmed') {
        assert.equal(mint.status, 'pending');
        await this.save({ ...this.state, claim: { userId: input.userId, unlockId: input.unlockId, jobId: mint.id } });
      }
      return mint;
    });
  }
  nextIndex() { return this.options.gateway.nextIndex(); }
  async inspect(input: Parameters<TonGateway['inspect']>[0]) {
    const inspection = await this.options.gateway.inspect(input);
    return inspection.status === 'confirmed' ? inspection : { ...inspection, retrySafe: false };
  }
  async prepare(input: Parameters<TonGateway['prepare']>[0]): Promise<PreparedMint> {
    return this.mutex.run(async () => {
      assert.equal(input.jobId, this.state.claim?.jobId, 'Only the website-created authorized job may be prepared');
      assert.equal(input.itemIndex, this.state.itemIndex);
      assert(Address.parse(input.recipient).equals(Address.parse(this.state.recipient)));
      assert(!this.state.messageHash && !this.state.sendAttempted, 'Automatic re-signing is forbidden');
      const prepared = await this.options.gateway.prepare(input);
      const cell = Cell.fromBase64(prepared.signedBoc);
      assert.equal(cell.hash().toString('hex'), prepared.messageHash);
      const message = loadMessage(cell.beginParse());
      assert(message.info.type === 'external-in' && message.info.dest.equals(Address.parse(this.state.walletAddress)));
      assert.equal(message.body.refs.length, 1);
      const transfer = loadMessageRelaxed(message.body.refs[0]!.beginParse());
      assert(transfer.info.type === 'internal' && transfer.info.dest.equals(Address.parse(this.state.collectionAddress)));
      assert.equal(transfer.info.value.coins, toNano('0.12'));
      const body = transfer.body.beginParse();
      assert.equal(body.loadUint(32), 1); body.loadUintBig(64);
      assert.equal(body.loadUintBig(64), BigInt(this.state.itemIndex));
      assert.equal(body.loadCoins(), toNano('0.08'));
      const item = body.loadRef().beginParse();
      assert(item.loadAddress().equals(Address.parse(this.state.recipient)));
      const sourceFees = await this.options.estimateSourceFees(message);
      assert(sourceFees >= 0n);
      const reserved = toNano('0.12') + sourceFees * 2n + toNano('0.01');
      assert(reserved <= toNano(this.state.maxSpendTon) && await this.options.balance() >= reserved, 'Approved budget or balance insufficient');
      await this.save({ ...this.state, messageHash: prepared.messageHash, reservedTon: fromNano(reserved) });
      return prepared;
    });
  }
  async send(prepared: PreparedMint): Promise<void> {
    await this.mutex.run(async () => {
      assert(!this.state.sendAttempted && this.state.claim && this.state.reservedTon);
      assert.equal(prepared.messageHash, this.state.messageHash);
      assert.equal(Cell.fromBase64(prepared.signedBoc).hash().toString('hex'), this.state.messageHash);
      assert(prepared.deadline > Math.floor(Date.now() / 1000));
      // Exclusive durable marker: even a crash/timeout or a restarted instance cannot send twice.
      const marker = await open(`${this.options.statePath}.sent`, 'wx', 0o600);
      try { await marker.writeFile(prepared.messageHash + '\n'); await marker.sync(); }
      finally { await marker.close(); }
      await syncDirectory(dirname(this.options.statePath));
      await this.save({ ...this.state, sendAttempted: true });
      await this.options.gateway.send(prepared);
    });
  }
  private async save(state: State): Promise<void> {
    const path = `${this.options.statePath}.${randomUUID()}.tmp`;
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(path, this.options.statePath);
    this.state = state;
    await syncDirectory(dirname(this.options.statePath));
  }
}
export function sourceFeeTotal(fees: { in_fwd_fee: number; storage_fee: number; gas_fee: number; fwd_fee: number }): bigint {
  return [fees.in_fwd_fee, fees.storage_fee, fees.gas_fee, fees.fwd_fee].reduce((sum, value) => {
    assert(Number.isSafeInteger(value) && value >= 0);
    return sum + BigInt(value);
  }, 0n);
}
async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
