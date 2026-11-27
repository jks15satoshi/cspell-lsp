# CSpell LSP

A language server that spell-checks source code with [CSpell](https://cspell.org/).

<!-- markdownlint-disable MD033 -->
<details>
<summary>About This Fork</summary>

The upstream [`vlabo/cspell-lsp`](https://github.com/vlabo/cspell-lsp) has been marked as deprecated in favor of [Codebook](https://github.com/blopker/codebook). In practice, however, I have found that Codebook is not yet a drop-in replacement for CSpell, whether in dictionary coverage or in functionality, so I believe this project still warrants continued maintenance.

Because the upstream project has some known issues and depends on a somewhat older version of cspell-lib, I have chosen to fork it and continue maintaining it here (and, in some ways, almost re-implement it). Given my limited capabilities and time, maintenance of this project will rely heavily on LLM agents.

</details>
<!-- markdownlint-enable MD033 -->

## Features

- **Incremental diagnostics:** Publishes `Information`-severity diagnostics for unknown and forbidden words as documents are opened and changed.
- **Quick fixes:** Offers case-matched CSpell suggestions and marks preferred suggestions when available.
- **Engine-derived configuration:** Uses the selected CSpell engine's file names for discovery and watching, with editing support for formats that have a safe writer.
- **Word management:** Adds words to `userWords`, `words`, or a writable custom dictionary through code actions and workspace commands. Supports JSON, JSONC, YAML/YML, TOML (when supported), and `package.json` configurations.
- **Automatic revalidation:** Rechecks open documents when a configuration or custom dictionary changes, and after adding a word.
- **`ignorePaths` support:** Skips files matched by `ignorePaths` from the merged configuration and clears diagnostics when an open file becomes ignored.
- **Multi-root workspaces:** Resolves settings per document and supports a different workspace-local CSpell engine in each folder.

## Getting Started

### Requirements

- Node.js 22.18 or newer.
- CSpell 8.x or newer when using a workspace-installed engine. The bundled engine does not require a local CSpell installation.

### Installation

> **Note:** This fork has not been published yet. Installation instructions will be added with the first release. To try the current source, see [Build and Run](#build-and-run).

### Editor Setup

This server works with any LSP client that can launch `cspell-lsp --stdio`.

<!-- TODO: link to editor setup docs -->

## Configuration

### CSpell Configuration

The server searches for a CSpell configuration starting from the document's directory. If `--config` is provided, that file is used instead of searching. The accepted file names and formats come from the selected engine's `defaultConfigFilenames`; see [Configuration Format Support](#configuration-format-support).

Configuration sources are merged in this order, with later sources taking precedence:

1. CSpell defaults
2. global CSpell configuration
3. `initializationOptions.defaultSettings`
4. project configuration or the file passed with `--config`

Files matching `ignorePaths` are not checked. Patterns from a configuration file are resolved relative to that file's `globRoot` or directory, including patterns declared by imported configurations.

The global configuration is read from `cspell.json` in:

| Platform | Path                            |
| -------- | ------------------------------- |
| Linux    | `~/.config/cspell/`             |
| macOS    | `~/Library/Preferences/cspell/` |
| Windows  | `%AppData%\cspell\Config\`      |

### Configuration Format Support

The selected engine's `defaultConfigFilenames` determines which files are
discovered and watched. The table below describes the bundled engine
(currently cspell-lib 10.x); a workspace engine may support a different set.

| Format                                                               | Editing                               | Behavior and limitations                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON / JSONC (`cspell.json`, `.cspell.json`, `cspell.jsonc`, ...)    | Yes                                   | JSONC comments and unrelated keys are preserved; whitespace and formatting may be normalized.                                                                      |
| YAML / YML (`cspell.yaml`, `.cspell.yml`, `cspell.config.yaml`, ...) | Yes                                   | Comment preservation depends on the selected engine's writer: bundled cspell-lib 10 preserves comments, while cspell-lib 8 does not. Formatting may be normalized. |
| `package.json` with a `cspell` object                                | Yes                                   | Discovered only when the `cspell` object exists. Writes only `cspell.words` and `cspell.userWords`; JSON whitespace may be normalized.                             |
| TOML (`cspell.config.toml`, `.cspell.config.toml`)                   | When supported by the selected engine | Comments and formatting are rewritten. Number representations may be normalized, but CSpell setting values are preserved.                                          |
| Executable JS/TS (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`)      | No                                    | Read-only; diagnostics still work.                                                                                                                                 |
| Other formats                                                        | Only with a safe writer               | Read-only when the selected engine has no safe writer.                                                                                                             |

Notes:

- Malformed, read-only, remote, and virtual configuration files are never
  written. Config-edit actions are hidden when a file cannot be edited safely;
  direct invocation returns an error.
- Edits are not byte-for-byte: serializers may normalize whitespace and
  formatting, although existing line endings are restored.
- A YAML `words` or `userWords` value that is an alias is materialized into a
  concrete list when that setting is edited; the anchored list is left
  unchanged. A comment attached to the alias itself is not preserved.
- Configuration edits are serialized per resolved file path within one server
  process, so concurrent add-word requests do not overwrite each other, even
  when the same directory is opened through a symlink alias. External
  processes are not locked.
- Clients that do not advertise relative-pattern support receive absolute
  string watcher globs for configuration and dictionary files. Literal path
  segments in those globs are escaped for glob syntax.
- When no project config exists and `--config` is not set, the server creates
  `cspell.json` at the workspace root.
- An explicit `--config` file must already exist; the server does not guess a
  format for a missing file.
- The watcher list includes `package.json` under every workspace folder when
  the selected engine lists it. Clients that support file-watcher exclusions
  should exclude `node_modules`.

### Command-Line Arguments

| Argument              | Description                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>` | Use the given CSpell configuration file instead of searching for one. The file is watched and editable according to its format. |
| `--sortWords`         | Sort `words` and `userWords` when a word is added.                                                                              |
| `--stdio`             | Use stdio for communication (the default).                                                                                      |
| `--engine <path>`     | Load the CSpell engine from the given package directory or entry file. Relative paths use cwd.                                  |
| `--engine bundled`    | Ignore workspace packages and use the engine bundled with this server.                                                          |

### CSpell Engine Selection

By default, the server resolves the CSpell engine for each workspace folder in this order:

1. the `cspell-lib` that the workspace's installed `cspell` package depends on;
2. a `cspell-lib` installed directly in the workspace;
3. the `cspell-lib` bundled with this server.

Local versions must be 8 or newer and expose the API used by the server. The server falls back to the bundled engine when packages are missing, versions are older than 8, imports fail, or the required API is unavailable. For each workspace folder, the startup log records any fallback reason and the selected mode, version, and package path.

Package directories use Node's ESM `exports` conditions in declaration order. When `exports` is present and not `null`, it is the only entry-point selector; `module`, `main`, and `index.js` are used only when `exports` is absent or `null`. A condition mapped to `null` blocks resolution. A `require`-only entry is not selected; pass the entry file to `--engine` when it is the only supported entry point.

An invalid path passed to `--engine` is a configuration error. The server stops with a clear message instead of silently falling back to the bundled engine.

Engines are resolved at startup. Restart the server after changing `cspell`, `cspell-lib`, or `node_modules`, or after adding or removing a workspace folder. Yarn PnP is not supported yet; those workspaces use the bundled engine.

## Limitations

- Only the first 1,048,576 characters of a document are checked.
- Configuration editing is limited by format and engine capabilities; see [Configuration Format Support](#configuration-format-support).
- Workspace cspell-lib 7.x and earlier are not supported; the server uses the bundled engine instead.
- Installed engine changes require to restart LSP; `node_modules` is not watched for version changes.
- Yarn PnP workspaces are not supported and use the bundled engine.

## Development

Building requires [Bun](https://bun.sh/); running the server requires Node.js 22.18 or newer.

### Build and Run

```bash
bun install
bun run build
bun run start
```

The build writes the bundled server to `dist/cspell-lsp.js`; `bun run start` runs it with Node. The build resolves `cspell-lib` through module resolution, so dependencies hoisted to an ancestor `node_modules` (for example, in a monorepo) are supported.

### Testing and Checks

Run the test suite with Bun's test runner:

```bash
bun test
```

Run all project checks:

```bash
bun run check
```

`bun run check` runs type checking, linting, formatting checks, and the test suite.

### Formatting and Linting

Formatting and linting use the [Oxc](https://oxc.rs/) toolchain:

```bash
bun run format
bun run format:check
bun run lint
```

## License

Licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE](./LICENSE) for the full license text and [NOTICE](./NOTICE) for copyright attributions and the modification notice.
