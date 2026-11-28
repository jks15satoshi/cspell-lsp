import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as cspellLib from 'cspell-lib';
import type {
  CSpellConfigFile,
  CSpellSettings,
  CSpellUserSettings,
  ICSpellConfigFile,
} from 'cspell-lib';

import {
  ConfigEditError,
  ConfigEditor,
  configReadOnlyReason,
  type ConfigEditorOptions,
} from '../../src/config/editor.js';
import {
  createEngineConfigAdapter,
  type EngineConfigAdapter,
} from '../../src/config/files.js';
import type { CSpellEngine } from '../../src/engine/registry.js';
import { cleanupTempDirs, createTempDir } from '../helpers/workspace.js';

beforeEach(() => {
  cspellLib.getDefaultConfigLoader().clearCachedSettingsFiles();
});

afterEach(cleanupTempDirs);

function createEngine(): CSpellEngine {
  return {
    mode: 'bundled',
    version: 'test',
    packagePath: '<bundled>',
    lib: cspellLib,
  };
}

function fakeConfigFile(
  overrides: Record<string, unknown> = {},
): ICSpellConfigFile {
  return {
    url: new URL('file:///workspace/cspell.json'),
    settings: {},
    ...overrides,
  } as ICSpellConfigFile;
}

function createEngineWithLoader(
  loader: ReturnType<typeof cspellLib.createConfigLoader>,
): CSpellEngine {
  return {
    ...createEngine(),
    lib: {
      ...cspellLib,
      getDefaultConfigLoader: () => loader,
    } as typeof cspellLib,
  };
}

function createSharedConfigEditor(): {
  editor: ConfigEditor;
  uriA: string;
  uriB: string;
  configPath: string;
} {
  const rootA = createTempDir();
  const rootB = createTempDir();
  const configPath = path.join(rootA, 'shared.json');
  writeFileSync(
    configPath,
    JSON.stringify({ version: '0.2', words: ['base'] }, null, 2),
  );

  const engineA = createEngineWithLoader(cspellLib.createConfigLoader());
  const engineB = createEngineWithLoader(cspellLib.createConfigLoader());
  const uriA = pathToFileURL(path.join(rootA, 'a.md')).href;
  const uriB = pathToFileURL(path.join(rootB, 'b.md')).href;
  const editor = new ConfigEditor(
    {
      engineForDocument: (uri) => (uri === uriA ? engineA : engineB),
      workspaceRootForDocument: (uri) => (uri === uriA ? rootA : rootB),
    },
    { configPath },
  );

  return { editor, uriA, uriB, configPath };
}

function readJsonConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(readText(configPath)) as Record<string, unknown>;
}

function createEditor(
  root: string,
  options: ConfigEditorOptions = {},
): { editor: ConfigEditor; documentUri: string } {
  const engine = createEngine();
  return {
    editor: new ConfigEditor(
      {
        engineForDocument: () => engine,
        workspaceRootForDocument: () => root,
      },
      options,
    ),
    documentUri: pathToFileURL(path.join(root, 'document.md')).href,
  };
}

async function readConfig(configPath: string): Promise<CSpellSettings> {
  cspellLib.getDefaultConfigLoader().clearCachedSettingsFiles();
  const configFile = await cspellLib
    .getDefaultConfigLoader()
    .readConfigFile(configPath);
  if (configFile instanceof Error) throw configFile;
  return configFile.settings;
}

function readText(configPath: string): string {
  return readFileSync(configPath, 'utf8');
}

