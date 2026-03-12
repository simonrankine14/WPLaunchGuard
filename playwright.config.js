const { defineConfig, devices } = require('@playwright/test');

const QA_MEDIA = String(process.env.QA_MEDIA || '').toLowerCase() === '1' || String(process.env.QA_MEDIA || '').toLowerCase() === 'true';

// Allow per-environment timeout overrides without code changes.
// PW_TIMEOUT: per-test timeout ms (default 180s). Set PW_TIMEOUT=300000 for slower CI.
const TEST_TIMEOUT = Number(process.env.PW_TIMEOUT || 180_000);

module.exports = defineConfig({
  testDir: './tests',
  timeout: TEST_TIMEOUT,
  expect: {
    timeout: 15000
  },
  // Retry once on CI to absorb transient network/browser flakes.
  // Never retry locally to keep the feedback loop fast.
  retries: process.env.CI ? 1 : 0,
  workers: 5,
  fullyParallel: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/playwright-html', open: 'never' }]
  ],
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    actionTimeout: 15000,
    navigationTimeout: 45000,
    // Default to no Playwright-generated media to avoid disk bloat.
    // Opt-in for debugging with QA_MEDIA=1.
    screenshot: QA_MEDIA ? 'only-on-failure' : 'off',
    video: QA_MEDIA ? 'retain-on-failure' : 'off',
    httpCredentials:
      process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
        ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
        : undefined
  },
  projects: [
    {
      name: 'chrome-desktop-1920',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 }
      },
      metadata: { browser: 'chromium', device: 'desktop', viewport: '1920x1080' }
    },
    {
      name: 'firefox-desktop',
      use: {
        ...devices['Desktop Firefox']
      },
      metadata: { browser: 'firefox', device: 'desktop', viewport: '1280x720' }
    },
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari']
      },
      metadata: { browser: 'webkit', device: 'desktop', viewport: '1280x720' }
    },
    {
      name: 'iphone-14',
      use: {
        ...devices['iPhone 14']
      },
      metadata: { browser: 'webkit', device: 'iphone-14', viewport: '390x844' }
    },
    {
      name: 'ipad',
      use: {
        ...devices['iPad (gen 7)']
      },
      metadata: { browser: 'webkit', device: 'ipad', viewport: '810x1080' }
    },
    {
      name: 'windows-laptop-1272',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1272, height: 900 }
      },
      metadata: { browser: 'chromium', device: 'windows-laptop-1272', viewport: '1272x900' }
    }
  ]
});
