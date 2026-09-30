import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Address, Cell } from '@ton/core';
import { compileContracts } from '../contracts/compile.js';
import { decodeMetadata } from '../contracts/metadata.js';
import { RealTonGateway, transactionSucceeded } from '../contracts/service/ton-gateway.js';
import { TestnetRpc } from '../contracts/service/rpc.js';
import { WALLET_SECRET_PATH } from '../contracts/service/wallet.js';

const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
let deployment: { network: string; collectionAddress: string; walletAddress: string; transactionHash: string } | undefined;
try { deployment = JSON.parse(await readFile(fileURLToPath(new URL('../contracts/deployments/testnet.json', import.meta.url)), 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (deployment && deployment.network !== 'testnet') throw new Error('Non-testnet deployment rejected');
const collectionAddress = option('--collection') ?? deployment?.collectionAddress;
if (!collectionAddress) throw new Error('No confirmed deployment; specify --collection ADDRESS for read-only verification');
const gateway = new RealTonGateway({ collectionAddress, walletSecretPath: WALLET_SECRET_PATH, apiKey: process.env.TONCENTER_API_KEY });
const nextIndex = await gateway.nextIndex(); // verifies collection code, item code, owner, testnet endpoint
const rpc = new TestnetRpc({ apiKey: process.env.TONCENTER_API_KEY });
await rpc.assertTestnet();
const collection = Address.parse(collectionAddress);
const { stack } = await rpc.call(client => client.runMethod(collection, 'get_collection_data'));
stack.readNumber();
const metadata = decodeMetadata(stack.readCell());
const owner = stack.readAddress();
const output: Record<string, unknown> = { network: 'testnet', collectionAddress: collection.toRawString(), walletAddress: owner.toRawString(), nextIndex, metadata, deploymentTransactionVerified: false };
if (deployment && collection.equals(Address.parse(deployment.collectionAddress))) {
  const transactions = await rpc.call(client => client.getTransactions(collection, { limit: 100, archival: true }));
  output.deploymentTransactionVerified = transactions.some(tx => tx.hash().toString('hex') === deployment.transactionHash && transactionSucceeded(tx) && tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(Address.parse(deployment!.walletAddress)));
  output.transactionHash = deployment.transactionHash;
  if (!output.deploymentTransactionVerified) output.warning = 'Recorded transaction not found in bounded history; not independently re-confirmed';
}
const indexText = option('--item');
if (indexText !== undefined) {
  if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(Number(indexText))) throw new Error('Invalid item index');
  const index = Number(indexText);
  const { stack: addressStack } = await rpc.call(client => client.runMethod(collection, 'get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]));
  const address = addressStack.readAddress();
  const state = await rpc.call(client => client.getContractState(address));
  const code = await compileContracts();
  if (state.state !== 'active' || !state.code || !Cell.fromBoc(state.code)[0]!.equals(code.item)) throw new Error('NFT not active or code mismatch');
  const { stack: itemStack } = await rpc.call(client => client.runMethod(address, 'get_nft_data'));
  const initialized = itemStack.readBoolean();
  const itemIndex = itemStack.readNumber();
  const itemCollection = itemStack.readAddress();
  const itemOwner = itemStack.readAddressOpt();
  const content = itemStack.readCellOpt();
  if (!initialized || itemIndex !== index || !itemCollection.equals(collection) || !itemOwner || !content) throw new Error('Item getters mismatch');
  const recipient = option('--recipient');
  if (recipient && !itemOwner.equals(Address.parse(recipient))) throw new Error('Item owner does not match recipient');
  const { stack: contentStack } = await rpc.call(client => client.runMethod(collection, 'get_nft_content', [{ type: 'int', value: BigInt(index) }, { type: 'cell', cell: content }]));
  if (!contentStack.readCell().equals(content)) throw new Error('Metadata getter mismatch');
  output.item = { address: address.toRawString(), initialized, index: itemIndex, collectionAddress: itemCollection.toRawString(), owner: itemOwner.toRawString(), metadata: decodeMetadata(content), note: 'Getter verification alone is not confirmation of a particular mint job' };
}
console.log(JSON.stringify(output, null, 2));
