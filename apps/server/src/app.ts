import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { Address } from '@ton/core';
import { Database } from './infrastructure/database.js';
import { constantEqual, security } from './infrastructure/security.js';
import { AtlasService, eventSchema, registerSchema, loginSchema, scenarioSchema, type Session, type User } from './application/service.js';
import { ApiError } from './application/errors.js';
import { MintWorker } from './application/mint-worker.js';
import type { TonGateway } from './application/ports/ton-gateway.js';
import type { MintPermission } from './application/ports/mint-permission.js';

export interface AppOptions {
  dbPath: string;
  gameKey?: string;
  gameSource?: string;
  demoMode?: boolean;
  mintingEnabled?: boolean;
  mintPermission?: MintPermission;
  /** Предел числа заявок на выпуск для стенда; новые заявки сверх него отклоняются. */
  mintLimit?: number;
  gateway?: TonGateway;
  collectionAddress?: string;
  walletAddress?: string;
  allowedOrigins?: string[];
  cookieSecure?: boolean;
  startWorker?: boolean;
  workerIntervalMs?: number;
  webDistPath?: string;
  rateLimits?: { global?: number; auth?: number; ingestion?: number };
}
export interface AtlasApp extends Express {
  close(): Promise<void>;
  services: AtlasService;
  mintWorker: MintWorker | null;
}
type ApiRequest = Request & { session?: Session; user?: User; requestId?: string };
const COOKIE = 'atlas_session';
export async function createApp(options: AppOptions): Promise<AtlasApp> {
  const db = await Database.open(options.dbPath);
  const service = new AtlasService(db, security);
  const secureCookie = options.cookieSecure ?? process.env.NODE_ENV === 'production';
  const app = express() as AtlasApp;
  const chainConfigured = !!options.gateway && validAddress(options.collectionAddress) && validAddress(options.walletAddress);
  const mintingEnabled = options.mintingEnabled === true;
  const canMint = chainConfigured && mintingEnabled;
  const worker = canMint ? new MintWorker(db, { gateway: options.gateway!, collectionAddress: options.collectionAddress!, walletAddress: options.walletAddress!, intervalMs: options.workerIntervalMs }) : null;
  app.services = service;
  app.mintWorker = worker;
  app.close = async () => { await worker?.stop(); await db.close(); };
  app.locals.close = app.close;
  app.disable('x-powered-by');
  app.use((req: ApiRequest, res, next) => { req.requestId = randomUUID(); res.setHeader('X-Request-Id', req.requestId); next(); });
  app.use(helmet({
    strictTransportSecurity: false,
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': secureCookie ? [] : null } },
  }));
  const originSet = new Set(options.allowedOrigins ?? ['http://localhost:3000', 'http://127.0.0.1:3000']);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && !originSet.has(origin)) return next(new ApiError(403, 'ORIGIN_FORBIDDEN', 'Источник запроса не разрешён'));
    next();
  });
  const limiter = (limit: number, windowMs: number) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Слишком много запросов. Повторите позже')) });
  app.use('/api', limiter(options.rateLimits?.global ?? 600, 60000));
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use(cookieParser());
  app.get('/api/health', (_req, res) => res.json({
    status: 'ok', service: 'achievement-atlas', network: 'testnet', demoMode: options.demoMode === true,
    chain: { configured: chainConfigured, collectionAddress: options.collectionAddress ?? null, walletAddress: options.walletAddress ?? null,
      mintingEnabled: canMint && (!options.mintPermission || options.mintPermission.status().remainingMints > 0),
      ...(options.mintPermission ? { permission: options.mintPermission.status() } : {}) },
  }));
  app.post('/api/events/ingest', limiter(options.rateLimits?.ingestion ?? 120, 60000), async (req, res) => {
    const key = req.get('X-Game-Key');
    if (!options.gameKey || !key || !constantEqual(key, options.gameKey)) throw new ApiError(401, 'INVALID_GAME_KEY', 'Неверный ключ источника');
    const event = eventSchema.parse(req.body);
    const result = await service.ingest(event, options.gameSource ?? 'trusted-game');
    res.status(result.duplicate ? 200 : 201).json(result.result);
  });
  app.use('/api', async (req: ApiRequest, _res, next) => {
    req.session = (await service.session(req.cookies?.[COOKIE])) ?? undefined;
    next();
  });
  function setSessionCookie(res: express.Response, token: string): void {
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/', maxAge: 24 * 60 * 60 * 1000 });
  }
  app.use('/api/auth', limiter(options.rateLimits?.auth ?? 40, 15 * 60000));
  app.get('/api/auth/me', async (req: ApiRequest, res) => {
    let session = req.session;
    if (!session) {
      const rotated = await service.rotateSession(undefined, null);
      session = rotated.session;
      setSessionCookie(res, rotated.token);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: session.user_id ? await service.user(session.user_id) : null, csrfToken: session.csrf_token });
  });
  const csrf: RequestHandler = (req: ApiRequest, _res, next) => {
    const token = req.get('X-CSRF-Token');
    if (!req.session || !token || !constantEqual(token, req.session.csrf_token)) return next(new ApiError(403, 'CSRF_INVALID', 'Требуется текущий CSRF-токен'));
    next();
  };
  const auth: RequestHandler = async (req: ApiRequest, _res, next) => {
    const user = req.session?.user_id ? await service.user(req.session.user_id) : null;
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт');
    req.user = user;
    next();
  };
  const operator: RequestHandler = (req: ApiRequest, _res, next) => {
    if (req.user?.role !== 'operator') return next(new ApiError(403, 'OPERATOR_REQUIRED', 'Требуется роль оператора'));
    next();
  };
  app.post('/api/auth/register', csrf, async (req: ApiRequest, res) => {
    const user = await service.register(registerSchema.parse(req.body));
    const rotated = await service.rotateSession(req.session?.token_hash, user.id);
    setSessionCookie(res, rotated.token);
    res.status(201).json({ user });
  });
  app.post('/api/auth/login', csrf, async (req: ApiRequest, res) => {
    const user = await service.login(loginSchema.parse(req.body));
    const rotated = await service.rotateSession(req.session?.token_hash, user.id);
    setSessionCookie(res, rotated.token);
    res.json({ user });
  });
  app.post('/api/auth/logout', csrf, async (req: ApiRequest, res) => {
    const rotated = await service.rotateSession(req.session?.token_hash, null);
    setSessionCookie(res, rotated.token);
    res.json({ ok: true });
  });
  app.get('/api/achievements', auth, async (req: ApiRequest, res) => res.json(await service.achievements(req.user!.id)));
  app.get('/api/events', auth, async (req: ApiRequest, res) => res.json(await service.events(req.user!.id)));
  app.get('/api/rewards', auth, async (req: ApiRequest, res) => res.json(await service.rewards(req.user!.id)));
  app.post('/api/rewards/:unlockId/mint', auth, csrf, async (req: ApiRequest, res) => {
    const input = z.object({ recipient: z.string().min(1).max(128) }).strict().parse(req.body);
    const unlockId = z.string().uuid().parse(req.params.unlockId);
    if (canMint && options.mintLimit !== undefined) {
      const { total, own } = await db.read(async c => ({
        total: (await c.get<{ n: number }>('SELECT COUNT(*) AS n FROM mint_jobs'))!.n,
        own: await c.get('SELECT id FROM mint_jobs WHERE unlock_id=?', [unlockId]),
      }));
      if (!own && total >= options.mintLimit) throw new ApiError(503, 'MINT_LIMIT_REACHED', 'Лимит выпуска NFT на этом стенде исчерпан');
    }
    const create = () => service.mint(req.user!.id, unlockId, input.recipient, canMint);
    const mint = canMint && options.mintPermission
      ? await options.mintPermission.request({ userId: req.user!.id, unlockId, recipient: input.recipient }, create)
      : await create();
    res.status(202).json({ mint });
  });
  app.get('/api/operator/users', auth, operator, async (_req, res) => res.json({ users: await service.users() }));
  app.post('/api/operator/simulate', auth, operator, csrf, async (req, res) => {
    if (options.demoMode !== true) throw new ApiError(403, 'DEMO_DISABLED', 'Демонстрационный режим отключён');
    res.json(await service.simulate(scenarioSchema.parse(req.body)));
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'API-маршрут не найден')));
  const dist = options.webDistPath ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(`${dist}/index.html`)) {
    app.use(express.static(dist, { index: false }));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(`${dist}/index.html`));
  }
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Маршрут не найден')));
  const errors: ErrorRequestHandler = (error: unknown, req: ApiRequest, res, _next) => {
    let status = 500; let code = 'INTERNAL_ERROR'; let message = 'Внутренняя ошибка сервера';
    if (error instanceof ApiError) { status = error.status; code = error.code; message = error.message; }
    else if (error instanceof z.ZodError) { status = 400; code = 'INVALID_PAYLOAD'; message = fieldMessages[String(error.issues[0]?.path.at(-1))] ?? 'Некорректные данные запроса'; }
    else if ((error as { type?: string })?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_PAYLOAD'; message = 'Некорректные данные запроса'; }
    else if ((error as { type?: string })?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Слишком большой запрос'; }
    if (status === 500) console.error(`API request failed (${req.requestId}); internal error withheld from response.`);
    res.status(status).json({ error: { code, message, requestId: req.requestId } });
  };
  app.use(errors);
  if (options.startWorker && worker) {
    try { await worker.start(); } catch (error) { await app.close(); throw error; }
  }
  return app;
}
/** Понятная причина отказа по первому не прошедшему проверку полю; значения полей в ответ не попадают. */
const fieldMessages: Record<string, string> = {
  email: 'Укажите корректный адрес электронной почты',
  password: 'Пароль должен содержать от 8 до 128 символов',
  displayName: 'Укажите имя длиной до 80 символов',
  recipient: 'Укажите адрес получателя',
};
function validAddress(value: string | undefined): boolean { if (!value) return false; try { Address.parse(value); return true; } catch { return false; } }
