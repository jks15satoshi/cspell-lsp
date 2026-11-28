import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bundledCSpellLib from 'cspell-lib';

import { getDocumentUriPath, getUncServer } from './documentPaths.js';
import {
  BUNDLED_PACKAGE_PATH,
  MINIMUM_MAJOR_VERSION,
  findNearestPackage,
  findPackage,
  getBundledVersion,
  importEngine,
  parseMajorVersion,
  readPackageInfo,
  resolvePackageEntry,
  type CSpellLib,
  type PackageInfo,
} from './package.js';

export type EngineMode = 'auto' | 'bundled' | 'path';

export interface CSpellEngine {
  mode: EngineMode;
  version: string;
  packagePath: string;
  lib: CSpellLib;
  root?: string;
  fallbackReason?: string;
}

export interface EngineRegistryOptions {
  roots: readonly string[];
  /** `--engine` value: `bundled`, a package/entry path, or null for auto. */
  engineOverride?: string | null;
  log?: (message: string) => void;
}

export class EngineLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineLoadError';
  }
}

interface RootEntry {
  /** Logical workspace path used by callers and logs. */
  logical: string;
  /** Logical and real paths that identify this workspace folder. */
  aliases: readonly string[];
}

/**
 * Resolves and loads one CSpell engine per workspace folder.
 *
 * Selection happens once at startup; installs are not watched for changes.
 */
export class EngineRegistry {
  private readonly realParentCache = new Map<string, string>();

  private constructor(
    private readonly workspaceRoots: readonly string[],
    private readonly rootEntries: readonly RootEntry[],
    private readonly enginesByRoot: ReadonlyMap<string, CSpellEngine>,
    private readonly fallbackEngine: CSpellEngine,
  ) {}

  static async create(options: EngineRegistryOptions): Promise<EngineRegistry> {
    const roots = uniqueRoots(options.roots);
    const rootEntries = roots.map((root) => ({
      logical: root,
      aliases: getRootAliases(root),
    }));
    const log = options.log ?? (() => {});
    const override = options.engineOverride?.trim();

    if (override === 'bundled') {
      const engine = createBundledEngine('bundled');
      logEngine(engine, log);
      return new EngineRegistry(
        roots,
        rootEntries,
        mapRootsToEngine(roots, engine),
        engine,
      );
    }

    if (override) {
      const engine = await loadExplicitEngine(override);
      logEngine(engine, log);
      return new EngineRegistry(
        roots,
        rootEntries,
        mapRootsToEngine(roots, engine),
        engine,
      );
    }

    if (roots.length === 0) {
      const engine = createBundledEngine(
        'auto',
        undefined,
        'no workspace folder',
      );
      logEngine(engine, log);
      return new EngineRegistry([], [], new Map(), engine);
    }

    const enginesByRoot = new Map<string, CSpellEngine>();
    for (const root of roots) {
      const engine = await resolveAutoEngine(root);
      enginesByRoot.set(root, engine);
      logEngine(engine, log, root);
    }

    const fallbackEngine = createBundledEngine(
      'auto',
      undefined,
      'document is outside the workspace',
    );
    return new EngineRegistry(
      roots,
      rootEntries,
      enginesByRoot,
      fallbackEngine,
    );
  }

  get roots(): readonly string[] {
    return this.workspaceRoots;
  }

  getForRoot(root: string): CSpellEngine {
    const entry = this.findRootEntry(path.resolve(root));
    return entry
      ? (this.enginesByRoot.get(entry.logical) ?? this.fallbackEngine)
      : this.fallbackEngine;
  }

  getForDocument(uri: string): CSpellEngine {
    const root = this.rootForDocument(uri);
    if (!root) return this.fallbackEngine;
    return this.enginesByRoot.get(root) ?? this.fallbackEngine;
  }

  rootForDocument(uri: string): string | undefined {
    return this.resolveDocumentUri(uri, false);
  }

