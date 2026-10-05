import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, readdir, readFile, readlink } from 'node:fs/promises';
import { chromium, firefox, type Browser } from 'playwright-core';
import { createApp } from '../apps/server/src/app.js';

async function verifyFirefoxSandbox() {
  if (process.platform !== 'linux') return;
  if (!process.getuid || process.getuid() === 0) throw new Error('Firefox E2E must run as an unprivileged user');
  const processes = new Map<number, { parent: number; name: string; seccomp: string; noNewPrivs: string }>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      if (await readlink(`/proc/${entry}/exe`) !== firefox.executablePath()) continue;
      const field = (name: string) => status.match(new RegExp(`^${name}:\\s+(.+)$`, 'm'))?.[1]?.trim() ?? '';
      if (Number(field('Uid').split(/\s+/)[0]) !== process.getuid()) continue;
      processes.set(Number(entry), { parent: Number(field('PPid')), name: field('Name'), seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    }
  }
  const content = [...processes.entries()].filter(([pid, info]) => {
    if (!/^(Web Content|Isolated Web|Privileged Cont)/.test(info.name)) return false;
    const visited = new Set<number>();
    while (pid !== process.pid) {
      if (visited.has(pid)) return false;
      visited.add(pid);
      const parent = processes.get(pid)?.parent;
      if (!parent) return false;
      pid = parent;
    }
    return true;
  });
  if (!content.length || content.some(([, info]) => info.seccomp !== '2' || info.noNewPrivs !== '1')) {
    throw new Error('Firefox web content sandbox was not verified');
  }
  console.log('[E2E] Firefox content sandbox verified:', JSON.stringify(content.map(([pid, info]) => ({ pid, ...info }))));
}

