import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { THEMES, VIEWPORTS, SCENARIOS, openScenario, assertHealthy, exerciseScenario, captureStill } from './browser.mjs';
import { json, sourceEvidence, hashBundle, sha256 } from './evidence.mjs';
import { writeCaptureReport } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
if (args.some((a, i) => i % 2 === 0 && !['--scenario','--output','--port'].includes(a)) || args.length % 2) throw new Error('Use --scenario NAME --output NEW_DIR [--port PORT]');
const scenario = option('--scenario', 'conversation-long');
if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
const outputArg = option('--output');
if (!outputArg) throw new Error('--output NEW_DIR is required');
const output = path.resolve(outputArg);
const port = Number(option('--port', '1459'));
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 1420) throw new Error('Choose a developer port between 1024 and 65535, excluding 1420');
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // exclusive: never overwrite a previous evidence bundle
let server, browser;
let interrupted = false;
const stop = () => { interrupted = true; void browser?.close(); void server?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const manifest = { schemaVersion: 1, evidenceId: randomUUID(), scenario, startedAt: new Date().toISOString(), status: 'incomplete', captures: [], masks: [], desktopParity: 'pending' };
const checks = { passed: false, captures: [], errors: [] };
let failed;
try {
  manifest.source = await sourceEvidence(root, output);
  server = await createServer({ root, cacheDir: path.join(root, '.klide-design-cache/capture'), optimizeDeps: { entries: [path.join(root, 'preview/design-feedback.html')], include: ['@tauri-apps/api/mocks'] }, resolve: { dedupe: ['react', 'react-dom'] }, configFile: path.join(root, 'vite.config.ts'), server: { fs: { allow: [root, await realpath(path.join(root, 'node_modules'))] }, host: '127.0.0.1', port, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/src-tauri/**', '**/artifacts/**', `${output}/**`] } }, clearScreen: false });
  await server.listen();
  browser = await chromium.launch();
  manifest.environment = { browser: 'chromium', browserVersion: browser.version(), playwrightVersion: JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(path.join(root,'node_modules/playwright/package.json'), 'utf8'))).version, platform: os.platform(), release: os.release(), arch: os.arch(), locale: 'en-US', timezone: 'Europe/Paris', deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce', captureToolHash: sha256(JSON.stringify(Object.entries(manifest.source.files).filter(([file]) => file.startsWith('scripts/design-feedback/') || file === 'playwright.design.config.ts' || file === 'package-lock.json'))), viewports: VIEWPORTS, themes: THEMES };
  for (const theme of THEMES) for (const viewport of VIEWPORTS) {
    if (interrupted) throw new Error('Capture cancelled');
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Europe/Paris', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], consoleErrors = [], blockedRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${port}`) return route.continue();
      blockedRequests.push(url.origin); return route.abort();
    });
    const id = `${theme}-${viewport.width}x${viewport.height}`;
    try {
    await openScenario(page, `http://127.0.0.1:${port}`, scenario, theme);
    const facts = await assertHealthy(page);
    let accessibilityViolations = 0;
    const interactions = await exerciseScenario(page, scenario, async (state, stateFacts) => {
      await page.mouse.move(0, 0);
      const captureId = `${id}-${state}`;
      const png = `${captureId}.png`, aria = `${captureId}.aria.yml`;
      await captureStill(page, async bytes => {
      await writeFile(path.join(output, png), bytes);
      await writeFile(path.join(output, aria), await page.locator('body').ariaSnapshot());
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      accessibilityViolations += scan.violations.length;
      await json(path.join(output, `${captureId}-accessibility.json`), { violations: scan.violations, incomplete: scan.incomplete, passes: scan.passes.map(p => p.id) });
      manifest.captures.push({ id: captureId, theme, viewport, state, png, aria, facts: stateFacts });
      });
    });
    const finalFacts = await assertHealthy(page);
    await json(path.join(output, `${id}-console.json`), { errors, consoleErrors, blockedRequests });
    if (errors.length || consoleErrors.length || blockedRequests.length) throw new Error(`Page or network errors in ${id}: ${JSON.stringify({ errors, consoleErrors, blockedRequests })}`);
    checks.captures.push({ id, facts, finalFacts, interactions, accessibilityViolations });
    } finally {
      await json(path.join(output, `${id}-console.json`), { errors, consoleErrors, blockedRequests });
      await context.close();
    }
  }
  if ((await sourceEvidence(root)).treeHash !== manifest.source.treeHash) throw new Error('Source changed during capture; create a new bundle from one revision');
  checks.passed = true; manifest.status = 'complete';
} catch (error) {
  failed = error; checks.errors.push(String(error));
} finally {
  await browser?.close(); await server?.close();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  manifest.finishedAt = new Date().toISOString();
  await json(path.join(output, 'checks.json'), checks);
  await writeFile(path.join(output, 'desktop-parity.md'), '# Native desktop parity — pending\n\nBrowser captures do not establish WKWebView parity. No desktop pass is claimed.\n\n- [ ] Record source revision, macOS version, native build and content dimensions.\n- [ ] Use synthetic history matching this scenario.\n- [ ] Check both themes and both content sizes.\n- [ ] Expand/collapse tool history, scroll away and jump to latest.\n- [ ] Check long code scrolls internally and composer remains reachable.\n- [ ] Check keyboard focus, menu dismissal and focus return.\n- [ ] Record fixture drift, browser differences and defects.\n\nAffected scenarios cannot enter model trials until this gate passes.\n');
  await writeCaptureReport(output, manifest, checks);
  manifest.fileHashes = await hashBundle(output);
  await json(path.join(output, 'manifest.json'), manifest);
}
if (failed) { console.error(failed); process.exitCode = 1; }
console.log(`${manifest.status}: ${path.join(output, 'index.html')}`);