describe('ConfigEditor JSON and JSONC', () => {
  for (const configName of ['cspell.json', '.cspell.jsonc']) {
    test(`adds words to ${configName} without rewriting comments or line endings`, async () => {
      const root = createTempDir();
      const configPath = path.join(root, configName);
      writeFileSync(
        configPath,
        [
          '{',
          '    // keep this comment',
          '    "version": "0.2",',
          '    "custom": { "keep": true },',
          '    "words": [',
          '        "alpha" // keep alpha comment',
          '    ]',
          '}',
          '',
        ].join('\r\n'),
      );
      const { editor, documentUri } = createEditor(root);

      expect(
        await editor.addWord(documentUri, 'words', 'beta', {
          sortWords: false,
        }),
      ).toBe(configPath);

      const text = readText(configPath);
      expect(text).toContain('// keep this comment');
      expect(text).toContain('// keep alpha comment');
      expect(text).toContain('    "version": "0.2",');
      expect(text).toContain('\r\n');

      const settings = await readConfig(configPath);
      expect(settings.words).toEqual(['alpha', 'beta']);
      expect((settings as unknown as { custom: unknown }).custom).toEqual({
        keep: true,
      });
    });
  }

  test('appends words without sorting by default', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify({ version: '0.2', words: ['zulu', 'alpha'] }, null, 2),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'beta');

    expect((await readConfig(configPath)).words).toEqual([
      'zulu',
      'alpha',
      'beta',
    ]);
  });

  test('sorts both word lists when sortWords is enabled', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '0.2',
          words: ['zulu', 'alpha'],
          userWords: ['zulu', 'alpha'],
        },
        null,
        2,
      ),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'beta', { sortWords: true });

    const settings = await readConfig(configPath);
    expect(settings.words).toEqual(['alpha', 'beta', 'zulu']);
    expect(settings.userWords).toEqual(['alpha', 'zulu']);
  });

  test('does not duplicate an existing word', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify({ version: '0.2', words: ['alpha'] }, null, 2),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'alpha');

    expect((await readConfig(configPath)).words).toEqual(['alpha']);
  });
});

describe('ConfigEditor concurrent and cached writes', () => {
  test('serializes concurrent writes from independently cached engines', async () => {
    const { editor, uriA, uriB, configPath } = createSharedConfigEditor();

    await editor.inspect(uriA);
    await editor.inspect(uriB);
    await Promise.all([
      editor.addWord(uriA, 'words', 'alpha'),
      editor.addWord(uriB, 'words', 'beta'),
    ]);

    const words = readJsonConfig(configPath).words as string[];
    const sorted = [...words];
    // oxlint-disable-next-line unicorn/no-array-sort
    sorted.sort();
    expect(sorted).toEqual(['alpha', 'base', 'beta']);
  });

  test('reloads a config cached by another engine before writing', async () => {
    const { editor, uriA, uriB, configPath } = createSharedConfigEditor();

    await editor.inspect(uriA);
    await editor.inspect(uriB);
    await editor.addWord(uriA, 'words', 'alpha');
    await editor.addWord(uriB, 'words', 'beta');

    const words = readJsonConfig(configPath).words as string[];
    const sorted = [...words];
    // oxlint-disable-next-line unicorn/no-array-sort
    sorted.sort();
    expect(sorted).toEqual(['alpha', 'base', 'beta']);
  });

  test('preserves external edits made after editability was resolved', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify({ version: '0.2', words: ['base'] }, null, 2),
    );
    const { editor, documentUri } = createEditor(root);

    expect(await editor.canEdit(documentUri)).toBe(true);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '0.2',
          words: ['base', 'external'],
          custom: { keep: true },
        },
        null,
        2,
      ),
    );

    await editor.addWord(documentUri, 'words', 'beta');

    const settings = readJsonConfig(configPath);
    expect(settings.words).toEqual(['base', 'external', 'beta']);
    expect(settings.custom).toEqual({ keep: true });
  });

  test('serializes new config writes through a directory symlink', async () => {
    const base = createTempDir();
    const realRoot = path.join(base, 'real');
    const aliasRoot = path.join(base, 'alias');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(
      realRoot,
      aliasRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const engineA = createEngineWithLoader(cspellLib.createConfigLoader());
    const engineB = createEngineWithLoader(cspellLib.createConfigLoader());
    const uriA = pathToFileURL(path.join(realRoot, 'a.md')).href;
    const uriB = pathToFileURL(path.join(aliasRoot, 'b.md')).href;

    let searches = 0;
    let releaseSearches!: () => void;
    const bothSearched = new Promise<void>((resolve) => {
      releaseSearches = resolve;
    });
    const createAdapter = (engine: CSpellEngine): EngineConfigAdapter => {
      const adapter = createEngineConfigAdapter(engine);
      return {
        ...adapter,
        async searchForConfigFileLocation() {
          searches += 1;
          if (searches === 2) releaseSearches();
          await bothSearched;
          return undefined;
        },
      };
    };

    const editor = new ConfigEditor(
      {
        engineForDocument: (uri) => (uri === uriA ? engineA : engineB),
        workspaceRootForDocument: (uri) =>
          uri === uriA ? realRoot : aliasRoot,
      },
      { defaultSettings: { version: '0.2', words: ['base'] } },
      createAdapter,
    );

    await Promise.all([
      editor.addWord(uriA, 'words', 'alpha'),
      editor.addWord(uriB, 'words', 'beta'),
    ]);

    const words = readJsonConfig(path.join(realRoot, 'cspell.json'))
      .words as string[];
    const sorted = [...words];
    // oxlint-disable-next-line unicorn/no-array-sort
    sorted.sort();
    expect(sorted).toEqual(['alpha', 'base', 'beta']);
  });
});

