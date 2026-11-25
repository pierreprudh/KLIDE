import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const env = { ...process.env };
// Local convenience only: explicit release credentials and CI take precedence.
if (process.platform === 'darwin' && !env.CI && !env.KLIDE_DISTRIBUTION
    && !env.APPLE_SIGNING_IDENTITY && !env.APPLE_CERTIFICATE
    && ['build', 'bundle', 'dev'].includes(args[0]) && !args.includes('--no-sign') && !args.includes('--ci')) {
  const identities = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const local = identities.stdout?.match(/\b([A-Fa-f0-9]{40}) "Klide Local Development"/);
  if (local) {
    env.APPLE_SIGNING_IDENTITY = local[1];
    console.log('Signing with Klide Local Development (this Mac only).');
    if (args[0] === 'dev') {
      const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
      const targetIndex = options.findIndex(arg => arg === '--target' || arg === '-t');
      const target = targetIndex >= 0 ? options[targetIndex + 1]
        : options.find(arg => arg.startsWith('--target='))?.slice('--target='.length)
          ?? spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1];
      if (!target) throw new Error('Cannot determine the Rust target for development signing.');
      if (target.endsWith('-apple-darwin')) {
        env.KLIDE_DEV_SIGNING_IDENTITY = local[1];
        // Cargo runs this after every link, including Tauri watcher restarts.
        // A TOML array preserves paths with spaces; a runner env string doesn't.
        const runner = ['/bin/bash', fileURLToPath(new URL('./macos-dev-runner.sh', import.meta.url))];
        const config = `target.${JSON.stringify(target)}.runner=${JSON.stringify(runner)}`;
        const separator = args.indexOf('--');
        if (separator < 0) args.push('--', '--config', config);
        else args.splice(separator + 1, 0, '--config', config);
      }
    }
  }
}
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args], {
  env, stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
