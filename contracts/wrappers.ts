import { Address, beginCell, Cell, contractAddress, type Contract, type ContractProvider, type Sender, SendMode, toNano } from '@ton/core';
import { encodeMetadata, type NftMetadata } from './metadata.js';

export function collectionData(owner: Address, itemCode: Cell): Cell {
  const content = beginCell().storeRef(encodeMetadata({ name: 'Achievement Atlas', description: 'Game achievements. TON testnet coursework collection. No personal data.' })).storeRef(beginCell().endCell()).endCell();
  const royalty = beginCell().storeUint(0, 16).storeUint(1000, 16).storeAddress(owner).endCell();
  return beginCell().storeAddress(owner).storeUint(0, 64).storeRef(content).storeRef(itemCode).storeRef(royalty).endCell();
}
export function mintBody(index: number, owner: Address, metadata: NftMetadata, queryId = 0n): Cell {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid NFT index');
  return beginCell().storeUint(1, 32).storeUint(queryId, 64).storeUint(index, 64).storeCoins(toNano('0.08')).storeRef(beginCell().storeAddress(owner).storeRef(encodeMetadata(metadata)).endCell()).endCell();
}
export class NftCollection implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}
  static create(owner: Address, collectionCode: Cell, itemCode: Cell) {
    const init = { code: collectionCode, data: collectionData(owner, itemCode) };
    return new NftCollection(contractAddress(0, init), init);
  }
  async sendDeploy(provider: ContractProvider, sender: Sender) {
    await provider.internal(sender, { value: toNano('0.12'), bounce: false, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
  }
  async sendMint(provider: ContractProvider, sender: Sender, index: number, owner: Address, metadata: NftMetadata) {
    await provider.internal(sender, { value: toNano('0.12'), sendMode: SendMode.PAY_GAS_SEPARATELY, body: mintBody(index, owner, metadata) });
  }
  async getData(provider: ContractProvider) {
    const { stack } = await provider.get('get_collection_data', []);
    return { nextIndex: stack.readNumber(), content: stack.readCell(), owner: stack.readAddress() };
  }
  async getItemAddress(provider: ContractProvider, index: number) {
    const { stack } = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);
    return stack.readAddress();
  }
  async getContent(provider: ContractProvider, index: number, content: Cell) {
    const { stack } = await provider.get('get_nft_content', [{ type: 'int', value: BigInt(index) }, { type: 'cell', cell: content }]);
    return stack.readCell();
  }
}
export class NftItem implements Contract {
  constructor(readonly address: Address) {}
  async getData(provider: ContractProvider) {
    const { stack } = await provider.get('get_nft_data', []);
    return { initialized: stack.readBoolean(), index: stack.readNumber(), collection: stack.readAddress(), owner: stack.readAddressOpt(), content: stack.readCellOpt() };
  }
  async sendTransfer(provider: ContractProvider, sender: Sender, owner: Address) {
    await provider.internal(sender, { value: toNano('0.05'), sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().storeUint(0x5fcc3d14, 32).storeUint(0, 64).storeAddress(owner).storeAddress(sender.address ?? null).storeBit(false).storeCoins(0).storeBit(false).endCell() });
  }
}
