import { describe, expect, test } from 'bun:test';
import type { CSpellSettings } from 'cspell-lib';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellLib } from '../src/engine/package.js';
import type { CSpellEngine, EngineRegistry } from '../src/engine/registry.js';
import {
  SettingsResolver,
  type SettingsResolverOptions,
} from '../src/settings.js';

function createResolver(options: SettingsResolverOptions = {}): {
  resolver: SettingsResolver;
  searchCalls: string[];
  setConfigVersion: (version: number) => void;
} {
  let configVersion = 1;
  const searchCalls: string[] = [];
  const lib = {
    async readSettings() {
      return { words: ['explicit-config'] };
    },
    getDefaultConfigLoader() {
      return {
        async searchForConfig(documentPath: string) {
          searchCalls.push(documentPath);
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
    searchCalls,
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

  test('searches for a local file URI', async () => {
    const { resolver, searchCalls } = createResolver();

    const settings = await resolver.getForDocument(document);

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toContain('example.ts');
    expect(settings.settings.words).toEqual(['search-1']);
  });

  test.skipIf(process.platform === 'win32')(
    'does not search for a file URI with a remote host',
    async () => {
      const remoteDocument = TextDocument.create(
        'file://server/share/a.ts',
        'typescript',
        1,
        'text',
      );
      const { resolver, searchCalls } = createResolver({
        defaultSettings: { words: ['defaults'] },
      });

      const settings = await resolver.getForDocument(remoteDocument);

      expect(searchCalls).toEqual([]);
      expect(settings.settings.words).toEqual(['defaults']);
    },
  );

  test('does not search for a file URI with an encoded separator', async () => {
    const encodedDocument = TextDocument.create(
      'file:///workspace/a%2Fb.ts',
      'typescript',
      1,
      'text',
    );
    const { resolver, searchCalls } = createResolver({
      defaultSettings: { words: ['defaults'] },
    });

    const settings = await resolver.getForDocument(encodedDocument);

    expect(searchCalls).toEqual([]);
    expect(settings.settings.words).toEqual(['defaults']);
  });
});
