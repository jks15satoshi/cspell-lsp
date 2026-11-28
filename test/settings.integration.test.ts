import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultConfigFilenames } from 'cspell-lib';
import type { CSpellSettings } from 'cspell-lib';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { ConfigEditor } from '../src/config.js';
import type { CSpellEngine, CSpellLib } from '../src/engine.js';
import { EngineRegistry } from '../src/engine.js';
import type { SettingsResolverOptions } from '../src/settings.js';
import { SettingsResolver } from '../src/settings.js';
import { validateTextDocument } from '../src/validator.js';
import {
  cleanupTempDirs,
  createTempDir,
  writeRealCSpellLib,
} from './helpers/workspace.js';

const unknownWord = `zz${Math.random()
  .toString(36)
  .replace(/[^a-z]/g, '')
  .padEnd(8, 'x')
  .slice(0, 8)}`;

const unknownWordDiagnostic = `"${unknownWord}": Unknown word.`;

const isolatedEnvNames = [
  'XDG_CONFIG_HOME',
  'HOME',
  'APPDATA',
  'USERPROFILE',
] as const;
const originalEnv = Object.fromEntries(
  isolatedEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof isolatedEnvNames)[number], string | undefined>;

let configHome: string | undefined;
let cspellLib: typeof import('cspell-lib');

beforeAll(async () => {
  configHome = mkdtempSync(path.join(tmpdir(), 'cspell-lsp-config-'));
  for (const name of isolatedEnvNames) {
    process.env[name] = configHome;
  }
  cspellLib = await import('cspell-lib');
});

afterAll(() => {
  for (const name of isolatedEnvNames) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (configHome) {
    rmSync(configHome, { recursive: true, force: true });
  }
});

afterEach(cleanupTempDirs);

function createEngine(lib: CSpellLib = cspellLib): CSpellEngine {
  return {
    mode: 'bundled',
    version: 'test',
    packagePath: '<bundled>',
    lib,
  };
}

function createResolver(
  options: SettingsResolverOptions = {},
  lib: CSpellLib = cspellLib,
): SettingsResolver {
  const engine = createEngine(lib);
  const registry = {
    getForDocument: () => engine,
    all: () => [engine],
  } as unknown as EngineRegistry;
  return new SettingsResolver(registry, options);
}

function createDocument(root: string, file = 'fixture.md'): TextDocument {
  return TextDocument.create(
    pathToFileURL(path.join(root, file)).href,
    'markdown',
    1,
    `This is a ${unknownWord} word.`,
  );
}

function writeSettings(file: string, settings: object): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      { version: '0.2', language: 'en', enabled: true, ...settings },
      null,
      2,
    ),
  );
}

function writeConfig(root: string, settings: object): void {
  writeSettings(path.join(root, 'cspell.json'), settings);
}

