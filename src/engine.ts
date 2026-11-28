import * as fs from 'fs';
import * as path from 'path';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'url';

import { normalizeGlobPatterns } from 'cspell-glob';
import * as bundledCSpellLib from 'cspell-lib';
import type { Glob } from 'cspell-lib';
import { URI } from 'vscode-uri';

export type CSpellLib = typeof import('cspell-lib');

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

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
}

interface PackageInfo {
  dir: string;
  json: PackageJson;
}

interface RootEntry {
  /** Logical workspace path used by callers and logs. */
  logical: string;
  /** Logical and real paths that identify this workspace folder. */
  aliases: readonly string[];
}

const BUNDLED_PACKAGE_PATH = '<bundled>';
const MINIMUM_MAJOR_VERSION = 8;

const REQUIRED_EXPORTS = [
  'createTextDocument',
  'constructSettingsForText',
  'defaultConfigFilenames',
  'DocumentValidator',
  'ExclusionHelper',
  'getDefaultConfigLoader',
  'getDefaultSettings',
  'getDictionary',
  'getGlobalSettingsAsync',
  'mergeSettings',
  'readSettings',
  'refreshDictionaryCache',
  'Text',
  'CompoundWordsMethod',
] as const;

declare const CSPELL_LIB_VERSION: string | undefined;

let cachedBundledVersion: string | undefined;

/**
 * Returns the version of the cspell-lib bundled into this server.
 *
 * The build injects the version because the published bundle does not include
 * cspell-lib's package.json. Unbundled runs resolve the installed package
 * through ESM resolution, which also supports dependencies hoisted into an
 * ancestor node_modules.
 */
