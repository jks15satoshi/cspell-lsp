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

/**
 * Validates a document against merged CSpell settings.
 *
 * @param textDocument - The document to validate.
 * @param settings - Merged settings for the document.
 * @param cSpell - CSpell engine used for validation.
 * @param globRoot - Fallback root for ignore globs that do not define their own.
 * @returns Diagnostics for the document, or an empty list when it is ignored.
 */
export async function validateTextDocument(
  textDocument: TextDocument,
  settings: CSpellUserSettings,
  cSpell: CSpellLib,
  globRoot?: string,
): Promise<Diagnostic[]> {
  if (isDocumentIgnored(textDocument.uri, settings, cSpell, globRoot)) {
    return [];
  }

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
  const r = await docVal.checkDocumentAsync();
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

/**
 * Checks the merged `ignorePaths` against the document URI.
 *
 * cspell-lib only applies `ignorePaths` from a configuration file it loads
 * itself. This server passes fully merged settings with `noConfigSearch`, so
 * defaults, the global configuration, and `--config` must be checked here.
 * Configuration globs already carry the root of the file that defined them;
 * `fallbackRoot` only applies to globs without a root, such as
 * `initializationOptions.defaultSettings`.
 */
function isDocumentIgnored(
  uri: string,
  settings: CSpellUserSettings,
  cSpell: CSpellLib,
  fallbackRoot: string | undefined,
): boolean {
  const ignorePaths = settings.ignorePaths;
  if (!ignorePaths?.length) return false;
  // The helper treats schemes outside this set as excluded, even when no glob
  // matches. Allow the document's own scheme so virtual documents are only
  // ignored when their path actually matches a configured pattern.
  const allowedSchemes = new Set(['file', 'untitled']);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase();
  if (scheme) allowedSchemes.add(scheme);
  const isExcluded = cSpell.ExclusionHelper.generateExclusionFunctionForUri(
    ignorePaths,
    settings.globRoot ?? fallbackRoot ?? process.cwd(),
    allowedSchemes,
  );
  return isExcluded(uri);
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