describe('ConfigEditor YAML', () => {
  for (const configName of ['cspell.config.yaml', '.cspell.yml']) {
    test(`adds words to ${configName} without losing comments`, async () => {
      const root = createTempDir();
      const configPath = path.join(root, configName);
      writeFileSync(
        configPath,
        [
          '# keep this comment',
          'version: "0.2"',
          'custom:',
          '  keep: true',
          'words:',
          '  # keep alpha comment',
          '  - alpha',
          '',
        ].join('\r\n'),
      );
      const { editor, documentUri } = createEditor(root);

      await editor.addWord(documentUri, 'words', 'beta');

      const text = readText(configPath);
      expect(text).toContain('# keep this comment');
      expect(text).toContain('# keep alpha comment');
      expect(text).toContain('  - alpha');
      expect(text).toContain('\r\n');

      const settings = await readConfig(configPath);
      expect(settings.words).toEqual(['alpha', 'beta']);
      expect((settings as unknown as { custom: unknown }).custom).toEqual({
        keep: true,
      });
    });
  }

  test('writes userWords through the YAML writer', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(
      configPath,
      ['version: "0.2"', 'userWords:', '  - alpha', ''].join('\n'),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'userWords', 'beta');

    const settings = await readConfig(configPath);
    expect(settings.userWords).toEqual(['alpha', 'beta']);
    expect(settings.words).toBeUndefined();
  });

  for (const attribute of ['words', 'userWords'] as const) {
    test(`creates a missing YAML ${attribute} list`, async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.config.yaml');
      writeFileSync(configPath, 'version: "0.2"\n');
      const { editor, documentUri } = createEditor(root);

      await editor.addWord(documentUri, attribute, 'beta');

      expect((await readConfig(configPath))[attribute]).toEqual(['beta']);
    });
  }

  test('sorts YAML userWords and the existing words list', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(
      configPath,
      [
        'words:',
        '  - zulu',
        '  - alpha',
        'userWords:',
        '  - zulu',
        '  - alpha',
        '',
      ].join('\n'),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'userWords', 'beta', { sortWords: true });

    const settings = await readConfig(configPath);
    expect(settings.userWords).toEqual(['alpha', 'beta', 'zulu']);
    expect(settings.words).toEqual(['alpha', 'zulu']);
  });

  test('keeps YAML comments with their words while sorting both lists', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(
      configPath,
      [
        'words:',
        '  # zulu comment',
        '  - zulu',
        '  # alpha comment',
        '  - alpha',
        'userWords:',
        '  # user-zulu comment',
        '  - zulu',
        '  # user-alpha comment',
        '  - alpha',
        '',
      ].join('\n'),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'beta', { sortWords: true });

    expect(readText(configPath)).toBe(
      [
        'words:',
        '  # alpha comment',
        '  - alpha',
        '  - beta',
        '  # zulu comment',
        '  - zulu',
        'userWords:',
        '  # user-alpha comment',
        '  - alpha',
        '  # user-zulu comment',
        '  - zulu',
        '',
      ].join('\n'),
    );
    const settings = await readConfig(configPath);
    expect(settings.words).toEqual(['alpha', 'beta', 'zulu']);
    expect(settings.userWords).toEqual(['alpha', 'zulu']);
  });

  test('sorts YAML words with the shared case-insensitive comparator', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(configPath, ['words:', '  - Z', '  - z', ''].join('\n'));
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'alpha', { sortWords: true });

    expect((await readConfig(configPath)).words).toEqual(['alpha', 'Z', 'z']);
  });

  test('materializes an aliased userWords list instead of failing', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(
      configPath,
      ['words: &word-list', '  - alpha', 'userWords: *word-list', ''].join(
        '\n',
      ),
    );
    const { editor, documentUri } = createEditor(root);

    expect(await editor.canEdit(documentUri)).toBe(true);
    await editor.addWord(documentUri, 'userWords', 'beta');

    const settings = await readConfig(configPath);
    expect(settings.words).toEqual(['alpha']);
    expect(settings.userWords).toEqual(['alpha', 'beta']);
    const text = readText(configPath);
    expect(text).toContain('words: &word-list');
    expect(text).not.toContain('userWords: *word-list');
  });

  test('does not rewrite an aliased list when the word is already present', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    const original = [
      'words: &word-list',
      '  - alpha',
      'userWords: *word-list',
      '',
    ].join('\n');
    writeFileSync(configPath, original);
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'userWords', 'alpha');

    expect(readText(configPath)).toBe(original);
  });

  test('sorts a materialized alias list when sortWords is enabled', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(
      configPath,
      [
        'words: &word-list',
        '  - zulu',
        '  - alpha',
        'userWords: *word-list',
        '',
      ].join('\n'),
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'userWords', 'beta', {
      sortWords: true,
    });

    const settings = await readConfig(configPath);
    expect(settings.words).toEqual(['alpha', 'zulu']);
    expect(settings.userWords).toEqual(['alpha', 'beta', 'zulu']);
  });
});

