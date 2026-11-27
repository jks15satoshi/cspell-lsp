import { afterEach, describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';

import * as cspellLib from 'cspell-lib';
import type { ICSpellConfigFile } from 'cspell-lib';

import {
  configReadOnlyReason,
  configWatcherGlobs,
  configWatcherPatterns,
  createEngineConfigAdapter,
  getConfigFileNames,
} from '../src/config.js';
import type { CSpellEngine, CSpellLib } from '../src/engine.js';
import { cleanupTempDirs, createTempDir } from './helpers/workspace.js';

afterEach(cleanupTempDirs);

function createEngine(lib: CSpellLib = cspellLib): CSpellEngine {
  return {
    mode: 'bundled',
    version: 'test',
    packagePath: '<bundled>',
    lib,
  };
}

function fakeConfigFile(
  overrides: Record<string, unknown> = {},
): ICSpellConfigFile {
  return {
    url: new URL('file:///workspace/cspell.json'),
    settings: {},
    ...overrides,
  } as ICSpellConfigFile;
}

describe('engine configuration adapter', () => {
  test('uses the selected engine config names', () => {
    const adapter = createEngineConfigAdapter(createEngine());

    expect(adapter.fileNames).toEqual([
      ...new Set(cspellLib.defaultConfigFilenames),
    ]);
  });

  test('uses a mock engine with a different config-name set', () => {
    const lib = {
      defaultConfigFilenames: [
        'custom.json',
        'nested/custom.yaml',
        'custom.json',
      ],
      getDefaultConfigLoader: () => ({
        clearCachedSettingsFiles() {},
        async readConfigFile() {
          return undefined;
        },
        async searchForConfigFileLocation() {
          return undefined;
        },
      }),
    } as unknown as CSpellLib;
    const adapter = createEngineConfigAdapter(createEngine(lib));

    expect(adapter.fileNames).toEqual(['custom.json', 'nested/custom.yaml']);
    expect(configWatcherGlobs(adapter.fileNames)).toEqual([
      '**/custom.json',
      '**/nested/custom.yaml',
    ]);
  });

  test('rejects engines without config names', () => {
    const lib = { defaultConfigFilenames: [] } as unknown as CSpellLib;

    expect(() => getConfigFileNames(createEngine(lib))).toThrow(
      'defaultConfigFilenames',
    );
  });
});

describe('config watcher patterns', () => {
  test('groups config names by directory', () => {
    expect(
      configWatcherGlobs([
        'cspell.json',
        'cspell.config.toml',
        'package.json',
        '.vscode/cspell.json',
        '.vscode/cSpell.json',
      ]),
    ).toEqual([
      '**/.vscode/{cSpell.json,cspell.json}',
      '**/{cspell.config.toml,cspell.json,package.json}',
    ]);
  });

  test('includes TOML only when the engine lists it', () => {
    expect(configWatcherGlobs(['cspell.json', 'cspell.config.toml'])).toEqual([
      '**/{cspell.config.toml,cspell.json}',
    ]);
    expect(configWatcherGlobs(['cspell.json', 'cspell.config.yaml'])).toEqual([
      '**/{cspell.config.yaml,cspell.json}',
    ]);
  });

  test('generates watcher globs for the bundled engine list', () => {
    const globs = configWatcherGlobs(cspellLib.defaultConfigFilenames);

    expect(globs.some((glob) => glob.includes('package.json'))).toBe(true);
    expect(globs.some((glob) => glob.includes('cspell.config.toml'))).toBe(
      cspellLib.defaultConfigFilenames.includes('cspell.config.toml'),
    );
  });

  test('deduplicates config names and patterns', () => {
    expect(configWatcherGlobs(['cspell.json', 'cspell.json'])).toEqual([
      '**/cspell.json',
    ]);
    expect(
      configWatcherPatterns({
        roots: [
          { root: '/workspace', fileNames: ['cspell.json'] },
          { root: '/workspace', fileNames: ['cspell.json'] },
        ],
      }),
    ).toEqual([
      {
        baseUri: pathToFileURL('/workspace').href,
        pattern: '**/cspell.json',
      },
    ]);
  });

  test('builds per-root, explicit, and global watcher patterns', () => {
    const globalRoot = createTempDir();

    expect(
      configWatcherPatterns({
        roots: [
          {
            root: '/workspace/one',
            fileNames: ['cspell.json', 'package.json'],
          },
          {
            root: '/workspace/two',
            fileNames: ['cspell.json', 'cspell.config.toml'],
          },
        ],
        configPath: '.config/cspell.yaml',
        cwd: '/workspace/project',
        globalConfigRoots: [globalRoot, '/workspace/missing-global'],
      }),
    ).toEqual([
      {
        baseUri: pathToFileURL('/workspace/one').href,
        pattern: '**/{cspell.json,package.json}',
      },
      {
        baseUri: pathToFileURL('/workspace/two').href,
        pattern: '**/{cspell.config.toml,cspell.json}',
      },
      {
        baseUri: pathToFileURL('/workspace/project/.config').href,
        pattern: 'cspell.yaml',
      },
      {
        baseUri: pathToFileURL(globalRoot).href,
        pattern: 'cspell.json',
      },
    ]);
  });

  test('falls back to global patterns without workspace roots', () => {
    expect(
      configWatcherPatterns({
        roots: [],
        fallbackFileNames: ['cspell.json', 'package.json'],
      }),
    ).toEqual([{ pattern: '**/{cspell.json,package.json}' }]);
  });
});

describe('config writability', () => {
  test('allows configs with an engine writer', () => {
    expect(
      configReadOnlyReason(fakeConfigFile({ serialize: () => '' })),
    ).toBeUndefined();
  });

  test('explains read-only configs and guards', () => {
    expect(configReadOnlyReason(fakeConfigFile({ readonly: true }))).toBe(
      'the configuration is marked read-only.',
    );
    expect(
      configReadOnlyReason(
        fakeConfigFile({ remote: true, serialize: () => '' }),
      ),
    ).toBe('remote configuration files are read-only.');
    expect(
      configReadOnlyReason(
        fakeConfigFile({ virtual: true, serialize: () => '' }),
      ),
    ).toBe('virtual configuration files are read-only.');
    expect(
      configReadOnlyReason(
        fakeConfigFile({
          error: new Error('invalid toml'),
          serialize: () => '',
        }),
      ),
    ).toBe('the configuration could not be parsed: invalid toml');
    expect(configReadOnlyReason(fakeConfigFile())).toBe(
      'the configuration has no safe writer.',
    );
  });
});
