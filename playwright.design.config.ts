import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/design-feedback',
  outputDir: './artifacts/design-feedback/test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:1460', viewport: { width: 900, height: 700 }, locale: 'en-US', timezoneId: 'Europe/Paris', reducedMotion: 'reduce' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 1460 --strictPort', url: 'http://127.0.0.1:1460/preview/design-feedback.html', reuseExistingServer: false, timeout: 30000 },
});