async function runE2E() {
  console.log('--- Starting Achievement Atlas End-to-End Test ---');
  const browserName = process.env.E2E_BROWSER ?? 'chromium';
  if (browserName !== 'chromium' && browserName !== 'firefox') throw new Error('E2E_BROWSER must be chromium or firefox');
  if (browserName === 'firefox' && Object.keys(process.env).some(key => /^MOZ_DISABLE_.*SANDBOX$/.test(key))) {
    throw new Error('Sandbox-disabling environment variables are forbidden');
  }
  const evidenceDir = process.env.E2E_EVIDENCE_DIR ? resolve(process.env.E2E_EVIDENCE_DIR) : undefined;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

  const gameKey = 'e2e-secret-game-key';
  const webDist = resolve('apps/web/dist');

  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.listen(0, '127.0.0.1', () => resolveReady());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind server');
  const port = address.port;
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[E2E] Server target baseUrl: ${baseUrl}`);

  // 1. Create and start test server with correct allowedOrigins
  const app = await createApp({
    dbPath: ':memory:',
    gameKey,
    gameSource: 'e2e-test-game',
    demoMode: true,
    webDistPath: webDist,
    allowedOrigins: [baseUrl, `http://localhost:${port}`],
    rateLimits: { global: 1000, auth: 100, ingestion: 100 },
  });

  const appServer = createServer(app);
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      appServer.listen(port, '127.0.0.1', () => resolveReady());
      appServer.once('error', reject);
    });
    browser = browserName === 'firefox'
      ? await firefox.launch({ headless: true })
      : await chromium.launch({
        executablePath: '/usr/bin/chromium',
        headless: true,
        chromiumSandbox: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu'],
      });
    console.log(`[E2E] Browser: ${browserName} ${browser.version()}`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const capture = async (name: string) => {
      if (evidenceDir) await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), fullPage: true });
    };
    const browserErrors: string[] = [];
    page.on('pageerror', err => browserErrors.push(err.message));
    // 3. Open welcome page
    console.log('[E2E] Step 1: Navigating to homepage...');
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const title = await page.title();
    console.log(`[E2E] Page title: "${title}"`);
    if (!title.includes('Achievement Atlas')) throw new Error(`Unexpected page title: ${title}`);

    // Check brand
    const brand = await page.locator('.brand strong').textContent();
    console.log(`[E2E] Brand text: "${brand?.trim()}"`);
    await page.waitForSelector('.hero-actions button.primary');
    if (browserName === 'firefox') await verifyFirefoxSandbox();
    await capture('01-welcome');

    // 4. Open registration modal
    console.log('[E2E] Step 2: Registering new player...');
    const registerBtn = page.locator('.hero-actions button.primary').first();
    await registerBtn.click();
    await page.waitForSelector('form.form-stack');

    // Fill registration form
    await page.fill('input[name="displayName"]', 'Игрок Тестовый');
    await page.fill('input[name="email"]', 'test-hero@atlas.internal');
    await page.fill('input[name="password"]', 'SuperStrongSecret123!');
    await page.click('form.form-stack button[type="submit"]');

    // 5. Verify user session created
    console.log('[E2E] Step 3: Verifying authenticated user state...');
    await page.waitForSelector('.account-identity');
    const userText = await page.locator('.account-identity strong').textContent();
    console.log(`[E2E] Authenticated user: "${userText?.trim()}"`);
    if (!userText?.includes('Игрок Тестовый')) throw new Error(`User name mismatch: ${userText}`);

    // Verify summary stats row is visible
    await page.waitForSelector('.summary-row');
    const summaryStats = page.locator('.summary-row div');
    const statsCount = await summaryStats.count();
    console.log(`[E2E] Summary metric items displayed: ${statsCount}`);
    if (statsCount !== 4) throw new Error(`Expected 4 stats (matches, wins, kills, xp), got ${statsCount}`);

    // Retrieve user id from server DB
    const users = await app.services.users();
    const player = users.find(u => u.email === 'test-hero@atlas.internal');
    if (!player) throw new Error('Player not found in database');
    console.log(`[E2E] Verified user in DB with ID: ${player.id}`);

    // 6. Ingest game event via trusted server API
    console.log('[E2E] Step 4: Ingesting game event via trusted server API...');
    const ingestRes = await fetch(`${baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Game-Key': gameKey },
      body: JSON.stringify({
        eventId: 'e2e-match-1',
        playerId: player.id,
        type: 'match.completed',
        payload: { won: true },
        occurredAt: new Date().toISOString(),
      }),
    });

    if (!ingestRes.ok) {
      const err = await ingestRes.text();
      throw new Error(`Ingestion failed (${ingestRes.status}): ${err}`);
    }
    const ingestResult = await ingestRes.json();
    console.log('[E2E] Event ingestion result:', JSON.stringify(ingestResult));

    // 7. Refresh UI and verify progress
    console.log('[E2E] Step 5: Refreshing UI and verifying progress...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.summary-row');

    // Check updated stats
    const statsText = await page.locator('.summary-row').textContent();
    console.log(`[E2E] Updated stats text: "${statsText}"`);
    const counters = await page.locator('.summary-row dd').allTextContents();
    if (JSON.stringify(counters.map(value => value.trim())) !== JSON.stringify(['1', '1', '0', '0'])) {
      throw new Error(`Unexpected counters: ${JSON.stringify(counters)}`);
    }
    const forbidden = await context.request.get(`${baseUrl}/api/operator/users`);
    if (forbidden.status() !== 403) throw new Error('Player must not access operator users');
    await capture('02-overview');

    // 8. Test Navigation to Catalog
    console.log('[E2E] Step 6: Navigating to Catalog...');
    await page.click('a[href="#/catalog"]');
    await page.waitForSelector('.achievement-grid');
    const catalogCards = page.locator('.achievement-card');
    const cardCount = await catalogCards.count();
    console.log(`[E2E] Catalog items count: ${cardCount}`);
    if (cardCount !== 6) throw new Error(`Expected 6 catalog achievements, got ${cardCount}`);
    await capture('03-catalog');

    // 9. Test Navigation to Rewards
    console.log('[E2E] Step 7: Checking NFT area of unlocked achievements...');
    const rewardCards = page.locator('.achievement-card.unlocked .card-mint');
    const rewardCount = await rewardCards.count();
    console.log(`[E2E] Unlocked rewards count: ${rewardCount}`);
    if (rewardCount !== 2) throw new Error(`Expected first-match and first-victory rewards, got ${rewardCount}`);

    // 10. Test Navigation to Events
    console.log('[E2E] Step 8: Navigating to Events History...');
    await page.click('a[href="#/events"]');
    await page.waitForSelector('.event-list');
    const eventItems = page.locator('.event-list li');
    const eventCount = await eventItems.count();
    console.log(`[E2E] Events count: ${eventCount}`);
    if (eventCount !== 1) throw new Error(`Expected exactly one recorded event, got ${eventCount}`);
    await capture('04-events');

    // 11. Test Logout
    console.log('[E2E] Step 9: Logging out...');
    const logoutBtn = page.locator('.logout-button');
    await logoutBtn.click();
    await page.waitForSelector('.hero-actions button.primary');
    console.log('[E2E] Successfully logged out to public state.');

    if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join('; ')}`);
    if (browserName === 'firefox') await verifyFirefoxSandbox();
    await capture('05-logged-out');
    console.log('=== ALL E2E USER JOURNEYS PASSED SUCCESSFULLY ===');
  } finally {
    try { await browser?.close(); }
    finally {
      try { await new Promise<void>(resolveClosed => appServer.close(() => resolveClosed())); }
      finally { await app.close(); }
    }
  }
}

runE2E().catch((err) => {
  console.error('[E2E FATAL ERROR]', err);
  process.exit(1);
});
