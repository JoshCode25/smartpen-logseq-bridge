import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    // Silence noisy console output from source during test runs
    onConsoleLog: (log, type) => {
      if (type === 'stdout') return false; // suppress console.log
      return true; // keep console.warn / console.error
    }
  },
  resolve: {
    alias: {
      '$lib':        resolve(__dirname, 'src/lib'),
      '$stores':     resolve(__dirname, 'src/stores'),
      '$components': resolve(__dirname, 'src/components'),
      '$utils':      resolve(__dirname, 'src/utils')
    }
  }
});
