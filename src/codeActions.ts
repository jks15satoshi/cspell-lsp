import type {
  CSpellSettings,
  SuggestionResult,
  SuggestOptions,
} from 'cspell-lib';
import type {
  CodeActionParams,
  Range as LangServerRange,
  TextDocuments,
} from 'vscode-languageserver/node.js';
import type {
  Position,
  TextDocument,
} from 'vscode-languageserver-textdocument';
import { Diagnostic, WorkspaceEdit } from 'vscode-languageserver-types';
import {
  CodeAction,
  CodeActionKind,
  TextEdit,
} from 'vscode-languageserver-types';

import type { CSpellEngine } from './engine.js';
import * as Validator from './validator.js';

function extractDiagnosticData(
  diag: Diagnostic,
): Validator.SpellCheckerDiagnosticData {
  const { data } = diag;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Validator.SpellCheckerDiagnosticData;
}

function replaceText(range: LangServerRange, text?: string) {
  return TextEdit.replace(range, text || '');
}

// A helper function to check if a position is inside a range.
function isPositionInRange(pos: Position, range: LangServerRange) {
  return (
    pos.line === range.start.line &&
    pos.character >= range.start.character &&
    pos.character <= range.end.character
  );
}

function suggestionToTitle(sug: Validator.Suggestion): string | undefined {
  return sug.word + (sug.isPreferred ? ' (preferred)' : '');
}

function createWorkspaceAction(
  title: string,
  workspaceEdit: WorkspaceEdit,
  diags: Diagnostic[] | undefined,
  isPreferred?: boolean,
): CodeAction {
  const action = CodeAction.create(
    title,
    workspaceEdit,
    CodeActionKind.QuickFix,
  );
  action.diagnostics = diags;
  if (isPreferred) {
    action.isPreferred = true;
  }
  return action;
}

function isWordLikeSelection(
  doc: TextDocument,
  range: LangServerRange,
): boolean {
  if (range.start.line !== range.end.line) return false;

  const text = doc.getText(range);
  const hasSpace = /\s/.test(text.trim());
  return !hasSpace;
}

export interface CodeActionDocumentContext {
  engine: CSpellEngine;
  settings: CSpellSettings;
}

export type DocumentContextProvider = (
  doc: TextDocument,
) => Promise<CodeActionDocumentContext>;

/** Whether config-edit actions should be offered for a document. */
export type ConfigEditStateProvider = (doc: TextDocument) => Promise<boolean>;

export function createOnCodeActionHandler(
  documents: TextDocuments<TextDocument>,
  getDocumentContext: DocumentContextProvider,
  isConfigEditable: ConfigEditStateProvider,
): (params: CodeActionParams) => Promise<CodeAction[]> {
  const codeActionHandler = new CodeActionHandler(
    documents,
    getDocumentContext,
    isConfigEditable,
  );

  return (params) => codeActionHandler.handler(params);
}

class CodeActionHandler {
  constructor(
    readonly documents: TextDocuments<TextDocument>,
    private readonly getDocumentContext: DocumentContextProvider,
    private readonly isConfigEditable: ConfigEditStateProvider,
  ) {}

  public async handler(params: CodeActionParams): Promise<CodeAction[]> {
    const {
      context,
      textDocument: { uri },
    } = params;
    const { diagnostics } = context;
    const spellCheckerDiags = diagnostics;

    if (!spellCheckerDiags.length) return [];

    const textDocument = this.documents.get(uri);
    if (!textDocument) return [];

    // Only provide suggestions if the selection is contained in the diagnostics.
    if (!isWordLikeSelection(textDocument, params.range)) {
      return [];
    }

    const { engine, settings } = await this.getDocumentContext(textDocument);
    const ctx = {
      params,
      textDocument,
      engine,
    };

    const actions = await this.handlerCSpell(
      {
        ...ctx,
        diags: spellCheckerDiags,
      },
      settings,
    );
    const arg = {
      uri: params.textDocument.uri,
      range: diagnostics[0].range,
      message: diagnostics[0].message,
    };

    if (await this.canEditConfig(textDocument)) {
      actions.push({
        title: 'Add to user words in config',
        kind: CodeActionKind.QuickFix,
        diagnostics: diagnostics,
        command: {
          title: 'Add to user words in config',
          command: 'AddToUserWordsConfig',
          arguments: [arg],
        },
      });
      actions.push({
        title: 'Add to workspace words in config',
        kind: CodeActionKind.QuickFix,
        diagnostics: diagnostics,
        command: {
          title: 'Add to workspace words in config',
          command: 'AddToWorkspaceWordsConfig',
          arguments: [arg],
        },
      });
    }

    const dictionaries = settings.dictionaries ?? [];
    if (
      settings.dictionaryDefinitions &&
      settings.dictionaryDefinitions.length > 0
    ) {
      const mutableDictionaries = settings.dictionaryDefinitions
        .filter((dict) => 'path' in dict && 'addWords' in dict && dict.addWords)
        .filter(
          (dict) =>
            dictionaries.indexOf(dict.name) >= 0 &&
            dictionaries.indexOf(`!${dict.name}`) < 0,
        );
      const customDictionaryActions = mutableDictionaries.map((dict) => ({
        title: `Add to ${dict.name} dictionary`,
        kind: CodeActionKind.QuickFix,
        diagnostics: diagnostics,
        command: {
          title: `Add to ${dict.name} dictionary`,
          command: 'AddToCustomDictionary',
          arguments: [
            {
              ...arg,
              name: dict.name,
              path: dict.path,
            },
          ],
        },
      }));
      actions.push(...customDictionaryActions);
    }

    return actions;
  }

