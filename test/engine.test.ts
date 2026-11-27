import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EngineLoadError,
  EngineRegistry,
  getBundledVersion,
} from '../src/engine.js';
import {
  cleanupTempDirs,
  createTempDir,
  nestedCSpellLibPath,
  writeConditionalCSpellLib,
  writeFakeCSpell,
  writeFakeCSpellLib,
} from './helpers/workspace.js';

afterEach(cleanupTempDirs);

function documentUri(root: string, file = 'src/app.ts'): string {
  return pathToFileURL(path.join(root, file)).href;
}

function engineMarker(registry: EngineRegistry, uri: string): unknown {
  const engine = registry.getForDocument(uri);
  return (engine.lib as unknown as { marker?: unknown }).marker;
}

async function createRegistry(
  roots: string[],
  engineOverride: string | null = null,
): Promise<{ registry: EngineRegistry; logs: string[] }> {
  const logs: string[] = [];
  const registry = await EngineRegistry.create({
    roots,
    engineOverride,
    log: (message) => logs.push(message),
  });
  return { registry, logs };
}

describe('bundled engine version', () => {
  test('resolves the installed version when it is not build-defined', () => {
    expect(getBundledVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

function writeConditionalPackage(
  root: string,
  exportsField: Record<string, unknown>,
  entries: readonly { file: string; marker: string }[],
): string {
  const packageDirectory = path.join(root, 'node_modules', 'cspell-lib');
  writeConditionalCSpellLib(packageDirectory, exportsField, entries);
  return packageDirectory;
}

describe('EngineRegistry conditional exports', () => {
  test('matches conditions in declaration order (node before import)', async () => {
    const root = createTempDir();
    writeConditionalPackage(
      root,
      { node: './node.js', import: './generic.js' },
      [
        { file: './node.js', marker: 'node' },
        { file: './generic.js', marker: 'generic' },
      ],
    );

    const { registry } = await createRegistry([root]);
    expect(engineMarker(registry, documentUri(root))).toBe('node');
  });

  test('matches default at its declared position', async () => {
    const root = createTempDir();
    writeConditionalPackage(
      root,
      { default: './default.js', import: './esm.js' },
      [
        { file: './default.js', marker: 'default' },
        { file: './esm.js', marker: 'import' },
      ],
    );

    const { registry } = await createRegistry([root]);
    expect(engineMarker(registry, documentUri(root))).toBe('default');
  });

  test('does not prefer node when import is declared first', async () => {
    const root = createTempDir();
    writeConditionalPackage(root, { import: './esm.js', node: './node.js' }, [
      { file: './esm.js', marker: 'import' },
      { file: './node.js', marker: 'node' },
    ]);

    const { registry } = await createRegistry([root]);
    expect(engineMarker(registry, documentUri(root))).toBe('import');
  });

  test('applies the same order to an explicit package directory', async () => {
    const root = createTempDir();
    const packageDirectory = writeConditionalPackage(
      root,
      { node: './node.js', import: './generic.js' },
      [
        { file: './node.js', marker: 'node' },
        { file: './generic.js', marker: 'generic' },
      ],
    );

    const { registry } = await createRegistry([root], packageDirectory);
    expect(engineMarker(registry, documentUri(root))).toBe('node');
  });

  test('falls back when only a require condition is exported', async () => {
    const root = createTempDir();
    writeConditionalPackage(root, { require: './cjs.js' }, [
      { file: './cjs.js', marker: 'require' },
    ]);

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no resolvable entry point');
  });

  test('rejects an explicit package with only a require condition', async () => {
    const root = createTempDir();
    const packageDirectory = writeConditionalPackage(
      root,
      { require: './cjs.js' },
      [{ file: './cjs.js', marker: 'require' }],
    );

    await expect(createRegistry([root], packageDirectory)).rejects.toThrow(
      'no resolvable entry point',
    );
  });
});

describe('EngineRegistry auto mode', () => {
  test('prefers the cspell-lib used by the workspace cspell package', async () => {
    const root = createTempDir();
    const cspellPackage = writeFakeCSpell(root);
    writeFakeCSpellLib(nestedCSpellLibPath(cspellPackage), {
      version: '9.2.0',
      marker: 'paired',
    });
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '10.1.0',
      marker: 'direct',
    });

    const { registry, logs } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.mode).toBe('auto');
    expect(engine.version).toBe('9.2.0');
    expect(engineMarker(registry, documentUri(root))).toBe('paired');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('mode=auto');
    expect(logs[0]).toContain('version=9.2.0');
    expect(logs[0]).toContain(`path=${engine.packagePath}`);
  });

  test('uses a directly installed cspell-lib when cspell is absent', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '8.5.0',
      marker: 'direct',
    });

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.mode).toBe('auto');
    expect(engine.version).toBe('8.5.0');
    expect(engineMarker(registry, documentUri(root))).toBe('direct');
  });

  test('falls back to the bundled engine when no local package exists', async () => {
    const root = createTempDir();
    const { registry, logs } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.version).toBe(getBundledVersion());
    expect(engine.fallbackReason).toContain('no cspell package found');
    expect(logs[0]).toContain('fallback=bundled');
    expect(logs[0]).toContain('reason=no cspell package found');
  });

  test('falls back when the local version is older than 8', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '7.9.0',
    });

    const { registry, logs } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('not supported');
    expect(engine.fallbackReason).toContain('7.9.0');
    expect(logs[0]).toContain('7.9.0');
  });

  test('falls back when loading the local entry throws', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      broken: true,
    });

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('broken engine');
  });

  test('uses the bundled engine without a workspace folder', async () => {
    const { registry, logs } = await createRegistry([]);
    const engine = registry.getForDocument(
      pathToFileURL('/tmp/outside-workspace.ts').href,
    );

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no workspace folder');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('fallback=bundled');
  });

  test('falls back when required exports are missing', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      missingExports: ['getDictionary'],
    });

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('getDictionary');
  });

  test('logs a selection once and not for every document', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      marker: 'local',
    });

    const { registry, logs } = await createRegistry([root]);
    expect(logs).toHaveLength(1);

    registry.getForDocument(documentUri(root, 'a.ts'));
    registry.getForDocument(documentUri(root, 'b.ts'));
    registry.getForDocument(documentUri(root, 'c.ts'));

    expect(logs).toHaveLength(1);
  });
});

