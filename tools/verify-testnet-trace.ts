import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Address } from '@ton/core';
import { TestnetRpc } from '../contracts/service/rpc.js';
import { serializedMessageHash, transactionSucceeded } from '../contracts/service/ton-gateway.js';

async function main() {
  const mint = JSON.parse(await readFile(new URL('../docs/evidence/testnet-mint-once.json', import.meta.url), 'utf8')) as {
    walletAddress: string; collectionAddress: string; recipient: string; mint: { itemAddress: string; transactionHash: string; itemIndex: number };
  };
  const reservation = JSON.parse(await readFile(new URL('../docs/evidence/testnet-mint-reservation.json', import.meta.url), 'utf8')) as { messageHash: string };
  const wallet = Address.parse(mint.walletAddress);
  const collection = Address.parse(mint.collectionAddress);
  const item = Address.parse(mint.mint.itemAddress);
  const rpc = new TestnetRpc();
  await rpc.assertTestnet();
  const walletTxs = await rpc.call(client => client.getTransactions(wallet, { limit: 100, archival: true }));
  const walletTx = walletTxs.find(tx => tx.inMessage?.info.type === 'external-in' && serializedMessageHash(tx.inMessage) === reservation.messageHash && transactionSucceeded(tx));
  assert(walletTx);
  const outgoing = Array.from(walletTx.outMessages.values()).find(message => message.info.type === 'internal' && message.info.dest.equals(collection));
  assert(outgoing?.info.type === 'internal');
  const outgoingCreatedLt = outgoing.info.createdLt;
  const collectionTxs = await rpc.call(client => client.getTransactions(collection, { limit: 100, archival: true }));
  const collectionTx = collectionTxs.find(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(wallet)
    && tx.inMessage.info.createdLt === outgoingCreatedLt && tx.inMessage.body.equals(outgoing.body) && transactionSucceeded(tx));
  assert(collectionTx);
  const initialization = Array.from(collectionTx.outMessages.values()).find(message => message.info.type === 'internal' && message.info.dest.equals(item));
  assert(initialization?.info.type === 'internal');
  const initializationCreatedLt = initialization.info.createdLt;
  const body = initialization.body.beginParse();
  assert(body.loadAddress().equals(Address.parse(mint.recipient)));
  const content = body.loadRef();
  const itemTxs = await rpc.call(client => client.getTransactions(item, { limit: 100, archival: true }));
  const itemTx = itemTxs.find(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(collection)
    && tx.inMessage.info.createdLt === initializationCreatedLt && tx.inMessage.body.equals(initialization.body) && transactionSucceeded(tx));
  assert(itemTx && itemTx.hash().toString('hex') === mint.mint.transactionHash);
  const { stack } = await rpc.call(client => client.runMethod(item, 'get_nft_data'));
  assert(stack.readBoolean());
  assert.equal(stack.readNumber(), mint.mint.itemIndex);
  assert(stack.readAddress().equals(collection));
  assert(stack.readAddress().equals(Address.parse(mint.recipient)));
  assert(stack.readCell().equals(content));
  const records = [
    { stage: 'wallet', address: wallet.toString({ testOnly: true, bounceable: false }), transactionHash: walletTx.hash().toString('hex'), lt: walletTx.lt.toString(), successful: true },
    { stage: 'collection', address: collection.toString({ testOnly: true }), transactionHash: collectionTx.hash().toString('hex'), lt: collectionTx.lt.toString(), successful: true },
    { stage: 'item', address: item.toString({ testOnly: true }), transactionHash: itemTx.hash().toString('hex'), lt: itemTx.lt.toString(), successful: true },
  ];
  const evidence = { checkedAt: new Date().toISOString(), network: 'testnet', itemIndex: mint.mint.itemIndex,
    messageHash: reservation.messageHash, traceVerified: true, initialized: true, expectedOwnerVerified: true, metadataCellVerified: true,
    transactions: records, itemExplorerUrl: `https://testnet.tonviewer.com/${records[2]!.address}` };
  await writeFile(new URL('../docs/evidence/testnet-mint-trace.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.info(JSON.stringify(evidence, null, 2));
}
main().catch(() => { console.error('Read-only trace verification failed; no transaction sent, internal details withheld.'); process.exitCode = 1; });
