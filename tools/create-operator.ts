import dotenv from 'dotenv';
dotenv.config({ path: process.env.ATLAS_ENV_FILE ?? '/etc/achievement-atlas/service.env' });
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../apps/server/src/infrastructure/database.js';
import { hashPassword } from '../apps/server/src/infrastructure/security.js';

/** Local-only provisioning; no public endpoint can elevate an account. Password is never a CLI argument. */
async function main(): Promise<void> {
  const input = z.object({ email: z.string().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(8).max(128), displayName: z.string().trim().min(1).max(80) }).parse({
    email: process.argv[2], displayName: process.argv[3] ?? 'Оператор', password: process.env.OPERATOR_PASSWORD,
  });
  const passwordHash = await hashPassword(input.password);
  const db = await Database.open(resolve(process.env.DB_PATH ?? 'data/atlas.db'));
  try {
    const id = await db.transaction(async c => {
      const existing = await c.get<{ id: string }>('SELECT id FROM users WHERE email=?', [input.email]);
      if (existing) {
        await c.run('UPDATE users SET role=\'operator\',password_hash=?,display_name=? WHERE id=?', [passwordHash, input.displayName, existing.id]);
        await c.run('DELETE FROM sessions WHERE user_id=?', [existing.id]);
        return existing.id;
      }
      const id = randomUUID();
      await c.run('INSERT INTO users(id,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,\'operator\',?)', [id, input.email, input.displayName, passwordHash, new Date().toISOString()]);
      await c.run('INSERT INTO counters(user_id) VALUES(?)', [id]);
      return id;
    });
    console.info(`Local operator provisioned: ${id}`);
  } finally { await db.close(); }
}
main().catch(() => {
  console.error('Operator provisioning failed. Usage: OPERATOR_PASSWORD=<secret> npm run operator:create -- email [displayName]. Use a protected environment; password must contain 8–128 characters.');
  process.exitCode = 1;
});