  /**
   * Returns the workspace path alias that matches the document URI.
   *
   * `rootForDocument` returns the logical root for engine selection. Rootless
   * ignore globs must instead use the alias the URI is addressed by, so a
   * workspace opened through a symlink still matches both its link and real
   * paths.
   */
  rootAliasForDocument(uri: string): string | undefined {
    return this.resolveDocumentUri(uri, true);
  }

  private resolveDocumentUri(
    uri: string,
    useAlias: boolean,
  ): string | undefined {
    if (uri.startsWith('file:')) {
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        return undefined;
      }
      return this.findOwningRoot(filePath, useAlias);
    }

    // Virtual documents are matched by the absolute path in their URI. The
    // UNC guard runs before any real-path fallback so a virtual path cannot
    // probe a host that no workspace names.
    const uriPath = getDocumentUriPath(uri);
    if (!uriPath) return undefined;
    if (!this.sharesWorkspaceServer(uriPath)) return undefined;
    return this.findOwningRoot(uriPath, useAlias);
  }

  /**
   * Guards virtual UNC paths against probing hosts no workspace uses.
   *
   * On Windows a non-file URI authority names a UNC host. Resolving a path
   * whose host no workspace alias names would query the network on every
   * validation, so only matching hosts reach the real-path fallback. Non-UNC
   * paths are always allowed.
   */
  private sharesWorkspaceServer(filePath: string): boolean {
    if (path.sep !== '\\') return true;
    const server = getUncServer(filePath);
    if (!server) return true;
    return this.rootEntries.some((entry) =>
      entry.aliases.some((alias) => getUncServer(alias) === server),
    );
  }

  private findRootEntry(rootPath: string): RootEntry | undefined {
    const candidates = getFinalPathCandidates(rootPath);
    return this.rootEntries.find((entry) =>
      entry.aliases.some((alias) => candidates.includes(alias)),
    );
  }

  private findOwningRoot(
    filePath: string,
    useAlias: boolean,
  ): string | undefined {
    const absolute = path.resolve(filePath);
    const direct = this.matchRoot(absolute, useAlias);

    // A client can address a real workspace through a symlinked path. Compare
    // the URI match with the real-path match so a nested workspace wins over
    // an outer workspace that happens to contain the URI alias.
    // Virtual documents can live in deleted directories, so resolve the
    // deepest existing ancestor and keep the unresolved suffix.
    const realParent = this.getRealPath(path.dirname(absolute));
    if (!realParent) return direct;
    const realPath = path.join(realParent, path.basename(absolute));
    const matched = this.matchRoot(realPath, useAlias);
    if (!matched) return direct;
    if (!direct || this.isNestedRoot(matched, direct)) {
      if (!useAlias) return matched;
      return this.aliasRootForPath(absolute, matched);
    }
    return direct;
  }

  /** Returns true when `candidate` is a workspace nested inside `current`. */
  private isNestedRoot(candidate: string, current: string): boolean {
    const candidateReal = this.getRealPath(candidate) ?? candidate;
    const currentReal = this.getRealPath(current) ?? current;
    return (
      candidateReal !== currentReal && isPathInside(candidateReal, currentReal)
    );
  }

  /**
   * Finds the document URI prefix that maps to the matched workspace root.
   *
   * Resolving the document's parent can change path segments after the
   * workspace prefix, so a suffix comparison is not enough. Walk the logical
   * ancestors and return the deepest one whose real path is the matched root.
   * Missing trailing segments are kept, so a deleted workspace root still maps
   * through the alias the document is addressed by. If the URI and workspace
   * only meet through a nested symlink, the filesystem root is the closest
   * URI-compatible anchor.
   */
  private aliasRootForPath(absolute: string, matched: string): string {
    const matchedReal = this.getRealPath(matched) ?? matched;
    for (
      let candidate = path.dirname(absolute);
      ;
      candidate = path.dirname(candidate)
    ) {
      if (this.getRealPath(candidate) === matchedReal) return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
    }
    return path.parse(absolute).root;
  }

  private matchRoot(filePath: string, useAlias: boolean): string | undefined {
    let best: { root: string; length: number } | undefined;
    for (const entry of this.rootEntries) {
      for (const alias of entry.aliases) {
        if (
          isPathInside(filePath, alias) &&
          (!best || alias.length > best.length)
        ) {
          best = {
            root: useAlias ? alias : entry.logical,
            length: alias.length,
          };
        }
      }
    }
    return best?.root;
  }

  private getRealPath(directory: string): string | undefined {
    return getRealPathWithMissingSuffix(directory, (candidate) =>
      this.getRealParent(candidate),
    );
  }

  private getRealParent(parent: string): string | undefined {
    const cached = this.realParentCache.get(parent);
    if (cached) return cached;
    const realParent = tryRealpath(parent);
    if (realParent) {
      this.realParentCache.set(parent, realParent);
    }
    return realParent;
  }

  /** Distinct engines used by the registry, for cache invalidation. */
  all(): CSpellEngine[] {
    const seen = new Set<CSpellLib>();
    const engines: CSpellEngine[] = [];
    for (const engine of this.enginesByRoot.values()) {
      if (seen.has(engine.lib)) continue;
      seen.add(engine.lib);
      engines.push(engine);
    }
    if (!seen.has(this.fallbackEngine.lib)) {
      engines.push(this.fallbackEngine);
    }
    return engines;
  }
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Resolves a directory to its real path, tolerating missing trailing
 * segments. Walks to the nearest existing ancestor and reattaches the
 * unresolved suffix, so documents in deleted directories still map to a
 * workspace reached through a symlink.
 */
