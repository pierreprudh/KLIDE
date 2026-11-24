import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const identities = process.platform === 'darwin'
  ? spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout
  : '';
const identity = identities?.match(/\b([A-Fa-f0-9]{40}) "Klide Local Development"/)?.[1];

test('Tauri dev signs each Cargo rebuild, preserves arguments, and keeps its identity', {
  skip: !identity && 'Requires macOS and npm run macos:setup-signing',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'klide dev signing '));
  const run = (cmd, args, extra = {}) => spawnSync(cmd, args, {
    cwd: root, encoding: 'utf8', timeout: 60_000, ...extra,
  });
  const check = result => assert.equal(result.status, 0, result.stdout + result.stderr);
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="signing-probe"\nversion="0.1.0"\nedition="2021"\n');
    const env = { ...process.env };
    for (const key of ['CI', 'KLIDE_DISTRIBUTION', 'APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE']) delete env[key];
    const args = [join(root, 'scripts/tauri.mjs'), 'dev', '--no-watch', '--no-dev-server-wait',
      '--config', JSON.stringify({ build: { beforeDevCommand: null } }), '--',
      '--manifest-path', join(dir, 'Cargo.toml'), '--target-dir', join(dir, 'target'), '--', 'argument with spaces'];
    let requirement;
    let previousHash;
    for (const version of [1, 2]) {
      writeFileSync(join(dir, 'src/main.rs'), `fn main() { println!("version ${version}: {}", std::env::args().nth(1).unwrap()); }\n`);
      const result = run(process.execPath, args, { env });
      check(result);
      assert.match(result.stdout, new RegExp(`version ${version}: argument with spaces`));
      const binary = join(dir, 'target/debug/signing-probe');
      check(run('/usr/bin/codesign', ['--verify', '--strict', binary]));
      const signature = run('/usr/bin/codesign', ['-d', '-r-', '--verbose=4', binary]);
      check(signature);
      const output = signature.stdout + signature.stderr;
      const current = output.match(/designated => .+/)?.[0];
      assert.ok(current?.includes('identifier "com.pierre.klide"'));
      assert.ok(current.toLowerCase().includes(identity.toLowerCase()));
      const hash = output.match(/^CDHash=(.+)$/m)?.[1];
      assert.ok(hash);
      if (requirement) {
        assert.equal(current, requirement);
        assert.notEqual(hash, previousHash, 'Rebuild must actually change the executable');
      }
      requirement = current;
      previousHash = hash;
    }
    // An unavailable certificate must block launch, never run unsigned.
    const failed = run('/bin/bash', [join(root, 'scripts/macos-dev-runner.sh'),
      join(dir, 'target/debug/signing-probe'), 'must not launch'], {
      env: { ...env, KLIDE_DEV_SIGNING_IDENTITY: 'Klide Missing Test Identity' },
    });
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.stdout, /version 2:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