  private async canEditConfig(textDocument: TextDocument): Promise<boolean> {
    try {
      return await this.isConfigEditable(textDocument);
    } catch {
      // Configuration state that cannot be resolved must not expose an edit.
      return false;
    }
  }

  private async handlerCSpell(
    handlerContext: CodeActionHandlerContext,
    settings: CSpellSettings,
  ) {
    const {
      params,
      textDocument,
      diags: spellCheckerDiags,
      engine,
    } = handlerContext;
    const actions: CodeAction[] = [];
    const uri = textDocument.uri;
    const cursorRange = params.range;
    if (!spellCheckerDiags.length) return [];

    const getSuggestions = (word: string) => {
      return this.genWordSuggestions(engine, settings, word);
    };

    // Find the specific diagnostic the user is pointing at.
    const relevantDiagnostics = spellCheckerDiags.filter((diag: Diagnostic) =>
      isPositionInRange(cursorRange.start, diag.range),
    );

    for (const diag of relevantDiagnostics) {
      const { suggestions } = extractDiagnosticData(diag);
      const srcWord = textDocument.getText(diag.range);
      const sugs: Validator.Suggestion[] =
        suggestions ?? (await getSuggestions(srcWord)) ?? [];
      sugs
        .map(({ word, isPreferred }) => ({
          word: engine.lib.Text.isLowerCase(word)
            ? engine.lib.Text.matchCase(srcWord, word)
            : word,
          isPreferred,
        }))
        .forEach((sug) => {
          const sugWord = sug.word;
          const title = suggestionToTitle(sug);
          if (!title) return;
          const workspaceEdit: WorkspaceEdit = {
            changes: { [uri]: [replaceText(diag.range, sugWord)] },
          };

          const action = createWorkspaceAction(
            title,
            workspaceEdit,
            [diag],
            sug.isPreferred,
          );
          actions.push(action);
        });
    }

    return actions;
  }

  private async genSuggestions(
    engine: CSpellEngine,
    settings: CSpellSettings,
    word: string,
  ): Promise<SuggestionResult[]> {
    const dictionary = await engine.lib.getDictionary(settings);
    const numSuggestions = 5;
    if (word.length > 20) {
      return [];
    }
    const numSugs =
      word.length > wordLengthForLimitingSuggestions
        ? Math.min(maxNumberOfSuggestionsForLongWords, numSuggestions)
        : numSuggestions;
    const options: SuggestOptions = {
      numChanges: 3,
      numSuggestions: numSugs,
      // Turn off compound suggestions for now until it works a bit better.
      compoundMethod: engine.lib.CompoundWordsMethod.NONE,
      ignoreCase: false,
      // Do not included ties, it could create a long list of suggestions.
      includeTies: false,
    };
    return dictionary
      .suggest(word, options)
      .map((s) => ({ ...s, word: s.word.replace(regexJoinedWords, '') }));
  }

  private async genWordSuggestions(
    engine: CSpellEngine,
    settings: CSpellSettings,
    word: string,
  ): Promise<Validator.Suggestion[]> {
    return (await this.genSuggestions(engine, settings, word)).map(
      ({ word: suggestionWord, isPreferred }) => ({
        word: suggestionWord,
        isPreferred,
      }),
    );
  }
}

interface CodeActionHandlerContext {
  params: CodeActionParams;
  diags: Diagnostic[];
  textDocument: TextDocument;
  engine: CSpellEngine;
}

const wordLengthForLimitingSuggestions = 15;
const maxNumberOfSuggestionsForLongWords = 1;
const regexJoinedWords = /[+]/g;