describe('ConfigEditor package.json', () => {
  test('writes words under cspell and leaves top-level fields alone', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'package.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: 'fixture',
          version: '1.0.0',
          cspell: { version: '0.2', words: ['alpha'] },
        },
        null,
        2,
      ) + '\n',
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'words', 'beta');

    const packageJson = JSON.parse(readText(configPath)) as Record<
      string,
      unknown
    >;
    expect(packageJson.name).toBe('fixture');
    expect(packageJson.version).toBe('1.0.0');
    expect(packageJson.words).toBeUndefined();
    expect(packageJson.userWords).toBeUndefined();
    expect((packageJson.cspell as { words?: string[] }).words).toEqual([
      'alpha',
      'beta',
    ]);
  });

  test('writes userWords under cspell and leaves top-level fields alone', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'package.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: 'fixture',
          cspell: { version: '0.2', userWords: ['alpha'] },
        },
        null,
        2,
      ) + '\n',
    );
    const { editor, documentUri } = createEditor(root);

    await editor.addWord(documentUri, 'userWords', 'beta');

    const packageJson = JSON.parse(readText(configPath)) as Record<
      string,
      unknown
    >;
    expect(packageJson.words).toBeUndefined();
    expect(packageJson.userWords).toBeUndefined();
    expect((packageJson.cspell as { userWords?: string[] }).userWords).toEqual([
      'alpha',
      'beta',
    ]);
  });
});

const supportsToml =
  cspellLib.defaultConfigFilenames.includes('cspell.config.toml');

if (supportsToml) {
  describe('ConfigEditor TOML', () => {
    test('adds words and preserves CSpell setting values', async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.config.toml');
      writeFileSync(
        configPath,
        [
          '# this comment is expected to be rewritten',
          'version = "0.2"',
          'custom = { keep = true }',
          'words = [',
          '  "alpha",',
          ']',
          '',
        ].join('\r\n'),
      );
      const { editor, documentUri } = createEditor(root);

      await editor.addWord(documentUri, 'words', 'beta');

      const text = readText(configPath);
      expect(text).toContain('\r\n');

      const settings = await readConfig(configPath);
      expect(settings.words).toEqual(['alpha', 'beta']);
      expect((settings as unknown as { custom: unknown }).custom).toEqual({
        keep: true,
      });
    });

    test('sorts TOML words when sortWords is enabled', async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.config.toml');
      writeFileSync(
        configPath,
        ['version = "0.2"', 'words = ["zulu", "alpha"]', ''].join('\n'),
      );
      const { editor, documentUri } = createEditor(root);

      await editor.addWord(documentUri, 'words', 'beta', {
        sortWords: true,
      });

      expect((await readConfig(configPath)).words).toEqual([
        'alpha',
        'beta',
        'zulu',
      ]);
    });

    test('edits an explicit TOML config', async () => {
      const root = createTempDir();
      const projectPath = path.join(root, 'cspell.json');
      writeFileSync(
        projectPath,
        JSON.stringify({ version: '0.2', words: [] }, null, 2),
      );
      const explicitPath = path.join(root, 'explicit.toml');
      writeFileSync(
        explicitPath,
        ['version = "0.2"', 'words = ["explicit"]', ''].join('\n'),
      );
      const { editor, documentUri } = createEditor(root, {
        configPath: explicitPath,
      });

      await editor.addWord(documentUri, 'words', 'beta');

      expect((await readConfig(explicitPath)).words).toEqual([
        'explicit',
        'beta',
      ]);
      expect((await readConfig(projectPath)).words).toEqual([]);
    });
  });
}

