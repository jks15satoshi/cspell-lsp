import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CSpellLib = typeof import('cspell-lib');

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
}

export interface PackageInfo {
  dir: string;
  json: PackageJson;
}

export const BUNDLED_PACKAGE_PATH = '<bundled>';
export const MINIMUM_MAJOR_VERSION = 8;

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

export function findPackage(
  name: string,
  from: string,
): PackageInfo | undefined {
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

export function findNearestPackage(from: string): PackageInfo | undefined {
  let directory = path.resolve(from);
  for (;;) {
    const packageInfo = readPackageInfo(directory);
    if (packageInfo) return packageInfo;

    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function readPackageInfo(directory: string): PackageInfo | undefined {
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
export function resolvePackageEntry(
  packageInfo: PackageInfo,
): string | undefined {
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

export async function importEngine(
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

export function parseMajorVersion(
  version: string | undefined,
): number | undefined {
  if (!version) return undefined;
  const match = /^(\d+)/.exec(version);
  return match ? Number(match[1]) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