describe('SettingsResolver with real cspell-lib', () => {
  test('reloads a changed configuration', async () => {
    const root = createTempDir();
    writeConfig(root, {});
    const resolver = createResolver();
    const document = createDocument(root);

    const before = await resolver.getForDocument(document);
    expect(
      (await validateTextDocument(document, before.settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    writeConfig(root, { words: [unknownWord] });
    resolver.clear();
    const after = await resolver.getForDocument(document);

    expect(
      await validateTextDocument(document, after.settings, cspellLib),
    ).toEqual([]);
  });

  test('ignores documents matched by workspace ignorePaths and follows changes', async () => {
    const root = createTempDir();
    writeConfig(root, { ignorePaths: ['dist/**'] });
    const resolver = createResolver();
    const ignoredDocument = createDocument(root, 'dist/fixture.md');

    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    const checkedDocument = createDocument(root);
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);

    writeConfig(root, {});
    resolver.clear();
    const unignored = await resolver.getForDocument(ignoredDocument);
    expect(
      (
        await validateTextDocument(
          ignoredDocument,
          unignored.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);

    writeConfig(root, { ignorePaths: ['dist/**'] });
    resolver.clear();
    const ignoredAgain = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignoredAgain.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);
  });

  test('uses ignorePaths from defaultSettings', async () => {
    const root = createTempDir();
    writeConfig(root, {});
    const resolver = createResolver({
      defaultSettings: { ignorePaths: ['build/**'] },
    });
    const ignoredDocument = createDocument(root, 'build/fixture.md');

    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    const checkedDocument = createDocument(root);
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('resolves defaultSettings ignorePaths relative to globRoot', async () => {
    const root = createTempDir();
    const globRoot = path.join(root, 'config');
    const resolver = createResolver({
      defaultSettings: { globRoot, ignorePaths: ['dist/**'] },
    });

    const ignoredDocument = createDocument(root, 'config/dist/fixture.md');
    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    const checkedDocument = createDocument(root, 'dist/fixture.md');
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('uses the workspace root for object defaultSettings ignorePaths without a root', async () => {
    const root = createTempDir();
    const globRoot = path.join(root, 'config');
    const resolver = createResolver({
      defaultSettings: {
        globRoot,
        ignorePaths: [{ glob: 'dist/**' }],
      },
    });

    const ignoredDocument = createDocument(root, 'dist/fixture.md');
    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    // The object glob has no root, so defaultSettings.globRoot must not be
    // applied to it.
    const checkedDocument = createDocument(root, 'config/dist/fixture.md');
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('does not ignore virtual documents without a matching ignore pattern', async () => {
    const root = createTempDir();
    writeConfig(root, {});
    const resolver = createResolver();
    const document = TextDocument.create(
      'git:/workspace/src/fixture.md',
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { settings } = await resolver.getForDocument(document);
    expect(
      (await validateTextDocument(document, settings, cspellLib, root)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('anchors virtual document ignorePaths to the containing workspace', async () => {
    const root = createTempDir();
    const registry = await EngineRegistry.create({
      roots: [root],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });

    function virtualDocument(file: string): TextDocument {
      return TextDocument.create(
        `git:${pathToFileURL(path.join(root, file)).pathname}`,
        'markdown',
        1,
        `This is a ${unknownWord} word.`,
      );
    }

    const ignoredDocument = virtualDocument('dist/fixture.md');
    const ignored = await resolver.getForDocument(ignoredDocument);
    const ignoredRoot = registry.rootAliasForDocument(ignoredDocument.uri);
    expect(ignoredRoot).toBe(root);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        ignored.engine.lib,
        ignoredRoot,
      ),
    ).toEqual([]);

    const checkedDocument = virtualDocument('src/fixture.md');
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          checked.engine.lib,
          registry.rootAliasForDocument(checkedDocument.uri),
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('resolves virtual document aliases through workspace symlinks', async () => {
    const realRoot = createTempDir();
    mkdirSync(path.join(realRoot, 'dist'), { recursive: true });
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const registry = await EngineRegistry.create({
      roots: [realRoot],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });
    const document = TextDocument.create(
      `git:${pathToFileURL(path.join(linkRoot, 'dist', 'fixture.md')).pathname}`,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(linkRoot);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test('anchors virtual documents in deleted directories through a symlink', async () => {
    const realRoot = createTempDir();
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const registry = await EngineRegistry.create({
      roots: [realRoot],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });
    const document = TextDocument.create(
      `git:${pathToFileURL(path.join(linkRoot, 'dist', 'fixture.md')).pathname}`,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(linkRoot);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test('anchors virtual documents in a missing workspace root through a symlink', async () => {
    const realParent = createTempDir();
    const linkParent = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realParent,
      linkParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const realRoot = path.join(realParent, 'deleted-root');
    const linkRoot = path.join(linkParent, 'deleted-root');

    const registry = await EngineRegistry.create({
      roots: [realRoot],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });
    const document = TextDocument.create(
      `git:${pathToFileURL(path.join(linkRoot, 'dist', 'fixture.md')).pathname}`,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(linkRoot);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test('anchors a missing root addressed by its real path', async () => {
    const realParent = createTempDir();
    const linkParent = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realParent,
      linkParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linkRoot = path.join(linkParent, 'deleted-root');
    const realRoot = path.join(realParent, 'deleted-root');

    const registry = await EngineRegistry.create({
      roots: [linkRoot],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });
    const document = TextDocument.create(
      `git:${pathToFileURL(path.join(realRoot, 'dist', 'fixture.md')).pathname}`,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(realRoot);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'anchors virtual documents whose POSIX path resembles a Windows drive',
    async () => {
      const registry = await EngineRegistry.create({
        roots: ['/c:/work'],
        engineOverride: 'bundled',
      });
      const resolver = new SettingsResolver(registry, {
        defaultSettings: { ignorePaths: ['dist/**'] },
      });
      const document = TextDocument.create(
        'git:/c:/work/dist/fixture.md',
        'markdown',
        1,
        `This is a ${unknownWord} word.`,
      );

      const { engine, settings } = await resolver.getForDocument(document);
      const rootAlias = registry.rootAliasForDocument(document.uri);
      expect(rootAlias).toBe('/c:/work');
      expect(
        await validateTextDocument(document, settings, engine.lib, rootAlias),
      ).toEqual([]);
    },
  );

  test('decodes encoded separators in virtual document URIs', async () => {
    const root = createTempDir();
    const registry = await EngineRegistry.create({
      roots: [root],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['dist/**'] },
    });
    const document = TextDocument.create(
      `git:${pathToFileURL(path.join(root, 'dist')).pathname}%2Ffixture.md`,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(root);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test('anchors defaultSettings ignorePaths to the document symlink alias', async () => {
    const realRoot = createTempDir();
    writeConfig(realRoot, {});
    mkdirSync(path.join(realRoot, 'dist'), { recursive: true });
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const roots of [[linkRoot], [realRoot]]) {
      const registry = await EngineRegistry.create({
        roots,
        engineOverride: 'bundled',
      });
      const resolver = new SettingsResolver(registry, {
        defaultSettings: { ignorePaths: ['dist/**'] },
      });

      for (const root of [linkRoot, realRoot]) {
        const document = createDocument(root, 'dist/fixture.md');
        const { engine, settings } = await resolver.getForDocument(document);
        expect(
          await validateTextDocument(
            document,
            settings,
            engine.lib,
            registry.rootAliasForDocument(document.uri),
          ),
        ).toEqual([]);
      }
    }
  });

  test('keeps the document alias when a nested symlink changes the suffix', async () => {
    const realRoot = createTempDir();
    mkdirSync(path.join(realRoot, 'actual'), { recursive: true });
    symlinkSync(
      path.join(realRoot, 'actual'),
      path.join(realRoot, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linkRoot = path.join(createTempDir(), 'workspace');
    symlinkSync(
      realRoot,
      linkRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const registry = await EngineRegistry.create({
      roots: [realRoot],
      engineOverride: 'bundled',
    });
    const resolver = new SettingsResolver(registry, {
      defaultSettings: { ignorePaths: ['alias/**'] },
    });
    const document = TextDocument.create(
      pathToFileURL(path.join(linkRoot, 'alias', 'fixture.md')).href,
      'markdown',
      1,
      `This is a ${unknownWord} word.`,
    );

    const { engine, settings } = await resolver.getForDocument(document);
    const rootAlias = registry.rootAliasForDocument(document.uri);
    expect(rootAlias).toBe(linkRoot);
    expect(
      await validateTextDocument(document, settings, engine.lib, rootAlias),
    ).toEqual([]);
  });

  test('uses ignorePaths from an explicit config relative to its globRoot', async () => {
    const root = createTempDir();
    const configFile = path.join(root, 'configs', 'custom.json');
    writeSettings(configFile, {
      globRoot: '../src',
      ignorePaths: ['generated/**'],
    });
    const resolver = createResolver({ configPath: configFile });
    const ignoredDocument = createDocument(root, 'src/generated/fixture.md');

    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    const checkedDocument = createDocument(root, 'src/fixture.md');
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('resolves ignorePaths relative to each imported configuration', async () => {
    const root = createTempDir();
    writeSettings(path.join(root, 'config', 'shared.json'), {
      ignorePaths: ['vendor/**'],
    });
    writeConfig(root, { import: ['./config/shared.json'] });
    const resolver = createResolver();

    const ignoredDocument = createDocument(root, 'config/vendor/fixture.md');
    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(
        ignoredDocument,
        ignored.settings,
        cspellLib,
        root,
      ),
    ).toEqual([]);

    const checkedDocument = createDocument(root, 'vendor/fixture.md');
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(
          checkedDocument,
          checked.settings,
          cspellLib,
          root,
        )
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('uses ignorePaths from the global configuration', async () => {
    const root = createTempDir();
    const globalRoot = createTempDir();
    writeConfig(root, {});
    const globalSettings: CSpellSettings = {
      ignorePaths: [{ glob: '**/global-ignored/**', root: globalRoot }],
    };
    const lib = {
      ...cspellLib,
      async getGlobalSettingsAsync() {
        return globalSettings;
      },
    } as CSpellLib;
    const resolver = createResolver({}, lib);

    const ignoredDocument = createDocument(root, 'global-ignored/fixture.md');
    const ignored = await resolver.getForDocument(ignoredDocument);
    expect(
      await validateTextDocument(ignoredDocument, ignored.settings, lib, root),
    ).toEqual([]);

    const checkedDocument = createDocument(root);
    const checked = await resolver.getForDocument(checkedDocument);
    expect(
      (
        await validateTextDocument(checkedDocument, checked.settings, lib, root)
      ).map((diagnostic) => diagnostic.message),
    ).toEqual([unknownWordDiagnostic]);
  });

  test('does not check disabled documents', async () => {
    const root = createTempDir();
    writeConfig(root, { enabled: false });
    const resolver = createResolver();
    const document = createDocument(root);

    const { settings } = await resolver.getForDocument(document);
    expect(
      await validateTextDocument(document, settings, cspellLib, root),
    ).toEqual([]);
  });

  test('revalidates after a supported configuration is deleted', async () => {
    const root = createTempDir();
    writeConfig(root, { words: [unknownWord] });
    const resolver = createResolver();
    const document = createDocument(root);

    const before = await resolver.getForDocument(document);
    expect(
      await validateTextDocument(document, before.settings, cspellLib),
    ).toEqual([]);

    rmSync(path.join(root, 'cspell.json'));
    resolver.clear();
    const after = await resolver.getForDocument(document);

    expect(
      (await validateTextDocument(document, after.settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);
  });

  const supportsToml = defaultConfigFilenames.includes('cspell.config.toml');
  const discoveredFormats = [
    {
      file: 'cspell.json',
      content: JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      ),
    },
    {
      file: '.cspell.jsonc',
      content: `// jsonc config\n${JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      )}`,
    },
    {
      file: 'cspell.config.yaml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: '.cspell.yml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: 'package.json',
      content: JSON.stringify(
        {
          name: 'fixture',
          cspell: { version: '0.2', words: [unknownWord] },
        },
        null,
        2,
      ),
    },
    {
      file: 'cspell.config.mjs',
      content: `export default { version: '0.2', words: [${JSON.stringify(
        unknownWord,
      )}] };\n`,
    },
    ...(supportsToml
      ? [
          {
            file: 'cspell.config.toml',
            content: `version = "0.2"\nwords = ["${unknownWord}"]\n`,
          },
        ]
      : []),
  ];

  for (const { file, content } of discoveredFormats) {
    test(`discovers and applies ${file}`, async () => {
      const root = createTempDir();
      writeFileSync(path.join(root, file), content);
      const resolver = createResolver();
      const document = createDocument(root);

      const { settings, engine } = await resolver.getForDocument(document);

      expect(
        await validateTextDocument(document, settings, engine.lib),
      ).toEqual([]);
    });
  }

  const explicitFormats = [
    {
      file: 'explicit.json',
      content: JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      ),
    },
    {
      file: 'explicit.jsonc',
      content: `// jsonc config\n${JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      )}`,
    },
    {
      file: 'explicit.yaml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: 'package.json',
      content: JSON.stringify(
        {
          name: 'fixture',
          cspell: { version: '0.2', words: [unknownWord] },
        },
        null,
        2,
      ),
    },
    {
      file: 'explicit.mjs',
      content: `export default { version: '0.2', words: [${JSON.stringify(
        unknownWord,
      )}] };\n`,
    },
    ...(supportsToml
      ? [
          {
            file: 'explicit.toml',
            content: `version = "0.2"\nwords = ["${unknownWord}"]\n`,
          },
        ]
      : []),
  ];

  for (const { file, content } of explicitFormats) {
    test(`uses --config with ${file}`, async () => {
      const root = createTempDir();
      writeConfig(root, {});
      const configPath = path.join(root, file);
      writeFileSync(configPath, content);
      const resolver = createResolver({ configPath });
      const document = createDocument(root);

      const { settings, engine } = await resolver.getForDocument(document);

      expect(
        await validateTextDocument(document, settings, engine.lib),
      ).toEqual([]);
    });
  }

  test('loads and uses a real workspace-local cspell-lib', async () => {
    const root = createTempDir();
    const localPackage = path.join(root, 'node_modules', 'cspell-lib');
    writeConfig(root, {});
    writeRealCSpellLib(localPackage, { marker: 'real-local' });

    const logs: string[] = [];
    const registry = await EngineRegistry.create({
      roots: [root],
      log: (message) => logs.push(message),
    });
    const resolver = new SettingsResolver(registry);
    const document = createDocument(root);
    const { engine, settings } = await resolver.getForDocument(document);

    expect(engine.mode).toBe('auto');
    expect(engine.packagePath).toBe(realpathSync(localPackage));
    expect(engine.fallbackReason).toBeUndefined();
    expect((engine.lib as unknown as { marker?: string }).marker).toBe(
      'real-local',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`path=${engine.packagePath}`);

    expect(
      (await validateTextDocument(document, settings, engine.lib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    writeConfig(root, { words: [unknownWord] });
    resolver.clear();
    const reloaded = await resolver.getForDocument(document);

    expect(
      await validateTextDocument(document, reloaded.settings, engine.lib),
    ).toEqual([]);
  });

  test('refreshes changed custom dictionaries', async () => {
    const root = createTempDir();
    const dictionaryPath = path.join(root, 'words.txt');
    writeFileSync(dictionaryPath, '');
    writeConfig(root, {
      dictionaryDefinitions: [
        { name: 'project', path: './words.txt', addWords: true },
      ],
      dictionaries: ['project'],
    });
    const resolver = createResolver();
    const document = createDocument(root);

    const { settings } = await resolver.getForDocument(document);
    expect(
      (await validateTextDocument(document, settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    appendFileSync(dictionaryPath, `${unknownWord}\n`);
    await resolver.refreshDictionaries();

    expect(await validateTextDocument(document, settings, cspellLib)).toEqual(
      [],
    );
  });

  const canTestReadOnlyFile =
    process.platform !== 'win32' && process.getuid?.() !== 0;

  test.skipIf(!canTestReadOnlyFile)(
    'does not keep a failed word addition in cached settings',
    async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.json');
      const configWord = `zz${Math.random()
        .toString(36)
        .replace(/[^a-z]/g, '')
        .padEnd(8, 'q')
        .slice(0, 8)}`;
      const missingWord = `zz${Math.random()
        .toString(36)
        .replace(/[^a-z]/g, '')
        .padEnd(8, 'w')
        .slice(0, 8)}`;
      writeConfig(root, { words: [configWord] });

      const engine = createEngine();
      const registry = {
        getForDocument: () => engine,
        all: () => [engine],
      } as unknown as EngineRegistry;
      const resolver = new SettingsResolver(registry);
      const editor = new ConfigEditor({
        engineForDocument: () => engine,
        workspaceRootForDocument: () => root,
      });
      const document = TextDocument.create(
        pathToFileURL(path.join(root, 'fixture.md')).href,
        'markdown',
        1,
        `${configWord} ${missingWord}`,
      );

      const before = await resolver.getForDocument(document);
      expect(
        (await validateTextDocument(document, before.settings, cspellLib)).map(
          (diagnostic) => diagnostic.message,
        ),
      ).toEqual([`"${missingWord}": Unknown word.`]);

      chmodSync(configPath, 0o444);
      try {
        await expect(
          editor.addWord(document.uri, 'words', missingWord),
        ).rejects.toThrow('Could not update');
        expect(
          (JSON.parse(readFileSync(configPath, 'utf8')) as { words: string[] })
            .words,
        ).toEqual([configWord]);

        const after = await resolver.getForDocument(document);
        expect(after.settings.words).toEqual([configWord]);
        expect(
          (await validateTextDocument(document, after.settings, cspellLib)).map(
            (diagnostic) => diagnostic.message,
          ),
        ).toEqual([`"${missingWord}": Unknown word.`]);
      } finally {
        chmodSync(configPath, 0o644);
      }
    },
  );
});