export function getBundledVersion(): string {
  if (cachedBundledVersion) return cachedBundledVersion;
  if (typeof CSPELL_LIB_VERSION === 'string') {
    cachedBundledVersion = CSPELL_LIB_VERSION;
    return cachedBundledVersion;
  }
  const packageInfo = resolveInstalledPackageInfo('cspell-lib');
  cachedBundledVersion = packageInfo?.json.version ?? 'unknown';
  return cachedBundledVersion;
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

    // Virtual documents are matched by the path in their URI. Only alias
    // resolution uses this path; engine selection keeps using real files.
    if (!useAlias) return undefined;
    const uriPath = getDocumentUriPath(uri);
    if (!uriPath) return undefined;
    if (!this.sharesWorkspaceServer(uriPath)) return undefined;
    return this.findOwningRoot(uriPath, true);
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
    if (direct) return direct;

    // A client can address a real workspace through a symlinked path. Fall
    // back to the containing directory's real path only when the URI itself
    // did not match a root, so symlinked subdirectories keep their URI root.
    // Virtual documents can live in deleted directories, so resolve the
    // deepest existing ancestor and keep the unresolved suffix.
    const realParent = this.getRealPath(path.dirname(absolute));
    if (!realParent) return undefined;
    const realPath = path.join(realParent, path.basename(absolute));
    const matched = this.matchRoot(realPath, useAlias);
    if (!matched || !useAlias) return matched;
    return this.aliasRootForPath(absolute, matched);
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

async function importEngine(
  entry: string,
  description: string,
): Promise<CSpellLib> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new Error(
      `${description} failed to import ${entry}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const normalized = normalizeEngineModule(module);
  if (!normalized.lib) {
    throw new Error(
      `${description} is missing required cspell-lib exports: ${normalized.missing.join(', ')}`,
    );
  }
  return normalized.lib;
}

function normalizeEngineModule(module: unknown): {
  lib?: CSpellLib;
  missing: string[];
} {
  const namespace = module as Record<string, unknown>;
  const missing = findMissingExports(namespace);
  if (missing.length === 0) {
    return { lib: namespace as unknown as CSpellLib, missing: [] };
  }

  const defaultExport = namespace.default;
  if (defaultExport && typeof defaultExport === 'object') {
    const defaultMissing = findMissingExports(
      defaultExport as Record<string, unknown>,
    );
    if (defaultMissing.length === 0) {
      return {
        lib: defaultExport as unknown as CSpellLib,
        missing: [],
      };
    }
  }

  return { missing };
}

function findMissingExports(namespace: Record<string, unknown>): string[] {
  return REQUIRED_EXPORTS.filter((name) => {
    const value = namespace[name];
    if (name === 'defaultConfigFilenames') {
      return !Array.isArray(value) || value.length === 0;
    }
    return (
      typeof value !== 'function' &&
      (typeof value !== 'object' || value === null)
    );
  });
}

function findPackage(name: string, from: string): PackageInfo | undefined {
  let directory = path.resolve(from);
  try {
    directory = fs.realpathSync(directory);
  } catch {
    // Keep the unresolved path; the caller will report a missing package.
  }

  for (;;) {
    const packageInfo = readPackageInfo(
      path.join(directory, 'node_modules', name),
    );
    if (packageInfo) return packageInfo;

    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function findNearestPackage(from: string): PackageInfo | undefined {
  let directory = path.resolve(from);
  for (;;) {
    const packageInfo = readPackageInfo(directory);
    if (packageInfo) return packageInfo;

    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readPackageInfo(directory: string): PackageInfo | undefined {
  try {
    const realDirectory = fs.realpathSync(directory);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(realDirectory, 'package.json'), 'utf8'),
    ) as PackageJson;
    return { dir: realDirectory, json: packageJson };
  } catch {
    // Treat unreadable or malformed metadata as "not a package" so discovery
    // can continue with the next candidate or fall back to the bundled engine.
    return undefined;
  }
}

/**
 * Resolves an installed package and its metadata through the runtime's ESM
 * resolver. This follows the same lookup the bundler uses and supports
 * dependencies installed in an ancestor node_modules.
 */
function resolveInstalledPackageInfo(name: string): PackageInfo | undefined {
  try {
    let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
      const packageInfo = readPackageInfo(directory);
      if (packageInfo?.json.name === name) return packageInfo;

      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    // The bundled version is build-defined; this fallback is best-effort for
    // unbundled runs and must not prevent the server from starting.
    return undefined;
  }
}

let cachedImportConditions: ReadonlySet<string> | undefined;

/**
 * Conditions Node activates when resolving dynamic `import()`.
 *
 * `default` is handled separately because it matches at its declared position.
 * Custom `--conditions` are not modeled; engine packages only need the
 * standard Node conditions.
 */
function getImportConditions(): ReadonlySet<string> {
  if (cachedImportConditions) return cachedImportConditions;
  const conditions = new Set(['node', 'import']);
  if (process.features.require_module) {
    conditions.add('module-sync');
  }
  if (!hasNoAddonsFlag()) {
    conditions.add('node-addons');
  }
  cachedImportConditions = conditions;
  return cachedImportConditions;
}

function hasNoAddonsFlag(): boolean {
  if (process.execArgv.includes('--no-addons')) return true;
  const nodeOptions = process.env.NODE_OPTIONS;
  return nodeOptions ? /(?:^|\s)--no-addons(?:\s|$)/.test(nodeOptions) : false;
}

type ExportResolution =
  | { kind: 'target'; target: string }
  | { kind: 'no-match' }
  | { kind: 'blocked' };

const NO_EXPORT_MATCH: ExportResolution = { kind: 'no-match' };
const BLOCKED_EXPORT: ExportResolution = { kind: 'blocked' };

/**
 * Resolves the package entry using Node ESM rules.
 *
 * `exports` takes precedence; legacy fields are considered only when it is
 * absent or explicitly `null`. A failed conditional export is final.
 */
function resolvePackageEntry(packageInfo: PackageInfo): string | undefined {
  const conditions = getImportConditions();
  const exportsField = packageInfo.json.exports;

  if (exportsField !== undefined && exportsField !== null) {
    const resolution = resolveExportTarget(exportsField, conditions);
    return resolution.kind === 'target'
      ? findFileEntry(packageInfo.dir, resolution.target)
      : undefined;
  }

  for (const candidate of [
    packageInfo.json.module,
    packageInfo.json.main,
    'index.js',
  ]) {
    const entry = candidate
      ? findFileEntry(packageInfo.dir, candidate)
      : undefined;
    if (entry) return entry;
  }
  return undefined;
}

function findFileEntry(packageDir: string, target: string): string | undefined {
  const entry = path.resolve(packageDir, target);
  try {
    return fs.statSync(entry).isFile() ? entry : undefined;
  } catch {
    // A target that does not exist cannot be selected.
    return undefined;
  }
}

function resolveExportTarget(
  exportsField: unknown,
  conditions: ReadonlySet<string>,
): ExportResolution {
  if (typeof exportsField === 'string') {
    return { kind: 'target', target: exportsField };
  }
  if (Array.isArray(exportsField)) {
    return selectConditionalTarget(exportsField, conditions);
  }
  if (exportsField === null) return BLOCKED_EXPORT;
  if (typeof exportsField !== 'object') return NO_EXPORT_MATCH;

  const record = exportsField as Record<string, unknown>;
  const hasSubpaths = Object.keys(record).some((key) => key.startsWith('.'));
  if (hasSubpaths) {
    if (!Object.prototype.hasOwnProperty.call(record, '.')) {
      return NO_EXPORT_MATCH;
    }
    return selectConditionalTarget(record['.'], conditions);
  }
  return selectConditionalTarget(record, conditions);
}

/**
 * Selects an export target using Node's conditional-export rules.
 *
 * Conditions are evaluated in declaration order, and `default` matches at its
 * own position rather than as a lower-priority fallback. An active condition
 * whose target is `null` blocks resolution; a condition with no nested match
 * does not end the search. Array targets keep looking after `null` in case a
 * later target is valid.
 */
function selectConditionalTarget(
  value: unknown,
  conditions: ReadonlySet<string>,
): ExportResolution {
  if (typeof value === 'string') {
    return { kind: 'target', target: value };
  }
  if (value === null) return BLOCKED_EXPORT;
  if (Array.isArray(value)) {
    let blocked = false;
    for (const candidate of value) {
      const resolved = selectConditionalTarget(candidate, conditions);
      if (resolved.kind === 'target') return resolved;
      if (resolved.kind === 'blocked') blocked = true;
    }
    return blocked ? BLOCKED_EXPORT : NO_EXPORT_MATCH;
  }
  if (!value || typeof value !== 'object') return NO_EXPORT_MATCH;

  const record = value as Record<string, unknown>;
  for (const [condition, target] of Object.entries(record)) {
    if (condition === 'default' || conditions.has(condition)) {
      const resolved = selectConditionalTarget(target, conditions);
      if (resolved.kind === 'target' || resolved.kind === 'blocked') {
        return resolved;
      }
    }
  }
  return NO_EXPORT_MATCH;
}

/**
 * Converts a non-file document URI to the path used by workspace matching.
 *
 * The path must stay virtual, so this does not resolve symlinks. Parsing with
 * `vscode-uri` matches cspell-lib's URI decoding, including encoded separators
 * such as `%2F`. POSIX must keep the decoded `uri.path` because `fsPath`
 * rewrites paths such as `/c:/work`; on Windows an authority names a UNC host
 * (`git://server/share/a` is `\\server\share\a`, not a current-drive path).
 *
 * The `platform` parameter exists for platform-independent tests.
 */
export function getDocumentUriPath(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  let parsed: URI;
  try {
    parsed = URI.parse(uri);
  } catch {
    return undefined;
  }

  if (platform !== 'win32') {
    return path.posix.isAbsolute(parsed.path) ? parsed.path : undefined;
  }

  const drivePath = parsed.path.replace(/^\/(?=[a-zA-Z]:)/, '');
  const nativePath = parsed.authority
    ? `\\\\${parsed.authority}${parsed.path}`.replace(/\//g, '\\')
    : drivePath.replace(/\//g, '\\');
  return path.win32.isAbsolute(nativePath) ? nativePath : undefined;
}

/**
 * Returns the value cspell-lib's ignore matcher should test.
 *
 * cspell-lib reduces non-file URIs to `uri.path`, which drops the authority
 * that names a UNC host on Windows. Passing the full UNC path keeps it
 * comparable with a UNC workspace root instead of resolving it against the
 * server process's current drive. cspell-glob still drops the host when it
 * makes the path relative to a glob root, so rooted globs from another server
 * must be removed by {@link getApplicableExclusionGlobs} first.
 *
 * The `platform` parameter exists for platform-independent tests.
 */
export function getExclusionTarget(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    platform !== 'win32' ||
    uri.startsWith('file:') ||
    uri.startsWith('stdin:')
  ) {
    return uri;
  }
  const uriPath = getDocumentUriPath(uri, platform);
  return uriPath?.startsWith('\\\\') ? uriPath : uri;
}

/**
 * Returns the ignore globs whose roots can apply to an exclusion target.
 *
 * cspell-glob makes a file URL relative to a glob root by comparing only the
 * pathname, so a glob rooted at `\\server-a\share` also matches
 * `\\server-b\share`. A rooted glob on another UNC server must not apply.
 * Roots are normalized first because cspell-glob resolves `${cwd}`, relative
 * roots, and four-slash UNC file URLs before matching. Global patterns stay
 * root independent.
 *
 * The `platform` and `cwd` parameters exist for platform-independent tests.
 */
export function getApplicableExclusionGlobs(
  globs: readonly Glob[],
  fallbackRoot: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): Glob[] {
  if (platform !== 'win32') return [...globs];
  const documentServer = getUncServer(target);
  if (!documentServer) return [...globs];

  return globs.filter((glob) => {
    const [normalized] = normalizeGlobPatterns([glob], {
      root: fallbackRoot,
      cwd,
      nested: true,
      nodePath: path.win32,
    });
    if (!normalized || normalized.isGlobalPattern) return true;
    const rootServer = getUncServer(normalized.root);
    return !rootServer || rootServer === documentServer;
  });
}

function isFileUrl(value: string): boolean {
  return /^file:/i.test(value);
}

/**
 * Canonicalizes a UNC server name for identity comparisons.
 *
 * File URLs expose an IDN host as lower-case ASCII, while a native UNC path
 * keeps the Unicode name the client supplied. Both sides must use the same
 * representation so the same server is not mistaken for a different one.
 * Invalid host names keep the previous case-insensitive behavior.
 */
function canonicalizeUncServer(server: string): string {
  return (domainToASCII(server) || server).toLowerCase();
}

/**
 * Extracts the host from a Windows UNC path or file URL, if it is one.
 *
 * The returned host is canonicalized for comparison: IDN names become ASCII
 * and ASCII case is folded. The host identifies the network destination, so
 * only servers named by a workspace alias are allowed to reach the real-path
 * fallback.
 */
function getUncServer(filePath: string): string | undefined {
  if (isFileUrl(filePath)) {
    try {
      const url = new URL(filePath);
      // Node's URL parser leaves a UNC host in the path for file:////host URLs.
      const fixed = url.href.startsWith('file:////')
        ? new URL(url.href.replace(/^file:\/{4}/, 'file://'))
        : url;
      return fixed.hostname ? canonicalizeUncServer(fixed.hostname) : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return undefined;

  const normalized = filePath.replace(/\//g, '\\');
  const unc = normalized.startsWith('\\\\?\\UNC\\')
    ? `\\\\${normalized.slice(8)}`
    : normalized;
  if (unc.startsWith('\\\\?\\')) return undefined;
  const root = path.win32.parse(unc).root;
  if (!root.startsWith('\\\\')) return undefined;
  const [server] = root.split(path.win32.sep).filter(Boolean);
  return server ? canonicalizeUncServer(server) : undefined;
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

function parseMajorVersion(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = /^(\d+)/.exec(version);
  return match ? Number(match[1]) : undefined;
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
