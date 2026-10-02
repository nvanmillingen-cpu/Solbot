import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    // Tests schrijven geen logbestanden in de echte logmap
    env: { LOG_DIR: path.join(os.tmpdir(), 'solbot-test-logs') },
  },
});
