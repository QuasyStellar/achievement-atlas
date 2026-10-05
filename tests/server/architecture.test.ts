import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../apps/server/src/', import.meta.url));
async function imports(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) found.push(match[1]!);
  }
  return found;
}
describe('dependency rule of the layered architecture', () => {
  it('keeps the domain free of any import', async () => {
    expect(await imports('domain')).toEqual([]);
  });
  it('lets application depend only on domain, its own ports and no HTTP, database or adapter code', async () => {
    const list = await imports('application');
    expect(list.length).toBeGreaterThan(0);
    for (const specifier of list) {
      expect(specifier).not.toMatch(/infrastructure|contracts\/|^express|^sqlite3|^cookie-parser|^helmet|app\.js$/);
    }
  });
});
