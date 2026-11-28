import { describe, expect, test } from 'bun:test';

import { cloneSettingsForConfig } from '../../src/config/words.js';

describe('cloneSettingsForConfig', () => {
  test('copies words arrays so adding and sorting do not mutate defaults', () => {
    const defaults = {
      words: ['zulu', 'alpha'],
      userWords: ['shared'],
    };

    const clone = cloneSettingsForConfig(defaults);

    expect(clone).not.toBe(defaults);
    expect(clone).toEqual(defaults);
    expect(clone.words).not.toBe(defaults.words);
    expect(clone.userWords).not.toBe(defaults.userWords);

    clone.words!.push('beta');
    clone.words!.sort((a, b) =>
      a.localeCompare(b, 'en', { sensitivity: 'base' }),
    );
    clone.userWords!.push('other');

    expect(defaults.words).toEqual(['zulu', 'alpha']);
    expect(defaults.userWords).toEqual(['shared']);
  });
});
