import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});

/**
 * 性能探针在 scripts/ 下，不进常规测试（建库耗时数秒）。
 * 用 `npm run perf` 单独跑：
 *   vitest run --config vitest.perf.config.ts
 */
