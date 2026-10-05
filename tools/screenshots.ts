/**
 * Снимает экраны интерфейса для пояснительной записки и презентации (docs/figures/screens).
 * Отдельный сервер на loopback, SQLite в памяти, сеть TON не используется: шлюз — заглушка,
 * обработчик очереди не запускается, заявки не отправляются.
 * Строка с выпущенным NFT — запись о реальном токене из docs/evidence/testnet-mint-trace.json,
 * внесённая в эту временную базу только для показа экрана; новый выпуск не выполняется.
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=... npx tsx tools/screenshots.ts
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright-core';
import { createApp } from '../apps/server/src/app.js';
import type { TonGateway } from '../apps/server/src/application/ports/ton-gateway.js';
import type { GameEvent } from '../apps/server/src/domain/achievements.js';

const out = fileURLToPath(new URL('../docs/figures/screens/', import.meta.url));
const dist = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const unavailable = async (): Promise<never> => { throw new Error('screenshots never touch the network'); };
const gateway: TonGateway = { nextIndex: unavailable, prepare: unavailable, send: unavailable, inspect: unavailable };
const port = 41733;
const base = `http://127.0.0.1:${port}`;
const app = await createApp({
  dbPath: ':memory:', demoMode: true, webDistPath: dist, allowedOrigins: [base], gateway, mintingEnabled: true, startWorker: false,
  collectionAddress: 'kQCNTqqdTbNus0PF8utf_031cWYG6hGlRJ1NAcM02nsUwAIs', walletAddress: '0QBmbGbnCIpGtv8OfOp_PopUS352-WCo8DZx0YJgng3nd7JF',
  rateLimits: { global: 5000, auth: 500, ingestion: 500 },
});
const server = createServer(app);
await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await firefox.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2, colorScheme: 'light' })).newPage();
  // Высота окна подгоняется под содержимое, чтобы боковая панель занимала всю высоту кадра.
  const shot = async (name: string) => {
    await page.setViewportSize({ width: 1360, height: 820 });
    const height = await page.evaluate(() => Math.max(820, document.documentElement.scrollHeight));
    await page.setViewportSize({ width: 1360, height });
    await page.screenshot({ path: `${out}${name}.png` });
    await page.setViewportSize({ width: 1360, height: 820 });
  };
  const register = async (name: string, email: string) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.hero-actions button.primary');
    await page.fill('input[name="displayName"]', name);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', 'screenshot-password-1');
    await page.click('form.form-stack button[type="submit"]');
    await page.waitForSelector('.summary-row');
  };
  const logout = async () => { await page.click('.logout-button'); await page.waitForSelector('.hero-actions'); };
  await page.goto(base, { waitUntil: 'networkidle' });
  await shot('scr_welcome');

  await register('Игрок Атласа', 'player@atlas.test');
  const player = (await app.services.users()).find(user => user.email === 'player@atlas.test')!;
  const send = (event: Omit<GameEvent, 'eventId' | 'playerId' | 'occurredAt'>, minute: number) => app.services.ingest(
    { ...event, eventId: `match-${1000 + minute}`, playerId: player.id, occurredAt: new Date(Date.now() - (30 - minute) * 60000).toISOString() } as GameEvent, 'trusted-game');
  await send({ type: 'match.completed', payload: { won: false } }, 2);
  await send({ type: 'match.completed', payload: { won: true } }, 9);
  await send({ type: 'combat.completed', payload: { kills: 64 } }, 10);
  await send({ type: 'xp.earned', payload: { xp: 450 } }, 11);
  await send({ type: 'match.completed', payload: { won: true } }, 24);
  await send({ type: 'combat.completed', payload: { kills: 41 } }, 25);
  await send({ type: 'xp.earned', payload: { xp: 380 } }, 26);
  // Запись о реальном NFT «Первый шаг» (TON testnet, индекс 0) — см. комментарий в начале файла.
  await app.services.db.transaction(async c => {
    const unlock = await c.get<{ id: string }>("SELECT id FROM unlocks WHERE user_id=? AND achievement_id='first_match'", [player.id]);
    const now = new Date().toISOString();
    await c.run("INSERT INTO mint_jobs(id,unlock_id,recipient,status,item_index,item_address,transaction_hash,created_at,updated_at) VALUES(?,?,?,'confirmed',0,?,?,?,?)",
      [randomUUID(), unlock!.id, 'kQBmbGbnCIpGtv8OfOp_PopUS352-WCo8DZx0YJgng3nd--A', '0:14e8d6863535b0ed8f49e707d89e22e458540fa695688139d88c617ae2e0da21',
        '4bcaba203a1d09f3250b7a58f13b7673548ab42ff152026f7e821a9f9a3560d4', now, now]);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.summary-row');
  await shot('scr_overview');
  await page.click('a[href="#/catalog"]');
  await page.waitForSelector('.mint-status.confirmed');
  await shot('scr_catalog');
  await page.click('.card-mint-details summary');
  await page.locator('.achievement-card:has(.mint-status.confirmed)').screenshot({ path: `${out}scr_confirmed.png` });
  await page.click('.card-mint-details summary');
  await page.click('.card-mint-button');
  await page.waitForSelector('dialog.modal input[name="recipient"]');
  await page.fill('input[name="recipient"]', '0QBmbGbnCIpGtv8OfOp_PopUS352-WCo8DZx0YJgng3nd7JF');
  await page.click('dialog.modal button[type="submit"]'); // шаг проверки адреса, заявка ещё не создаётся
  await page.waitForSelector('.confirmation-address');
  await page.locator('dialog.modal .modal-content').screenshot({ path: `${out}scr_mint_dialog.png` });
  await page.click('dialog.modal .icon-button'); // окно закрыто без создания заявки
  await page.click('a[href="#/events"]');
  await page.waitForSelector('.event-list');
  await shot('scr_events');
  await logout();

  await register('Демо-оператор', 'operator@atlas.test');
  await app.services.db.transaction(c => c.run("UPDATE users SET role='operator' WHERE email='operator@atlas.test'"));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('a[href="#/operator"]');
  await page.waitForSelector('select');
  await page.selectOption('select', player.id);
  await page.click('label:has-text("10 матчей")');
  await page.click('button:has-text("Запустить сценарий")');
  await page.waitForSelector('text=Сценарий обработан');
  await shot('scr_operator');
  if ((await app.services.db.read(c => c.all('SELECT id FROM mint_jobs'))).length !== 1) throw new Error('Screenshots must not create mint jobs');
  console.log('Экраны сохранены в docs/figures/screens');
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await app.close();
}
