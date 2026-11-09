import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { json, sha256, hashBundle } from './evidence.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const shell = body => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Klide design evidence</title><style>body{font:16px system-ui;margin:32px;background:#f7f5f0;color:#292e2a}h1{font-size:24px}section{margin:32px 0}img{max-width:100%;border:1px solid #ccc}.pair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}a{color:inherit}pre{white-space:pre-wrap}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style>${body}</html>`;
export const PERCEPTUAL = { threshold: 0.1, includeAA: false };
export async function writeCaptureReport(output, manifest, checks) {
  await writeFile(path.join(output, 'index.html'), shell(`<h1>Klide design evidence</h1><p>${escape(manifest.scenario)} · ${escape(manifest.status)}</p><p>Production AiPanel with synthetic data. Browser evidence; native desktop parity is pending. Pixel changes do not measure design quality.</p><p>Automated accessibility findings: ${checks.captures.reduce((n, c) => n + c.accessibilityViolations, 0)} across captured configurations. These are recorded findings, not a full accessibility audit.</p><p><a href="manifest.json">Manifest</a> · <a href="checks.json">Checks</a> · <a href="desktop-parity.md">Desktop checklist</a></p>${manifest.captures.map(c => `<section><h2>${escape(c.id)}</h2><a href="${c.png}"><img alt="${escape(c.id)}" src="${c.png}"></a><p><a href="${c.aria}">Accessible structure</a></p></section>`).join('')}<pre>${escape(JSON.stringify(checks, null, 2))}</pre>`));
}
export async function compareBundles(baselineDir, candidateDir, output) {
  const baseline = JSON.parse(await readFile(path.join(baselineDir, 'manifest.json')));
  const candidate = JSON.parse(await readFile(path.join(candidateDir, 'manifest.json')));
  for (const m of [baseline, candidate]) {
    if (m.status !== 'complete') throw new Error('Incomplete bundles cannot be compared');
    const actualFiles = await hashBundle(m === baseline ? baselineDir : candidateDir);
    if (Object.keys(actualFiles).sort().join('\n') !== Object.keys(m.fileHashes).sort().join('\n')) throw new Error('Evidence file set mismatch');
    for (const [file, hash] of Object.entries(m.fileHashes)) {
      if (sha256(await readFile(path.join(m === baseline ? baselineDir : candidateDir, file))) !== hash) throw new Error(`Evidence hash mismatch: ${file}`);
    }
  }
  const comparable = JSON.stringify(baseline.environment) === JSON.stringify(candidate.environment) && baseline.source.fixtureHash === candidate.source.fixtureHash && baseline.source.briefHash === candidate.source.briefHash && baseline.scenario === candidate.scenario;
  if (!comparable) throw new Error('Incomparable render environments, fixtures, briefs, or scenarios');
  if (baseline.captures.length !== candidate.captures.length) throw new Error('Capture sets differ');
  await mkdir(output); // never overwrite evidence
  const results = [];
  for (const b of baseline.captures) {
    const c = candidate.captures.find(c => c.id === b.id);
    if (!c) throw new Error(`Missing candidate capture: ${b.id}`);
    const bb = await readFile(path.join(baselineDir, b.png));
    const cb = await readFile(path.join(candidateDir, c.png));
    const bp = PNG.sync.read(bb), cp = PNG.sync.read(cb);
    if (bp.width !== cp.width || bp.height !== cp.height) throw new Error(`Image sizes differ: ${b.id}`);
    const diff = new PNG({ width: bp.width, height: bp.height });
    // Raw: any byte that moved. Perceptual: the declared tolerance below —
    // pixelmatch's default colour threshold, antialiased pixels excluded.
    // Both are reported; the tolerance is stated, never applied silently.
    const changedPixels = pixelmatch(bp.data, cp.data, diff.data, bp.width, bp.height, { threshold: 0 });
    const perceptualPixels = pixelmatch(bp.data, cp.data, null, bp.width, bp.height, PERCEPTUAL);
    await writeFile(path.join(output, `${b.id}-baseline.png`), bb);
    await writeFile(path.join(output, `${b.id}-candidate.png`), cb);
    await writeFile(path.join(output, `${b.id}-diff.png`), PNG.sync.write(diff));
    results.push({ id: b.id, changedPixels, perceptualPixels, totalPixels: bp.width * bp.height, identicalBytes: sha256(bb) === sha256(cb) });
  }
  await json(path.join(output, 'comparison.json'), { baseline: path.resolve(baselineDir), candidate: path.resolve(candidateDir), perceptualTolerance: PERCEPTUAL, results });
  await writeFile(path.join(output, 'index.html'), shell(`<h1>Baseline / candidate / pixel diff</h1><p>Identical rendering environments verified. A pixel difference records change, not improvement. Desktop parity remains a separate gate.</p>${results.map(r => `<section><h2>${escape(r.id)} · ${r.changedPixels} changed pixels · ${r.perceptualPixels} perceptual</h2><div class="pair">${['baseline','candidate','diff'].map(kind => `<figure><figcaption>${kind}</figcaption><img alt="${kind}" src="${r.id}-${kind}.png"></figure>`).join('')}</div></section>`).join('')}`));
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const get = key => args[args.indexOf(key) + 1];
  if (!['--baseline','--candidate','--output'].every(k => args.includes(k) && get(k))) throw new Error('Use --baseline DIR --candidate DIR --output NEW_DIR');
  console.log(await compareBundles(...['--baseline','--candidate','--output'].map(k => path.resolve(get(k)))));
}
