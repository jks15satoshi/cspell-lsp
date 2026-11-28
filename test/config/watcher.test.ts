import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as cspellLib from 'cspell-lib';

import {
  absoluteWatcherPattern,
  configWatcherGlobs,
  configWatcherPatterns,
  escapeGlobLiteral,
} from '../../src/config/watcher.js';
import { cleanupTempDirs, createTempDir } from '../helpers/workspace.js';

afterEach(cleanupTempDirs);

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

describe('config watcher patterns', () => {
  test('groups config names by directory', () => {
    expect(
      configWatcherGlobs([
        'cspell.json',
        'cspell.config.toml',
        'package.json',
        '.vscode/cspell.json',
        '.vscode/cSpell.json',
      ]),
    ).toEqual([
      '**/.vscode/{cSpell.json,cspell.json}',
      '**/{cspell.config.toml,cspell.json,package.json}',
    ]);
  });

  test('includes TOML only when the engine lists it', () => {
    expect(configWatcherGlobs(['cspell.json', 'cspell.config.toml'])).toEqual([
      '**/{cspell.config.toml,cspell.json}',
    ]);
    expect(configWatcherGlobs(['cspell.json', 'cspell.config.yaml'])).toEqual([
      '**/{cspell.config.yaml,cspell.json}',
    ]);
  });

  test('generates watcher globs for the bundled engine list', () => {
    const globs = configWatcherGlobs(cspellLib.defaultConfigFilenames);

    expect(globs.some((glob) => glob.includes('package.json'))).toBe(true);
    expect(globs.some((glob) => glob.includes('cspell.config.toml'))).toBe(
      cspellLib.defaultConfigFilenames.includes('cspell.config.toml'),
    );
  });

  test('deduplicates config names and patterns', () => {
    expect(configWatcherGlobs(['cspell.json', 'cspell.json'])).toEqual([
      '**/cspell.json',
    ]);
    expect(
      configWatcherPatterns({
        roots: [
          { root: '/workspace', fileNames: ['cspell.json'] },
          { root: '/workspace', fileNames: ['cspell.json'] },
        ],
      }),
    ).toEqual([
      {
        baseUri: pathToFileURL('/workspace').href,
        pattern: '**/cspell.json',
      },
    ]);
  });

  test('builds per-root, explicit, and global watcher patterns', () => {
    const globalRoot = createTempDir();

    expect(
      configWatcherPatterns({
        roots: [
          {
            root: '/workspace/one',
            fileNames: ['cspell.json', 'package.json'],
          },
          {
            root: '/workspace/two',
            fileNames: ['cspell.json', 'cspell.config.toml'],
          },
        ],
        configPath: '.config/cspell.yaml',
        cwd: '/workspace/project',
        globalConfigRoots: [globalRoot, '/workspace/missing-global'],
      }),
    ).toEqual([
      {
        baseUri: pathToFileURL('/workspace/one').href,
        pattern: '**/{cspell.json,package.json}',
      },
      {
        baseUri: pathToFileURL('/workspace/two').href,
        pattern: '**/{cspell.config.toml,cspell.json}',
      },
      {
        baseUri: pathToFileURL('/workspace/project/.config').href,
        pattern: 'cspell.yaml',
      },
      {
        baseUri: pathToFileURL(globalRoot).href,
        pattern: 'cspell.json',
      },
    ]);
  });

  test('falls back to global patterns without workspace roots', () => {
    expect(
      configWatcherPatterns({
        roots: [],
        fallbackFileNames: ['cspell.json', 'package.json'],
      }),
    ).toEqual([{ pattern: '**/{cspell.json,package.json}' }]);
  });

  test('uses absolute string globs without relative pattern support', () => {
    const projectRoot = createTempDir();
    const globalRoot = createTempDir();
    const explicitPath = path.join(projectRoot, '.config', 'cspell.yaml');

    expect(
      configWatcherPatterns({
        roots: [
          {
            root: projectRoot,
            fileNames: ['cspell.json', 'package.json'],
          },
        ],
        configPath: explicitPath,
        globalConfigRoots: [globalRoot],
        relativePatternSupport: false,
      }),
    ).toEqual([
      {
        pattern: `${normalizePath(projectRoot)}/**/{cspell.json,package.json}`,
      },
      { pattern: normalizePath(explicitPath) },
      { pattern: `${normalizePath(globalRoot)}/cspell.json` },
    ]);
  });

  test('converts a watcher base URI to an absolute glob', () => {
    const root = createTempDir();
    const expected = `${normalizePath(root)}/**/cspell.json`;

    expect(
      absoluteWatcherPattern(pathToFileURL(root).href, '**/cspell.json'),
    ).toBe(expected);
  });

  test('escapes glob metacharacters in literal path segments', () => {
    expect(escapeGlobLiteral('plain.json')).toBe('plain.json');
    expect(escapeGlobLiteral('br[ack]et{1}*?')).toBe(
      'br[[]ack[]]et[{]1[}][*][?]',
    );
    expect(escapeGlobLiteral('back\\slash')).toBe('back[\\\\]slash');
  });

  test.skipIf(process.platform === 'win32')(
    'preserves a literal POSIX backslash in an absolute watcher path',
    () => {
      const base = '/tmp/back\\slash';

      expect(
        absoluteWatcherPattern(pathToFileURL(base).href, '**/cspell.json'),
      ).toBe('/tmp/back[\\\\]slash/**/cspell.json');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'escapes glob metacharacters in an absolute watcher path',
    () => {
      const base = '/tmp/br[ack]et{1}*?';

      expect(
        absoluteWatcherPattern(pathToFileURL(base).href, '**/cspell.json'),
      ).toBe('/tmp/br[[]ack[]]et[{]1[}][*][?]/**/cspell.json');
    },
  );

  test('escapes a literal explicit config name for relative and absolute watchers', () => {
    const projectRoot = createTempDir();
    const explicitPath = path.join(projectRoot, '.config', 'cspell[1].yaml');

    expect(
      configWatcherPatterns({
        roots: [],
        configPath: explicitPath,
      }),
    ).toEqual([
      {
        baseUri: pathToFileURL(path.dirname(explicitPath)).href,
        pattern: 'cspell[[]1[]].yaml',
      },
    ]);

    expect(
      configWatcherPatterns({
        roots: [],
        configPath: explicitPath,
        relativePatternSupport: false,
      }),
    ).toEqual([
      {
        pattern: `${normalizePath(path.dirname(explicitPath))}/cspell[[]1[]].yaml`,
      },
    ]);
  });
});
