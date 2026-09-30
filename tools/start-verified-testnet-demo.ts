import { Address } from '@ton/core';
import { startServer } from '../apps/server/src/index.js';
import { RealTonGateway, type TonGateway } from '../contracts/service/ton-gateway.js';
import { WALLET_SECRET_PATH } from '../contracts/service/wallet.js';

async function main() {
  const collectionAddress = 'kQCNTqqdTbNus0PF8utf_031cWYG6hGlRJ1NAcM02nsUwAIs';
  const walletAddress = '0QBmbGbnCIpGtv8OfOp_PopUS352-WCo8DZx0YJgng3nd7JF';
  const real = new RealTonGateway({ collectionAddress, walletSecretPath: WALLET_SECRET_PATH });
  if (!Address.parse(await real.walletAddress()).equals(Address.parse(walletAddress))) throw new Error('Wallet mismatch');
  await real.nextIndex();
  const gateway: TonGateway = {
    nextIndex: () => real.nextIndex(),
    inspect: input => real.inspect(input),
    prepare: async () => { throw new Error('Additional mint requires separate approval'); },
    send: async () => { throw new Error('Additional send requires separate approval'); },
  };
  await startServer({ gateway, collectionAddress, walletAddress, mintingEnabled: false, startWorker: false });
}
main().catch(() => { console.error('Verified testnet demo startup failed; internal details withheld.'); process.exitCode = 1; });
