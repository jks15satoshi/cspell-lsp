import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import * as bundledCSpellLib from 'cspell-lib';

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

const BUNDLED_PACKAGE_PATH = '<bundled>';
const MINIMUM_MAJOR_VERSION = 8;

const REQUIRED_EXPORTS = [
  'createTextDocument',
  'constructSettingsForText',
  'DocumentValidator',
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
 * The build injects the version because the published package does not ship
 * cspell-lib's package.json.
 */
export function getBundledVersion(): string {
  if (cachedBundledVersion) return cachedBundledVersion;
  if (typeof CSPELL_LIB_VERSION === 'string') {
    cachedBundledVersion = CSPELL_LIB_VERSION;
    return cachedBundledVersion;
  }
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(
        new URL('../node_modules/cspell-lib/package.json', import.meta.url),
        'utf8',
      ),
    ) as PackageJson;
    cachedBundledVersion = packageJson.version ?? 'unknown';
  } catch {
    cachedBundledVersion = 'unknown';
  }
  return cachedBundledVersion;
}

/**
 * Resolves and loads one CSpell engine per workspace folder.
 *
 * Selection happens once at startup; installs are not watched for changes.
 */
export class EngineRegistry {
  private constructor(
    private readonly workspaceRoots: readonly string[],
    private readonly enginesByRoot: ReadonlyMap<string, CSpellEngine>,
    private readonly fallbackEngine: CSpellEngine,
  ) {}

  static async create(options: EngineRegistryOptions): Promise<EngineRegistry> {
    const roots = uniqueRoots(options.roots);
    const log = options.log ?? (() => {});
    const override = options.engineOverride?.trim();

    if (override === 'bundled') {
      const engine = createBundledEngine('bundled');
      logEngine(engine, log);
      return new EngineRegistry(roots, mapRootsToEngine(roots, engine), engine);
    }

    if (override) {
      const engine = await loadExplicitEngine(override);
      logEngine(engine, log);
      return new EngineRegistry(roots, mapRootsToEngine(roots, engine), engine);
    }

    if (roots.length === 0) {
      const engine = createBundledEngine(
        'auto',
        undefined,
        'no workspace folder',
      );
      logEngine(engine, log);
      return new EngineRegistry([], new Map(), engine);
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
    return new EngineRegistry(roots, enginesByRoot, fallbackEngine);
  }

  get roots(): readonly string[] {
    return this.workspaceRoots;
  }

  getForRoot(root: string): CSpellEngine {
    return this.enginesByRoot.get(path.resolve(root)) ?? this.fallbackEngine;
  }

  getForDocument(uri: string): CSpellEngine {
    const root = this.rootForDocument(uri);
    if (!root) return this.fallbackEngine;
    return this.enginesByRoot.get(root) ?? this.fallbackEngine;
  }

  rootForDocument(uri: string): string | undefined {
    if (!uri.startsWith('file:')) return undefined;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    return findOwningRoot(filePath, this.workspaceRoots);
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

function resolvePackageEntry(packageInfo: PackageInfo): string | undefined {
  const exportTarget =
    packageInfo.json.exports === undefined
      ? undefined
      : resolveExportTarget(packageInfo.json.exports);
  const candidates = [
    exportTarget,
    packageInfo.json.module,
    packageInfo.json.main,
    'index.js',
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const entry = path.resolve(packageInfo.dir, candidate);
    try {
      if (fs.statSync(entry).isFile()) return entry;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function resolveExportTarget(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (Array.isArray(exportsField)) {
    for (const candidate of exportsField) {
      const target = selectConditionalTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const hasSubpaths = Object.keys(record).some((key) => key.startsWith('.'));
  if (hasSubpaths) {
    const rootExport = record['.'];
    return rootExport === undefined
      ? undefined
      : selectConditionalTarget(rootExport);
  }
  return selectConditionalTarget(record);
}

function selectConditionalTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = selectConditionalTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const condition of ['import', 'node', 'default', 'require']) {
    if (condition in record) {
      const target = selectConditionalTarget(record[condition]);
      if (target) return target;
    }
  }
  return undefined;
}

function findOwningRoot(
  filePath: string,
  roots: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    const relative = path.relative(root, filePath);
    const inside =
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
    if (inside && (!best || root.length > best.length)) {
      best = root;
    }
  }
  return best;
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
