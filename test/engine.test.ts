import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EngineLoadError,
  EngineRegistry,
  getApplicableExclusionGlobs,
  getBundledVersion,
  getDocumentUriPath,
  getExclusionTarget,
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
  options: { main?: string; module?: string } = {},
): string {
  const packageDirectory = path.join(root, 'node_modules', 'cspell-lib');
  writeConditionalCSpellLib(packageDirectory, exportsField, entries, options);
  return packageDirectory;
}

function writeNullExportsPackage(root: string): void {
  const packageDirectory = path.join(root, 'node_modules', 'cspell-lib');
  writeFakeCSpellLib(packageDirectory, { version: '9.0.0', marker: 'main' });
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ) as Record<string, unknown>;
  writeFileSync(
    packageJsonPath,
    JSON.stringify({
      ...packageJson,
      main: './index.js',
      exports: null,
    }),
  );
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

  test('does not fall back to legacy entries for a require-only export', async () => {
    const root = createTempDir();
    writeConditionalPackage(
      root,
      { require: './cjs.js' },
      [
        { file: './cjs.js', marker: 'require' },
        { file: './module.js', marker: 'module' },
        { file: './main.js', marker: 'main' },
      ],
      { module: './module.js', main: './main.js' },
    );

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no resolvable entry point');
  });

  test('does not fall back to index.js for a require-only export', async () => {
    const root = createTempDir();
    writeConditionalPackage(root, { require: './cjs.js' }, [
      { file: './cjs.js', marker: 'require' },
      { file: './index.js', marker: 'index' },
    ]);

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no resolvable entry point');
  });

  test('stops at an active condition mapped to null', async () => {
    const root = createTempDir();
    writeConditionalPackage(root, { import: null, default: './generic.js' }, [
      { file: './generic.js', marker: 'generic' },
    ]);

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no resolvable entry point');
  });

  test('does not fall back when the exported target is missing', async () => {
    const root = createTempDir();
    writeConditionalPackage(
      root,
      { import: './missing.js' },
      [{ file: './main.js', marker: 'main' }],
      { main: './main.js' },
    );

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('no resolvable entry point');
  });

  test('treats exports: null as absent and uses main', async () => {
    const root = createTempDir();
    writeNullExportsPackage(root);

    const { registry } = await createRegistry([root]);
    expect(engineMarker(registry, documentUri(root))).toBe('main');
  });

  test('rejects an explicit package with only a require condition', async () => {
    const root = createTempDir();
    const packageDirectory = writeConditionalPackage(
      root,
      { require: './cjs.js' },
      [
        { file: './cjs.js', marker: 'require' },
        { file: './main.js', marker: 'main' },
      ],
      { main: './main.js' },
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

  test('falls back when default config file names are missing', async () => {
    const root = createTempDir();
    writeFakeCSpellLib(path.join(root, 'node_modules', 'cspell-lib'), {
      version: '9.0.0',
      missingExports: ['defaultConfigFilenames'],
    });

    const { registry } = await createRegistry([root]);
    const engine = registry.getForDocument(documentUri(root));

    expect(engine.packagePath).toBe('<bundled>');
    expect(engine.fallbackReason).toContain('defaultConfigFilenames');
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

  test('matches a symlinked root by logical and real document paths', async () => {
    const realRoot = createTempDir();
    mkdirSync(path.join(realRoot, 'src'), { recursive: true });
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFakeCSpellLib(path.join(realRoot, 'node_modules', 'cspell-lib'), {
      version: '9.3.0',
      marker: 'symlinked',
    });

    const { registry } = await createRegistry([linkRoot]);

    expect(engineMarker(registry, documentUri(realRoot))).toBe('symlinked');
    expect(engineMarker(registry, documentUri(linkRoot))).toBe('symlinked');
    expect(registry.rootForDocument(documentUri(realRoot))).toBe(linkRoot);
    expect(registry.getForRoot(realRoot).version).toBe('9.3.0');

    const { registry: realRegistry } = await createRegistry([realRoot]);
    expect(engineMarker(realRegistry, documentUri(linkRoot))).toBe('symlinked');
    expect(realRegistry.rootForDocument(documentUri(linkRoot))).toBe(realRoot);
  });
});

function systemBinWorkspace(): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const realBin = realpathSync('/bin');
    return realBin === '/bin' ? undefined : path.dirname(realBin);
  } catch {
    return undefined;
  }
}

const binWorkspace = systemBinWorkspace();

describe('EngineRegistry alias roots', () => {
  test.skipIf(!binWorkspace)(
    'uses the filesystem root when no alias prefix maps to the workspace',
    async () => {
      const { registry } = await createRegistry([binWorkspace!]);

      expect(registry.rootAliasForDocument('file:///bin/sh')).toBe(
        path.parse('/bin/sh').root,
      );
    },
  );

  test('keeps the symlink alias for documents in deleted directories', async () => {
    const realRoot = createTempDir();
    mkdirSync(path.join(realRoot, 'present'), { recursive: true });
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { registry } = await createRegistry([realRoot]);
    const missingFile = path.join(linkRoot, 'deleted', 'fixture.md');

    expect(
      registry.rootAliasForDocument(
        `git:${pathToFileURL(missingFile).pathname}`,
      ),
    ).toBe(linkRoot);
    expect(registry.rootAliasForDocument(pathToFileURL(missingFile).href)).toBe(
      linkRoot,
    );
  });

  test('keeps the symlink alias when the workspace root is missing', async () => {
    const realParent = createTempDir();
    const linkParent = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realParent,
      linkParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const realRoot = path.join(realParent, 'deleted-root');
    const linkRoot = path.join(linkParent, 'deleted-root');
    const missingFile = path.join(linkRoot, 'dist', 'fixture.md');

    const { registry } = await createRegistry([realRoot]);
    const uri = pathToFileURL(missingFile).href;

    expect(registry.rootForDocument(uri)).toBe(realRoot);
    expect(registry.rootAliasForDocument(uri)).toBe(linkRoot);
  });

  test('resolves a missing symlinked root through its real parent', async () => {
    const realParent = createTempDir();
    const linkParent = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realParent,
      linkParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linkRoot = path.join(linkParent, 'deleted-root');
    const realRoot = path.join(realParent, 'deleted-root');
    const file = path.join(realRoot, 'dist', 'fixture.md');

    const { registry } = await createRegistry([linkRoot]);
    const uri = pathToFileURL(file).href;

    expect(registry.rootForDocument(uri)).toBe(linkRoot);
    expect(registry.rootAliasForDocument(uri)).toBe(realRoot);
  });

  test.skipIf(process.platform === 'win32')(
    'matches POSIX paths that resemble a Windows drive',
    async () => {
      const { registry } = await createRegistry(['/c:/work'], 'bundled');

      expect(
        registry.rootAliasForDocument('git:/c:/work/dist/fixture.md'),
      ).toBe('/c:/work');
    },
  );
});

describe('getDocumentUriPath platform semantics', () => {
  test('maps a non-file authority to a UNC path on Windows', () => {
    expect(
      getDocumentUriPath('git://server/share/dist/fixture.md', 'win32'),
    ).toBe('\\\\server\\share\\dist\\fixture.md');
  });

  test('keeps POSIX paths that resemble a Windows drive', () => {
    expect(getDocumentUriPath('git:/c:/work/dist/fixture.md', 'linux')).toBe(
      '/c:/work/dist/fixture.md',
    );
  });

  test('keeps drive paths local on Windows without an authority', () => {
    expect(getDocumentUriPath('git:/c:/work/dist/fixture.md', 'win32')).toBe(
      'c:\\work\\dist\\fixture.md',
    );
  });

  test('rejects relative URI paths', () => {
    expect(
      getDocumentUriPath('git:relative/fixture.md', 'linux'),
    ).toBeUndefined();
    expect(
      getDocumentUriPath('git:relative/fixture.md', 'win32'),
    ).toBeUndefined();
  });
});

describe('getExclusionTarget platform semantics', () => {
  test('uses the full UNC path for virtual documents on Windows', () => {
    expect(
      getExclusionTarget('git://server/share/dist/fixture.md', 'win32'),
    ).toBe('\\\\server\\share\\dist\\fixture.md');
  });

  test('keeps non-authority and non-Windows URIs unchanged', () => {
    expect(getExclusionTarget('git:/c:/work/dist/fixture.md', 'win32')).toBe(
      'git:/c:/work/dist/fixture.md',
    );
    expect(
      getExclusionTarget('git://server/share/dist/fixture.md', 'linux'),
    ).toBe('git://server/share/dist/fixture.md');
  });

  test('leaves file and stdin URIs unchanged', () => {
    expect(
      getExclusionTarget('file://server/share/dist/fixture.md', 'win32'),
    ).toBe('file://server/share/dist/fixture.md');
    expect(getExclusionTarget('stdin://server/share/fixture.md', 'win32')).toBe(
      'stdin://server/share/fixture.md',
    );
  });
});

describe('getApplicableExclusionGlobs', () => {
  const serverA = '\\\\server-a\\share';
  const serverB = '\\\\server-b\\share';
  const targetA = path.win32.join(serverA, 'dist', 'fixture.md');
  const targetB = path.win32.join(serverB, 'dist', 'fixture.md');

  test('drops globs rooted on another UNC server', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
      'dist/**',
      { glob: '**/dist/**', root: serverA },
      { glob: '!**/keep/**', root: serverA },
      { glob: 'dist/**', root: 'file://server-a/share/' },
    ];

    expect(
      getApplicableExclusionGlobs(globs, serverB, targetB, 'win32'),
    ).toEqual([globs[1], globs[2], globs[3], globs[4]]);
  });

  test('keeps roots on the same server regardless of case', () => {
    const glob = { glob: 'dist/**', root: '\\\\SERVER-A\\share' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetA, 'win32'),
    ).toEqual([glob]);
  });

  test('canonicalizes non-ASCII UNC server names', () => {
    const server = '\\\\測試\\share';
    const otherServer = '\\\\其他\\share';
    const globs = [
      { glob: 'dist/**', root: server },
      { glob: 'dist/**', root: otherServer },
      { glob: 'dist/**', root: 'file://測試/share/' },
      { glob: 'dist/**', root: 'file://xn--g6w251d/share/' },
    ];
    const target = getExclusionTarget(
      'git://測試/share/dist/fixture.md',
      'win32',
    );

    expect(getApplicableExclusionGlobs(globs, server, target, 'win32')).toEqual(
      [globs[0], globs[2], globs[3]],
    );
  });

  test('uses the fallback root for string and relative glob roots', () => {
    const relativeGlob = { glob: 'dist/**', root: 'sub' };

    expect(
      getApplicableExclusionGlobs(['dist/**'], serverA, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([relativeGlob], serverA, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([relativeGlob], serverB, targetB, 'win32'),
    ).toEqual([relativeGlob]);
  });

  test('compares the server of file URL targets', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
    ];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverB,
        'file://server-b/share/dist/fixture.md',
        'win32',
      ),
    ).toEqual([globs[1]]);
  });

  test('leaves globs unchanged without a Windows UNC target', () => {
    const globs = [{ glob: 'dist/**', root: serverA }];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverA,
        'file:///c:/work/dist/fixture.md',
        'win32',
      ),
    ).toEqual(globs);
    expect(
      getApplicableExclusionGlobs(globs, serverB, targetA, 'linux'),
    ).toEqual(globs);
  });

  test('uses the current directory for a ${cwd} glob prefix', () => {
    const glob = { glob: '${cwd}/dist/**', root: serverA };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverB),
    ).toEqual([glob]);
    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverA),
    ).toEqual([]);
  });

  test('resolves a ${cwd} root before comparing servers', () => {
    const glob = { glob: 'dist/**', root: '${cwd}' };
    const nestedGlob = { glob: 'dist/**', root: '${cwd}/nested' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverA),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverB),
    ).toEqual([glob]);
    expect(
      getApplicableExclusionGlobs(
        [nestedGlob],
        serverB,
        targetB,
        'win32',
        serverA,
      ),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs(
        [nestedGlob],
        serverB,
        targetB,
        'win32',
        serverB,
      ),
    ).toEqual([nestedGlob]);
  });

  test('normalizes four-slash UNC file URL roots', () => {
    const glob = { glob: 'dist/**', root: 'file:////server-a/share/' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([glob], serverA, targetA, 'win32'),
    ).toEqual([glob]);
  });

  test('recognizes four-slash UNC file URL targets', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
    ];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverB,
        'file:////server-b/share/dist/fixture.md',
        'win32',
      ),
    ).toEqual([globs[1]]);
  });
});
