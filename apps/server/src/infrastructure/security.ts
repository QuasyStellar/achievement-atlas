import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { SecurityPort } from '../application/ports/security.js';
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function constantEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, value] = stored.split('$');
  if (!salt || !value) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(value, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Recursively sort keys so semantically identical JSON has identical SHA-256. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) as string;
}
export const security: SecurityPort = { hash, randomToken, hashPassword, verifyPassword, canonicalJson };
