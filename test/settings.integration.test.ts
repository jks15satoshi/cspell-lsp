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
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellEngine } from '../src/engine.js';
import { EngineRegistry } from '../src/engine.js';
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

function createEngine(): CSpellEngine {
  return {
    mode: 'bundled',
    version: 'test',
    packagePath: '<bundled>',
    lib: cspellLib,
  };
}

function createResolver(): SettingsResolver {
  const engine = createEngine();
  const registry = {
    getForDocument: () => engine,
    all: () => [engine],
  } as unknown as EngineRegistry;
  return new SettingsResolver(registry);
}

function createDocument(root: string): TextDocument {
  return TextDocument.create(
    pathToFileURL(path.join(root, 'fixture.md')).href,
    'markdown',
    1,
    `This is a ${unknownWord} word.`,
  );
}

function writeConfig(root: string, settings: object): void {
  writeFileSync(
    path.join(root, 'cspell.json'),
    JSON.stringify(
      { version: '0.2', language: 'en', enabled: true, ...settings },
      null,
      2,
    ),
  );
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
