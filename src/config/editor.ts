import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify as stringifyJsonc } from 'comment-json';

import type {
  CSpellConfigFile,
  CSpellUserSettings,
  ICSpellConfigFile,
} from 'cspell-lib';

import type { CSpellEngine } from '../engine/registry.js';
import {
  createEngineConfigAdapter,
  hasSerialize,
  type EngineConfigAdapter,
} from './files.js';
import { cloneSettingsForConfig } from './words.js';

const WORD_ATTRIBUTES = ['words', 'userWords'] as const;

export type ConfigWordAttribute = (typeof WORD_ATTRIBUTES)[number];

/**
 * Explains why a configuration file must not be written.
 *
 * A missing reason means the config is editable. Writability follows the
 * selected engine's config object: a format is editable when that object is
 * not read-only and exposes a serializer. Executable JavaScript/TypeScript
 * configs are read-only because the engine marks them read-only. Configs whose
 * word settings are not string arrays are rejected so a write cannot discard
 * invalid values.
 */
export function configReadOnlyReason(
  configFile: ICSpellConfigFile,
): string | undefined {
  const error = getConfigFileError(configFile);
  if (error) return `the configuration could not be parsed: ${error.message}`;
  if (configFile.remote) return 'remote configuration files are read-only.';
  if (configFile.virtual) return 'virtual configuration files are read-only.';
  if (configFile.readonly) return 'the configuration is marked read-only.';
  const wordFieldError = invalidWordFieldReason(
    configFile.settings as CSpellUserSettings,
  );
  if (wordFieldError) return wordFieldError;
  if (!hasSerialize(configFile)) {
    return 'the configuration has no safe writer.';
  }
  return undefined;
}

function invalidWordFieldReason(
  settings: CSpellUserSettings,
): string | undefined {
  for (const key of WORD_ATTRIBUTES) {
    const value = settings[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      !value.every((word) => typeof word === 'string')
    ) {
      return `the "${key}" setting must be an array of strings.`;
    }
  }
  return undefined;
}

export interface ExistingConfigTarget {
  kind: 'existing';
  path: string;
  configFile: CSpellConfigFile;
  editable: boolean;
  reason?: string;
}

export interface NewConfigTarget {
  kind: 'new';
  path: string;
  settings: CSpellUserSettings;
  editable: boolean;
  reason?: string;
}

export interface UnavailableConfigTarget {
  kind: 'unavailable';
  path?: string;
  editable: false;
  reason: string;
}

export type ConfigEditTarget =
  | ExistingConfigTarget
  | NewConfigTarget
  | UnavailableConfigTarget;

export interface ConfigEditorHost {
  engineForDocument(uri: string): CSpellEngine;
  workspaceRootForDocument(uri: string): string | undefined;
}

export interface ConfigEditorOptions {
  configPath?: string | null;
  defaultSettings?: CSpellUserSettings;
}

export interface AddWordOptions {
  sortWords?: boolean;
}

export type ConfigAdapterFactory = (
  engine: CSpellEngine,
) => EngineConfigAdapter;

/**
 * Resolves the CSpell configuration for a document and writes words through
 * the selected engine's config-file implementation.
 */
export class ConfigEditor {
  private readonly adapters = new WeakMap<CSpellEngine, EngineConfigAdapter>();

  constructor(
    private readonly host: ConfigEditorHost,
    private readonly options: ConfigEditorOptions = {},
    private readonly createAdapter: ConfigAdapterFactory = createEngineConfigAdapter,
  ) {}

  /**
   * Resolves the configuration target without changing it.
   *
   * Existing config files are loaded through the selected engine. A missing
   * project config is reported as a new `cspell.json` target; a missing
   * explicit `--config` file is an error because its format cannot be known.
   */
  async inspect(documentUri: string): Promise<ConfigEditTarget> {
    const engine = this.host.engineForDocument(documentUri);
    const adapter = this.adapterFor(engine);
    const configuredPath = this.options.configPath;

    if (configuredPath) {
      const absolute = path.resolve(configuredPath);
      if (!fs.existsSync(absolute)) {
        return {
          kind: 'unavailable',
          path: absolute,
          editable: false,
          reason: `Cannot edit ${absolute}: the configuration file does not exist.`,
        };
      }
      return this.readTarget(adapter, absolute);
    }

    const documentPath = safeFileURLToPath(documentUri);
    if (!documentPath) {
      return {
        kind: 'unavailable',
        editable: false,
        reason: `Cannot edit the CSpell configuration for ${documentUri}: the document is not a local file.`,
      };
    }

    let location: URL | undefined;
    try {
      location = await adapter.searchForConfigFileLocation(documentPath);
    } catch (error) {
      return {
        kind: 'unavailable',
        editable: false,
        reason: `Could not search for the CSpell configuration: ${errorMessage(error)}`,
      };
    }

    if (!location) {
      const workspaceRoot = this.host.workspaceRootForDocument(documentUri);
      if (!workspaceRoot) {
        return {
          kind: 'unavailable',
          editable: false,
          reason:
            'Cannot determine workspace root to create a new cspell.json file.',
        };
      }
      return this.createNewTarget(path.join(workspaceRoot, 'cspell.json'));
    }

    return this.readTarget(adapter, location);
  }

