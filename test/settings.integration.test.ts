import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellEngine, EngineRegistry } from '../src/engine.js';
import { SettingsResolver } from '../src/settings.js';
import { validateTextDocument } from '../src/validator.js';
import { cleanupTempDirs, createTempDir } from './helpers/workspace.js';

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
