import { createHash } from 'node:crypto';
import { Address, beginCell, Cell, contractAddress, external, internal, loadMessage, SendMode, storeMessage, toNano, type Transaction } from '@ton/core';
import { compileContracts } from '../compile.js';
import { mintBody } from '../wrappers.js';
import { TestnetRpc } from './rpc.js';
import { readWallet } from './wallet.js';

export interface PreparedMint { signedBoc: string; messageHash: string; walletSeqno: number; deadline: number }
export type MintInspection = { status: 'confirmed'; itemAddress: string; transactionHash: string; owner: string; collectionAddress: string; itemIndex: number; initialized: true } | { status: 'pending' | 'absent'; retrySafe: boolean };
export interface TonGateway {
  nextIndex(): Promise<number>;
  prepare(input: { jobId: string; itemIndex: number; recipient: string; metadata: { name: string; description: string; imageData?: string } }): Promise<PreparedMint>;
  send(prepared: PreparedMint): Promise<void>;
  inspect(input: { itemIndex: number; recipient: string; messageHash: string; deadline: number; walletSeqno: number }): Promise<MintInspection>;
}
class ChainConflict extends Error {}
export function transactionSucceeded(tx: Transaction): boolean {
  return tx.description.type === 'generic' && !tx.description.aborted && tx.description.computePhase.type === 'vm' && tx.description.computePhase.success && (tx.description.actionPhase == null || tx.description.actionPhase.success);
}
export function serializedMessageHash(message: NonNullable<Transaction['inMessage']>): string {
  return beginCell().store(storeMessage(message)).endCell().hash().toString('hex');
}
const pending = (): MintInspection => ({ status: 'pending', retrySafe: false });

