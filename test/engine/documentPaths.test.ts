import { describe, expect, test } from 'bun:test';

import {
  getDocumentUriPath,
  getExclusionTarget,
} from '../../src/engine/documentPaths.js';

describe('getDocumentUriPath platform semantics', () => {
  test('maps a non-file authority to a UNC path on Windows', () => {
    expect(
      getDocumentUriPath('git://server/share/dist/fixture.md', 'win32'),
    ).toBe('\\\\server\\share\\dist\\fixture.md');
  });

  test('keeps POSIX paths that resemble a Windows drive', () => {
    expect(getDocumentUriPath('git:/c:/work/dist/fixture.md', 'linux')).toBe(
      '/c:/work/dist/fixture.md',
    );
  });

  test('keeps drive paths local on Windows without an authority', () => {
    expect(getDocumentUriPath('git:/c:/work/dist/fixture.md', 'win32')).toBe(
      'c:\\work\\dist\\fixture.md',
    );
  });

  test('rejects relative URI paths', () => {
    expect(
      getDocumentUriPath('git:relative/fixture.md', 'linux'),
    ).toBeUndefined();
    expect(
      getDocumentUriPath('git:relative/fixture.md', 'win32'),
    ).toBeUndefined();
  });
});

describe('getExclusionTarget platform semantics', () => {
  test('uses the full UNC path for virtual documents on Windows', () => {
    expect(
      getExclusionTarget('git://server/share/dist/fixture.md', 'win32'),
    ).toBe('\\\\server\\share\\dist\\fixture.md');
  });

  test('keeps non-authority and non-Windows URIs unchanged', () => {
    expect(getExclusionTarget('git:/c:/work/dist/fixture.md', 'win32')).toBe(
      'git:/c:/work/dist/fixture.md',
    );
    expect(
      getExclusionTarget('git://server/share/dist/fixture.md', 'linux'),
    ).toBe('git://server/share/dist/fixture.md');
  });

  test('leaves file and stdin URIs unchanged', () => {
    expect(
      getExclusionTarget('file://server/share/dist/fixture.md', 'win32'),
    ).toBe('file://server/share/dist/fixture.md');
    expect(getExclusionTarget('stdin://server/share/fixture.md', 'win32')).toBe(
      'stdin://server/share/fixture.md',
    );
  });
});
