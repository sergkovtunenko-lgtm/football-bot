import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: [
        'src/config.ts',
        'src/logger.ts',
        'src/security/**/*.ts',
        'src/domain/**/*.ts',
        'src/application/**/*.ts',
        'src/adapters/telegram/render.ts',
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