  /**
   * Whether the config-edit code actions should be offered for a document.
   *
   * Resolution failures hide the actions: an edit path must not be advertised
   * when the current configuration state cannot be trusted.
   */
  async canEdit(documentUri: string): Promise<boolean> {
    try {
      return (await this.inspect(documentUri)).editable;
    } catch {
      return false;
    }
  }

  /**
   * Adds one word to the resolved configuration and returns the written path.
   *
   * The file is serialized by the config object returned from the selected
   * engine. Line endings from the original file are restored because the
   * engine writers normalize them to LF.
   *
   * @throws {@link ConfigEditError} when the configuration is not writable.
   */
  async addWord(
    documentUri: string,
    attribute: ConfigWordAttribute,
    word: string,
    options: AddWordOptions = {},
  ): Promise<string> {
    let target: ConfigEditTarget;
    try {
      target = await this.inspect(documentUri);
    } catch (error) {
      throw new ConfigEditError(
        `Could not resolve the CSpell configuration: ${errorMessage(error)}`,
      );
    }

    this.assertEditable(target);

    const sortWords = options.sortWords ?? false;
    return withConfigWriteLock(configWriteKey(target.path), async () => {
      const engine = this.host.engineForDocument(documentUri);
      const adapter = this.adapterFor(engine);
      const current = await this.reloadTarget(adapter, target);
      this.assertEditable(current);

      if (current.kind === 'new') {
        try {
          addWordsToSettings(current.settings, attribute, word, sortWords);
          fs.writeFileSync(
            current.path,
            stringifyJsonc(current.settings, null, 2),
          );
        } catch (error) {
          throw new ConfigEditError(
            `Could not write ${current.path}: ${errorMessage(error)}`,
          );
        }
        return current.path;
      }

      try {
        const settings = current.configFile.settings as CSpellUserSettings;
        updateConfigFileSettings(
          current.configFile,
          settings,
          attribute,
          word,
          sortWords,
        );
        const serialized = adapter.serializeConfigFile(current.configFile);
        if (serialized === undefined) {
          throw new Error('the configuration has no safe writer');
        }
        const original = fs.readFileSync(current.path, 'utf8');
        fs.writeFileSync(
          current.path,
          applyLineEndings(serialized, detectLineEnding(original)),
        );
      } catch (error) {
        // The in-memory config was mutated before serialization; discard it so
        // a later read cannot observe a write that never reached disk.
        adapter.clearCachedSettingsFiles();
        throw new ConfigEditError(
          `Could not update ${current.path}: ${errorMessage(error)}`,
        );
      }

      return current.path;
    });
  }

  private assertEditable(
    target: ConfigEditTarget,
  ): asserts target is ExistingConfigTarget | NewConfigTarget {
    if (target.kind === 'unavailable') {
      throw new ConfigEditError(target.reason);
    }
    if (!target.editable) {
      throw new ConfigEditError(
        `Cannot edit ${target.path}: ${target.reason ?? 'the configuration is read-only.'}`,
      );
    }
  }

  private async reloadTarget(
    adapter: EngineConfigAdapter,
    target: ExistingConfigTarget | NewConfigTarget,
  ): Promise<ConfigEditTarget> {
    if (target.kind === 'existing') {
      adapter.clearCachedSettingsFiles();
      return this.readTarget(adapter, target.path);
    }

    // Another writer may have created this file while the edit waited for the
    // lock. Read it instead of overwriting it with the original defaults.
    if (!fs.existsSync(target.path)) return target;
    adapter.clearCachedSettingsFiles();
    return this.readTarget(adapter, target.path);
  }

