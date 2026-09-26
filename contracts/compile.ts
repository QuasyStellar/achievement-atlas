import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileFunc } from '@ton-community/func-js';
import { Cell } from '@ton/core';

const root = fileURLToPath(new URL('./', import.meta.url));
export async function compileContracts(): Promise<{ collection: Cell; item: Cell }> {
  const paths = ['vendor/stdlib.fc', 'vendor/nft/op-codes.fc', 'vendor/nft/params.fc', 'vendor/nft/nft-item.fc', 'src/nft-collection.fc'];
  const sources = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(root + path, 'utf8')])));
  const compile = async (target: string) => {
    const result = await compileFunc({ targets: ['vendor/stdlib.fc', 'vendor/nft/op-codes.fc', 'vendor/nft/params.fc', target], sources });
    if (result.status !== 'ok') throw new Error(result.message);
    return Cell.fromBase64(result.codeBoc);
  };
  const item = await compile('vendor/nft/nft-item.fc');
  const collection = await compile('src/nft-collection.fc');
  return { collection, item };
}