function getRealPathWithMissingSuffix(
  directory: string,
  resolveExisting: (candidate: string) => string | undefined,
): string | undefined {
  const missing: string[] = [];
  for (let current = directory; ;) {
    const real = resolveExisting(current);
    if (real) {
      return missing.reduceRight(
        (resolved, segment) => path.join(resolved, segment),
        real,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    missing.push(path.basename(current));
    current = parent;
  }
}

/** Returns the real path of a target, or undefined when it cannot resolve. */
function tryRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

function getRootAliases(root: string): string[] {
  const logical = path.resolve(root);
  const aliases = [logical];
  const realPath = getRealPathWithMissingSuffix(logical, tryRealpath);
  if (realPath && realPath !== logical) aliases.push(realPath);
  return aliases;
}

function getFinalPathCandidates(filePath: string): string[] {
  const absolute = path.resolve(filePath);
  const candidates = [absolute];
  try {
    const realPath = fs.realpathSync(absolute);
    if (realPath !== absolute) candidates.push(realPath);
  } catch {
    // A missing path can still be matched by its logical form.
  }
  return candidates;
}

function mapRootsToEngine(
  roots: readonly string[],
  engine: CSpellEngine,
): Map<string, CSpellEngine> {
  return new Map(roots.map((root) => [root, engine]));
}

function createBundledEngine(
  mode: EngineMode,
  root?: string,
  fallbackReason?: string,
): CSpellEngine {
  return {
    mode,
    version: getBundledVersion(),
    packagePath: BUNDLED_PACKAGE_PATH,
    lib: bundledCSpellLib,
    root,
    fallbackReason,
  };
}

async function resolveAutoEngine(root: string): Promise<CSpellEngine> {
  const reasons: string[] = [];
  const cSpellPackage = findPackage('cspell', root);
  let pairedLib: PackageInfo | undefined;

  if (cSpellPackage) {
    pairedLib = findPackage('cspell-lib', cSpellPackage.dir);
    if (pairedLib) {
      const loaded = await tryLoadCandidate(
        pairedLib,
        'cspell dependency',
        reasons,
      );
      if (loaded) return { mode: 'auto', root, ...loaded };
    } else {
      reasons.push(
        `cspell at ${cSpellPackage.dir} has no resolvable cspell-lib dependency`,
      );
    }
  } else {
    reasons.push('no cspell package found');
  }

  const directLib = findPackage('cspell-lib', root);
  if (directLib && directLib.dir !== pairedLib?.dir) {
    const loaded = await tryLoadCandidate(
      directLib,
      'direct dependency',
      reasons,
    );
    if (loaded) return { mode: 'auto', root, ...loaded };
  } else if (!directLib) {
    reasons.push('no directly installed cspell-lib found');
  }

  return createBundledEngine('auto', root, reasons.join('; '));
}

async function tryLoadCandidate(
  packageInfo: PackageInfo,
  source: string,
  reasons: string[],
): Promise<Pick<CSpellEngine, 'version' | 'packagePath' | 'lib'> | undefined> {
  const { version } = packageInfo.json;
  const major = parseMajorVersion(version);
  if (major === undefined) {
    reasons.push(
      `${source} cspell-lib at ${packageInfo.dir} has no usable version`,
    );
    return undefined;
  }
  if (major < MINIMUM_MAJOR_VERSION) {
    reasons.push(
      `${source} cspell-lib ${version} at ${packageInfo.dir} is not supported (requires version 8 or newer)`,
    );
    return undefined;
  }

  const entry = resolvePackageEntry(packageInfo);
  if (!entry) {
    reasons.push(
      `${source} cspell-lib at ${packageInfo.dir} has no resolvable entry point`,
    );
    return undefined;
  }

  try {
    const lib = await importEngine(entry, `${source} cspell-lib`);
    return { version: version!, packagePath: packageInfo.dir, lib };
  } catch (error) {
    reasons.push(errorMessage(error));
    return undefined;
  }
}

async function loadExplicitEngine(input: string): Promise<CSpellEngine> {
  const absolutePath = path.resolve(input);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    throw new EngineLoadError(
      `CSpell engine path does not exist: ${absolutePath}`,
    );
  }

  let packageInfo: PackageInfo | undefined;
  let entry: string | undefined;

  if (stats.isDirectory()) {
    packageInfo = readPackageInfo(absolutePath);
    if (!packageInfo) {
      packageInfo = {
        dir: fs.realpathSync(absolutePath),
        json: {},
      };
    }
    entry = resolvePackageEntry(packageInfo);
    if (!entry) {
      throw new EngineLoadError(
        `CSpell engine directory has no resolvable entry point: ${absolutePath}`,
      );
    }
  } else if (stats.isFile()) {
    if (path.basename(absolutePath) === 'package.json') {
      packageInfo = readPackageInfo(path.dirname(absolutePath));
      entry = packageInfo ? resolvePackageEntry(packageInfo) : undefined;
      if (!entry) {
        throw new EngineLoadError(
          `CSpell engine package has no resolvable entry point: ${absolutePath}`,
        );
      }
    } else {
      entry = absolutePath;
      packageInfo = findNearestPackage(path.dirname(absolutePath));
    }
  } else {
    throw new EngineLoadError(
      `CSpell engine path is not a file or directory: ${absolutePath}`,
    );
  }

  const version =
    packageInfo?.json.name === 'cspell-lib'
      ? (packageInfo.json.version ?? 'unknown')
      : 'unknown';
  const major = parseMajorVersion(version);
  if (major !== undefined && major < MINIMUM_MAJOR_VERSION) {
    throw new EngineLoadError(
      `CSpell engine at ${absolutePath} has unsupported version ${version}; cspell-lib 8 or newer is required`,
    );
  }

  let lib: CSpellLib;
  try {
    lib = await importEngine(entry, `CSpell engine at ${absolutePath}`);
  } catch (error) {
    throw new EngineLoadError(
      `CSpell engine at ${absolutePath} could not be loaded: ${errorMessage(error)}`,
    );
  }

  return {
    mode: 'path',
    version,
    packagePath: packageInfo?.dir ?? entry,
    lib,
  };
}

function isPathInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logEngine(
  engine: CSpellEngine,
  log: (message: string) => void,
  root?: string,
): void {
  const parts = [`CSpell engine: mode=${engine.mode}`];
  if (engine.mode === 'auto' && engine.packagePath === BUNDLED_PACKAGE_PATH) {
    parts.push('fallback=bundled');
  }
  parts.push(`version=${engine.version}`);
  parts.push(`path=${engine.packagePath}`);
  if (root) parts.push(`root=${root}`);
  if (engine.fallbackReason) parts.push(`reason=${engine.fallbackReason}`);
  log(parts.join(' '));
}
