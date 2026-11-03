import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  // Several runtime specs start a full Runtime with subprocess stand-ins and can take seconds on a loaded
  // CI runner; the timeout only bounds a failure, it does not slow passing tests.
  test: { include: ['tests/**/*.spec.{ts,tsx}'], testTimeout: 30_000, hookTimeout: 30_000 } })
