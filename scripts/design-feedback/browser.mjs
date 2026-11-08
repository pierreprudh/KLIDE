import { expect } from '@playwright/test';
export const THEMES = ['klide-light', 'sage-garden-dark'];
export const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 900, height: 700 }];
export const SCENARIOS = ['conversation-long', 'compose-empty', 'tools-and-review', 'waiting-and-error', 'subagent-activity', 'composer-menu', 'result-and-diff'];
export const FIXED_TIME = 1793952000000;
export const COMPOSER = 'textarea[data-ai-composer="true"]';
export const SCROLLER = '[style*="overflow-anchor: none"]';

export async function openScenario(page, baseURL, scenario, theme) {
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(`${baseURL}/preview/design-feedback.html?${new URLSearchParams({ scenario, theme })}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__designFeedback?.error || window.__designFeedback?.status === "ready");
  await page.evaluate(async () => {
    const api = window.__designFeedback;
    if (api.error) throw new Error(api.error);
    await api.ready;
  });
  await expect(page.locator(COMPOSER)).toBeVisible();
}

export async function assertHealthy(page) {
  const facts = await page.evaluate(() => {
    const fonts = ['400 14px "Atkinson Hyperlegible"', '700 14px "Atkinson Hyperlegible"', '400 14px "Monaspace Neon"', '700 14px "Monaspace Neon"'];
    const native = window.__designFeedback.native;
    return {
      rootText: document.getElementById('root').innerText.trim().length,
      fonts: fonts.map(font => ({ font, loaded: document.fonts.check(font) })),
      loadedFamilies: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      nativeCalls: [...new Set(native.calls)].sort(),
      nativeActions: native.actions.map(({ command, payload }) => ({ command, decision: payload.decision, runId: payload.runId, request: payload.request ? { runId: payload.request.runId, retry: payload.request.retry, provider: payload.request.provider, model: payload.request.model } : undefined })),
      unexpected: native.unexpected,
    };
  });
  expect(facts.rootText, 'Root must not be blank').toBeGreaterThan(10);
  expect(facts.fonts.every(f => f.loaded), 'Required font weights must be loaded').toBe(true);
  expect(facts.loadedFamilies.some(f => f.includes('Atkinson'))).toBe(true);
  expect(facts.loadedFamilies.some(f => f.includes('Monaspace'))).toBe(true);
  expect(facts.documentOverflow, 'Document must not overflow horizontally').toBe(false);
  expect(facts.unexpected, 'Native fixture must cover every boundary').toEqual([]);
  const composer = await page.locator(COMPOSER).boundingBox();
  expect(composer, 'Composer must exist').not.toBeNull();
  expect(composer.y).toBeGreaterThanOrEqual(0);
  expect(composer.y + composer.height).toBeLessThanOrEqual(page.viewportSize().height);
  return facts;
}

export async function exerciseConversation(page) {
  const scroll = page.locator(SCROLLER);
  await expect(scroll).toBeVisible();
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: 'Jump to latest message' })).toBeVisible();
  const fold = page.locator('.klide-tool-run-row').first();
  await expect(fold).toBeVisible();
  await fold.click();
  await expect(page.locator('.klide-tool-run-body[data-open="true"]')).toBeVisible();
  await expect(page.getByText('Read fixture 1:', { exact: false }).first()).toBeVisible();
  await fold.click();
  await expect(page.locator('.klide-tool-run-body[data-open="false"]')).toBeAttached();
  await page.getByRole('button', { name: 'Jump to latest message' }).click();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
  const pre = page.locator('pre').filter({ hasText: 'const observation1 =' }).first();
  expect(await pre.evaluate(el => el.scrollWidth > el.clientWidth), 'Fixture must exercise long code').toBe(true);
  expect(await pre.evaluate(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))).toBe(true);
  await assertHealthy(page);
}

const actions = page => page.evaluate(() => window.__designFeedback.native.actions);
const reset = async page => {
  await page.evaluate(() => window.__designFeedback.reset());
  await expect.poll(() => page.evaluate(() => window.__designFeedback.native.unexpected)).toEqual([]);
};

/** Exercise real production controls and capture each named state only after
 * its observable outcome. The mock never executes commands or edits files. */
export async function exerciseScenario(page, scenario, capture = async () => {}) {
  const save = async state => { const facts = await assertHealthy(page); await capture(state, facts); };
  if (scenario === 'conversation-long') {
    await exerciseConversation(page);
    await save('latest');
    await page.locator(SCROLLER).evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(page.getByRole('button', { name: 'Jump to latest message' })).toBeVisible();
    await save('earlier');
    return ['tool fold expands and collapses', 'scroll away and jump to latest', 'long code scrolls internally'];
  }
  if (scenario === 'compose-empty') {
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled();
    await page.locator(COMPOSER).fill('Review this synthetic conversation');
    await expect(send).toBeEnabled();
    await page.locator(COMPOSER).fill('');
    await expect(send).toBeDisabled();
    await save('empty');
    return ['typing enables Send', 'clearing disables Send'];
  }
  if (scenario === 'tools-and-review') {
    const run = page.getByRole('button', { name: 'Run (↵)', exact: true });
    await expect(run).toBeVisible();
    await expect(page.getByText('Run the synthetic workspace checks.', { exact: true })).toBeVisible();
    await save('permission');
    const working = page.getByRole('button', { name: /^Working/ });
    await working.click();
    await expect(page.getByText('Bindings inspected:', { exact: false }).first()).toBeVisible();
    await save('tool-output');
    await working.click();
    await run.click();
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeVisible();
    await expect.poll(async () => (await actions(page)).find(a => a.command === 'agent_resolve_permission')?.payload.decision).toMatchObject({ requestId: 'fixture-permission', decision: { behavior: 'allow', scope: 'once' } });
    await save('diff');
    await page.getByRole('button', { name: 'Open changes', exact: true }).click();
    await expect(page.getByText('export const menuEscape = true;', { exact: false }).first()).toBeVisible();
    await save('diff-expanded');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('The proposed edit was rejected. No workspace files were changed.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await actions(page)).find(a => a.command === 'agent_resolve_diff')?.payload.decision).toMatchObject({ proposalId: 'fixture-diff', decision: { behavior: 'reject' } });
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0);
    await save('rejected');
    return ['permission response reaches the pending command', 'diff expands', 'rejection reaches the pending edit', 'rejected edit settles without writes'];
  }
  if (scenario === 'waiting-and-error') {
    const first = page.getByRole('button', { name: /SQLite — local file/ });
    await expect(first).toBeVisible();
    await first.focus();
    await save('question');
    await first.press('ArrowDown');
    await expect(page.getByRole('button', { name: /Postgres — shared service/ })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect.poll(async () => (await actions(page)).find(a => a.command === 'agent_resolve_question')?.payload.decision).toMatchObject({ requestId: 'fixture-question', answer: 'SQLite — local file' });
    await save('error');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Recovered successfully. The selected storage is SQLite — local file.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await actions(page)).find(a => a.command === 'agent_start_run')?.payload.request.retry).toBe(true);
    await save('recovered');
    await reset(page);
    await expect(first).toBeVisible();
    await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await expect.poll(async () => (await actions(page)).some(a => a.command === 'agent_abort_run')).toBe(true);
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0);
    await expect(first).toHaveCount(0);
    await save('cancelled');
    return ['answer choices support arrows and Enter', 'selected answer reaches the question', 'retry explicitly resumes after provider failure', 'Stop clears the pending question'];
  }
  if (scenario === 'subagent-activity') {
    const tray = page.locator('.klide-subagent-tray');
    const header = tray.getByRole('button', { name: /4 sub-agents/ });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(tray.getByRole('img', { name: 'running', exact: true })).toHaveCount(1);
    await expect(tray.getByRole('img', { name: 'done', exact: true })).toHaveCount(1);
    await expect(tray.getByRole('img', { name: 'failed', exact: true })).toHaveCount(1);
    await expect(tray.getByRole('img', { name: 'ended', exact: true })).toHaveCount(1);
    await save('mixed');
    await tray.getByRole('button', { name: /Inspect transcript wrapping/ }).click();
    await expect(tray.getByText('Synthetic evidence for Inspect transcript wrapping.', { exact: false }).first()).toBeVisible();
    await save('child-details');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(tray.locator('.klide-subagent-rows')).toHaveAttribute('inert', '');
    await save('collapsed');
    await page.evaluate(() => window.__designFeedback.native.settleChildren());
    await expect(page.getByText('All explorers have settled.', { exact: false })).toBeVisible();
    await header.click();
    await expect(tray.getByRole('img', { name: 'done', exact: true })).toHaveCount(2);
    await expect(tray.getByRole('img', { name: 'running', exact: true })).toHaveCount(0);
    await save('settled');
    return ['mixed child statuses remain distinct', 'child steps use the production fold', 'collapsed tray is inert', 'live child completion updates the tray'];
  }
  if (scenario === 'composer-menu') {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    const filter = page.getByRole('textbox', { name: 'Filter models', exact: true });
    await expect(filter).toBeFocused();
    await save('menu-open');
    await filter.press('ArrowDown');
    await filter.press('Enter');
    await expect(trigger).toHaveText(/fixture-fast/);
    await expect(trigger).toBeFocused();
    await expect(filter).toHaveCount(0);
    await save('model-selected');
    await trigger.click();
    await expect(filter).toBeFocused();
    await filter.fill('fixture-reasoning');
    await expect(page.getByRole('option')).toHaveCount(1);
    await save('menu-filtered');
    await filter.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(filter).toHaveCount(0);
    await expect(trigger).toHaveText(/fixture-fast/);
    await save('menu-dismissed');
    return ['opening focuses the filter', 'arrows and Enter select a model', 'filter narrows the model list', 'Escape restores trigger focus and preserves selection'];
  }
  if (scenario === 'result-and-diff') {
    // End-to-end review run: README.md approved, "Validate all" on notes/a.md,
    // notes/b.md applied by policy. The result card must fold what was read,
    // open what wasn't, wrap long lines and scroll as one.
    const card = page.locator('.klide-result-island');
    const row = name => card.locator('button.klide-result-change', { hasText: name });
    const reviewedLabel = name => card.locator('.klide-result-file', { has: page.locator('button.klide-result-change', { hasText: name }) }).locator('.klide-result-reviewed');
    await expect(card).toBeVisible();
    await expect(card.getByText('3 files changed', { exact: true })).toBeVisible();
    await expect(reviewedLabel('README.md')).toHaveText('reviewed');
    await expect(reviewedLabel('a.md')).toHaveText('reviewed');
    await expect(reviewedLabel('b.md')).toHaveCount(0);
    await save('result');
    await card.getByRole('button', { name: 'See changes', exact: true }).click();
    await expect(row('b.md')).toHaveAttribute('aria-expanded', 'true');
    await expect(row('README.md')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('a.md')).toHaveAttribute('aria-expanded', 'false');
    const diff = card.getByRole('group', { name: 'Diff' });
    await expect(diff).toHaveCount(1);
    expect(await diff.evaluate(el => el.scrollWidth > el.clientWidth + 1), 'Diff must not scroll sideways').toBe(false);
    expect((await diff.getByText(/^- Item 1: a deliberately long sentence/).boundingBox()).height, 'A long line wraps in view').toBeGreaterThan(30);
    expect(await diff.evaluate(el => [el, ...el.querySelectorAll('*')].some(n => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1)), 'No scroll inside the diff').toBe(false);
    await save('result-diff');
    // The card body is the one scroll; the open file's row stays at its top.
    const body = card.locator('.klide-result-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight), 'The card body scrolls').toBe(true);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event('scroll')); });
    // Pinned at the top of the scroll area: the body's edge plus its padding.
    const pinnedAt = await body.evaluate(el => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop));
    await expect.poll(async () => Math.abs((await row('b.md').boundingBox()).y - pinnedAt)).toBeLessThan(1);
    await save('result-scrolled');
    await card.getByRole('button', { name: 'Hide changes', exact: true }).click();
    await expect(diff).toHaveCount(0);
    await row('README.md').click();
    await expect(row('README.md')).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('group', { name: 'Diff' }).getByText(/reset with/)).toBeVisible();
    await save('reviewed-opened');
    return ['approved and Validate-all files read as reviewed, the auto-applied one does not', 'See changes opens only the unreviewed file', 'long lines wrap with no sideways or nested scroll', 'the card scrolls as one and the open row stays pinned', 'a reviewed file still opens from its row'];
  }
  throw new Error(`Unknown scenario: ${scenario}`);
}

/** Freeze motion only while recording a still; interaction checks run with
 * production styles. Wait for consecutive identical paints rather than masking
 * changing pixels or accepting a screenshot captured during a transition. */
export async function captureStill(page, consume = async () => {}) {
  await page.mouse.move(0, 0);
  const style = await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
  try {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    let previous = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const current = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      if (current.equals(previous)) { await consume(current); return current; }
      previous = current;
    }
    throw new Error('Rendered state did not settle to consecutive identical screenshots');
  } finally {
    await style.evaluate(element => element.remove());
  }
}
