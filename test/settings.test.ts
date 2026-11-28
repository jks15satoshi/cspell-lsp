import { describe, expect, test } from 'bun:test';
import type { CSpellSettings } from 'cspell-lib';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellLib } from '../src/engine/package.js';
import type { CSpellEngine, EngineRegistry } from '../src/engine/registry.js';
import { SettingsResolver } from '../src/settings.js';

function createResolver(options: { configPath?: string } = {}): {
  resolver: SettingsResolver;
  setConfigVersion: (version: number) => void;
} {
  let configVersion = 1;
  const lib = {
    async readSettings() {
      return { words: ['explicit-config'] };
    },
    getDefaultConfigLoader() {
      return {
        async searchForConfig() {
          return { words: [`search-${configVersion}`] };
        },
        clearCachedSettingsFiles() {},
      };
    },
    async getDefaultSettings() {
      return {};
    },
    async getGlobalSettingsAsync() {
      return {};
    },
    mergeSettings(...settings: CSpellSettings[]) {
      return Object.assign({}, ...settings);
    },
    constructSettingsForText(settings: CSpellSettings) {
      return settings;
    },
  } as unknown as CSpellLib;
  const engine: CSpellEngine = {
    mode: 'auto',
    version: '9.0.0',
    packagePath: '/workspace/node_modules/cspell-lib',
    lib,
  };
  const registry = {
    getForDocument: () => engine,
    all: () => [engine],
  } as unknown as EngineRegistry;

  return {
    resolver: new SettingsResolver(registry, options),
    setConfigVersion: (version) => {
      configVersion = version;
    },
  };
}

const document = TextDocument.create(
  'file:///workspace/example.ts',
  'typescript',
  1,
  'text',
);

describe('SettingsResolver', () => {
  test('caches resolved settings per document', async () => {
    const { resolver, setConfigVersion } = createResolver();

    const first = await resolver.getForDocument(document);
    setConfigVersion(2);
    const second = await resolver.getForDocument(document);

    expect(first.settings.words).toEqual(['search-1']);
    expect(second.settings.words).toEqual(['search-1']);
  });

  test('clear drops cached document settings', async () => {
    const { resolver, setConfigVersion } = createResolver();

    const before = await resolver.getForDocument(document);
    setConfigVersion(2);
    resolver.clear();
    const after = await resolver.getForDocument(document);

    expect(before.settings.words).toEqual(['search-1']);
    expect(after.settings.words).toEqual(['search-2']);
  });

  test('uses an explicit config path when configured', async () => {
    const { resolver } = createResolver({
      configPath: '/workspace/cspell.json',
    });
    const settings = await resolver.getForDocument(document);

    expect(settings.settings.words).toEqual(['explicit-config']);
  });
});