  private adapterFor(engine: CSpellEngine): EngineConfigAdapter {
    let adapter = this.adapters.get(engine);
    if (!adapter) {
      adapter = this.createAdapter(engine);
      this.adapters.set(engine, adapter);
    }
    return adapter;
  }

  private readTarget(
    adapter: EngineConfigAdapter,
    file: string | URL,
  ): Promise<ConfigEditTarget> {
    return this.readTargetAsync(adapter, file, configFilePath(file));
  }

  private async readTargetAsync(
    adapter: EngineConfigAdapter,
    file: string | URL,
    displayPath: string,
  ): Promise<ConfigEditTarget> {
    let result: CSpellConfigFile | Error;
    try {
      result = await adapter.readConfigFile(file);
    } catch (error) {
      return {
        kind: 'unavailable',
        path: displayPath,
        editable: false,
        reason: `Cannot edit ${displayPath}: ${errorMessage(error)}`,
      };
    }

    if (result instanceof Error) {
      return {
        kind: 'unavailable',
        path: displayPath,
        editable: false,
        reason: `Cannot edit ${displayPath}: the configuration could not be parsed or read: ${result.message}`,
      };
    }

    const reason = configReadOnlyReason(result);
    return {
      kind: 'existing',
      path: displayPath,
      configFile: result,
      editable: !reason,
      reason,
    };
  }

  private createNewTarget(configPath: string): ConfigEditTarget {
    const sourceSettings = this.options.defaultSettings ?? {};
    const reason = invalidWordFieldReason(sourceSettings);
    if (reason) {
      return {
        kind: 'unavailable',
        path: configPath,
        editable: false,
        reason: `Cannot create ${configPath}: ${reason}`,
      };
    }

    return {
      kind: 'new',
      path: configPath,
      settings: cloneSettingsForConfig(sourceSettings),
      editable: true,
    };
  }
}

/**
 * Error raised when a configuration cannot be edited safely.
 */
export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEditError';
  }
}

function updateConfigFileSettings(
  configFile: CSpellConfigFile,
  settings: CSpellUserSettings,
  attribute: ConfigWordAttribute,
  word: string,
  sortWords: boolean,
): void {
  const yamlConfig = configFile as unknown as YamlConfigFile;

  // YAML v10 uses a yaml AST, so settings must be written through its node
  // API. YAML v8 has no AST and its serializer reads the settings object.
  if ('yamlDoc' in configFile && typeof yamlConfig.setValue === 'function') {
    updateYamlConfigFile(yamlConfig, settings, attribute, word, sortWords);
    return;
  }

  // JSON, JSONC, package.json, TOML, and YAML without an AST keep the
  // settings object live. Mutating the existing array in place also preserves
  // comment-json tokens attached to JSON arrays.
  addWordsToSettings(settings, attribute, word, sortWords);
}

interface YamlArrayNode {
  readonly type?: string;
  readonly value?: unknown;
  push?(value: string): unknown;
}

interface YamlScalarNode {
  readonly value?: unknown;
  commentBefore?: string | null;
}

interface YamlSequenceNode {
  commentBefore?: string | null;
  items?: YamlScalarNode[];
}

interface YamlDocument {
  get(key: ConfigWordAttribute): YamlSequenceNode | undefined;
}

interface YamlConfigFile {
  readonly yamlDoc?: YamlDocument;
  getNode?(key: ConfigWordAttribute): YamlArrayNode | undefined;
  setValue(key: ConfigWordAttribute, value: string[]): unknown;
}

function updateYamlConfigFile(
  configFile: YamlConfigFile,
  settings: CSpellUserSettings,
  attribute: ConfigWordAttribute,
  word: string,
  sortWords: boolean,
): void {
  addYamlWord(configFile, settings, attribute, word);

  if (!sortWords) return;
  for (const key of WORD_ATTRIBUTES) {
    sortYamlWordList(configFile, key);
  }
}

function addYamlWord(
  configFile: YamlConfigFile,
  settings: CSpellUserSettings,
  attribute: ConfigWordAttribute,
  word: string,
): void {
  let node: YamlArrayNode | undefined;
  try {
    node = configFile.getNode?.(attribute);
  } catch (error) {
    if (!isYamlAliasNodeError(error)) throw error;

    // cspell-config-lib cannot edit alias nodes. Materialize the alias so the
    // edit affects only this setting and leaves the anchored list unchanged.
    const current = getWordList(settings[attribute]);
    if (current.includes(word)) return;
    configFile.setValue(attribute, appendWord(current, word));
    return;
  }

  const current = Array.isArray(node?.value)
    ? (node.value as string[])
    : getWordList(settings[attribute]);
  if (current.includes(word)) return;

  if (node?.type === 'array' && node.push) {
    // Pushing a YAML node preserves comments on existing word items.
    node.push(word);
    return;
  }
  configFile.setValue(attribute, appendWord(current, word));
}

function isYamlAliasNodeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Unsupported YAML node type: alias')
  );
}

function sortYamlWordList(
  configFile: YamlConfigFile,
  attribute: ConfigWordAttribute,
): void {
  const sequence = configFile.yamlDoc?.get(attribute);
  const items = sequence?.items;
  if (!sequence || !items || items.length < 2) return;

  // The YAML parser attaches the first item's leading comment to the
  // sequence. Move it onto that item before reordering so it stays with its
  // word instead of remaining above the new first item.
  if (sequence.commentBefore) {
    const first = items[0];
    first.commentBefore = first.commentBefore
      ? `${sequence.commentBefore}\n${first.commentBefore}`
      : sequence.commentBefore;
    sequence.commentBefore = null;
  }

  // Sorting the AST nodes keeps each word's comments attached to it.
  // oxlint-disable-next-line unicorn/no-array-sort
  items.sort((a, b) => compareWords(yamlScalarValue(a), yamlScalarValue(b)));
}

function yamlScalarValue(node: YamlScalarNode): string {
  return typeof node.value === 'string' ? node.value : String(node.value);
}

function appendWord(words: string[], word: string): string[] {
  const next = [...words];
  if (!next.includes(word)) next.push(word);
  return next;
}

function addWordsToSettings(
  settings: CSpellUserSettings,
  attribute: ConfigWordAttribute,
  word: string,
  sortWords: boolean,
): void {
  const list = getWordList(settings[attribute]);
  if (!list.includes(word)) list.push(word);
  settings[attribute] = list;

  if (!sortWords) return;
  for (const key of WORD_ATTRIBUTES) {
    const value = settings[key];
    if (Array.isArray(value)) value.sort(compareWords);
  }
}

function getWordList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function compareWords(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function getConfigFileError(configFile: ICSpellConfigFile): Error | undefined {
  if ('error' in configFile) {
    const error = (configFile as { error?: unknown }).error;
    if (error !== undefined) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  // cspell-config-lib's YAML parser keeps parse errors on the document
  // instead of throwing, so inspect them before attempting a write.
  const yamlErrors = (
    configFile as { yamlDoc?: { errors?: readonly unknown[] } }
  ).yamlDoc?.errors;
  if (yamlErrors && yamlErrors.length > 0) {
    return new Error(yamlErrors.map((error) => errorMessage(error)).join('; '));
  }

  return undefined;
}

function configFilePath(file: string | URL): string {
  if (typeof file === 'string') return file;
  if (file.protocol === 'file:') {
    return safeFileURLToPath(file.href) ?? file.href;
  }
  return file.href;
}

/**
 * Serializes configuration writes by path across all editor instances.
 *
 * The server normally has one editor, but memoizing the lock at module scope
 * also covers a concurrent first-use race that could create two instances.
 */
const configWriteLocks = new Map<string, Promise<void>>();

function withConfigWriteLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = configWriteLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  // The tail never rejects so one failed write cannot block later writes.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  configWriteLocks.set(key, tail);
  void tail.finally(() => {
    if (configWriteLocks.get(key) === tail) {
      configWriteLocks.delete(key);
    }
  });
  return run;
}

/**
 * Returns a stable lock key for a configuration path.
 *
 * Real paths serialize writes through symlinks. A new file has no real path
 * yet, so the nearest existing ancestor is resolved and the remaining path is
 * appended. This keeps the key stable when the same directory is reached
 * through a symlink alias before the file has been created.
 */
function configWriteKey(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return realpathOfExistingAncestor(absolute);
  }
}

function realpathOfExistingAncestor(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch (error) {
      // Only missing components are moved into the tail. An unreadable path
      // cannot be canonicalized, so keep the logical key and let the write
      // report its normal error.
      if (!isMissingPathError(error)) return absolute;

      const parent = path.dirname(current);
      if (parent === current) return absolute;

      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function detectLineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function applyLineEndings(content: string, lineEnding: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
