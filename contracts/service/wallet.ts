import { readFile, lstat } from 'node:fs/promises';
import { Address } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';

export const WALLET_SECRET_PATH = process.env.TON_WALLET_SECRET_PATH ?? '/etc/achievement-atlas/wallet.json';
export async function readWallet(path = WALLET_SECRET_PATH) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Wallet secret must be a private regular file (0600)');
  let data: { network?: string; mnemonic?: string[]; publicKey?: string; secretKey?: string; address?: string };
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Cannot read wallet secret'); }
  if (data.network !== 'testnet' || !Array.isArray(data.mnemonic) || data.mnemonic.length !== 24) throw new Error('Invalid testnet wallet secret');
  const keys = await mnemonicToPrivateKey(data.mnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
  if (data.publicKey !== keys.publicKey.toString('hex') || data.secretKey !== keys.secretKey.toString('hex') || !data.address || !wallet.address.equals(Address.parse(data.address))) throw new Error('Wallet secret integrity mismatch');
  return { wallet, secretKey: keys.secretKey };
}
