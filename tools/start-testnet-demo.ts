import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { startServer } from '../apps/server/src/index.js';
import { RealTonGateway } from '../contracts/service/ton-gateway.js';
import { WALLET_SECRET_PATH } from '../contracts/service/wallet.js';

/** Regular website queue, explicitly enabled by the operator for TON testnet only. */
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--user-enabled-testnet', '--no-demo-caps']);
  assert(process.env.MINTING_ENABLED === 'true' && process.env.TON_MINTING_ENABLED === 'true');
  const collectionAddress = 'kQCNTqqdTbNus0PF8utf_031cWYG6hGlRJ1NAcM02nsUwAIs';
  const walletAddress = '0QBmbGbnCIpGtv8OfOp_PopUS352-WCo8DZx0YJgng3nd7JF';
  const gateway = new RealTonGateway({ collectionAddress, walletSecretPath: WALLET_SECRET_PATH });
  assert(Address.parse(await gateway.walletAddress()).equals(Address.parse(walletAddress)), 'Wallet mismatch');
  await gateway.nextIndex();
  await startServer({ gateway, collectionAddress, walletAddress, mintingEnabled: true, startWorker: true });
  console.info('Regular TON testnet website queue enabled: no per-run NFT count, fixed-recipient or spending cap. No mint request is created by this launcher. Authentication, owned rewards, recipient confirmation, idempotency and chain verification remain active.');
}
main().catch(() => { console.error('Testnet website startup failed; internal configuration and wallet details withheld.'); process.exitCode = 1; });
