import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const cspellLibPackage = JSON.parse(
  await readFile(
    path.join(root, 'node_modules', 'cspell-lib', 'package.json'),
    'utf8',
  ),
);

const result = await Bun.build({
  entrypoints: [path.join(root, 'src', 'main.ts')],
  outdir: path.join(root, 'dist'),
  naming: 'cspell-lsp.js',
  target: 'node',
  define: {
    CSPELL_LIB_VERSION: JSON.stringify(cspellLibPackage.version),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
