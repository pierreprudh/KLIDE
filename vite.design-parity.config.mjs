import { mergeConfig } from 'vite';
import appConfig from './vite.config.ts';
import { fileURLToPath } from 'node:url';
export default async environment => mergeConfig(await appConfig(environment), {
  // Only this dedicated developer server aliases native boundaries. The app
  // build and ordinary browser fixtures keep their normal Tauri imports.
  cacheDir: '.klide-design-cache/native',
  resolve: { alias: ['core', 'event', 'mocks'].map(name => ({
    find: new RegExp(`^@tauri-apps/api/${name}$`),
    replacement: fileURLToPath(new URL(`./preview/design-feedback/desktop/${name === 'event' ? 'events' : name}.mjs`, import.meta.url)),
  })) },
  server: { host: '127.0.0.1', port: 1465, strictPort: true, watch: { ignored: ['**/artifacts/**'] } },
});
