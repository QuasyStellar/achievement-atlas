import { mkdir, open, lstat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { readWallet, WALLET_SECRET_PATH } from '../contracts/service/wallet.js';

await mkdir(dirname(WALLET_SECRET_PATH), { recursive: true, mode: 0o700 });
const directory = await lstat(dirname(WALLET_SECRET_PATH));
if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe wallet directory');
await chmod(dirname(WALLET_SECRET_PATH), 0o700);
try {
  const handle = await open(WALLET_SECRET_PATH, 'wx', 0o600);
  try {
    const mnemonic = await mnemonicNew(24);
    const keys = await mnemonicToPrivateKey(mnemonic);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
    await handle.writeFile(JSON.stringify({ version: 1, network: 'testnet', mnemonic, publicKey: keys.publicKey.toString('hex'), secretKey: keys.secretKey.toString('hex'), address: wallet.address.toRawString() }));
  } finally { await handle.close(); }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Wallet creation failed; secret material is never logged');
}
const { wallet } = await readWallet(WALLET_SECRET_PATH);
console.log(JSON.stringify({ address: wallet.address.toString({ testOnly: true, bounceable: false }), network: 'testnet', secretPath: WALLET_SECRET_PATH, faucet: 'https://t.me/testgiver_ton_bot' }, null, 2));