describe('ConfigEditor creation and explicit config', () => {
  test('creates cspell.json at the workspace root when no config exists', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    const { editor, documentUri } = createEditor(root, {
      defaultSettings: { words: ['alpha'] },
    });

    expect(await editor.addWord(documentUri, 'words', 'beta')).toBe(configPath);
    expect((await readConfig(configPath)).words).toEqual(['alpha', 'beta']);
  });

  test('does not create a config from malformed default settings', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    const { editor, documentUri } = createEditor(root, {
      defaultSettings: {
        words: ['alpha', 42],
      } as unknown as CSpellUserSettings,
    });

    expect(await editor.canEdit(documentUri)).toBe(false);
    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'the "words" setting must be an array of strings',
    );
    expect(existsSync(configPath)).toBe(false);
  });

  test('reports a missing explicit config', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'custom.json');
    const { editor, documentUri } = createEditor(root, {
      configPath,
      defaultSettings: { words: ['alpha'] },
    });

    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'the configuration file does not exist',
    );
    expect(existsSync(configPath)).toBe(false);
  });

  test('prefers --config over project config search', async () => {
    const root = createTempDir();
    const projectPath = path.join(root, 'cspell.json');
    writeFileSync(
      projectPath,
      JSON.stringify({ version: '0.2', words: ['search'] }, null, 2),
    );
    const explicitDirectory = path.join(root, 'config');
    mkdirSync(explicitDirectory);
    const explicitPath = path.join(explicitDirectory, 'cspell.yaml');
    writeFileSync(
      explicitPath,
      ['version: "0.2"', 'words:', '  - explicit', ''].join('\n'),
    );
    const { editor, documentUri } = createEditor(root, {
      configPath: explicitPath,
    });

    await editor.addWord(documentUri, 'words', 'beta');

    expect((await readConfig(explicitPath)).words).toEqual([
      'explicit',
      'beta',
    ]);
    expect((await readConfig(projectPath)).words).toEqual(['search']);
  });
});

describe('ConfigEditor adapter injection', () => {
  test('mutates settings when the writer has no setValue', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(configPath, 'words:\n  - alpha\n');
    const settings: CSpellUserSettings = { words: ['alpha'] };
    const configFile = {
      url: new URL(pathToFileURL(configPath).href),
      settings,
      readonly: false,
      virtual: false,
      remote: false,
      serialize() {
        const words = settings.words ?? [];
        return `words:\n${words.map((word) => `  - ${word}`).join('\n')}\n`;
      },
    } as unknown as CSpellConfigFile;
    const adapter: EngineConfigAdapter = {
      fileNames: ['cspell.config.yaml'],
      async searchForConfigFileLocation() {
        return pathToFileURL(configPath);
      },
      async readConfigFile() {
        return configFile;
      },
      serializeConfigFile(file) {
        return (
          file as unknown as {
            serialize(): string;
          }
        ).serialize();
      },
      clearCachedSettingsFiles() {},
    };
    const editor = new ConfigEditor(
      {
        engineForDocument: () => createEngine(),
        workspaceRootForDocument: () => root,
      },
      {},
      () => adapter,
    );

    await editor.addWord(
      pathToFileURL(path.join(root, 'document.md')).href,
      'words',
      'beta',
    );

    expect(settings.words).toEqual(['alpha', 'beta']);
    expect(readText(configPath)).toBe('words:\n  - alpha\n  - beta\n');
  });
});

