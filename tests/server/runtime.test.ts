import { afterEach, expect, it, vi } from 'vitest';
import { configuredGateway } from '../../apps/server/src/runtime.js';
import { RealTonGateway } from '../../contracts/service/ton-gateway.js';
import { TestnetRpc } from '../../contracts/service/rpc.js';

const walletAddress = `0:${'1'.repeat(64)}`;
const collectionAddress = `0:${'2'.repeat(64)}`;
afterEach(() => vi.restoreAllMocks());

it('disabled startup does not access a wallet or RPC, and one flag cannot enable dispatch', async () => {
  const wallet = vi.spyOn(RealTonGateway.prototype, 'walletAddress').mockResolvedValue(walletAddress);
  const rpc = vi.spyOn(TestnetRpc.prototype, 'call').mockRejectedValue(new Error('No network in runtime tests'));
  expect(await configuredGateway({ dbPath: ':memory:' }, {})).toBeUndefined();
  await expect(configuredGateway({ dbPath: ':memory:', mintingEnabled: true }, {})).rejects.toThrow('both');
  await expect(configuredGateway({ dbPath: ':memory:', mintingEnabled: true }, { TON_MINTING_ENABLED: 'true' })).rejects.toThrow('addresses');
  expect(wallet).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it('configured composition validates wallet identity and never calls a network or send', async () => {
  const wallet = vi.spyOn(RealTonGateway.prototype, 'walletAddress').mockResolvedValue(walletAddress);
  const rpc = vi.spyOn(TestnetRpc.prototype, 'call').mockRejectedValue(new Error('No network in runtime tests'));
  const send = vi.spyOn(RealTonGateway.prototype, 'send').mockRejectedValue(new Error('No send in runtime tests'));
  const options = { dbPath: ':memory:', mintingEnabled: true, collectionAddress, walletAddress };
  const env = { TON_MINTING_ENABLED: 'true' };
  expect(await configuredGateway(options, env)).toBeInstanceOf(RealTonGateway);
  wallet.mockResolvedValue(`0:${'3'.repeat(64)}`);
  await expect(configuredGateway(options, env)).rejects.toThrow('does not match');
  await expect(configuredGateway(options, { ...env, TON_RPC_URL: 'https://toncenter.com/api/v2/jsonRPC' })).rejects.toThrow('Only');
  expect(rpc).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
