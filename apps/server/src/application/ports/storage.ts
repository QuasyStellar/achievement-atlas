export interface Connection {
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastID: number }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}
/** Transactional storage port. The adapter decides the engine; scenarios only see atomic units of work. */
export interface Storage {
  readonly path: string;
  read<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
  transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
}
