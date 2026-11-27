#!/usr/bin/env node

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  ExecuteCommandParams,
  FileSystemWatcher,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CSpellUserSettings } from 'cspell-lib';

import * as Validator from './validator.js';
import {
  createOnCodeActionHandler,
  type CodeActionDocumentContext,
} from './codeActions.js';
import {
  ConfigEditError,
  ConfigEditor,
  configWatcherPatterns,
  getConfigFileNames,
} from './config.js';
import { EngineRegistry } from './engine.js';
import { SettingsResolver } from './settings.js';
import commandLineArgs from 'command-line-args';

const optionDefinitions = [
  { name: 'config', alias: 'c', type: String, defaultValue: null },
  { name: 'sortWords', type: Boolean, defaultValue: false },
  { name: 'stdio', type: String },
  { name: 'engine', type: String, defaultValue: null },
];

const options = commandLineArgs(optionDefinitions);

let defaultSettings: CSpellUserSettings = {};
let workspaceRoots: string[] = [];

const COMMANDS = [
  'AddToUserWordsConfig',
  'AddToWorkspaceWordsConfig',
  'AddToCustomDictionary',
];

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

const watchingCustomDictionaries: Set<string> = new Set();

let engineRegistryPromise: Promise<EngineRegistry> | undefined;
let settingsResolver: SettingsResolver | undefined;
let configEditor: ConfigEditor | undefined;

connection.onInitialize((params: InitializeParams) => {
  defaultSettings = params.initializationOptions?.defaultSettings ?? {};

  hasConfigurationCapability = !!(
    params.capabilities.workspace &&
    !!params.capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    params.capabilities.workspace &&
    !!params.capabilities.workspace.workspaceFolders
  );

  workspaceRoots = collectWorkspaceRoots(params);

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        willSave: true,
        save: { includeText: true },
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
      executeCommandProvider: {
        commands: COMMANDS,
      },
    },
  };
  return result;
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log(
        'Workspace folder change event received. Restart the server to apply engine changes.',
      );
    });
  }

  try {
    const registry = await getEngineRegistry();
    settingsResolver = createSettingsResolver(registry);
    await registerWatchers(registry);
  } catch (error) {
    const message = `CSpell engine could not be initialized: ${errorMessage(error)}`;
    process.stderr.write(`cspell-lsp: ${message}\n`);
    connection.console.error(message);
    connection.dispose();
    // Give the error notification a chance to reach the client before exiting.
    setTimeout(() => process.exit(1), 100);
  }
});

connection.onDidChangeWatchedFiles(async (change) => {
  connection.console.log(
    'Configuration file changed. Revalidating all open documents.',
  );
  const customDictionaryChanged = change.changes.some((changedFile) =>
    isWatchingDictionary(changedFile.uri),
  );
  if (customDictionaryChanged) {
    try {
      await (await ensureSettingsResolver()).refreshDictionaries();
    } catch (error) {
      connection.console.error(
        `Failed to refresh CSpell dictionaries: ${errorMessage(error)}`,
      );
    }
  }
  await revalidateAllOpenDocuments();
});

connection.onCodeAction(
  createOnCodeActionHandler(
    documents,
    getDocumentContext,
    async (textDocument) =>
      (await ensureConfigEditor()).canEdit(textDocument.uri),
  ),
);

// This event is emitted when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  void validateTextDocument(change.document);
});

async function getDocumentContext(
  textDocument: TextDocument,
): Promise<CodeActionDocumentContext> {
  return (await ensureSettingsResolver()).getForDocument(textDocument);
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  try {
    const { engine, settings } = await getDocumentContext(textDocument);
    connection.sendDiagnostics({
      uri: textDocument.uri,
      diagnostics: await Validator.validateTextDocument(
        textDocument,
        settings,
        engine.lib,
      ),
    });
  } catch (error) {
    connection.console.error(
      `Failed to validate ${textDocument.uri}: ${errorMessage(error)}`,
    );
  }
}

async function revalidateAllOpenDocuments(): Promise<void> {
  try {
    (await ensureSettingsResolver()).clear();
  } catch (error) {
    connection.console.error(
      `Failed to reload CSpell settings: ${errorMessage(error)}`,
    );
    return;
  }
  for (const doc of documents.all()) {
    void validateTextDocument(doc);
  }
}

