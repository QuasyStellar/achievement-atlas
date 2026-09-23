/** Hashing and token primitives supplied by infrastructure; scenarios never import node:crypto wrappers directly. */
export interface SecurityPort {
  hash(value: string): string;
  randomToken(): string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, stored: string): Promise<boolean>;
  canonicalJson(value: unknown): string;
}
