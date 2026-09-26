import { beforeAll, describe, expect, it } from 'vitest';
import { Blockchain } from '@ton/sandbox';
import { beginCell, contractAddress, toNano, type Address, type Cell, type Transaction } from '@ton/core';
import { compileContracts } from '../compile.js';
import { decodeMetadata, encodeMetadata } from '../metadata.js';
import { NftCollection, NftItem } from '../wrappers.js';

function at(transactions: Transaction[], address: Address, success: boolean, exitCode?: number) {
  return transactions.some(tx => {
    if (tx.inMessage?.info.type !== 'internal' || !tx.inMessage.info.dest.equals(address) || tx.description.type !== 'generic') return false;
    const phase = tx.description.computePhase;
    return phase.type === 'vm' && phase.success === success && (exitCode === undefined || phase.exitCode === exitCode) && (!success || !tx.description.aborted);
  });
}
let code: { collection: Cell; item: Cell };
beforeAll(async () => { code = await compileContracts(); }, 60_000);

describe('Pinned official NFT reference, TEP-64 adaptation', () => {
  it('deploys, mints, exposes initialized owner/index/collection/content, rejects unauthorized operations and transfers', async () => {
    const chain = await Blockchain.create();
    const owner = await chain.treasury('collection-owner');
    const player = await chain.treasury('player');
    const attacker = await chain.treasury('attacker');
    const nextOwner = await chain.treasury('next-owner');
    const collection = chain.openContract(NftCollection.create(owner.address, code.collection, code.item));
    expect(at((await collection.sendDeploy(owner.getSender())).transactions, collection.address, true)).toBe(true);
    expect((await collection.getData()).owner.equals(owner.address)).toBe(true);
    expect((await collection.getData()).nextIndex).toBe(0);
    expect(decodeMetadata((await collection.getData()).content).name).toBe('Achievement Atlas');
    const metadata = { name: 'Первая победа', description: 'Достижение без персональных данных. '.repeat(12), imageData: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>' };
    const denial = await collection.sendMint(attacker.getSender(), 0, attacker.address, metadata);
    expect(at(denial.transactions, collection.address, false, 401)).toBe(true);
    expect((await collection.getData()).nextIndex).toBe(0);
    const itemAddress = await collection.getItemAddress(0);
    const result = await collection.sendMint(owner.getSender(), 0, player.address, metadata);
    expect(at(result.transactions, collection.address, true)).toBe(true);
    expect(at(result.transactions, itemAddress, true)).toBe(true);
    expect((await collection.getData()).nextIndex).toBe(1);
    const item = chain.openContract(new NftItem(itemAddress));
    const data = await item.getData();
    expect(data.initialized).toBe(true);
    expect(data.index).toBe(0);
    expect(data.collection.equals(collection.address)).toBe(true);
    expect(data.owner?.equals(player.address)).toBe(true);
    expect(decodeMetadata(data.content!)).toEqual({ name: metadata.name, description: metadata.description, image_data: metadata.imageData });
    expect((await collection.getContent(0, data.content!)).equals(data.content!)).toBe(true);
    expect(at((await item.sendTransfer(attacker.getSender(), attacker.address)).transactions, itemAddress, false, 401)).toBe(true);
    expect((await item.getData()).owner?.equals(player.address)).toBe(true);
    expect(at((await item.sendTransfer(player.getSender(), nextOwner.address)).transactions, itemAddress, true)).toBe(true);
    expect((await item.getData()).owner?.equals(nextOwner.address)).toBe(true);
  }, 60_000);

  it('rejects direct initialization not sent by the collection, and raw duplicate mint is not assumed harmless', async () => {
    const chain = await Blockchain.create();
    const owner = await chain.treasury('owner');
    const player = await chain.treasury('player');
    const collection = chain.openContract(NftCollection.create(owner.address, code.collection, code.item));
    await collection.sendDeploy(owner.getSender());
    const data = beginCell().storeUint(0, 64).storeAddress(collection.address).endCell();
    const init = { code: code.item, data };
    const address = contractAddress(0, init);
    const response = await chain.sendMessage({ info: { type: 'internal', ihrDisabled: true, bounce: true, bounced: false, src: player.address, dest: address, value: { coins: toNano('0.1') }, ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0 }, init, body: beginCell().storeAddress(player.address).storeRef(encodeMetadata({ name: 'Bad', description: '' })).endCell() });
    expect(at(response.transactions, address, false, 405)).toBe(true);
    await collection.sendMint(owner.getSender(), 0, player.address, { name: 'Award', description: '' });
    const duplicate = await collection.sendMint(owner.getSender(), 0, owner.address, { name: 'Different', description: '' });
    expect(at(duplicate.transactions, address, false)).toBe(true);
    expect((await chain.openContract(new NftItem(address)).getData()).owner?.equals(player.address)).toBe(true);
  }, 60_000);
});
