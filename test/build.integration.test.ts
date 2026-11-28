import { afterEach, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, createTempDir } from './helpers/workspace.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

afterEach(cleanupTempDirs);

function findNodeModulesRoot(entryUrl: string): string {
  let directory = path.dirname(realpathSync(fileURLToPath(entryUrl)));
  for (;;) {
    const parent = path.dirname(directory);
    if (path.basename(parent) === 'node_modules') {
      return parent;
    }
    if (parent === directory) {
      throw new Error(`Could not find node_modules for ${entryUrl}`);
    }
    directory = parent;
  }
}

function spawnBun(args: string[], cwd: string) {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('builds when cspell-lib is hoisted to an ancestor node_modules', () => {
  const monorepoRoot = createTempDir();
  const packageRoot = path.join(monorepoRoot, 'packages', 'cspell-lsp');
  mkdirSync(packageRoot, { recursive: true });

  cpSync(path.join(repoRoot, 'src'), path.join(packageRoot, 'src'), {
    recursive: true,
  });
  cpSync(path.join(repoRoot, 'scripts'), path.join(packageRoot, 'scripts'), {
    recursive: true,
  });
  cpSync(
    path.join(repoRoot, 'package.json'),
    path.join(packageRoot, 'package.json'),
  );

  const nodeModulesRoot = findNodeModulesRoot(
    import.meta.resolve('cspell-lib'),
  );
  symlinkSync(
    nodeModulesRoot,
    path.join(monorepoRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const build = spawnBun(['run', 'scripts/build.mjs'], packageRoot);
  if (build.exitCode !== 0) {
    throw new Error(
      `Hoisted build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`,
    );
  }
  const builtEntry = path.join(packageRoot, 'dist', 'cspell-lsp.js');
  expect(existsSync(builtEntry)).toBe(true);

  const builtSource = readFileSync(builtEntry, 'utf8');
  expect(builtSource).toMatch(/from ["']cspell-lib["']/);
  expect(builtSource).toMatch(/from ["']cspell-glob["']/);
  expect(builtSource).not.toMatch(/^\/\/ node_modules\//m);

  const checkScript = path.join(monorepoRoot, 'check-version.mjs');
  writeFileSync(
    checkScript,
    [
      "import { getBundledVersion } from './packages/cspell-lsp/src/engine/package.ts';",
      'console.log(`VERSION=${getBundledVersion()}`);',
      '',
    ].join('\n'),
  );

  const check = spawnBun([checkScript], monorepoRoot);
  if (check.exitCode !== 0) {
    throw new Error(
      `Version check failed:\n${check.stdout.toString()}\n${check.stderr.toString()}`,
    );
  }

  const lines = check.stdout.toString().trim().split('\n');
  expect(lines[lines.length - 1]).toMatch(/^VERSION=\d+\.\d+\.\d+/);
}, 30_000);
