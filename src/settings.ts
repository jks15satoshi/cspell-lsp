import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CSpellSettings, CSpellUserSettings } from 'cspell-lib';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { getDocumentUriPath } from './engine/documentPaths.js';
import type { CSpellLib } from './engine/package.js';
import type { CSpellEngine, EngineRegistry } from './engine/registry.js';

export interface DocumentSettings {
  engine: CSpellEngine;
  settings: CSpellSettings;
}

export interface SettingsResolverOptions {
  configPath?: string | null;
  defaultSettings?: CSpellUserSettings;
  /** Called for custom dictionaries that can be extended with addWords. */
  onDictionaryDefinition?: (dictionaryPath: string) => void;
}

interface CacheEntry {
  engine: CSpellEngine;
  settings: CSpellSettings;
}

/**
 * Resolves CSpell settings with the engine selected for the document.
 *
 * Settings are cached per document, but cache invalidation also clears each
 * engine's config loader so a configuration change cannot keep stale settings
 * from a different engine instance.
 */
export class SettingsResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defaultSettings: CSpellUserSettings;

  constructor(
    private readonly engines: EngineRegistry,
    private readonly options: SettingsResolverOptions = {},
  ) {
    this.defaultSettings = normalizeDefaultIgnorePaths(options.defaultSettings);
  }

  async getForDocument(textDocument: TextDocument): Promise<DocumentSettings> {
    const engine = this.engines.getForDocument(textDocument.uri);
    const cached = this.cache.get(textDocument.uri);
    if (cached?.engine === engine) {
      return { engine, settings: cached.settings };
    }

    const documentPath = textDocument.uri.startsWith('file:')
      ? safeFileURLToPath(textDocument.uri)
      : getDocumentUriPath(textDocument.uri);

    let config: CSpellSettings | undefined;
    if (this.options.configPath) {
      config = await readExplicitConfig(engine.lib, this.options.configPath);
    } else if (documentPath) {
      config = await engine.lib
        .getDefaultConfigLoader()
        .searchForConfig(documentPath);
    }

    const settings = engine.lib.mergeSettings(
      await engine.lib.getDefaultSettings(),
      await engine.lib.getGlobalSettingsAsync(),
      this.defaultSettings,
      config || {},
    );
    const documentSettings = engine.lib.constructSettingsForText(
      settings,
      undefined,
      textDocument.languageId,
    );

    for (const dictionary of documentSettings.dictionaryDefinitions ?? []) {
      if (!('path' in dictionary) || !dictionary.path) continue;
      if (!('addWords' in dictionary) || !dictionary.addWords) continue;
      this.options.onDictionaryDefinition?.(dictionary.path);
    }

    this.cache.set(textDocument.uri, { engine, settings: documentSettings });
    return { engine, settings: documentSettings };
  }

  /**
   * Drops document settings and the selected engines' config file caches.
   */
  clear(): void {
    this.cache.clear();
    for (const engine of this.engines.all()) {
      engine.lib.getDefaultConfigLoader().clearCachedSettingsFiles();
    }
  }

  /**
   * Refreshes dictionary caches for every selected engine.
   */
  async refreshDictionaries(): Promise<void> {
    await Promise.all(
      this.engines.all().map((engine) => engine.lib.refreshDictionaryCache(0)),
    );
  }
}

/**
 * Reads an explicit `--config` file and reports missing, unreadable, or
 * malformed files instead of silently falling back to default settings.
 *
 * cspell-lib can return a settings object carrying import errors rather than
 * throwing, and older engines may not expose the same error helpers. The
 * readability check covers missing and permission failures for every engine;
 * `extractImportErrors` adds parse errors when the selected engine provides it.
 */
async function readExplicitConfig(
  lib: CSpellLib,
  configPath: string,
): Promise<CSpellSettings> {
  try {
    fs.accessSync(configPath, fs.constants.R_OK);
  } catch (error) {
    throw explicitConfigError(configPath, error);
  }

  let config: CSpellSettings;
  try {
    config = await lib.readSettings(configPath);
  } catch (error) {
    throw explicitConfigError(configPath, error);
  }

  const extractImportErrors = (
    lib as unknown as {
      extractImportErrors?: (settings: CSpellSettings) => { error?: Error }[];
    }
  ).extractImportErrors;
  const importErrors = extractImportErrors?.(config) ?? [];
  if (importErrors.length > 0) {
    throw explicitConfigError(
      configPath,
      importErrors
        .map((entry) => entry.error?.message ?? 'Unknown error')
        .join('; '),
    );
  }
  return config;
}

function explicitConfigError(configPath: string, error: unknown): Error {
  return new Error(
    `Failed to read CSpell config at ${configPath}: ${errorMessage(error)}`,
    { cause: error },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Anchors string `defaultSettings.ignorePaths` to their own `globRoot`.
 *
 * cspell-lib normalizes globs from configuration files to `{ glob, root }`
 * definitions, but `mergeSettings` clears `globRoot`. Initialization defaults
 * are merged as raw settings, so their root has to be attached before merging.
 * This mirrors cspell-lib's `toGlobDef`: only string globs receive the root;
 * object globs keep their own root or fall back to the workspace root.
 */
function normalizeDefaultIgnorePaths(
  settings: CSpellUserSettings | undefined,
): CSpellUserSettings {
  if (!settings) return {};
  const globRoot = settings.globRoot;
  if (!globRoot || !settings.ignorePaths?.length) return settings;

  return {
    ...settings,
    ignorePaths: settings.ignorePaths.map((glob) =>
      typeof glob === 'string' ? { glob, root: globRoot } : glob,
    ),
  };
}

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}
