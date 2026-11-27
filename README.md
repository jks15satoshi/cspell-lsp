# CSpell LSP

A language server that spell-checks source code with [CSpell](https://cspell.org/).

## Features

- **Incremental diagnostics:** Uses incremental LSP document synchronization to publish `Information`-severity diagnostics for unknown and forbidden words when a document is opened or changed.
- **Quick-fix code actions:** Offers case-matched CSpell suggestions for flagged words and marks preferred suggestions when available.
- **Word-management commands:** Provides code actions and workspace commands to add words to `userWords` or `words` in the resolved configuration, or to a writable custom dictionary.
- **Automatic revalidation:** Rechecks all open documents when a watched configuration file or custom dictionary changes, and after adding a word.
- **Multi-root workspace support:** Resolves settings per document and supports using a different local CSpell engine in each workspace folder.

## Getting started

### Requirements

- Node.js 22.18 or newer.
- CSpell 8.x or newer when using a workspace-installed engine. The bundled engine does not require a local CSpell installation.

### Installation

> **Note:** This fork has not been published yet. Installation instructions will be added with the first release. To try the current source, see [Build and run](#build-and-run).

### Editor setup

This server works with any LSP client that can launch `cspell-lsp --stdio`.

<!-- TODO: link to editor setup docs -->

## Configuration

### CSpell configuration

The server searches for a CSpell configuration starting from the document's directory. If `--config` is provided, that file is used instead of searching.

Configuration sources are merged in this order, with later sources taking precedence:

1. CSpell defaults
2. global CSpell configuration
3. `initializationOptions.defaultSettings`
4. project configuration or the file passed with `--config`

The global configuration is read from `cspell.json` in:

| Platform | Path                            |
| -------- | ------------------------------- |
| Linux    | `~/.config/cspell/`             |
| macOS    | `~/Library/Preferences/cspell/` |
| Windows  | `%AppData%\cspell\Config\`      |

### Command-line arguments

| Argument              | Description                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `-c, --config <path>` | Use the given CSpell configuration file instead of searching for one.                          |
| `--sortWords`         | Sort `words` and `userWords` when a word is added.                                             |
| `--stdio`             | Use stdio for communication (the default).                                                     |
| `--engine <path>`     | Load the CSpell engine from the given package directory or entry file. Relative paths use cwd. |
| `--engine bundled`    | Ignore workspace packages and use the engine bundled with this server.                         |

### CSpell engine selection

By default, the server resolves the CSpell engine for each workspace folder in this order:

1. the `cspell-lib` that the workspace's installed `cspell` package depends on;
2. a `cspell-lib` installed directly in the workspace;
3. the `cspell-lib` bundled with this server.

Local versions must be 8 or newer and expose the API used by the server. The server falls back to the bundled engine when packages are missing, versions are older than 8, imports fail, or the required API is unavailable. The startup log includes the reason for a fallback.

Package directories are resolved with Node's ESM import conditions, in declaration order. When `exports` is present and not `null`, only `exports` selects the entry point; `module`, `main`, and `index.js` are used only when `exports` is absent or `null`. An active condition mapped to `null` blocks resolution. A `require`-only entry is not selected by that resolution; pass the entry file to `--engine` when it is the only supported entry point.

An invalid path passed to `--engine` is treated as a configuration error. The server stops with a clear message instead of silently falling back to the bundled engine.

The server logs the selected mode, version, and package path once per workspace folder at info level. In a multi-root workspace, each folder can use a different local version.

The installed version is resolved at startup. Restart the server after changing `cspell`, `cspell-lib`, or `node_modules`, or after adding or removing a workspace folder. Yarn PnP is not supported yet; those workspaces use the bundled engine.

## Limitations

- Only the first 1,048,576 characters of a document are checked.
- Configuration edits are limited to `.json` files.
- Workspace `cspell-lib` versions older than 8 are not used.
- Installed engine changes require a restart; `node_modules` is not watched for version changes.
- Yarn PnP workspaces are not supported and use the bundled engine.

## Development

Building requires [Bun](https://bun.sh/); running the server requires Node.js 22.18 or newer.

### Build and run

```bash
bun install
bun run build
bun run start
```

The build writes the bundled server to `dist/cspell-lsp.js`; `bun run start` runs it with Node. The build resolves `cspell-lib` through module resolution, so dependencies hoisted to an ancestor `node_modules` (for example, in a monorepo) are supported.

### Testing and checks

Run the test suite with Bun's test runner:

```bash
bun test
```

Run all project checks:

```bash
bun run check
```

`bun run check` runs type checking, linting, formatting checks, and the test suite.

### Formatting and linting

Formatting and linting use the [Oxc](https://oxc.rs/) toolchain:

```bash
bun run format
bun run format:check
bun run lint
```

## About this fork

The upstream [`vlabo/cspell-lsp`](https://github.com/vlabo/cspell-lsp) has been marked as deprecated in favor of [Codebook](https://github.com/blopker/codebook). In practice, however, I have found that Codebook is not yet a drop-in replacement for CSpell, whether in dictionary coverage or in functionality, so I believe this project still warrants continued maintenance.

Because the upstream project has some known issues and depends on a somewhat older version of `cspell-lib`, I have chosen to fork it and maintain it from here on. Given my limited capabilities and time, maintenance of this project will rely heavily on LLM agents.

## License

Licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE](./LICENSE) for the full license text and [NOTICE](./NOTICE) for copyright attributions and the modification notice.
