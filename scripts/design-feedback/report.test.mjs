import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { compareBundles } from './report.mjs';
import { hashBundle, json } from './evidence.mjs';
const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function pair() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klide-design-evidence-'));
  temporary.push(root);
  async function bundle(name, white = false, environment = { browser: 'fixture' }) {
    const dir = path.join(root, name); await mkdir(dir);
    const png = new PNG({ width: 8, height: 8 });
    png.data.fill(white === true ? 255 : white || 0);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    await writeFile(path.join(dir, 'view.png'), PNG.sync.write(png));
    await json(path.join(dir, 'manifest.json'), { schemaVersion: 1, status: 'complete', scenario: 'conversation-long', environment, source: { fixtureHash: 'fixture-v1', briefHash: 'brief-v1' }, captures: [{ id: 'view', png: 'view.png' }], fileHashes: await hashBundle(dir) });
    return dir;
  }
  return { root, bundle, output: path.join(root, 'comparison') };
}
describe('evidence comparison', () => {
  it('reports identical captures without invented improvement scores', async () => {
    const { bundle, output } = await pair();
    const result = await compareBundles(await bundle('a'), await bundle('b'), output);
    expect(result[0]).toMatchObject({ changedPixels: 0, identicalBytes: true });
  });
  it('produces a pixel diff when the candidate changes', async () => {
    const { bundle, output } = await pair();
    const result = await compareBundles(await bundle('a'), await bundle('b', true), output);
    expect(result[0]).toMatchObject({ changedPixels: 64, perceptualPixels: 64, identicalBytes: false });
  });
  it('reports a sub-threshold shift as raw change but not perceptual change', async () => {
    const { bundle, output } = await pair();
    const result = await compareBundles(await bundle('a'), await bundle('b', 2), output);
    expect(result[0]).toMatchObject({ changedPixels: 64, perceptualPixels: 0, identicalBytes: false });
  });
  it('refuses modified evidence', async () => {
    const { bundle, output } = await pair();
    const a = await bundle('a'), b = await bundle('b');
    await writeFile(path.join(b, 'view.png'), 'tampered');
    await expect(compareBundles(a, b, output)).rejects.toThrow('Evidence hash mismatch');
  });
  it('refuses comparisons from a different render environment', async () => {
    const { bundle, output } = await pair();
    await expect(compareBundles(await bundle('a'), await bundle('b', false, { browser: 'different' }), output)).rejects.toThrow('Incomparable');
  });
  it('refuses incomplete evidence and existing output directories', async () => {
    const { bundle, output } = await pair();
    const a = await bundle('a'), b = await bundle('b');
    await mkdir(output);
    await expect(compareBundles(a, b, output)).rejects.toThrow('EEXIST');
    await json(path.join(b, 'manifest.json'), { status: 'incomplete' });
    await expect(compareBundles(a, b, path.join(output, 'new'))).rejects.toThrow('Incomplete');
  });
});
