import { fileURLToPath } from 'url';

import type { CSpellSettings, CSpellUserSettings } from 'cspell-lib';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellEngine, EngineRegistry } from './engine.js';

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

  constructor(
    private readonly engines: EngineRegistry,
    private readonly options: SettingsResolverOptions = {},
  ) {}

  async getForDocument(textDocument: TextDocument): Promise<DocumentSettings> {
    const engine = this.engines.getForDocument(textDocument.uri);
    const cached = this.cache.get(textDocument.uri);
    if (cached?.engine === engine) {
      return { engine, settings: cached.settings };
    }

    const documentPath = textDocument.uri.startsWith('file:')
      ? safeFileURLToPath(textDocument.uri)
      : undefined;

    let config: CSpellSettings | undefined;
    if (this.options.configPath) {
      try {
        config = await engine.lib.readSettings(this.options.configPath);
      } catch {
        // The configured file might not exist yet.
        config = undefined;
      }
    } else if (documentPath) {
      config = await engine.lib
        .getDefaultConfigLoader()
        .searchForConfig(documentPath);
    }

    const settings = engine.lib.mergeSettings(
      await engine.lib.getDefaultSettings(),
      await engine.lib.getGlobalSettingsAsync(),
      this.options.defaultSettings ?? {},
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

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}
