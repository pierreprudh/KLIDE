import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const SOURCE_PATHS = ['src', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/tauri.design-parity.conf.json', 'vite.design-parity.config.mjs', 'schemas', 'preview', 'scripts', 'tests', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.design.config.ts', 'tsconfig.design.json', 'tsconfig.json', 'Design.md'];
export async function sourceEvidence(root) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const list = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]).toString().split('\0').filter(Boolean);
  const files = [...new Set(list)].sort();
  const hashes = {};
  for (const file of files) {
    try { hashes[file] = sha256(await readFile(path.join(root, file))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; } // deleted paths are retained in the patch
  }
  const patch = git(['diff', '--binary', 'HEAD', '--', ...SOURCE_PATHS]);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]).toString().split('\0').filter(Boolean);
  const fixtureFiles = Object.entries(hashes).filter(([file]) => file.startsWith('preview/design-feedback'));
  return { commit: git(['rev-parse', 'HEAD']).toString().trim(), treeHash: sha256(JSON.stringify(hashes)), files: hashes,
    patchHash: sha256(patch), untrackedInputs: untracked, fixtureHash: sha256(JSON.stringify(fixtureFiles)),
    scope: SOURCE_PATHS }; // the brief belongs to an experiment (its config's briefSha256), not to a capture
}
// Files every capture depends on whether or not the page imports them.
const TOOLING = /^(scripts\/design-feedback\/|preview\/design-feedback|playwright\.design\.config\.ts$|vite\.config\.ts$|package(-lock)?\.json$|tsconfig[\w.]*\.json$)/;
// What one capture actually read: the modules Vite served plus the tooling.
// Edits elsewhere in a shared checkout cannot change these screenshots.
export function captureInputs(root, servedFiles, evidence) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const served = new Set([...servedFiles].filter(f => f.startsWith(prefix)).map(f => path.relative(root, f).split(path.sep).join('/')));
  return Object.keys(evidence.files).filter(f => served.has(f) || (TOOLING.test(f) && !f.endsWith('.md'))).sort();
}
// Fails when any captured input changed between the two snapshots.
export function changedInputs(inputs, before, after) {
  return inputs.filter(f => before.files[f] !== after.files[f]);
}
// Reproduction aids limited to what the capture read: the patch of those
// files against HEAD, and copies of the untracked ones.
export async function writeCaptureInputs(root, output, inputs, evidence) {
  const patch = inputs.length ? execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...inputs], { cwd: root, maxBuffer: 32 * 1024 * 1024 }) : Buffer.alloc(0);
  await writeFile(path.join(output, 'source.patch'), patch);
  const copied = evidence.untrackedInputs.filter(f => inputs.includes(f));
  for (const file of copied) {
    const destination = path.join(output, 'source-inputs', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  return { capturePatchHash: sha256(patch), copiedInputs: copied };
}
export async function hashBundle(directory, prefix = '') {
  const hashes = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(hashes, await hashBundle(path.join(directory, entry.name), relative + '/'));
    else if (relative !== 'manifest.json') hashes[relative] = sha256(await readFile(path.join(directory, entry.name)));
  }
  return hashes;
}
