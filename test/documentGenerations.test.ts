import { describe, expect, test } from 'bun:test';

import { DocumentGenerations } from '../src/documentGenerations.js';

describe('DocumentGenerations', () => {
  test('uses a process-wide sequence for each URI', () => {
    const generations = new DocumentGenerations();

    expect(generations.next('file:///a.md')).toBe(1);
    expect(generations.next('file:///b.md')).toBe(2);
    expect(generations.next('file:///a.md')).toBe(3);
    expect(generations.isCurrent('file:///a.md', 3)).toBe(true);
    expect(generations.isCurrent('file:///b.md', 2)).toBe(true);
  });

  test('rejects results from an older generation', () => {
    const generations = new DocumentGenerations();
    const older = generations.next('file:///a.md');
    const newer = generations.next('file:///a.md');

    expect(generations.isCurrent('file:///a.md', older)).toBe(false);
    expect(generations.isCurrent('file:///a.md', newer)).toBe(true);
  });

  test('rejects a pre-close generation after the document reopens', () => {
    const generations = new DocumentGenerations();
    const beforeClose = generations.next('file:///a.md');

    generations.delete('file:///a.md');
    const afterReopen = generations.next('file:///a.md');

    expect(afterReopen).toBeGreaterThan(beforeClose);
    expect(generations.isCurrent('file:///a.md', beforeClose)).toBe(false);
    expect(generations.isCurrent('file:///a.md', afterReopen)).toBe(true);
  });
});
