import { test, expect } from '@playwright/test';
// @ts-expect-error development-only JS runner shares the same checks
import { openScenario, assertHealthy, exerciseConversation, exerciseScenario, captureStill, THEMES } from '../../scripts/design-feedback/browser.mjs';
for (const theme of THEMES) {
  test(`long conversation — ${theme}`, async ({ page, baseURL }) => {
    await openScenario(page, baseURL, 'conversation-long', theme);
    await assertHealthy(page);
    await exerciseConversation(page);
  });
}
test('detects an injected overflow regression', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'conversation-long', 'klide-light');
  await assertHealthy(page);
  await page.addStyleTag({ content: 'html::after { content:"overflow"; display:block; width:3000px; height:1px }' });
  await expect(assertHealthy(page)).rejects.toThrow('Document must not overflow');
});
test('unknown scenario fails explicitly', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/preview/design-feedback.html?scenario=unknown`);
  await expect(page.locator('#root')).toContainText('Unknown scenario: unknown');
});
test('composer enables send and reset removes the draft', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'compose-empty', 'klide-light');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole('textbox').fill('Synthetic draft');
  await expect(send).toBeEnabled();
  await page.evaluate(async () => { await (window as any).__designFeedback.reset(); });
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(send).toBeDisabled();
  await assertHealthy(page);
});
test('a caught native error still invalidates capture', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'conversation-long', 'klide-light');
  await page.evaluate(async () => {
    try { await (window as any).__TAURI_INTERNALS__.invoke('unimplemented-design-boundary'); } catch { /* production may catch errors */ }
  });
  await expect(assertHealthy(page)).rejects.toThrow('Native fixture must cover every boundary');
});
test('rejects a missing required font', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'conversation-long', 'klide-light');
  await page.evaluate(() => { document.querySelectorAll('style[data-vite-dev-id*="@fontsource"]').forEach(style => style.remove()); });
  await expect(assertHealthy(page)).rejects.toThrow();
});
test('reset restores the same transcript and rejects unknown states', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'conversation-long', 'klide-light');
  const messages = await page.locator('[data-conversation-message]').allTextContents();
  await page.evaluate(async () => { await (window as any).__designFeedback.reset(); });
  await expect.poll(() => page.locator('[data-conversation-message]').allTextContents()).toEqual(messages);
  await expect(page.evaluate(async () => { await (window as any).__designFeedback.setState('bad'); })).rejects.toThrow('Unknown state');
});

for (const scenario of ['tools-and-review', 'waiting-and-error', 'subagent-activity', 'composer-menu', 'result-and-diff']) {
  for (const theme of THEMES) {
    test(`${scenario} — ${theme}`, async ({ page, baseURL }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await openScenario(page, baseURL, scenario, theme);
      await assertHealthy(page);
      await exerciseScenario(page, scenario);
      expect(errors).toEqual([]);
    });
  }
}

for (const scenario of ['tools-and-review', 'waiting-and-error', 'subagent-activity', 'composer-menu', 'result-and-diff']) {
  test(`${scenario} resets to a ready, reproducible initial state`, async ({ page, baseURL }) => {
    await openScenario(page, baseURL, scenario, 'klide-light');
    await exerciseScenario(page, scenario);
    await page.evaluate(() => (window as any).__designFeedback.reset());
    expect(await page.evaluate(() => (window as any).__designFeedback.status)).toBe('ready');
    expect(await page.evaluate(() => (window as any).__designFeedback.native.actions)).toEqual([]);
    if (scenario === 'tools-and-review') await expect(page.getByRole('button', { name: 'Run (↵)', exact: true })).toBeVisible();
    if (scenario === 'waiting-and-error') await expect(page.getByRole('button', { name: /SQLite — local file/ })).toBeVisible();
    if (scenario === 'subagent-activity') await expect(page.locator('.klide-subagent-tray').getByRole('img', { name: 'running', exact: true })).toHaveCount(1);
    if (scenario === 'result-and-diff') await expect(page.locator('.klide-result-island').getByRole('group', { name: 'Diff' })).toHaveCount(0);
    if (scenario === 'composer-menu') {
      await expect(page.getByRole('textbox', { name: 'Filter models', exact: true })).toBeFocused();
      await expect(page.locator('button[aria-haspopup="listbox"]')).toHaveText(/fixture-vision/);
    }
    await assertHealthy(page);
  });
}

test('rejected-edit captures settle and preserve layout across resets', async ({ page, baseURL }) => {
  await openScenario(page, baseURL, 'tools-and-review', 'klide-light');
  const layouts: unknown[] = [];
  for (let round = 0; round < 4; round++) {
    if (round) await page.evaluate(() => (window as any).__designFeedback.reset());
    await exerciseScenario(page, 'tools-and-review', async (state: string) => {
      if (state !== 'rejected') return;
      const image = await captureStill(page, async () => {
        layouts.push(await page.locator('[data-conversation-message]').evaluateAll(elements => elements.map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() }))));
      });
      expect(image.length).toBeGreaterThan(1000);
    });
  }
  expect(layouts).toHaveLength(4);
  expect(layouts.every(layout => JSON.stringify(layout) === JSON.stringify(layouts[0]))).toBe(true);
});
