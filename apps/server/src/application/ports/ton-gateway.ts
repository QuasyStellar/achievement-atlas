export interface PreparedMint {
  signedBoc: string;
  messageHash: string;
  walletSeqno: number;
  /** Unix seconds; expiry of the signed wallet message. */
  deadline: number;
}
export type MintInspection = {
  status: 'confirmed';
  initialized: true;
  itemAddress: string;
  transactionHash: string;
  owner: string;
  collectionAddress: string;
  itemIndex: number;
} | {
  status: 'pending' | 'absent';
  /** True only when original message cannot execute and wallet/index are safe to reuse. */
  retrySafe: boolean;
};
/** Testnet-only adapter. prepare MUST NOT send; inspect must use authoritative provider data. */
export interface TonGateway {
  nextIndex(): Promise<number>;
  prepare(input: { jobId: string; itemIndex: number; recipient: string; metadata: { name: string; description: string; imageData?: string } }): Promise<PreparedMint>;
  send(prepared: PreparedMint): Promise<void>;
  inspect(input: { itemIndex: number; recipient: string; messageHash: string; deadline: number; walletSeqno: number }): Promise<MintInspection>;
}
