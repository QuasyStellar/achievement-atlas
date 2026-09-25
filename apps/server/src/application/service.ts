import { randomUUID } from 'node:crypto';
import { Address } from '@ton/core';
import { z } from 'zod';
import { ACHIEVEMENTS, applyEvent, eligibleAchievements, type Counters, type GameEvent } from '../domain/achievements.js';
import type { Connection, Storage } from './ports/storage.js';
import type { SecurityPort } from './ports/security.js';
import { ApiError } from './errors.js';

export const registerSchema = z.object({ email: z.string().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(8).max(128), displayName: z.string().trim().min(1).max(80) }).strict();
export const loginSchema = z.object({ email: z.string().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(1).max(128) }).strict();
const eventBase = { eventId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/), playerId: z.string().uuid(), occurredAt: z.string().datetime({ offset: true }) };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('match.completed'), payload: z.object({ won: z.boolean() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('combat.completed'), payload: z.object({ kills: z.number().int().min(0).max(1000000) }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('xp.earned'), payload: z.object({ xp: z.number().int().min(0).max(10000000) }).strict() }).strict(),
]);
export const scenarioSchema = z.object({ userId: z.string().uuid(), scenario: z.enum(['first-match', 'victory', 'ten-matches', 'hundred-kills', 'thousand-xp']) }).strict();
export interface User { id: string; email: string; displayName: string; role: 'player' | 'operator' }
interface UserRow { id: string; email: string; display_name: string; password_hash: string; role: User['role'] }
export interface Session { token_hash: string; user_id: string | null; csrf_token: string; expires_at: number }
export interface MintRow {
  id: string; unlock_id: string; recipient: string; status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  item_index: number | null; item_address: string | null; transaction_hash: string | null; error: string | null;
  signed_boc: string | null; message_hash: string | null; wallet_seqno: number | null; deadline: number | null;
  created_at: string; updated_at: string;
}
export function publicMint(row: MintRow) {
  return { id: row.id, status: row.status, recipient: row.recipient, itemIndex: row.item_index, itemAddress: row.item_address,
    transactionHash: row.transaction_hash, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicUser(row: UserRow): User { return { id: row.id, email: row.email, displayName: row.display_name, role: row.role }; }
export function normalizedAddress(input: string): string {
  try { return Address.parse(input).toString({ bounceable: true, testOnly: true }); }
  catch { throw new ApiError(400, 'INVALID_RECIPIENT', 'Некорректный TON-адрес'); }
}
export interface IngestionResult { eventId: string; playerId: string; unlocked: string[]; counters: Counters }
export class AtlasService {
  constructor(readonly db: Storage, private readonly security: SecurityPort) {}
  async register(input: z.infer<typeof registerSchema>): Promise<User> {
    const passwordHash = await this.security.hashPassword(input.password);
    return this.db.transaction(async c => {
      if (await c.get('SELECT id FROM users WHERE email=?', [input.email])) throw new ApiError(409, 'EMAIL_EXISTS', 'Аккаунт уже существует');
      const user: User = { id: randomUUID(), email: input.email, displayName: input.displayName, role: 'player' };
      await c.run('INSERT INTO users(id,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', [user.id, user.email, user.displayName, passwordHash, user.role, new Date().toISOString()]);
      await c.run('INSERT INTO counters(user_id) VALUES(?)', [user.id]);
      return user;
    });
  }
  async login(input: z.infer<typeof loginSchema>): Promise<User> {
    const row = await this.db.read(c => c.get<UserRow>('SELECT * FROM users WHERE email=?', [input.email]));
    // Perform scrypt also for unknown accounts to avoid an account-existence timing oracle.
    const dummy = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);
    const valid = await this.security.verifyPassword(input.password, row?.password_hash ?? dummy);
    if (!row || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль');
    return publicUser(row);
  }
  async user(id: string): Promise<User | null> {
    const row = await this.db.read(c => c.get<UserRow>('SELECT * FROM users WHERE id=?', [id]));
    return row ? publicUser(row) : null;
  }
  async users(): Promise<User[]> { return this.db.read(async c => (await c.all<UserRow>('SELECT * FROM users ORDER BY created_at,id')).map(publicUser)); }
  async session(token: unknown): Promise<Session | null> {
    if (typeof token !== 'string' || token.length > 128) return null;
    return this.db.read(async c => (await c.get<Session>('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', [this.security.hash(token), Date.now()])) ?? null);
  }
  async rotateSession(oldHash: string | undefined, userId: string | null): Promise<{ token: string; session: Session }> {
    const token = this.security.randomToken();
    const session: Session = { token_hash: this.security.hash(token), user_id: userId, csrf_token: this.security.randomToken(), expires_at: Date.now() + 24 * 60 * 60 * 1000 };
    await this.db.transaction(async c => {
      if (oldHash) await c.run('DELETE FROM sessions WHERE token_hash=?', [oldHash]);
      await c.run('DELETE FROM sessions WHERE expires_at<=?', [Date.now()]);
      await c.run('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)', [session.token_hash, session.user_id, session.csrf_token, session.expires_at]);
    });
    return { token, session };
  }
  async ingest(event: GameEvent, source: string): Promise<{ duplicate: boolean; result: IngestionResult }> {
    return this.db.transaction(c => this.ingestInTransaction(c, event, source));
  }
  private async ingestInTransaction(c: Connection, event: GameEvent, source: string): Promise<{ duplicate: boolean; result: IngestionResult }> {
    const digest = this.security.hash(this.security.canonicalJson(event));
    const existing = await c.get<{ payload_hash: string; result: string }>('SELECT payload_hash,result FROM events WHERE source=? AND event_id=?', [source, event.eventId]);
    if (existing) {
      if (existing.payload_hash !== digest) throw new ApiError(409, 'EVENT_CONFLICT', 'Этот eventId уже использован для другого события');
      return { duplicate: true, result: JSON.parse(existing.result) as IngestionResult };
    }
    const counters = await c.get<Counters>('SELECT matches,wins,kills,xp FROM counters WHERE user_id=?', [event.playerId]);
    if (!counters) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'Игрок не найден');
    let next: Counters;
    try { next = applyEvent(counters, event); } catch { throw new ApiError(400, 'COUNTER_LIMIT', 'Превышен предел счётчика'); }
    const unlocks = await c.all<{ achievement_id: string }>('SELECT achievement_id FROM unlocks WHERE user_id=?', [event.playerId]);
    const unlocked = eligibleAchievements(next, new Set(unlocks.map(u => u.achievement_id)));
    const result: IngestionResult = { eventId: event.eventId, playerId: event.playerId, unlocked, counters: next };
    const id = randomUUID(); const now = new Date().toISOString();
    await c.run('INSERT INTO events(id,source,event_id,user_id,type,occurred_at,payload,payload_hash,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [id, source, event.eventId, event.playerId, event.type, event.occurredAt, this.security.canonicalJson(event.payload), digest, JSON.stringify(result), now]);
    await c.run('UPDATE counters SET matches=?,wins=?,kills=?,xp=? WHERE user_id=?', [next.matches, next.wins, next.kills, next.xp, event.playerId]);
    for (const achievement of unlocked) await c.run('INSERT INTO unlocks(id,user_id,achievement_id,unlocked_at,event_id) VALUES(?,?,?,?,?)', [randomUUID(), event.playerId, achievement, now, id]);
    return { duplicate: false, result };
  }
  async simulate(input: z.infer<typeof scenarioSchema>): Promise<{ processed: number; unlocked: string[] }> {
    const events: GameEvent[] = [];
    const base = () => ({ eventId: `demo:${randomUUID()}`, playerId: input.userId, occurredAt: new Date().toISOString() });
    if (input.scenario === 'hundred-kills') events.push({ ...base(), type: 'combat.completed', payload: { kills: 100 } });
    else if (input.scenario === 'thousand-xp') events.push({ ...base(), type: 'xp.earned', payload: { xp: 1000 } });
    else for (let i = 0; i < (input.scenario === 'ten-matches' ? 10 : 1); i++) events.push({ ...base(), type: 'match.completed', payload: { won: input.scenario === 'victory' } });
    return this.db.transaction(async c => {
      const unlocked: string[] = [];
      for (const event of events) unlocked.push(...(await this.ingestInTransaction(c, event, 'server-demo')).result.unlocked);
      return { processed: events.length, unlocked };
    });
  }
  async achievements(userId: string) {
    return this.db.read(async c => {
      const counters = (await c.get<Counters>('SELECT matches,wins,kills,xp FROM counters WHERE user_id=?', [userId]))!;
      const unlocks = await c.all<{ id: string; achievement_id: string; unlocked_at: string }>('SELECT id,achievement_id,unlocked_at FROM unlocks WHERE user_id=?', [userId]);
      const jobs = await c.all<MintRow>('SELECT m.* FROM mint_jobs m JOIN unlocks u ON m.unlock_id=u.id WHERE u.user_id=?', [userId]);
      return {
        achievements: ACHIEVEMENTS.map(a => {
          const unlock = unlocks.find(u => u.achievement_id === a.id);
          const job = jobs.find(j => j.unlock_id === unlock?.id);
          return { ...a, progress: Math.min(counters[a.metric], a.target), unlocked: !!unlock, unlockedAt: unlock?.unlocked_at ?? null, unlockId: unlock?.id ?? null, mint: job ? publicMint(job) : null };
        }),
        summary: { ...counters, unlocked: unlocks.length, total: ACHIEVEMENTS.length, minted: jobs.filter(j => j.status === 'confirmed').length },
      };
    });
  }
  async events(userId: string) {
    return this.db.read(async c => ({ events: (await c.all<{ id: string; event_id: string; type: string; occurred_at: string; payload: string; result: string; created_at: string }>(
      'SELECT id,event_id,type,occurred_at,payload,result,created_at FROM events WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200', [userId]
    )).map(e => ({ id: e.id, eventId: e.event_id, type: e.type, occurredAt: e.occurred_at, payload: JSON.parse(e.payload) as object, createdAt: e.created_at,
      unlocked: (JSON.parse(e.result) as IngestionResult).unlocked })) }));
  }
  async rewards(userId: string) {
    const data = await this.achievements(userId);
    return { rewards: data.achievements.filter(a => a.unlocked).map(a => ({ unlockId: a.unlockId!, achievementId: a.id, title: a.title, unlockedAt: a.unlockedAt!, mint: a.mint })) };
  }
  async mint(userId: string, unlockId: string, recipient: string, configured: boolean) {
    const normalized = normalizedAddress(recipient);
    return this.db.transaction(async c => {
      const unlock = await c.get('SELECT id FROM unlocks WHERE id=? AND user_id=?', [unlockId, userId]);
      if (!unlock) throw new ApiError(404, 'REWARD_NOT_FOUND', 'Награда не найдена');
      const existing = await c.get<MintRow>('SELECT * FROM mint_jobs WHERE unlock_id=?', [unlockId]);
      if (existing && existing.recipient !== normalized) throw new ApiError(409, 'RECIPIENT_CONFLICT', 'Получатель этой награды уже зафиксирован');
      if (!configured) throw new ApiError(503, 'MINTING_UNAVAILABLE', 'Минт отключён или TON testnet не настроен');
      if (existing) {
        if (existing.status === 'failed' && !existing.message_hash) {
          await c.run('UPDATE mint_jobs SET status=\'pending\',error=NULL,updated_at=? WHERE id=?', [new Date().toISOString(), existing.id]);
          return publicMint((await c.get<MintRow>('SELECT * FROM mint_jobs WHERE id=?', [existing.id]))!);
        }
        return publicMint(existing);
      }
      const now = new Date().toISOString(); const id = randomUUID();
      await c.run('INSERT INTO mint_jobs(id,unlock_id,recipient,status,created_at,updated_at) VALUES(?,?,?,\'pending\',?,?)', [id, unlockId, normalized, now, now]);
      return publicMint((await c.get<MintRow>('SELECT * FROM mint_jobs WHERE id=?', [id]))!);
    });
  }
}
