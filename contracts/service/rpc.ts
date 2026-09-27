import { TonClient } from '@ton/ton';

export const TESTNET_RPC_URL = 'https://testnet.toncenter.com/api/v2/jsonRPC';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// One instance must be shared by the single wallet worker. Every individual RPC,
// including retry attempts, passes this queue; provider helpers are not used.
export class TestnetRpc {
  private readonly client: TonClient;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(options: { rpcUrl?: string; apiKey?: string } = {}) {
    const endpoint = options.rpcUrl ?? TESTNET_RPC_URL;
    if (endpoint !== TESTNET_RPC_URL) throw new Error('Only the known TON testnet endpoint is permitted');
    this.client = new TonClient({ endpoint, apiKey: options.apiKey, timeout: 15_000 });
  }
  call<T>(operation: (client: TonClient) => Promise<T>, retry = true): Promise<T> {
    const task = this.queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await wait(Math.max(0, 1050 - (Date.now() - this.lastRequest)));
        this.lastRequest = Date.now();
        try { return await operation(this.client); }
        catch (error) {
          const status = (error as { response?: { status?: number } }).response?.status;
          const code = (error as { code?: string }).code;
          if (!retry || attempt >= 3 || !(status === 429 || (status !== undefined && status >= 500) || ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND'].includes(code ?? ''))) throw error;
          await wait(1500 * 2 ** attempt);
        }
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async assertTestnet() {
    // Network proof is the fixed, TLS-authenticated official testnet endpoint,
    // not a caller-supplied URL or an address's testOnly display bit.
    const info = await this.call(client => client.getMasterchainInfo());
    if (info.workchain !== -1 || !Number.isSafeInteger(info.latestSeqno) || info.latestSeqno <= 0) throw new Error('Invalid testnet masterchain response');
    return info;
  }
}
