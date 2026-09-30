import { fromNano } from '@ton/core';
import { TestnetRpc } from '../contracts/service/rpc.js';
import { readWallet } from '../contracts/service/wallet.js';

const { wallet } = await readWallet();
const rpc = new TestnetRpc({ apiKey: process.env.TONCENTER_API_KEY });
await rpc.assertTestnet();
const state = await rpc.call(client => client.getContractState(wallet.address));
console.log(JSON.stringify({ network: 'testnet', address: wallet.address.toString({ testOnly: true, bounceable: false }), balanceTon: fromNano(state.balance), state: state.state }, null, 2));
