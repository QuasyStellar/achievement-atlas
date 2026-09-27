import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Blockchain } from '@ton/sandbox';
import { Address, Cell, loadMessage, toNano, type Transaction, type TupleItem } from '@ton/core';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4, type TonClient } from '@ton/ton';
import { compileContracts } from '../compile.js';
import { NftCollection, NftItem } from '../wrappers.js';
import { RealTonGateway } from '../service/ton-gateway.js';
import { TestnetRpc } from '../service/rpc.js';

let directory: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

it('real adapter signs without sending, confirms actual traced Sandbox transaction, reconciles expiry conservatively', async () => {
  const chain = await Blockchain.create();
  chain.now = Math.floor(Date.now() / 1000);
  const mnemonic = await mnemonicNew();
  const keys = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
  directory = await mkdtemp(join(tmpdir(), 'atlas-ton-'));
  const path = join(directory, 'wallet.json');
  await writeFile(path, JSON.stringify({ network: 'testnet', mnemonic, publicKey: keys.publicKey.toString('hex'), secretKey: keys.secretKey.toString('hex'), address: wallet.address.toRawString() }), { mode: 0o600 });
  const treasury = await chain.treasury('funding');
  const recipient = await chain.treasury('recipient');
  await treasury.send({ to: wallet.address, value: toNano('1'), bounce: false });
  const code = await compileContracts();
  const collection = chain.openContract(NftCollection.create(wallet.address, code.collection, code.item));
  // Sandbox-only spoofed internal sender deploys the fixture. No public network.
  await collection.sendDeploy({ address: wallet.address, send: async input => { await chain.sendMessage({ info: { type: 'internal', ihrDisabled: true, bounce: false, bounced: false, src: wallet.address, dest: input.to, value: { coins: input.value }, ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: chain.now! }, init: input.init, body: input.body! }); } });
  let sends = 0;
  let hideHistory = false;
  const transactions: Transaction[] = [];
  const fakeClient = {
    getMasterchainInfo: async () => ({ workchain: -1, latestSeqno: 1 }),
    getContractState: async (address: Address) => {
      const contract = await chain.getContract(address);
      const state = contract.accountState;
      return { state: state?.type === 'active' ? 'active' : state?.type === 'frozen' ? 'frozen' : 'uninitialized', code: state?.type === 'active' ? state.state.code?.toBoc() : null, data: state?.type === 'active' ? state.state.data?.toBoc() : null, balance: contract.balance, timestampt: chain.now };
    },
    runMethod: async (address: Address, name: string, stack: TupleItem[] = []) => ({ stack: (await chain.runGetMethod(address, name, stack)).stackReader }),
    getTransactions: async (address: Address) => hideHistory ? [] : transactions.filter(tx => tx.address === BigInt('0x' + address.hash.toString('hex'))),
    sendFile: async (boc: Buffer) => { sends++; transactions.push(...(await chain.sendMessage(loadMessage(Cell.fromBoc(boc)[0]!.beginParse()))).transactions); },
  };
  vi.spyOn(TestnetRpc.prototype, 'call').mockImplementation(operation => operation(fakeClient as unknown as TonClient));
  const gateway = new RealTonGateway({ collectionAddress: collection.address.toRawString(), walletSecretPath: path });
  expect(await gateway.nextIndex()).toBe(0);
  const prepared = await gateway.prepare({ jobId: 'mint-1', itemIndex: 0, recipient: recipient.address.toRawString(), metadata: { name: 'First win', description: 'Achievement without personal information' } });
  expect(sends).toBe(0);
  const input = { itemIndex: 0, recipient: recipient.address.toRawString(), ...prepared };
  vi.stubEnv('TON_MINTING_ENABLED', 'false');
  await expect(gateway.send(prepared)).rejects.toThrow('TON_MINTING_ENABLED');
  expect(sends).toBe(0);
  vi.stubEnv('TON_MINTING_ENABLED', 'true');
  await gateway.send(prepared);
  expect(sends).toBe(1);
  const confirmed = await gateway.inspect(input);
  expect(confirmed.status).toBe('confirmed');
  if (confirmed.status !== 'confirmed') throw new Error('Expected traced Sandbox confirmation');
  expect(confirmed.transactionHash).not.toBe(prepared.messageHash);
  expect(transactions.some(tx => tx.hash().toString('hex') === confirmed.transactionHash)).toBe(true);
  hideHistory = true;
  expect(await gateway.inspect(input)).toEqual({ status: 'pending', retrySafe: false });
  hideHistory = false;
  const absent = await gateway.prepare({ jobId: 'mint-2', itemIndex: 1, recipient: recipient.address.toRawString(), metadata: { name: 'Second', description: '' } });
  const absentInput = { itemIndex: 1, recipient: recipient.address.toRawString(), ...absent };
  expect(await gateway.inspect(absentInput)).toEqual({ status: 'pending', retrySafe: false });
  chain.now = absent.deadline + 31;
  expect(await gateway.inspect(absentInput)).toEqual({ status: 'absent', retrySafe: true });
  expect(await gateway.inspect({ ...absentInput, walletSeqno: absent.walletSeqno - 1 })).toEqual({ status: 'pending', retrySafe: false });
  const item = chain.openContract(new NftItem(Address.parse(confirmed.itemAddress)));
  await item.sendTransfer(recipient.getSender(), treasury.address);
  await expect(gateway.inspect(input)).rejects.toThrow('conflicts');
}, 60_000);

it('rejects all non-official and mainnet RPC endpoints', () => {
  expect(() => new TestnetRpc({ rpcUrl: 'https://toncenter.com/api/v2/jsonRPC' })).toThrow('Only');
  expect(() => new TestnetRpc({ rpcUrl: 'http://testnet.toncenter.com/api/v2/jsonRPC' })).toThrow('Only');
});
