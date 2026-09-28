import { Address } from '@ton/core';
import { RealTonGateway } from '../../../contracts/service/ton-gateway.js';
import { WALLET_SECRET_PATH } from '../../../contracts/service/wallet.js';
import type { AppOptions } from './app.js';

/** Disabled by default. Enabling dispatch requires separate, explicit TON approval. */
export async function configuredGateway(options: AppOptions, env: NodeJS.ProcessEnv = process.env) {
  if (options.gateway || !options.mintingEnabled) return options.gateway;
  if (env.TON_MINTING_ENABLED !== 'true') throw new Error('Real minting requires both MINTING_ENABLED and TON_MINTING_ENABLED after testnet/address/spend approval');
  if (!options.collectionAddress || !options.walletAddress) throw new Error('Minting requires configured collection and wallet addresses');
  const wallet = Address.parse(options.walletAddress);
  if (wallet.workChain !== 0) throw new Error('Mint wallet must be in workchain 0');
  const gateway = new RealTonGateway({
    collectionAddress: options.collectionAddress,
    walletSecretPath: env.TON_WALLET_SECRET_PATH ?? WALLET_SECRET_PATH,
    rpcUrl: env.TON_RPC_URL,
    apiKey: env.TONCENTER_API_KEY,
  });
  if (!wallet.equals(Address.parse(await gateway.walletAddress()))) throw new Error('Configured wallet does not match the private wallet file');
  return gateway;
}