function getEngineRegistry(): Promise<EngineRegistry> {
  if (!engineRegistryPromise) {
    engineRegistryPromise = EngineRegistry.create({
      roots: workspaceRoots,
      engineOverride: options.engine,
      log: (message) => connection.console.info(message),
    });
  }
  return engineRegistryPromise;
}

async function ensureSettingsResolver(): Promise<SettingsResolver> {
  if (!settingsResolver) {
    const registry = await getEngineRegistry();
    settingsResolver = createSettingsResolver(registry);
  }
  return settingsResolver;
}

async function ensureConfigEditor(): Promise<ConfigEditor> {
  if (!configEditor) {
    const registry = await getEngineRegistry();
    configEditor = new ConfigEditor(
      {
        engineForDocument: (uri) => registry.getForDocument(uri),
        workspaceRootForDocument: (uri) =>
          registry.rootForDocument(uri) ?? registry.roots[0],
      },
      {
        configPath: options.config,
        defaultSettings,
      },
    );
  }
  return configEditor;
}

function createSettingsResolver(registry: EngineRegistry): SettingsResolver {
  return new SettingsResolver(registry, {
    configPath: options.config,
    defaultSettings,
    onDictionaryDefinition: addDictionaryWatcher,
  });
}

async function registerWatchers(registry: EngineRegistry): Promise<void> {
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
    configPath: options.config,
    globalConfigRoots: [...globalRoots],
  });
  const watchers: FileSystemWatcher[] = patterns.map(({ baseUri, pattern }) =>
    baseUri ? { globPattern: { baseUri, pattern } } : { globPattern: pattern },
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
  const pattern = path.basename(dictionaryPath);
  watchingCustomDictionaries.add(dictionaryPath);
  void connection.client
    .register(DidChangeWatchedFilesNotification.type, {
      watchers: [{ globPattern: { baseUri, pattern } }],
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

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  const { command, arguments: args } = params;
  if (COMMANDS.indexOf(command) < 0) {
    return;
  }

  const diagnosticInfo = args![0];
  const { uri, range, name: dictName, path: dictPath } = diagnosticInfo;
  const document = documents.get(uri!);
  if (!document) {
    return { error: `Could not get document for ${uri}` };
  }
  const word = document.getText(range);
  if (!word) {
    return { error: 'Could not extract the word from the message.' };
  }

  if (
    command == 'AddToUserWordsConfig' ||
    command == 'AddToWorkspaceWordsConfig'
  ) {
    const attribute = command == 'AddToUserWordsConfig' ? 'userWords' : 'words';
    try {
      await (
        await ensureConfigEditor()
      ).addWord(uri!, attribute, word, { sortWords: options.sortWords });
    } catch (error) {
      if (error instanceof ConfigEditError) {
        return { error: error.message };
      }
      return { error: errorMessage(error) };
    }

    await revalidateAllOpenDocuments();
    return { result: `Added "${word}" to the dictionary.` };
  }
  if (command == 'AddToCustomDictionary') {
    // Assumes the file breaks lines with LF and it ends with a \n already,
    // instead of trying to be clever
    fs.appendFileSync(dictPath, `${word}\n`);

    try {
      await (await ensureSettingsResolver()).refreshDictionaries();
    } catch (error) {
      connection.console.error(
        `Failed to refresh CSpell dictionaries: ${errorMessage(error)}`,
      );
    }
    await revalidateAllOpenDocuments();
    return { result: `Added ${word} to ${dictName} dictionary.` };
  }
});

function collectWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  for (const folder of params.workspaceFolders ?? []) {
    const root = safeFileURLToPath(folder.uri);
    if (root) roots.push(path.resolve(root));
  }
  if (roots.length === 0 && params.rootUri) {
    const root = safeFileURLToPath(params.rootUri);
    if (root) roots.push(path.resolve(root));
  }
  if (roots.length === 0 && params.rootPath) {
    roots.push(path.resolve(params.rootPath));
  }
  return [...new Set(roots)];
}

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
