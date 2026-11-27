import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultConfigFilenames } from 'cspell-lib';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { ConfigEditor } from '../src/config.js';
import type { CSpellEngine } from '../src/engine.js';
import { EngineRegistry } from '../src/engine.js';
import { SettingsResolver } from '../src/settings.js';
import { validateTextDocument } from '../src/validator.js';
import {
  cleanupTempDirs,
  createTempDir,
  writeRealCSpellLib,
} from './helpers/workspace.js';

const unknownWord = `zz${Math.random()
  .toString(36)
  .replace(/[^a-z]/g, '')
  .padEnd(8, 'x')
  .slice(0, 8)}`;

const isolatedEnvNames = [
  'XDG_CONFIG_HOME',
  'HOME',
  'APPDATA',
  'USERPROFILE',
] as const;
const originalEnv = Object.fromEntries(
  isolatedEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof isolatedEnvNames)[number], string | undefined>;

let configHome: string | undefined;
let cspellLib: typeof import('cspell-lib');

beforeAll(async () => {
  configHome = mkdtempSync(path.join(tmpdir(), 'cspell-lsp-config-'));
  for (const name of isolatedEnvNames) {
    process.env[name] = configHome;
  }
  cspellLib = await import('cspell-lib');
});

afterAll(() => {
  for (const name of isolatedEnvNames) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (configHome) {
    rmSync(configHome, { recursive: true, force: true });
  }
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

function createResolver(
  options: { configPath?: string } = {},
): SettingsResolver {
  const engine = createEngine();
  const registry = {
    getForDocument: () => engine,
    all: () => [engine],
  } as unknown as EngineRegistry;
  return new SettingsResolver(registry, options);
}

function createDocument(root: string): TextDocument {
  return TextDocument.create(
    pathToFileURL(path.join(root, 'fixture.md')).href,
    'markdown',
    1,
    `This is a ${unknownWord} word.`,
  );
}

function writeConfig(root: string, settings: object): void {
  writeFileSync(
    path.join(root, 'cspell.json'),
    JSON.stringify(
      { version: '0.2', language: 'en', enabled: true, ...settings },
      null,
      2,
    ),
  );
}

describe('SettingsResolver with real cspell-lib', () => {
  test('reloads a changed configuration', async () => {
    const root = createTempDir();
    writeConfig(root, {});
    const resolver = createResolver();
    const document = createDocument(root);

    const before = await resolver.getForDocument(document);
    expect(
      (await validateTextDocument(document, before.settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    writeConfig(root, { words: [unknownWord] });
    resolver.clear();
    const after = await resolver.getForDocument(document);

    expect(
      await validateTextDocument(document, after.settings, cspellLib),
    ).toEqual([]);
  });

  test('revalidates after a supported configuration is deleted', async () => {
    const root = createTempDir();
    writeConfig(root, { words: [unknownWord] });
    const resolver = createResolver();
    const document = createDocument(root);

    const before = await resolver.getForDocument(document);
    expect(
      await validateTextDocument(document, before.settings, cspellLib),
    ).toEqual([]);

    rmSync(path.join(root, 'cspell.json'));
    resolver.clear();
    const after = await resolver.getForDocument(document);

    expect(
      (await validateTextDocument(document, after.settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);
  });

  const supportsToml = defaultConfigFilenames.includes('cspell.config.toml');
  const discoveredFormats = [
    {
      file: 'cspell.json',
      content: JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      ),
    },
    {
      file: '.cspell.jsonc',
      content: `// jsonc config\n${JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      )}`,
    },
    {
      file: 'cspell.config.yaml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: '.cspell.yml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: 'package.json',
      content: JSON.stringify(
        {
          name: 'fixture',
          cspell: { version: '0.2', words: [unknownWord] },
        },
        null,
        2,
      ),
    },
    {
      file: 'cspell.config.mjs',
      content: `export default { version: '0.2', words: [${JSON.stringify(
        unknownWord,
      )}] };\n`,
    },
    ...(supportsToml
      ? [
          {
            file: 'cspell.config.toml',
            content: `version = "0.2"\nwords = ["${unknownWord}"]\n`,
          },
        ]
      : []),
  ];

  for (const { file, content } of discoveredFormats) {
    test(`discovers and applies ${file}`, async () => {
      const root = createTempDir();
      writeFileSync(path.join(root, file), content);
      const resolver = createResolver();
      const document = createDocument(root);

      const { settings, engine } = await resolver.getForDocument(document);

      expect(
        await validateTextDocument(document, settings, engine.lib),
      ).toEqual([]);
    });
  }

  const explicitFormats = [
    {
      file: 'explicit.json',
      content: JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      ),
    },
    {
      file: 'explicit.jsonc',
      content: `// jsonc config\n${JSON.stringify(
        { version: '0.2', words: [unknownWord] },
        null,
        2,
      )}`,
    },
    {
      file: 'explicit.yaml',
      content: `version: "0.2"\nwords:\n  - ${unknownWord}\n`,
    },
    {
      file: 'package.json',
      content: JSON.stringify(
        {
          name: 'fixture',
          cspell: { version: '0.2', words: [unknownWord] },
        },
        null,
        2,
      ),
    },
    {
      file: 'explicit.mjs',
      content: `export default { version: '0.2', words: [${JSON.stringify(
        unknownWord,
      )}] };\n`,
    },
    ...(supportsToml
      ? [
          {
            file: 'explicit.toml',
            content: `version = "0.2"\nwords = ["${unknownWord}"]\n`,
          },
        ]
      : []),
  ];

  for (const { file, content } of explicitFormats) {
    test(`uses --config with ${file}`, async () => {
      const root = createTempDir();
      writeConfig(root, {});
      const configPath = path.join(root, file);
      writeFileSync(configPath, content);
      const resolver = createResolver({ configPath });
      const document = createDocument(root);

      const { settings, engine } = await resolver.getForDocument(document);

      expect(
        await validateTextDocument(document, settings, engine.lib),
      ).toEqual([]);
    });
  }

  test('loads and uses a real workspace-local cspell-lib', async () => {
    const root = createTempDir();
    const localPackage = path.join(root, 'node_modules', 'cspell-lib');
    writeConfig(root, {});
    writeRealCSpellLib(localPackage, { marker: 'real-local' });

    const logs: string[] = [];
    const registry = await EngineRegistry.create({
      roots: [root],
      log: (message) => logs.push(message),
    });
    const resolver = new SettingsResolver(registry);
    const document = createDocument(root);
    const { engine, settings } = await resolver.getForDocument(document);

    expect(engine.mode).toBe('auto');
    expect(engine.packagePath).toBe(realpathSync(localPackage));
    expect(engine.fallbackReason).toBeUndefined();
    expect((engine.lib as unknown as { marker?: string }).marker).toBe(
      'real-local',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`path=${engine.packagePath}`);

    expect(
      (await validateTextDocument(document, settings, engine.lib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    writeConfig(root, { words: [unknownWord] });
    resolver.clear();
    const reloaded = await resolver.getForDocument(document);

    expect(
      await validateTextDocument(document, reloaded.settings, engine.lib),
    ).toEqual([]);
  });

  test('refreshes changed custom dictionaries', async () => {
    const root = createTempDir();
    const dictionaryPath = path.join(root, 'words.txt');
    writeFileSync(dictionaryPath, '');
    writeConfig(root, {
      dictionaryDefinitions: [
        { name: 'project', path: './words.txt', addWords: true },
      ],
      dictionaries: ['project'],
    });
    const resolver = createResolver();
    const document = createDocument(root);

    const { settings } = await resolver.getForDocument(document);
    expect(
      (await validateTextDocument(document, settings, cspellLib)).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([`"${unknownWord}": Unknown word.`]);

    appendFileSync(dictionaryPath, `${unknownWord}\n`);
    await resolver.refreshDictionaries();

    expect(await validateTextDocument(document, settings, cspellLib)).toEqual(
      [],
    );
  });

  const canTestReadOnlyFile =
    process.platform !== 'win32' && process.getuid?.() !== 0;

  test.skipIf(!canTestReadOnlyFile)(
    'does not keep a failed word addition in cached settings',
    async () => {
      const root = createTempDir();
      const configPath = path.join(root, 'cspell.json');
      const configWord = `zz${Math.random()
        .toString(36)
        .replace(/[^a-z]/g, '')
        .padEnd(8, 'q')
        .slice(0, 8)}`;
      const missingWord = `zz${Math.random()
        .toString(36)
        .replace(/[^a-z]/g, '')
        .padEnd(8, 'w')
        .slice(0, 8)}`;
      writeConfig(root, { words: [configWord] });

      const engine = createEngine();
      const registry = {
        getForDocument: () => engine,
        all: () => [engine],
      } as unknown as EngineRegistry;
      const resolver = new SettingsResolver(registry);
      const editor = new ConfigEditor({
        engineForDocument: () => engine,
        workspaceRootForDocument: () => root,
      });
      const document = TextDocument.create(
        pathToFileURL(path.join(root, 'fixture.md')).href,
        'markdown',
        1,
        `${configWord} ${missingWord}`,
      );

      const before = await resolver.getForDocument(document);
      expect(
        (await validateTextDocument(document, before.settings, cspellLib)).map(
          (diagnostic) => diagnostic.message,
        ),
      ).toEqual([`"${missingWord}": Unknown word.`]);

      chmodSync(configPath, 0o444);
      try {
        await expect(
          editor.addWord(document.uri, 'words', missingWord),
        ).rejects.toThrow('Could not update');
        expect(
          (JSON.parse(readFileSync(configPath, 'utf8')) as { words: string[] })
            .words,
        ).toEqual([configWord]);

        const after = await resolver.getForDocument(document);
        expect(after.settings.words).toEqual([configWord]);
        expect(
          (await validateTextDocument(document, after.settings, cspellLib)).map(
            (diagnostic) => diagnostic.message,
          ),
        ).toEqual([`"${missingWord}": Unknown word.`]);
      } finally {
        chmodSync(configPath, 0o644);
      }
    },
  );
});
