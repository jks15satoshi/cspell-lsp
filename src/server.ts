import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CSpellUserSettings } from 'cspell-lib';

import * as Validator from './validator.js';
import {
  createOnCodeActionHandler,
  type CodeActionDocumentContext,
} from './codeActions.js';
import { COMMANDS, createExecuteCommandHandler } from './commands.js';
import { ConfigEditor } from './config/editor.js';
import { DocumentGenerations } from './documentGenerations.js';
import { EngineRegistry } from './engine/registry.js';
import { SettingsResolver } from './settings.js';
import { createConfigWatcher, type ConfigWatcher } from './watchers.js';
import { collectWorkspaceRoots } from './workspace.js';

export interface ServerOptions {
  config: string | null;
  engine: string | null;
  sortWords: boolean;
}

export interface CSpellServer {
  listen(): void;
}

/**
 * Creates the language server for the given CLI options.
 */
export function createServer(options: ServerOptions): CSpellServer {
  let defaultSettings: CSpellUserSettings = {};
  let workspaceRoots: string[] = [];

  // Create a connection for the server, using Node's IPC as a transport.
  // Also include all preview / proposed LSP features.
  const connection = createConnection(ProposedFeatures.all);

  // Create a simple text document manager.
  const documents = new TextDocuments(TextDocument);

  let hasConfigurationCapability = false;
  let hasWorkspaceFolderCapability = false;
  let hasRelativePatternSupport = false;

  let watchers: ConfigWatcher | undefined;
  const validationGenerations = new DocumentGenerations();

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
    hasRelativePatternSupport =
      !!params.capabilities.workspace?.didChangeWatchedFiles
        ?.relativePatternSupport;

    workspaceRoots = collectWorkspaceRoots(params);

    watchers = createConfigWatcher({
      connection,
      configPath: options.config,
      relativePatternSupport: hasRelativePatternSupport,
    });

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
      await watchers!.register(registry);
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
      watchers ? watchers.isWatchingDictionary(changedFile.uri) : false,
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

  documents.onDidClose((change) => {
    validationGenerations.delete(change.document.uri);
  });

  interface DocumentContext extends CodeActionDocumentContext {
    /** Workspace path alias that matches the document, used to anchor ignore globs. */
    root?: string;
  }

  async function getDocumentContext(
    textDocument: TextDocument,
  ): Promise<DocumentContext> {
    const resolver = await ensureSettingsResolver();
    const context = await resolver.getForDocument(textDocument);
    const registry = await getEngineRegistry();
    return {
      ...context,
      root: registry.rootAliasForDocument(textDocument.uri),
    };
  }

  async function validateTextDocument(
    textDocument: TextDocument,
  ): Promise<void> {
    const generation = validationGenerations.next(textDocument.uri);
    try {
      const { engine, settings, root } = await getDocumentContext(textDocument);
      const diagnostics = await Validator.validateTextDocument(
        textDocument,
        settings,
        engine.lib,
        root,
      );
      if (!validationGenerations.isCurrent(textDocument.uri, generation)) {
        return;
      }
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    } catch (error) {
      if (!validationGenerations.isCurrent(textDocument.uri, generation)) {
        return;
      }
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
      onDictionaryDefinition: (dictionaryPath) =>
        watchers?.addDictionaryWatcher(dictionaryPath),
    });
  }

  connection.onExecuteCommand(
    createExecuteCommandHandler({
      connection,
      documents,
      getConfigEditor: ensureConfigEditor,
      getSettingsResolver: ensureSettingsResolver,
      revalidateAllOpenDocuments,
      sortWords: options.sortWords,
    }),
  );

  return {
    listen() {
      // Make the text document manager listen on the connection
      // for open, change and close text document events
      documents.listen(connection);

      // Listen on the connection
      connection.listen();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
