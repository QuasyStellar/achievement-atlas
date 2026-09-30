import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Address, beginCell, Cell, external, fromNano, internal, SendMode, storeMessage, toNano } from '@ton/core';
import { compileContracts } from '../contracts/compile.js';
import { NftCollection } from '../contracts/wrappers.js';
import { TestnetRpc, TESTNET_RPC_URL } from '../contracts/service/rpc.js';
import { readWallet, WALLET_SECRET_PATH } from '../contracts/service/wallet.js';
import { serializedMessageHash, transactionSucceeded } from '../contracts/service/ton-gateway.js';

const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const { wallet, secretKey } = await readWallet();
const code = await compileContracts();
const collection = NftCollection.create(wallet.address, code.collection, code.item);
const plan = { network: 'testnet', rpc: TESTNET_RPC_URL, walletAddress: wallet.address.toString({ testOnly: true, bounceable: false }), collectionAddress: collection.address.toString({ testOnly: true }), transferTon: '0.12', secretPath: WALLET_SECRET_PATH };
if (args.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const spend = option('--max-spend');
  const expectedWallet = option('--wallet-address');
  const expectedCollection = option('--collection-address');
  if (!args.includes('--confirm-testnet') || !spend || !expectedWallet || !expectedCollection) throw new Error('No send: use --plan first. Sending requires --confirm-testnet --wallet-address ADDRESS --collection-address ADDRESS --max-spend TON after explicit user approval.');
  if (!wallet.address.equals(Address.parse(expectedWallet)) || !collection.address.equals(Address.parse(expectedCollection))) throw new Error('Confirmed address does not match deployment plan');
  if (!/^\d+(\.\d{1,9})?$/.test(spend)) throw new Error('Invalid spending limit');
  const budget = toNano(spend);
  if (budget > toNano('0.5') || budget < toNano('0.13')) throw new Error('Testnet deployment budget must be between 0.13 and 0.5 TON');
  const rpc = new TestnetRpc({ apiKey: process.env.TONCENTER_API_KEY });
  await rpc.assertTestnet();
  const existing = await rpc.call(client => client.getContractState(collection.address));
  if (existing.state === 'active') throw new Error('Collection already deployed. Use verify:testnet; never resend initialization.');
  const walletState = await rpc.call(client => client.getContractState(wallet.address));
  if (walletState.state === 'frozen') throw new Error('Wallet frozen');
  const seqno = walletState.state === 'active' ? (await rpc.call(client => client.runMethod(wallet.address, 'seqno'))).stack.readNumber() : 0;
  const body = wallet.createTransfer({ seqno, secretKey, timeout: Math.floor(Date.now() / 1000) + 300, sendMode: SendMode.NONE, messages: [internal({ to: collection.address, value: toNano('0.12'), bounce: false, init: collection.init, body: beginCell().endCell() })] });
  const message = beginCell().store(storeMessage(external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body }))).endCell();
  const fees = await rpc.call(client => client.estimateExternalMessageFee(wallet.address, { body, initCode: seqno === 0 ? wallet.init.code : null, initData: seqno === 0 ? wallet.init.data : null, ignoreSignature: false }));
  const sourceFees = Object.values(fees.source_fees).filter(value => typeof value === 'number').reduce((sum, value) => sum + BigInt(value), 0n);
  const reserved = toNano('0.12') + sourceFees * 2n + toNano('0.01');
  if (reserved > budget || walletState.balance < reserved) throw new Error(`Budget/balance insufficient; conservative reservation ${fromNano(reserved)} TON`);
  console.log(JSON.stringify({ ...plan, maxSpendTon: spend, reservedTon: fromNano(reserved), externalMessageHash: message.hash().toString('hex') }));
  // Exactly one send. Timeout is ambiguous: do not resend; inspect chain history.
  await rpc.call(client => client.sendFile(message.toBoc()), false);
  let transactionHash: string | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
    const state = await rpc.call(client => client.getContractState(collection.address));
    if (state.state !== 'active') continue;
    if (!state.code || !Cell.fromBoc(state.code)[0]!.equals(code.collection)) throw new Error('Deployed code mismatch');
    const { stack } = await rpc.call(client => client.runMethod(collection.address, 'get_collection_data'));
    const index = stack.readNumber(); stack.readCell();
    if (index !== 0 || !stack.readAddress().equals(wallet.address)) throw new Error('Unexpected deployed collection getters');
    const walletTransactions = await rpc.call(client => client.getTransactions(wallet.address, { limit: 100, archival: true }));
    const walletTx = walletTransactions.find(tx => tx.inMessage?.info.type === 'external-in' && serializedMessageHash(tx.inMessage) === message.hash().toString('hex') && transactionSucceeded(tx));
    const outgoing = walletTx && Array.from(walletTx.outMessages.values()).find(msg => msg.info.type === 'internal' && msg.info.dest.equals(collection.address));
    if (!outgoing || outgoing.info.type !== 'internal') continue;
    const lt = outgoing.info.createdLt;
    const transactions = await rpc.call(client => client.getTransactions(collection.address, { limit: 100, archival: true }));
    const tx = transactions.find(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(wallet.address) && tx.inMessage.info.createdLt === lt && tx.inMessage.body.equals(outgoing.body) && transactionSucceeded(tx));
    if (tx) { transactionHash = tx.hash().toString('hex'); break; }
  }
  if (!transactionHash) throw new Error('Deployment unconfirmed. No deployment record written; reconcile on-chain before any resend.');
  const directory = fileURLToPath(new URL('../contracts/deployments/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const record = { network: 'testnet', rpc: TESTNET_RPC_URL, collectionAddress: collection.address.toRawString(), walletAddress: wallet.address.toRawString(), transactionHash, codeHash: code.collection.hash().toString('hex'), itemCodeHash: code.item.hash().toString('hex'), sourceCommit: '0b493104cd547d0fd52b7e6fd3c046fc365fe3d4', confirmedAt: new Date().toISOString() };
  await writeFile(directory + 'testnet.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(record, null, 2));
}
