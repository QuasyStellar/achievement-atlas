import { mkdir, open, readFile, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address } from '@ton/core';
import { createHash } from 'node:crypto';
import { Mutex } from './mutex.js';
import type { Storage } from './ports/storage.js';
import type { TonGateway, PreparedMint } from './ports/ton-gateway.js';
import type { MintRow } from './service.js';
import { ACHIEVEMENTS } from '../domain/achievements.js';

export interface MintWorkerOptions {
  gateway: TonGateway; collectionAddress: string; walletAddress: string;
  intervalMs?: number;
}
function sameAddress(a: string, b: string): boolean {
  try { return Address.parse(a).equals(Address.parse(b)); } catch { return false; }
}
/** One sequential wallet dispatcher. Persist exact signed envelope BEFORE any network send. */
export class MintWorker {
  private readonly mutex = new Mutex();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private lock: FileHandle | undefined;
  private running = false;
  private readonly lockPath: string;
  constructor(private readonly db: Storage, private readonly options: MintWorkerOptions) {
    this.lockPath = join(tmpdir(), `achievement-atlas-wallet-${createHash('sha256').update(Address.parse(options.walletAddress).toRawString()).digest('hex')}.lock`);
  }
  private async acquireLock(): Promise<void> {
    if (this.lock || this.db.path === ':memory:') return;
    // Serialize stale-PID recovery as well as creation. Otherwise two recovering
    // processes could unlink each other's newly created lock after a crash.
    const recoveryPath = `${this.lockPath}.recovery`;
    try { await mkdir(recoveryPath, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Mint wallet locked during recovery; stale recovery directory requires operator inspection');
      throw error;
    }
    try {
      try {
        this.lock = await open(this.lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await readFile(this.lockPath, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Mint wallet lock requires operator recovery');
        let dead = false;
        try { process.kill(pid, 0); } catch (check) { dead = (check as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('Mint wallet already locked by another process');
        await unlink(this.lockPath);
        this.lock = await open(this.lockPath, 'wx', 0o600);
      }
      await this.lock.writeFile(String(process.pid));
    } finally { await rmdir(recoveryPath); }
  }
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    await this.acquireLock();
    const run = () => { if (!this.running && !this.stopping) void this.tick().catch(() => { console.error('Mint worker tick failed; dispatch paused until reconciliation retry.'); }); };
    this.timer = setInterval(run, this.options.intervalMs ?? 5000);
    this.timer.unref();
    run();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.mutex.run(async () => {
      if (this.lock) { await this.lock.close(); this.lock = undefined; await unlink(this.lockPath); }
    });
  }
  async tick(): Promise<void> {
    if (this.stopping || this.running) return;
    this.running = true;
    try {
      await this.mutex.run(async () => {
        await this.acquireLock();
        let job = await this.db.read(c => c.get<MintRow>(
          `SELECT * FROM mint_jobs WHERE status IN ('pending','submitted') OR (status='failed' AND item_index IS NOT NULL) ORDER BY CASE WHEN item_index IS NOT NULL THEN 0 ELSE 1 END,item_index,created_at,rowid LIMIT 1`
        ));
        if (!job || job.status === 'failed') return; // Never leap over an unissued stable index.
        if (job.message_hash && job.item_index !== null) {
          let inspection;
          try {
            if (job.deadline === null || job.wallet_seqno === null) throw new Error('Missing durable envelope');
            inspection = await this.options.gateway.inspect({ itemIndex: job.item_index, recipient: job.recipient, messageHash: job.message_hash, deadline: job.deadline, walletSeqno: job.wallet_seqno });
          }
          catch { await this.setError(job.id, 'RECONCILIATION_UNAVAILABLE'); return; }
          if (inspection.status === 'confirmed') {
            if (inspection.initialized !== true || inspection.itemIndex !== job.item_index || !sameAddress(inspection.owner, job.recipient)
              || !sameAddress(inspection.collectionAddress, this.options.collectionAddress) || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(inspection.transactionHash)
              || !isAddress(inspection.itemAddress)) {
              await this.setError(job.id, 'CHAIN_STATE_MISMATCH'); return;
            }
            await this.db.transaction(c => c.run('UPDATE mint_jobs SET status=\'confirmed\',item_address=?,transaction_hash=?,error=NULL,updated_at=? WHERE id=?',
              [inspection.itemAddress, inspection.transactionHash, new Date().toISOString(), job!.id]));
            return;
          }
          // A transport timeout or elapsed deadline alone is NOT evidence of failure.
          if (inspection.status !== 'absent' || !inspection.retrySafe || job.deadline === null || job.deadline > Math.floor(Date.now() / 1000)) return;
          const chainIndex = await this.options.gateway.nextIndex();
          if (chainIndex !== job.item_index) { await this.setError(job.id, 'CHAIN_INDEX_UNCERTAIN'); return; }
          await this.db.transaction(c => c.run('UPDATE mint_jobs SET status=\'pending\',signed_boc=NULL,message_hash=NULL,wallet_seqno=NULL,deadline=NULL,error=NULL,updated_at=? WHERE id=?', [new Date().toISOString(), job!.id]));
          job = { ...job, status: 'pending', signed_boc: null, message_hash: null, wallet_seqno: null, deadline: null };
        }
        if (job.item_index === null) {
          const nextIndex = await this.options.gateway.nextIndex();
          if (!Number.isSafeInteger(nextIndex) || nextIndex < 0) throw new Error('Invalid collection next index');
          const last = await this.db.read(c => c.get<{ highest: number | null }>('SELECT MAX(item_index) AS highest FROM mint_jobs'));
          // Only allocate provider's actual next index: no holes or imaginary collection state.
          if (last?.highest !== null && last?.highest !== undefined && nextIndex <= last.highest) return;
          await this.db.transaction(c => c.run('UPDATE mint_jobs SET item_index=?,updated_at=? WHERE id=?', [nextIndex, new Date().toISOString(), job!.id]));
          job.item_index = nextIndex;
        }
        const actualNextIndex = await this.options.gateway.nextIndex();
        if (actualNextIndex !== job.item_index) { await this.setError(job.id, 'CHAIN_INDEX_UNCERTAIN'); return; }
        let prepared: PreparedMint;
        try {
          const unlock = await this.db.read(c => c.get<{ achievement_id: string }>('SELECT achievement_id FROM unlocks WHERE id=?', [job!.unlock_id]));
          const definition = ACHIEVEMENTS.find(a => a.id === unlock?.achievement_id);
          if (!definition) throw new Error('Unknown achievement');
          prepared = await this.options.gateway.prepare({ jobId: job.id, itemIndex: job.item_index, recipient: job.recipient,
            metadata: { name: definition.title, description: `${definition.description} Achievement Atlas · TON testnet.` } });
          if (!prepared.signedBoc || !/^[a-fA-F0-9]{64}$/.test(prepared.messageHash) || !Number.isSafeInteger(prepared.walletSeqno)
            || prepared.walletSeqno < 0 || !Number.isSafeInteger(prepared.deadline) || prepared.deadline <= Math.floor(Date.now() / 1000)) throw new Error('Invalid prepared message');
        } catch { await this.db.transaction(c => c.run('UPDATE mint_jobs SET status=\'failed\',error=\'PREPARATION_FAILED\',updated_at=? WHERE id=?', [new Date().toISOString(), job!.id])); return; }
        await this.db.transaction(c => c.run(
          'UPDATE mint_jobs SET status=\'submitted\',signed_boc=?,message_hash=?,wallet_seqno=?,deadline=?,error=NULL,updated_at=? WHERE id=?',
          [prepared.signedBoc, prepared.messageHash, prepared.walletSeqno, prepared.deadline, new Date().toISOString(), job!.id]
        ));
        try { await this.options.gateway.send(prepared); }
        catch { await this.setError(job.id, 'SUBMISSION_UNCERTAIN'); }
      });
    } finally { this.running = false; }
  }
  private async setError(id: string, code: string): Promise<void> {
    await this.db.transaction(c => c.run('UPDATE mint_jobs SET error=?,updated_at=? WHERE id=?', [code, new Date().toISOString(), id]));
  }
}
function isAddress(value: string): boolean { try { Address.parse(value); return true; } catch { return false; } }
