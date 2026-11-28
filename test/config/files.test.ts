import { describe, expect, test } from 'bun:test';

import * as cspellLib from 'cspell-lib';

import {
  createEngineConfigAdapter,
  getConfigFileNames,
} from '../../src/config/files.js';
import { configWatcherGlobs } from '../../src/config/watcher.js';
import type { CSpellLib } from '../../src/engine/package.js';
import type { CSpellEngine } from '../../src/engine/registry.js';

function createEngine(lib: CSpellLib = cspellLib): CSpellEngine {
  return {
    mode: 'bundled',
    version: 'test',
    packagePath: '<bundled>',
    lib,
  };
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
