import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DidChangeWatchedFilesNotification,
  type Connection,
  type FileSystemWatcher,
} from 'vscode-languageserver/node.js';

import { getConfigFileNames } from './config/files.js';
import {
  absoluteWatcherPattern,
  configWatcherPatterns,
  escapeGlobLiteral,
} from './config/watcher.js';
import type { EngineRegistry } from './engine/registry.js';
import { safeFileURLToPath } from './workspace.js';

export interface ConfigWatcherOptions {
  connection: Connection;
  configPath?: string | null;
  relativePatternSupport: boolean;
}

export interface ConfigWatcher {
  register(registry: EngineRegistry): Promise<void>;
  addDictionaryWatcher(dictionaryPath: string): void;
  isWatchingDictionary(uri: string): boolean;
}

/**
 * Creates the config and custom-dictionary watcher state for one server.
 */
export function createConfigWatcher(
  options: ConfigWatcherOptions,
): ConfigWatcher {
  const { connection, configPath, relativePatternSupport } = options;
  const watchingCustomDictionaries: Set<string> = new Set();

  async function register(registry: EngineRegistry): Promise<void> {
    const globalRoots = new Set<string>();
    for (const engine of registry.all()) {
      try {
        const globalConfig = await engine.lib.getGlobalSettingsAsync();
        // getGlobalSettingsAsync returns with globRoot even if global config doesn't exist
        if (globalConfig.globRoot) globalRoots.add(globalConfig.globRoot);
      } catch (error) {
        connection.console.warn(
          `Could not read the global CSpell configuration: ${errorMessage(error)}`,
        );
      }
    }

    const roots = registry.roots.map((root) => ({
      root,
      fileNames: getConfigFileNames(registry.getForRoot(root)),
    }));
    const patterns = configWatcherPatterns({
      roots,
      fallbackFileNames:
        roots.length === 0
          ? getConfigFileNames(registry.getForDocument(''))
          : undefined,
      configPath,
      globalConfigRoots: [...globalRoots],
      relativePatternSupport,
    });
    const watchers: FileSystemWatcher[] = patterns.map(({ baseUri, pattern }) =>
      baseUri
        ? { globPattern: { baseUri, pattern } }
        : { globPattern: pattern },
    );

    // Watch for changes in cspell config files
    try {
      await connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers,
      });
    } catch (error) {
      connection.console.warn(
        `Could not register CSpell configuration watchers: ${errorMessage(error)}`,
      );
    }
  }

  function addDictionaryWatcher(dictionaryPath: string): void {
    if (watchingCustomDictionaries.has(dictionaryPath)) return;

    const baseUri = pathToFileURL(path.dirname(dictionaryPath)).href;
    const pattern = escapeGlobLiteral(path.basename(dictionaryPath));
    const globPattern = relativePatternSupport
      ? { baseUri, pattern }
      : absoluteWatcherPattern(baseUri, pattern);
    watchingCustomDictionaries.add(dictionaryPath);
    void connection.client
      .register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern }],
      })
      .catch((error) => {
        watchingCustomDictionaries.delete(dictionaryPath);
        connection.console.error(
          `Failed to watch custom dictionary ${dictionaryPath}: ${errorMessage(error)}`,
        );
      });
  }

  function isWatchingDictionary(uri: string): boolean {
    const dictionaryPath = safeFileURLToPath(uri);
    return dictionaryPath
      ? watchingCustomDictionaries.has(dictionaryPath)
      : false;
  }

  return { register, addDictionaryWatcher, isWatchingDictionary };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
