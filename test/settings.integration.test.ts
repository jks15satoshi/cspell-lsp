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
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellSettings } from 'cspell-lib';
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
});
