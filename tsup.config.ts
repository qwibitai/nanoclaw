import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'api/sdk': 'src/api/sdk.ts',
    'api/channels/telegram': 'src/api/channels/telegram.ts',
  },
  format: ['cjs'],
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: false,
  // Shim import.meta.url → __filename-based URL in CJS output.
  // config.ts uses import.meta.url to resolve PACKAGE_ROOT.
  shims: true,
});
