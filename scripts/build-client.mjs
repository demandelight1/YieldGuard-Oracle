import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('../src/client/payment.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../public/payment.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none'
});
console.log(`Bundled browser payment module from ${root}`);
