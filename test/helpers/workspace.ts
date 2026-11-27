import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

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
  const exports = Object.entries(fakeExports)
    .filter(([name]) => !missing.has(name))
    .map(([, source]) => source)
    .join('\n');
  const marker = JSON.stringify(options.marker ?? 'fake');
  writeFileSync(entry, `${exports}\nexport const marker = ${marker};\n`);
  return entry;
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

export function nestedCSpellLibPath(cspellPackageDirectory: string): string {
  return path.join(cspellPackageDirectory, 'node_modules', 'cspell-lib');
}
