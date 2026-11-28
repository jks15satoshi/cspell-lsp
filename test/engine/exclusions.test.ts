import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import { getExclusionTarget } from '../../src/engine/documentPaths.js';
import { getApplicableExclusionGlobs } from '../../src/engine/exclusions.js';

describe('getApplicableExclusionGlobs', () => {
  const serverA = '\\\\server-a\\share';
  const serverB = '\\\\server-b\\share';
  const targetA = path.win32.join(serverA, 'dist', 'fixture.md');
  const targetB = path.win32.join(serverB, 'dist', 'fixture.md');

  test('drops globs rooted on another UNC server', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
      'dist/**',
      { glob: '**/dist/**', root: serverA },
      { glob: '!**/keep/**', root: serverA },
      { glob: 'dist/**', root: 'file://server-a/share/' },
    ];

    expect(
      getApplicableExclusionGlobs(globs, serverB, targetB, 'win32'),
    ).toEqual([globs[1], globs[2], globs[3], globs[4]]);
  });

  test('keeps roots on the same server regardless of case', () => {
    const glob = { glob: 'dist/**', root: '\\\\SERVER-A\\share' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetA, 'win32'),
    ).toEqual([glob]);
  });

  test('canonicalizes non-ASCII UNC server names', () => {
    const server = '\\\\測試\\share';
    const otherServer = '\\\\其他\\share';
    const globs = [
      { glob: 'dist/**', root: server },
      { glob: 'dist/**', root: otherServer },
      { glob: 'dist/**', root: 'file://測試/share/' },
      { glob: 'dist/**', root: 'file://xn--g6w251d/share/' },
    ];
    const target = getExclusionTarget(
      'git://測試/share/dist/fixture.md',
      'win32',
    );

    expect(getApplicableExclusionGlobs(globs, server, target, 'win32')).toEqual(
      [globs[0], globs[2], globs[3]],
    );
  });

  test('uses the fallback root for string and relative glob roots', () => {
    const relativeGlob = { glob: 'dist/**', root: 'sub' };

    expect(
      getApplicableExclusionGlobs(['dist/**'], serverA, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([relativeGlob], serverA, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([relativeGlob], serverB, targetB, 'win32'),
    ).toEqual([relativeGlob]);
  });

  test('compares the server of file URL targets', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
    ];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverB,
        'file://server-b/share/dist/fixture.md',
        'win32',
      ),
    ).toEqual([globs[1]]);
  });

  test('leaves globs unchanged without a Windows UNC target', () => {
    const globs = [{ glob: 'dist/**', root: serverA }];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverA,
        'file:///c:/work/dist/fixture.md',
        'win32',
      ),
    ).toEqual(globs);
    expect(
      getApplicableExclusionGlobs(globs, serverB, targetA, 'linux'),
    ).toEqual(globs);
  });

  test('uses the current directory for a ${cwd} glob prefix', () => {
    const glob = { glob: '${cwd}/dist/**', root: serverA };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverB),
    ).toEqual([glob]);
    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverA),
    ).toEqual([]);
  });

  test('resolves a ${cwd} root before comparing servers', () => {
    const glob = { glob: 'dist/**', root: '${cwd}' };
    const nestedGlob = { glob: 'dist/**', root: '${cwd}/nested' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverA),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32', serverB),
    ).toEqual([glob]);
    expect(
      getApplicableExclusionGlobs(
        [nestedGlob],
        serverB,
        targetB,
        'win32',
        serverA,
      ),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs(
        [nestedGlob],
        serverB,
        targetB,
        'win32',
        serverB,
      ),
    ).toEqual([nestedGlob]);
  });

  test('normalizes four-slash UNC file URL roots', () => {
    const glob = { glob: 'dist/**', root: 'file:////server-a/share/' };

    expect(
      getApplicableExclusionGlobs([glob], serverB, targetB, 'win32'),
    ).toEqual([]);
    expect(
      getApplicableExclusionGlobs([glob], serverA, targetA, 'win32'),
    ).toEqual([glob]);
  });

  test('recognizes four-slash UNC file URL targets', () => {
    const globs = [
      { glob: 'dist/**', root: serverA },
      { glob: 'dist/**', root: serverB },
    ];

    expect(
      getApplicableExclusionGlobs(
        globs,
        serverB,
        'file:////server-b/share/dist/fixture.md',
        'win32',
      ),
    ).toEqual([globs[1]]);
  });
});
