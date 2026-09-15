import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const appPort = process.env.ITX_E2E_APP_PORT ?? '5273';
const baseURL = `http://127.0.0.1:${appPort}`;
const scenarioPath = resolve('.local/scenario.json');
if (!existsSync(scenarioPath)) {
  throw new Error(
    `No seeded scenario at ${scenarioPath}. Run \`npm run local:anvil\` and seed a scenario ` +
      '(e.g. `node dev/local-chain/scripts/local/commands/local-scenario.mjs commit-open`) before running the e2e suite.',
  );
}
const worldwideDay: string = JSON.parse(readFileSync(scenarioPath, 'utf8')).worldwideDay;

export default defineConfig({
  testDir: './tests/e2e/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${appPort} --strictPort`,
    env: {
      ITX_RUNTIME_CONFIG_DIR: resolve('.local/config'),
      ITX_LOCAL_DEV: '1',
    },
    url: `${baseURL}/auction/${worldwideDay}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
