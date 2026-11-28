// cspell:ignore Mispellled

import { describe, expect, test } from 'bun:test';
import type { CSpellSettings } from 'cspell-lib';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { CSpellLib } from '../src/engine/package.js';
import { validateTextDocument } from '../src/validator.js';

function createFakeLib(): CSpellLib {
  return {
    createTextDocument: (info: unknown) => info,
    DocumentValidator: class {
      private readonly settings: { engineMarker?: string };

      constructor(
        _doc: unknown,
        _options: unknown,
        settings: { engineMarker?: string },
      ) {
        this.settings = settings;
      }

      async prepare() {}

      async checkDocumentAsync() {
        return [
          {
            text: 'Mispellled',
            offset: 0,
            length: 10,
            message: `checked by ${this.settings.engineMarker}`,
            suggestions: ['misspelled'],
            isFlagged: false,
          },
        ];
      }
    },
    Text: {
      isLowerCase: (value: string) => value === value.toLowerCase(),
      matchCase: (example: string, word: string) => `${word}<${example}>`,
    },
  } as unknown as CSpellLib;
}

describe('validateTextDocument', () => {
  test('uses the selected engine for diagnostics and suggestions', async () => {
    const textDocument = TextDocument.create(
      'file:///workspace/example.ts',
      'typescript',
      1,
      'Mispellled word',
    );
    const settings = {
      engineMarker: 'local-engine',
    } as unknown as CSpellSettings;

    const diagnostics = await validateTextDocument(
      textDocument,
      settings,
      createFakeLib(),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe(
      '"Mispellled": checked by local-engine.',
    );
    expect(diagnostics[0].source).toBe('cSpell');
    expect(diagnostics[0].data?.suggestions).toEqual([
      { word: 'misspelled<Mispellled>' },
    ]);
  });
});
