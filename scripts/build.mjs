import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const cspellLibPackage = readCSpellLibPackage(root);

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

/**
 * Locates cspell-lib through the same ESM resolution the bundler uses, then
 * walks up to its package metadata. This supports dependencies hoisted to an
 * ancestor node_modules instead of assuming a package-local install.
 */
function readCSpellLibPackage(packageRoot) {
  let entry;
  try {
    entry = Bun.resolveSync(
      'cspell-lib',
      path.join(packageRoot, 'src', 'engine', 'package.ts'),
    );
  } catch (error) {
    throw new Error('Unable to resolve cspell-lib from src/engine/package.ts', {
      cause: error,
    });
  }

  let directory = path.dirname(realpathSync(entry));
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Unable to read ${candidate}`, { cause: error });
      }
    }

    if (packageJson?.name === 'cspell-lib') {
      if (typeof packageJson.version !== 'string' || !packageJson.version) {
        throw new Error(`cspell-lib at ${directory} has no usable version`);
      }
      return packageJson;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not find cspell-lib package.json from resolved entry ${entry}`,
      );
    }
    directory = parent;
  }
}
