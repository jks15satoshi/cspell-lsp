import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Builds glob patterns for the given config file names.
 *
 * Names with directory components are grouped by directory so the resulting
 * watcher list stays small. The patterns are relative to the watcher base URI.
 */
export function configWatcherGlobs(fileNames: readonly string[]): string[] {
  const groups = new Map<string, Set<string>>();

  for (const name of fileNames) {
    const normalized = name.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || segments.includes('..')) {
      continue;
    }

    const directory = path.posix.dirname(normalized);
    const base = path.posix.basename(normalized);
    if (!base) continue;

    const bases = groups.get(directory) ?? new Set<string>();
    bases.add(base);
    groups.set(directory, bases);
  }

  const patterns: string[] = [];
  for (const [directory, bases] of groups) {
    // Sorting a copy keeps the generated watcher list deterministic.
    // oxlint-disable-next-line unicorn/no-array-sort
    const names = [...bases].sort();
    const basenamePattern =
      names.length === 1 ? names[0] : `{${names.join(',')}}`;
    patterns.push(
      directory === '.'
        ? `**/${basenamePattern}`
        : `**/${directory}/${basenamePattern}`,
    );
  }

  // oxlint-disable-next-line unicorn/no-array-sort
  return [...new Set(patterns)].sort();
}

export interface ConfigWatcherRoot {
  root: string;
  fileNames: readonly string[];
}

export interface ConfigWatcherOptions {
  roots: readonly ConfigWatcherRoot[];
  /** Used when there is no workspace root to scope the search. */
  fallbackFileNames?: readonly string[];
  configPath?: string | null;
  cwd?: string;
  globalConfigRoots?: readonly string[];
  /**
   * Whether the client supports LSP RelativePattern watchers.
   *
   * Defaults to true for callers that do not know the capability. When false,
   * absolute string globs are emitted instead.
   */
  relativePatternSupport?: boolean;
}

export interface ConfigWatcherPattern {
  baseUri?: string;
  pattern: string;
}

/**
 * Escapes glob metacharacters in a literal path segment.
 *
 * LSP watchers always interpret their pattern as a glob. A path segment that
 * comes from the filesystem must therefore be escaped before it is combined
 * with a relative pattern. Do not pass patterns from `configWatcherGlobs()`
 * here: those intentionally contain glob syntax.
 *
 * Bracket expressions keep the characters literal for common LSP client glob
 * implementations. Normalize platform separators before calling this helper.
 */
export function escapeGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]{}]/g, (character) => {
    switch (character) {
      case '\\':
        return '[\\\\]';
      case '*':
        return '[*]';
      case '?':
        return '[?]';
      case '[':
        return '[[]';
      case ']':
        return '[]]';
      case '{':
        return '[{]';
      case '}':
        return '[}]';
      default:
        return character;
    }
  });
}

/**
 * Converts a watcher base URI and relative pattern into an absolute glob.
 *
 * LSP clients without `relativePatternSupport` cannot consume relative
 * `baseUri` watchers, so the server sends the equivalent string glob instead.
 * The base path is literal and is escaped before it is joined with `pattern`,
 * which is expected to be a glob or an already escaped literal.
 */
export function absoluteWatcherPattern(
  baseUri: string,
  pattern: string,
): string {
  const basePath = fileURLToPath(baseUri);
  // A POSIX path may contain a literal backslash. Only Windows uses `\` as
  // its separator, so only Windows converts it to the LSP glob separator.
  const normalized =
    path.sep === '\\' ? basePath.replace(/\\/g, '/') : basePath;
  const escaped = escapeGlobLiteral(normalized);
  const trimmed = escaped.endsWith('/') ? escaped.slice(0, -1) : escaped;
  return `${trimmed}/${pattern}`;
}

/**
 * Builds the complete watched-file pattern list.
 *
 * Project configs are scoped to each workspace root and use that root's
 * selected engine. The explicit `--config` and global config watchers are kept
 * independent of the engine's project config names.
 *
 * When `relativePatternSupport` is false, the same paths are emitted as
 * absolute string globs.
 */
export function configWatcherPatterns(
  options: ConfigWatcherOptions,
): ConfigWatcherPattern[] {
  const patterns: ConfigWatcherPattern[] = [];
  const useRelativePatterns = options.relativePatternSupport !== false;

  const addPattern = (baseUri: string | undefined, pattern: string): void => {
    if (baseUri && !useRelativePatterns) {
      patterns.push({ pattern: absoluteWatcherPattern(baseUri, pattern) });
    } else if (baseUri) {
      patterns.push({ baseUri, pattern });
    } else {
      patterns.push({ pattern });
    }
  };

  if (options.roots.length > 0) {
    for (const { root, fileNames } of options.roots) {
      const baseUri = pathToFileURL(root).href;
      // These patterns intentionally contain glob syntax.
      for (const pattern of configWatcherGlobs(fileNames)) {
        addPattern(baseUri, pattern);
      }
    }
  } else if (options.fallbackFileNames) {
    for (const pattern of configWatcherGlobs(options.fallbackFileNames)) {
      addPattern(undefined, pattern);
    }
  }

  if (options.configPath) {
    const absolute = path.resolve(
      options.cwd ?? process.cwd(),
      options.configPath,
    );
    // The explicit config name is a literal file name, not a glob pattern.
    addPattern(
      pathToFileURL(path.dirname(absolute)).href,
      escapeGlobLiteral(path.basename(absolute)),
    );
  }

  for (const root of options.globalConfigRoots ?? []) {
    if (!fs.existsSync(root)) continue;
    // Global config stays cspell.json; see cspell-lib's cfgStore.
    addPattern(pathToFileURL(root).href, escapeGlobLiteral('cspell.json'));
  }

  const seen = new Set<string>();
  return patterns.filter(({ baseUri, pattern }) => {
    const key = `${baseUri ?? ''}\0${pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
