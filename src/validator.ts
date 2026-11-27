import type { CSpellUserSettings, IssueType } from 'cspell-lib';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic } from 'vscode-languageserver-types';
import { DiagnosticSeverity } from 'vscode-languageserver-types';

import type { CSpellLib } from './engine.js';

export type ExtensionId = 'cSpell';
export const defaultCheckLimit = 1 << 20; // 1MB

export interface Suggestion {
  word: string;
  isPreferred?: boolean;
}

export type DiagnosticSource = ExtensionId;

export interface SpellCheckerDiagnosticData {
  /** The text of the issue. It is expected to match `document.getText(diag.range)` */
  text?: string;
  issueType?: IssueType | undefined;
  /** The issue indicates that the word has been flagged as an error. */
  isFlagged?: boolean | undefined;
  /** The issue is a suggested change, but is not considered an error. */
  isSuggestion?: boolean | undefined;
  suggestions?: Suggestion[] | undefined;
}

export interface SpellingDiagnostic extends Diagnostic {
  source: DiagnosticSource;
  data: SpellCheckerDiagnosticData;
}

export async function validateTextDocument(
  textDocument: TextDocument,
  settings: CSpellUserSettings,
  cSpell: CSpellLib,
): Promise<Diagnostic[]> {
  // const { severity, severityFlaggedWords } = calcSeverity(textDocument.uri, options);
  const defaultSeverity = DiagnosticSeverity.Information;
  const defaultSeverityFlaggedWords = DiagnosticSeverity.Information;
  const limit = defaultCheckLimit;
  const truncatedContent = textDocument.getText().slice(0, limit);
  const docInfo = {
    uri: textDocument.uri,
    content: truncatedContent,
    languageId: textDocument.languageId,
    version: textDocument.version,
  };
  const doc = cSpell.createTextDocument(docInfo);
  const docVal = new cSpell.DocumentValidator(
    doc,
    { noConfigSearch: true },
    settings,
  );
  await docVal.prepare();
  const r = await docVal.checkDocumentAsync(true);
  const diags = r
    // Convert the offset into a position
    .map((issue) => ({
      ...issue,
      position: textDocument.positionAt(issue.offset),
    }))
    // Calculate the range
    .map((issue) => ({
      ...issue,
      range: {
        start: issue.position,
        end: {
          ...issue.position,
          character:
            issue.position.character + (issue.length ?? issue.text.length),
        },
      },
      severity: issue.isFlagged ? defaultSeverityFlaggedWords : defaultSeverity,
    }))
    // Convert it to a Diagnostic
    .map(
      ({
        text,
        range,
        isFlagged,
        message,
        issueType,
        suggestions,
        suggestionsEx,
        severity,
      }) => {
        const diagMessage = `"${text}": ${message ?? `${isFlagged ? 'Forbidden' : 'Unknown'} word`}.`;
        const sugs = suggestionsEx || suggestions?.map((word) => ({ word }));
        const data: SpellCheckerDiagnosticData = {
          text,
          issueType,
          isFlagged,
          isSuggestion: undefined, // This is a future enhancement to CSpell.
          suggestions: haveSuggestionsMatchCase(text, sugs, cSpell.Text),
        };
        const diag: SpellingDiagnostic = {
          severity,
          range,
          message: diagMessage,
          source: 'cSpell',
          data,
        };
        return diag;
      },
    )
    .filter((diag) => !!diag.severity);
  return diags;
}

function haveSuggestionsMatchCase(
  example: string,
  suggestions: Suggestion[] | undefined,
  text: CSpellLib['Text'],
): Suggestion[] | undefined {
  if (!suggestions) return undefined;
  if (text.isLowerCase(example)) return suggestions;
  return suggestions.map((sug) =>
    text.isLowerCase(sug.word)
      ? { ...sug, word: text.matchCase(example, sug.word) }
      : sug,
  );
}
