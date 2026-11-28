import type { CSpellConfigFile, ICSpellConfigFile } from 'cspell-lib';

import type { CSpellEngine } from '../engine/registry.js';

/**
 * The configuration APIs of one selected CSpell engine.
 *
 * Everything here comes from the same engine instance so a workspace engine
 * never reads with one copy of cspell-lib and writes with another.
 */
export interface EngineConfigAdapter {
  readonly fileNames: readonly string[];
  searchForConfigFileLocation(searchFrom: string): Promise<URL | undefined>;
  readConfigFile(file: string | URL): Promise<CSpellConfigFile | Error>;
  serializeConfigFile(configFile: CSpellConfigFile): string | undefined;
  clearCachedSettingsFiles(): void;
}

/**
 * Returns the config file names reported by the selected engine.
 *
 * The list is the source of truth for discovery and watching; cspell-lsp does
 * not maintain its own format list.
 */
export function getConfigFileNames(engine: CSpellEngine): readonly string[] {
  const names = engine.lib.defaultConfigFilenames;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(
      `CSpell engine at ${engine.packagePath} does not expose defaultConfigFilenames`,
    );
  }
  return [...new Set(names)];
}

/**
 * Creates the configuration adapter for a selected engine.
 */
export function createEngineConfigAdapter(
  engine: CSpellEngine,
): EngineConfigAdapter {
  const loader = engine.lib.getDefaultConfigLoader();
  return {
    fileNames: getConfigFileNames(engine),
    searchForConfigFileLocation: (searchFrom) =>
      loader.searchForConfigFileLocation(searchFrom),
    readConfigFile: (file) => loader.readConfigFile(file),
    serializeConfigFile,
    clearCachedSettingsFiles: () => loader.clearCachedSettingsFiles(),
  };
}

/**
 * Whether a configuration object can serialize itself back to disk.
 */
export function hasSerialize(
  configFile: ICSpellConfigFile,
): configFile is ICSpellConfigFile & { serialize(): string } {
  return (
    typeof (configFile as { serialize?: unknown }).serialize === 'function'
  );
}

function serializeConfigFile(configFile: CSpellConfigFile): string | undefined {
  if (!hasSerialize(configFile)) return undefined;
  return configFile.serialize();
}
