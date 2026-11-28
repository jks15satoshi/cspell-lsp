// cspell:ignore localfix mispellled preferredfix

import { describe, expect, test } from 'bun:test';
import type { CSpellSettings } from 'cspell-lib';
import type {
  CodeActionParams,
  TextDocuments,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic } from 'vscode-languageserver-types';

import { createOnCodeActionHandler } from '../src/codeActions.js';
import type { CSpellLib } from '../src/engine/package.js';
import type { CSpellEngine } from '../src/engine/registry.js';

function createEngine(): CSpellEngine {
  const lib = {
    getDictionary: async () => ({
      suggest: () => [
        { word: 'localfix' },
        { word: 'preferredfix', isPreferred: true },
      ],
    }),
    CompoundWordsMethod: { NONE: 0 },
    Text: {
      isLowerCase: (value: string) => value === value.toLowerCase(),
      matchCase: (_example: string, word: string) => word,
    },
  } as unknown as CSpellLib;

  return {
    mode: 'auto',
    version: '9.0.0',
    packagePath: '/workspace/node_modules/cspell-lib',
    lib,
  };
}

function createHandler(isConfigEditable: () => Promise<boolean>) {
  const textDocument = TextDocument.create(
    'file:///workspace/example.ts',
    'typescript',
    1,
    'mispellled',
  );
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 10 },
  };
  const diagnostic: Diagnostic = {
    range,
    message: '"mispellled": Unknown word.',
    source: 'cSpell',
    data: {
      text: 'mispellled',
      isFlagged: false,
    },
  };
  const documents = {
    get: (uri: string) => (uri === textDocument.uri ? textDocument : undefined),
  } as unknown as TextDocuments<TextDocument>;
  const settings = {} as CSpellSettings;

  const handler = createOnCodeActionHandler(
    documents,
    async () => ({
      engine: createEngine(),
      settings,
    }),
    isConfigEditable,
  );
  const params = {
    textDocument: { uri: textDocument.uri },
    range,
    context: { diagnostics: [diagnostic] },
  } as CodeActionParams;

  return { handler, params, textDocument, range };
}

describe('createOnCodeActionHandler', () => {
  test('builds replacement actions from the selected engine suggestions', async () => {
    const { handler, params, textDocument, range } = createHandler(
      async () => true,
    );

    const actions = await handler(params);
    const titles = actions.map((action) => action.title);

    expect(titles).toContain('localfix');
    expect(titles).toContain('preferredfix (preferred)');
    expect(titles).toContain('Add to user words in config');
    expect(titles).toContain('Add to workspace words in config');

    const localFix = actions.find((action) => action.title === 'localfix');
    expect(localFix?.edit?.changes?.[textDocument.uri]).toEqual([
      {
        range,
        newText: 'localfix',
      },
    ]);
  });

  test('hides config actions when the configuration is read-only', async () => {
    const { handler, params } = createHandler(async () => false);

    const titles = (await handler(params)).map((action) => action.title);

    expect(titles).toContain('localfix');
    expect(titles).not.toContain('Add to user words in config');
    expect(titles).not.toContain('Add to workspace words in config');
  });

  test('hides config actions when editability cannot be resolved', async () => {
    const { handler, params } = createHandler(async () => {
      throw new Error('unreadable config');
    });

    const titles = (await handler(params)).map((action) => action.title);

    expect(titles).toContain('localfix');
    expect(titles).not.toContain('Add to user words in config');
    expect(titles).not.toContain('Add to workspace words in config');
  });
});
