import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const SOURCE_PATHS = ['src', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/tauri.design-parity.conf.json', 'vite.design-parity.config.mjs', 'schemas', 'preview', 'scripts', 'tests', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.design.config.ts', 'tsconfig.design.json', 'tsconfig.json', 'Design.md', 'docs/DESIGN_AGENT_PLAN.md'];
export async function sourceEvidence(root, output) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const list = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]).toString().split('\0').filter(Boolean);
  const files = [...new Set(list)].sort();
  const hashes = {};
  for (const file of files) {
    try { hashes[file] = sha256(await readFile(path.join(root, file))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; } // deleted paths are retained in the patch
  }
  const patch = git(['diff', '--binary', 'HEAD', '--', ...SOURCE_PATHS]);
  if (output) await writeFile(path.join(output, 'source.patch'), patch);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]).toString().split('\0').filter(Boolean);
  if (output) for (const file of untracked) {
    const destination = path.join(output, 'source-inputs', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  const fixtureFiles = Object.entries(hashes).filter(([file]) => file.startsWith('preview/design-feedback'));
  return { commit: git(['rev-parse', 'HEAD']).toString().trim(), treeHash: sha256(JSON.stringify(hashes)), files: hashes,
    patchHash: sha256(patch), untrackedInputs: untracked, fixtureHash: sha256(JSON.stringify(fixtureFiles)),
    briefHash: hashes['docs/DESIGN_AGENT_PLAN.md'] ?? null, scope: SOURCE_PATHS };
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
