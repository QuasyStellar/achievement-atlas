import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileContracts } from '../contracts/compile.js';

const output = fileURLToPath(new URL('../contracts/build/', import.meta.url));
await mkdir(output, { recursive: true });
const code = await compileContracts();
for (const [name, cell] of Object.entries(code)) {
  await writeFile(output + name + '.boc', cell.toBoc());
  console.log(`${name}: code hash ${cell.hash().toString('hex')}`);
}
