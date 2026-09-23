export interface MintPermission {
  status(): { recipient: string; maxSpendTon: string; remainingMints: number; automaticRetryAllowed: false };
  request<T extends { id: string; status: string }>(input: { userId: string; unlockId: string; recipient: string }, create: () => Promise<T>): Promise<T>;
}