describe('ConfigEditor read-only guards', () => {
  test('does not write a readonly config', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        { version: '0.2', readonly: true, words: ['alpha'] },
        null,
        2,
      ),
    );
    const before = readText(configPath);
    const { editor, documentUri } = createEditor(root);

    expect(await editor.canEdit(documentUri)).toBe(false);
    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'the configuration is marked read-only',
    );
    expect(readText(configPath)).toBe(before);
  });

  test('does not write a malformed JSON config', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(configPath, '{ "words": [');
    const before = readText(configPath);
    const { editor, documentUri } = createEditor(root);

    const target = await editor.inspect(documentUri);
    expect(target.kind).toBe('unavailable');
    expect(target.editable).toBe(false);
    expect(target.reason).toContain('could not be parsed');
    expect(await editor.canEdit(documentUri)).toBe(false);

    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'could not be parsed',
    );
    expect(readText(configPath)).toBe(before);
  });

  test('does not write a malformed YAML config', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.yaml');
    writeFileSync(configPath, 'words: [');
    const before = readText(configPath);
    const { editor, documentUri } = createEditor(root);

    const target = await editor.inspect(documentUri);
    expect(target.kind).toBe('existing');
    expect(target.editable).toBe(false);
    expect(target.reason).toContain('could not be parsed');
    expect(await editor.canEdit(documentUri)).toBe(false);

    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'could not be parsed',
    );
    expect(readText(configPath)).toBe(before);
  });

  const malformedWordFieldConfigs = [
    {
      file: 'cspell.json',
      content: JSON.stringify({ version: '0.2', words: 'alpha' }, null, 2),
    },
    {
      file: 'package.json',
      content:
        JSON.stringify(
          {
            name: 'fixture',
            cspell: { version: '0.2', words: 'alpha' },
          },
          null,
          2,
        ) + '\n',
    },
    ...(supportsToml
      ? [{ file: 'cspell.config.toml', content: 'words = "alpha"\n' }]
      : []),
  ];

  for (const { file, content } of malformedWordFieldConfigs) {
    test(`does not write a non-array word field in ${file}`, async () => {
      const root = createTempDir();
      const configPath = path.join(root, file);
      writeFileSync(configPath, content);
      const before = readText(configPath);
      const { editor, documentUri } = createEditor(root);

      expect(await editor.canEdit(documentUri)).toBe(false);
      await expect(
        editor.addWord(documentUri, 'words', 'beta'),
      ).rejects.toThrow('the "words" setting must be an array of strings');
      expect(readText(configPath)).toBe(before);
    });
  }

  test('does not write a word list with non-string entries', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.json');
    writeFileSync(
      configPath,
      JSON.stringify({ version: '0.2', words: ['alpha', 42] }, null, 2),
    );
    const before = readText(configPath);
    const { editor, documentUri } = createEditor(root);

    expect(await editor.canEdit(documentUri)).toBe(false);
    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'the "words" setting must be an array of strings',
    );
    expect(readText(configPath)).toBe(before);
  });

  test('does not write an executable JavaScript config', async () => {
    const root = createTempDir();
    const configPath = path.join(root, 'cspell.config.mjs');
    writeFileSync(
      configPath,
      'export default { version: "0.2", words: ["alpha"] };\n',
    );
    const before = readText(configPath);
    const { editor, documentUri } = createEditor(root);

    expect(await editor.canEdit(documentUri)).toBe(false);
    await expect(editor.addWord(documentUri, 'words', 'beta')).rejects.toThrow(
      'the configuration is marked read-only',
    );
    expect(readText(configPath)).toBe(before);
  });

  if (supportsToml) {
    test('does not write a readonly TOML config', async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.config.toml');
      writeFileSync(
        configPath,
        ['readonly = true', 'words = ["alpha"]', ''].join('\n'),
      );
      const before = readText(configPath);
      const { editor, documentUri } = createEditor(root);

      expect(await editor.canEdit(documentUri)).toBe(false);
      await expect(
        editor.addWord(documentUri, 'words', 'beta'),
      ).rejects.toThrow('the configuration is marked read-only');
      expect(readText(configPath)).toBe(before);
    });

    test('does not write a malformed TOML config', async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.config.toml');
      writeFileSync(configPath, 'words = [');
      const before = readText(configPath);
      const { editor, documentUri } = createEditor(root);

      expect(await editor.canEdit(documentUri)).toBe(false);
      await expect(
        editor.addWord(documentUri, 'words', 'beta'),
      ).rejects.toBeInstanceOf(ConfigEditError);
      expect(readText(configPath)).toBe(before);
    });
  }
});

describe('config writability', () => {
  test('allows configs with an engine writer', () => {
    expect(
      configReadOnlyReason(fakeConfigFile({ serialize: () => '' })),
    ).toBeUndefined();
  });

  test('explains read-only configs and guards', () => {
    expect(configReadOnlyReason(fakeConfigFile({ readonly: true }))).toBe(
      'the configuration is marked read-only.',
    );
    expect(
      configReadOnlyReason(
        fakeConfigFile({ remote: true, serialize: () => '' }),
      ),
    ).toBe('remote configuration files are read-only.');
    expect(
      configReadOnlyReason(
        fakeConfigFile({ virtual: true, serialize: () => '' }),
      ),
    ).toBe('virtual configuration files are read-only.');
    expect(
      configReadOnlyReason(
        fakeConfigFile({
          error: new Error('invalid toml'),
          serialize: () => '',
        }),
      ),
    ).toBe('the configuration could not be parsed: invalid toml');
    expect(configReadOnlyReason(fakeConfigFile())).toBe(
      'the configuration has no safe writer.',
    );
  });
});
