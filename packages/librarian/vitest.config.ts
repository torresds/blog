import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], fileParallelism: false } },
      { extends: true, test: { name: 'contracts', include: ['test/contracts/**/*.test.ts'] } },
      { extends: true, test: { name: 'architecture', include: ['test/architecture/**/*.test.ts'] } },
      { extends: true, test: { name: 'performance', include: ['test/performance/**/*.test.ts'], fileParallelism: false } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
      exclude: ['**/*.d.ts'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