describe('EngineRegistry override mode', () => {
  test('loads an explicitly selected package directory', async () => {
    const root = createTempDir();
    const explicitDirectory = path.join(root, 'vendor', 'cspell-lib');
    writeFakeCSpellLib(explicitDirectory, {
      version: '9.5.0',
      marker: 'explicit',
    });
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '7.0.0',
    });

    const { registry, logs } = await createRegistry([root], explicitDirectory);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.mode).toBe('path');
    expect(engine.version).toBe('9.5.0');
    expect(engineMarker(registry, documentUri(root))).toBe('explicit');
    expect(logs[0]).toContain('mode=path');
    expect(logs[0]).toContain(`path=${realpathSync(explicitDirectory)}`);
  });

  test('loads an explicitly selected entry file', async () => {
    const root = createTempDir();
    const entry = writeFakeCSpellLib(path.join(root, 'vendor', 'cspell-lib'), {
      version: '9.6.0',
      marker: 'entry',
    });

    const { registry } = await createRegistry([root], entry);
    expect(engineMarker(registry, documentUri(root))).toBe('entry');
  });

  test('loads an explicitly selected package.json', async () => {
    const root = createTempDir();
    const packageDirectory = path.join(root, 'vendor', 'cspell-lib');
    writeFakeCSpellLib(packageDirectory, {
      version: '9.7.0',
      marker: 'package-json',
    });

    const { registry } = await createRegistry(
      [root],
      path.join(packageDirectory, 'package.json'),
    );
    expect(engineMarker(registry, documentUri(root))).toBe('package-json');
  });

  test('bundled ignores local packages', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '10.0.0',
      marker: 'local',
    });

    const { registry } = await createRegistry([root], 'bundled');
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.mode).toBe('bundled');
    expect(engine.packagePath).toBe('<bundled>');
  });

  test('rejects a missing path with a clear error', async () => {
    const root = createTempDir();
    const missing = path.join(root, 'missing-cspell-lib');

    try {
      await createRegistry([root], missing);
      throw new Error('Expected EngineRegistry.create to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineLoadError);
      expect((error as Error).message).toContain('does not exist');
      expect((error as Error).message).toContain(missing);
    }
  });

  test('rejects an explicit version older than 8', async () => {
    const root = createTempDir();
    const explicitDirectory = path.join(root, 'vendor', 'cspell-lib');
    writeFakeCSpellLib(explicitDirectory, { version: '7.5.0' });

    await expect(createRegistry([root], explicitDirectory)).rejects.toThrow(
      'cspell-lib 8 or newer is required',
    );
  });
});

describe('EngineRegistry multi-root workspaces', () => {
  test('selects an engine per workspace folder', async () => {
    const firstRoot = createTempDir();
    const secondRoot = createTempDir();
    writeFakeCSpellLib(path.join(firstRoot, 'node_modules', 'cspell-lib'), {
      version: '8.1.0',
      marker: 'first',
    });
    writeFakeCSpellLib(path.join(secondRoot, 'node_modules', 'cspell-lib'), {
      version: '10.2.0',
      marker: 'second',
    });

    const { registry } = await createRegistry([firstRoot, secondRoot]);

    expect(registry.getForDocument(documentUri(firstRoot)).version).toBe(
      '8.1.0',
    );
    expect(engineMarker(registry, documentUri(firstRoot))).toBe('first');
    expect(registry.getForDocument(documentUri(secondRoot)).version).toBe(
      '10.2.0',
    );
    expect(engineMarker(registry, documentUri(secondRoot))).toBe('second');
  });

  test('uses the most specific workspace folder', async () => {
    const outerRoot = createTempDir();
    const nestedRoot = path.join(outerRoot, 'packages', 'app');
    writeFakeCSpellLib(path.join(outerRoot, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      marker: 'outer',
    });
    writeFakeCSpellLib(path.join(nestedRoot, 'node_modules', 'cspell-lib'), {
      version: '9.1.0',
      marker: 'nested',
    });

    const { registry } = await createRegistry([outerRoot, nestedRoot]);

    expect(engineMarker(registry, documentUri(nestedRoot))).toBe('nested');
    expect(engineMarker(registry, documentUri(outerRoot))).toBe('outer');
  });

  test('uses the bundled engine for documents outside every root', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      marker: 'local',
    });
    const outsideRoot = createTempDir();

    const { registry } = await createRegistry([root]);
    expect(engineMarker(registry, documentUri(outsideRoot))).toBeUndefined();
    expect(registry.getForDocument(documentUri(outsideRoot)).packagePath).toBe(
      '<bundled>',
    );
  });
});
