import * as fs from 'node:fs';

import type {
  Connection,
  ExecuteCommandParams,
  TextDocuments,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { ConfigEditError, type ConfigEditor } from './config/editor.js';
import type { SettingsResolver } from './settings.js';

export const COMMANDS = [
  'AddToUserWordsConfig',
  'AddToWorkspaceWordsConfig',
  'AddToCustomDictionary',
];

export interface ExecuteCommandContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  getConfigEditor(): Promise<ConfigEditor>;
  getSettingsResolver(): Promise<SettingsResolver>;
  revalidateAllOpenDocuments(): Promise<void>;
  sortWords: boolean;
}

/**
 * Creates the executeCommand handler for the dictionary commands.
 */
export function createExecuteCommandHandler(
  context: ExecuteCommandContext,
): (params: ExecuteCommandParams) => Promise<unknown> {
  return async (params: ExecuteCommandParams) => {
    const { command, arguments: args } = params;
    if (COMMANDS.indexOf(command) < 0) {
      return;
    }

    const diagnosticInfo = args![0];
    const { uri, range, name: dictName, path: dictPath } = diagnosticInfo;
    const document = context.documents.get(uri!);
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
      const attribute =
        command == 'AddToUserWordsConfig' ? 'userWords' : 'words';
      try {
        await (
          await context.getConfigEditor()
        ).addWord(uri!, attribute, word, {
          sortWords: context.sortWords,
        });
      } catch (error) {
        // A failed write can leave mutated settings in the resolver cache, so
        // reload from disk before returning the error.
        await context.revalidateAllOpenDocuments();
        if (error instanceof ConfigEditError) {
          return { error: error.message };
        }
        return { error: errorMessage(error) };
      }

      await context.revalidateAllOpenDocuments();
      return { result: `Added "${word}" to the dictionary.` };
    }
    if (command == 'AddToCustomDictionary') {
      // Assumes the file breaks lines with LF and it ends with a \n already,
      // instead of trying to be clever
      fs.appendFileSync(dictPath, `${word}\n`);

      try {
        await (await context.getSettingsResolver()).refreshDictionaries();
      } catch (error) {
        context.connection.console.error(
          `Failed to refresh CSpell dictionaries: ${errorMessage(error)}`,
        );
      }
      await context.revalidateAllOpenDocuments();
      return { result: `Added ${word} to ${dictName} dictionary.` };
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
