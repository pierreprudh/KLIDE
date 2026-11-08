// Build a distinct, development-only Mac bundle; never replace the installed app.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, copyFile, rename, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'darwin') throw new Error('Native parity requires macOS');
const root = path.resolve(import.meta.dirname, '../..');
execFileSync('cargo', ['build','--offline','--features','design-parity','--manifest-path','src-tauri/Cargo.toml'], {cwd:root,stdio:'inherit'});
const target = path.join(root,'src-tauri/target/debug');
const candidates = [];
for (const name of await readdir(path.join(target,'.fingerprint'))) {
  if (!name.startsWith('klide-')) continue;
  try {
    const fingerprint = JSON.parse(await readFile(path.join(target,'.fingerprint',name,'bin-klide.json'),'utf8'));
    if (!JSON.parse(fingerprint.features).includes('design-parity')) continue;
    const binary = path.join(target,'deps',name);
    candidates.push({binary,time:(await stat(binary)).mtimeMs});
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
candidates.sort((a,b)=>b.time-a.time);
if (!candidates.length) throw new Error('No feature-specific parity executable found');
const bundle = path.join('/private/tmp','klide-native-check','Klide Native Check.app');
const contents = path.join(bundle,'Contents');
await mkdir(path.join(contents,'MacOS'),{recursive:true});
const executable = path.join(contents,'MacOS/klide');
await copyFile(candidates[0].binary, executable+'.next');
await chmod(executable+'.next',0o755);
await rename(executable+'.next',executable);
await writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>klide</string><key>CFBundleIdentifier</key><string>com.pierre.klide.design-parity</string><key>CFBundleName</key><string>Klide Native Check</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
console.log(`Prepared ${bundle}\nStart fixture server: npx vite --config vite.design-parity.config.mjs\nThen: open '${bundle}'\nQuit this test app before rebuilding it.`);
