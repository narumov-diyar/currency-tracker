import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: '**/*.pw.js',
  timeout: 30_000,
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
});
