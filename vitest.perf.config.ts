import { defineConfig } from 'vitest/config';

/** 性能探针专用：只跑 scripts/，超时放宽 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