/** Real RPC adapter. One durable worker owns this wallet's seqno. Never expose signedBoc in HTTP. */
export class RealTonGateway implements TonGateway {
  readonly collectionAddress: string;
  private readonly collection: Address;
  private readonly rpc: TestnetRpc;
  private readonly secretPath: string;
  private codePromise?: ReturnType<typeof compileContracts>;
  constructor(options: { collectionAddress: string; walletSecretPath: string; rpcUrl?: string; apiKey?: string }) {
    this.collection = Address.parse(options.collectionAddress);
    if (this.collection.workChain !== 0) throw new Error('Collection must be in workchain 0');
    this.collectionAddress = this.collection.toRawString();
    this.secretPath = options.walletSecretPath;
    this.rpc = new TestnetRpc(options);
  }
  async walletAddress(): Promise<string> { return (await readWallet(this.secretPath)).wallet.address.toRawString(); }
  private code() { return this.codePromise ??= compileContracts(); }
  private async collectionData() {
    await this.rpc.assertTestnet();
    const { wallet } = await readWallet(this.secretPath);
    const code = await this.code();
    const state = await this.rpc.call(client => client.getContractState(this.collection));
    if (state.state !== 'active' || !state.code || !Cell.fromBoc(state.code)[0]!.equals(code.collection)) throw new ChainConflict('Collection is not the expected compiled testnet contract');
    if (!state.data) throw new ChainConflict('Missing collection storage');
    const storage = Cell.fromBoc(state.data)[0]!.beginParse();
    const storedOwner = storage.loadAddress();
    storage.loadUintBig(64); storage.loadRef();
    if (!storage.loadRef().equals(code.item)) throw new ChainConflict('Collection has an unexpected item code');
    const { stack } = await this.rpc.call(client => client.runMethod(this.collection, 'get_collection_data'));
    const nextIndex = stack.readNumber(); stack.readCell();
    const owner = stack.readAddress();
    if (!owner.equals(wallet.address) || !storedOwner.equals(owner)) throw new ChainConflict('Collection owner does not match configured wallet');
    if (!Number.isSafeInteger(nextIndex) || nextIndex < 0) throw new ChainConflict('Unsupported item index');
    return { nextIndex, owner };
  }
  async nextIndex(): Promise<number> { return (await this.collectionData()).nextIndex; }
  private async seqno(wallet: Awaited<ReturnType<typeof readWallet>>['wallet']) {
    const state = await this.rpc.call(client => client.getContractState(wallet.address));
    if (state.state === 'frozen') throw new ChainConflict('Wallet is frozen');
    if (state.state !== 'active') return { seqno: 0, state };
    const { stack } = await this.rpc.call(client => client.runMethod(wallet.address, 'seqno'));
    return { seqno: stack.readNumber(), state };
  }
  async prepare(input: { jobId: string; itemIndex: number; recipient: string; metadata: { name: string; description: string; imageData?: string } }): Promise<PreparedMint> {
    const recipient = Address.parse(input.recipient);
    if (recipient.workChain !== 0) throw new Error('Reference NFT only supports workchain 0');
    const { nextIndex } = await this.collectionData();
    if (input.itemIndex !== nextIndex) throw new ChainConflict('Reconcile existing index before signing another mint');
    const { wallet, secretKey } = await readWallet(this.secretPath);
    const { seqno } = await this.seqno(wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const queryId = createHash('sha256').update(input.jobId).digest().readBigUInt64BE();
    const transfer = wallet.createTransfer({ seqno, secretKey, timeout: deadline, sendMode: SendMode.PAY_GAS_SEPARATELY, messages: [internal({ to: this.collection, value: toNano('0.12'), bounce: true, body: mintBody(input.itemIndex, recipient, input.metadata, queryId) })] });
    const message = beginCell().store(storeMessage(external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body: transfer }))).endCell();
    return { signedBoc: message.toBoc().toString('base64'), messageHash: message.hash().toString('hex'), walletSeqno: seqno, deadline };
  }
  async send(prepared: PreparedMint): Promise<void> {
    if (process.env.TON_MINTING_ENABLED !== 'true') throw new Error('TON_MINTING_ENABLED must be explicitly enabled after testnet/address/spend approval');
    await this.rpc.assertTestnet();
    const { wallet } = await readWallet(this.secretPath);
    const cell = Cell.fromBase64(prepared.signedBoc);
    const message = loadMessage(cell.beginParse());
    if (message.info.type !== 'external-in' || !message.info.dest.equals(wallet.address) || cell.hash().toString('hex') !== prepared.messageHash || prepared.deadline <= Math.floor(Date.now() / 1000)) throw new Error('Invalid or expired prepared mint');
    // Do not automatically retry a send: a timeout is ambiguous. Persist submitted
    // state first and reconcile exact message/item before any future attempt.
    await this.rpc.call(client => client.sendFile(cell.toBoc()), false);
  }
  async inspect(input: { itemIndex: number; recipient: string; messageHash: string; deadline: number; walletSeqno: number }): Promise<MintInspection> {
    try {
      if (!Number.isSafeInteger(input.itemIndex) || input.itemIndex < 0 || !Number.isSafeInteger(input.deadline) || !Number.isSafeInteger(input.walletSeqno) || !/^[a-f0-9]{64}$/i.test(input.messageHash)) return pending();
      const { nextIndex } = await this.collectionData();
      const code = await this.code();
      const { wallet } = await readWallet(this.secretPath);
      const expectedRecipient = Address.parse(input.recipient);
      const { stack: addressStack } = await this.rpc.call(client => client.runMethod(this.collection, 'get_nft_address_by_index', [{ type: 'int', value: BigInt(input.itemIndex) }]));
      const itemAddress = addressStack.readAddress();
      const calculated = contractAddress(0, { code: code.item, data: beginCell().storeUint(input.itemIndex, 64).storeAddress(this.collection).endCell() });
      if (!itemAddress.equals(calculated)) throw new ChainConflict('Deterministic NFT address mismatch');
      const state = await this.rpc.call(client => client.getContractState(itemAddress));
      if (state.state !== 'active') {
        const current = await this.seqno(wallet);
        // Both authoritative account reads must be from chain time after expiry;
        // a local clock and unchanged seqno alone are NOT evidence of absence.
        const chainExpired = Math.min(state.timestampt, current.state.timestampt) > input.deadline + 30;
        if (state.state === 'uninitialized' && chainExpired && current.seqno === input.walletSeqno && nextIndex === input.itemIndex) return { status: 'absent', retrySafe: true };
        return pending();
      }
      if (!state.code || !Cell.fromBoc(state.code)[0]!.equals(code.item)) throw new ChainConflict('NFT item code mismatch');
      const { stack } = await this.rpc.call(client => client.runMethod(itemAddress, 'get_nft_data'));
      const initialized = stack.readBoolean();
      const index = stack.readNumber();
      const collection = stack.readAddress();
      const owner = stack.readAddressOpt();
      const content = stack.readCellOpt();
      if (!initialized) return pending();
      if (index !== input.itemIndex || !collection.equals(this.collection) || !owner?.equals(expectedRecipient)) throw new ChainConflict('NFT owner/index/collection conflicts with mint job');
      if (!content) throw new ChainConflict('NFT content missing');
      const { stack: contentStack } = await this.rpc.call(client => client.runMethod(this.collection, 'get_nft_content', [{ type: 'int', value: BigInt(index) }, { type: 'cell', cell: content }]));
      if (!contentStack.readCell().equals(content)) throw new ChainConflict('Collection metadata getter mismatch');
      // Trace the signed external message -> wallet -> collection -> item.
      // Bounded history: if evidence has aged out, remain pending, never invent it.
      const walletTransactions = await this.rpc.call(client => client.getTransactions(wallet.address, { limit: 100, archival: true }));
      const walletTx = walletTransactions.find(tx => tx.inMessage?.info.type === 'external-in' && serializedMessageHash(tx.inMessage) === input.messageHash && transactionSucceeded(tx));
      if (!walletTx) return pending();
      const mintMessage = Array.from(walletTx.outMessages.values()).find(message => {
        if (message.info.type !== 'internal' || !message.info.dest.equals(this.collection)) return false;
        const body = message.body.beginParse();
        return body.remainingBits >= 160 && body.loadUint(32) === 1 && (body.loadUintBig(64), body.loadUintBig(64) === BigInt(input.itemIndex));
      });
      if (!mintMessage || mintMessage.info.type !== 'internal') return pending();
      const mintLt = mintMessage.info.createdLt;
      const collectionTransactions = await this.rpc.call(client => client.getTransactions(this.collection, { limit: 100, archival: true }));
      const collectionTx = collectionTransactions.find(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(wallet.address) && tx.inMessage.info.createdLt === mintLt && tx.inMessage.body.equals(mintMessage.body) && transactionSucceeded(tx));
      if (!collectionTx) return pending();
      const initialization = Array.from(collectionTx.outMessages.values()).find(message => message.info.type === 'internal' && message.info.dest.equals(itemAddress));
      if (!initialization || initialization.info.type !== 'internal') return pending();
      const initBody = initialization.body.beginParse();
      if (!initBody.loadAddress().equals(expectedRecipient) || !initBody.loadRef().equals(content)) throw new ChainConflict('Mint initialization recipient/content conflict');
      const initLt = initialization.info.createdLt;
      const itemTransactions = await this.rpc.call(client => client.getTransactions(itemAddress, { limit: 100, archival: true }));
      const itemTx = itemTransactions.find(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(this.collection) && tx.inMessage.info.createdLt === initLt && tx.inMessage.body.equals(initialization.body) && transactionSucceeded(tx));
      if (!itemTx) return pending();
      return { status: 'confirmed', initialized: true, itemAddress: itemAddress.toRawString(), transactionHash: itemTx.hash().toString('hex'), owner: owner.toRawString(), collectionAddress: this.collection.toRawString(), itemIndex: index };
    } catch (error) {
      if (error instanceof ChainConflict) throw error;
      return pending(); // unavailable/unknown provider state can never authorize a retry
    }
  }
}
