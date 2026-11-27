import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporaryDirectories: string[] = [];

const fakeExports: Record<string, string> = {
  DocumentValidator: `export class DocumentValidator {
  constructor(doc, options, settings) {
    this.doc = doc;
    this.options = options;
    this.settings = settings;
  }
  async prepare() {}
  async checkDocumentAsync() {
    return [];
  }
}`,
  createTextDocument: `export function createTextDocument(info) {
  return { ...info };
}`,
  getDictionary: `export async function getDictionary() {
  return { suggest() { return []; } };
}`,
  getDefaultConfigLoader: `export function getDefaultConfigLoader() {
  return {
    clearCachedSettingsFiles() {},
    async searchForConfig() { return undefined; },
  };
}`,
  getDefaultSettings: `export async function getDefaultSettings() {
  return {};
}`,
  getGlobalSettingsAsync: `export async function getGlobalSettingsAsync() {
  return {};
}`,
  mergeSettings: `export function mergeSettings(...settings) {
  return Object.assign({}, ...settings);
}`,
  constructSettingsForText: `export function constructSettingsForText(settings) {
  return settings;
}`,
  readSettings: `export async function readSettings() {
  return {};
}`,
  refreshDictionaryCache: `export async function refreshDictionaryCache() {}`,
  Text: `export const Text = {
  isLowerCase(value) { return value === value.toLowerCase(); },
  matchCase(example, word) { return word; },
};`,
  CompoundWordsMethod: `export const CompoundWordsMethod = { NONE: 0 };`,
};

function createFakeExportsSource(
  missing: ReadonlySet<string> = new Set(),
): string {
  return Object.entries(fakeExports)
    .filter(([name]) => !missing.has(name))
    .map(([, source]) => source)
    .join('\n');
}

export interface FakeCSpellLibOptions {
  version?: string;
  marker?: string;
  missingExports?: readonly string[];
  broken?: boolean;
}

export function createTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cspell-lsp-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTempDirs(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function writeFakeCSpellLib(
  packageDirectory: string,
  options: FakeCSpellLibOptions = {},
): string {
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'cspell-lib',
      version: options.version ?? '9.0.0',
      type: 'module',
      exports: { '.': { import: './index.js' } },
    }),
  );

  const entry = path.join(packageDirectory, 'index.js');
  if (options.broken) {
    writeFileSync(entry, `throw new Error('broken engine');\n`);
    return entry;
  }

  const missing = new Set(options.missingExports ?? []);
  const exports = createFakeExportsSource(missing);
  const marker = JSON.stringify(options.marker ?? 'fake');
  writeFileSync(entry, `${exports}\nexport const marker = ${marker};\n`);
  return entry;
}

export interface ConditionalCSpellLibEntry {
  /** Path relative to the package directory. */
  file: string;
  marker: string;
}

export interface ConditionalCSpellLibOptions {
  version?: string;
  main?: string;
  module?: string;
}

/**
 * Writes a cspell-lib-shaped package whose root export uses the given
 * conditional-export object. Each entry exports its own marker so tests can
 * observe which target the engine selected.
 */
export function writeConditionalCSpellLib(
  packageDirectory: string,
  exportsField: Record<string, unknown>,
  entries: readonly ConditionalCSpellLibEntry[],
  options: ConditionalCSpellLibOptions = {},
): void {
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'cspell-lib',
      version: options.version ?? '9.0.0',
      type: 'module',
      ...(options.main ? { main: options.main } : {}),
      ...(options.module ? { module: options.module } : {}),
      exports: { '.': exportsField },
    }),
  );

  const exportsSource = createFakeExportsSource();
  for (const { file, marker } of entries) {
    const entry = path.join(packageDirectory, file);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      `${exportsSource}\nexport const marker = ${JSON.stringify(marker)};\n`,
    );
  }
}

export function writeFakeCSpell(
  workspaceRoot: string,
  version = '10.0.0',
): string {
  const packageDirectory = path.join(workspaceRoot, 'node_modules', 'cspell');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'cspell',
      version,
      type: 'module',
      exports: { '.': { import: './index.js' } },
      dependencies: { 'cspell-lib': '^9.0.0' },
    }),
  );
  writeFileSync(
    path.join(packageDirectory, 'index.js'),
    `export const name = 'cspell';\n`,
  );
  return packageDirectory;
}

export interface RealCSpellLibOptions {
  marker?: string;
}

function readCSpellLibPackageJsonFromEntry(entry: string): {
  version?: string;
} {
  let directory = path.dirname(fileURLToPath(entry));
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    if (existsSync(candidate)) {
      const packageJson = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === 'cspell-lib') return packageJson;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find cspell-lib package.json from ${entry}`);
    }
    directory = parent;
  }
}

/**
 * Creates a workspace-local cspell-lib that re-exports the installed
 * implementation. This exercises real package loading without requiring a
 * second installed CSpell version.
 */
export function writeRealCSpellLib(
  packageDirectory: string,
  options: RealCSpellLibOptions = {},
): string {
  const realEntry = import.meta.resolve('cspell-lib');
  const packageJson = readCSpellLibPackageJsonFromEntry(realEntry);

  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'cspell-lib',
      version: packageJson.version ?? '0.0.0',
      type: 'module',
      exports: { '.': { import: './index.js' } },
    }),
  );

  const entry = path.join(packageDirectory, 'index.js');
  const marker = options.marker ?? 'real-local';
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(realEntry)};\nexport const marker = ${JSON.stringify(marker)};\n`,
  );
  return entry;
}

export function nestedCSpellLibPath(cspellPackageDirectory: string): string {
  return path.join(cspellPackageDirectory, 'node_modules', 'cspell-lib');
}
