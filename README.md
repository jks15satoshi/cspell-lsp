# CSpell LSP

A language server that spell-checks source code with [CSpell](https://cspell.org/).

> [!NOTE]
> The upstream [`vlabo/cspell-lsp`](https://github.com/vlabo/cspell-lsp) has been marked as deprecated in favor of [Codebook](https://github.com/blopker/codebook). In practice, however, I have found that Codebook is not yet a drop-in replacement for CSpell, whether in dictionary coverage or in functionality, so I believe this project still warrants continued maintenance.
>
> Because the upstream project has some known issues and depends on a somewhat older version of `cspell-lib`, I have chosen to fork it and maintain it from here on. Given my limited capabilities and time, maintenance of this project will rely heavily on LLM agents.

## Features

- Spell-checks open documents with cspell-lib and your existing cspell configuration.
- Reports unknown and forbidden words as `Information`-severity diagnostics when a document is opened or changed.
- Provides quick fixes to:
  - replace a flagged word with one of cspell's suggestions;
  - add the word to `userWords` in the resolved configuration;
  - add the word to `words` in the resolved configuration;
  - add the word to a writable custom dictionary.
- Revalidates all open documents when a watched configuration file or custom dictionary changes.
- Supports project, global, and explicit (`--config`) cspell configurations.
- Sorts `words` and `userWords` when adding a word if `--sortWords` is enabled.

## Requirements

- Node.js 22.18 or newer.

## Installation

> **Note:** This fork has not been published yet. Installation instructions will be added with the first release. To try the current source, see [Development](#development).

## Configuration

The server searches for a cspell configuration starting from the document's directory. If `--config` is provided, that file is used instead of searching.

Configuration sources are merged in this order, with later sources taking precedence:

1. cspell defaults
2. global cspell configuration
3. `initializationOptions.defaultSettings`
4. project configuration or the file passed with `--config`

The global configuration is read from `cspell.json` in:

| Platform | Path                            |
| -------- | ------------------------------- |
| Linux    | `~/.config/cspell/`             |
| macOS    | `~/Library/Preferences/cspell/` |
| Windows  | `%AppData%\cspell\Config\`      |

### Command-line arguments

| Argument              | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `-c, --config <path>` | Use the given cspell configuration file instead of searching for one. |
| `--sortWords`         | Sort `words` and `userWords` when a word is added.                    |
| `--stdio`             | Use stdio for communication (the default).                            |

## Limitations

- Only the first 1,048,576 characters of a document are checked.
- Configuration edits are limited to `.json` files.

## Editor setup

This server works with any LSP client that can launch `cspell-lsp --stdio`. Editor-specific setup guides for Helix, Neovim, and Zed will be published separately.

<!-- TODO: link to editor setup docs -->

## Development

Building requires [Bun](https://bun.sh/); running the server requires Node.js 22.18 or newer.

```bash
bun install
bun run build
bun run start
```

The build writes the bundled server to `dist/cspell-lsp.js`; `bun run start` runs it with Node.

### Formatting and linting

Formatting and linting use the [Oxc](https://oxc.rs/) toolchain:

```bash
bun run format
bun run format:check
bun run lint
```

The [Oxc extension for Zed](https://zed.dev/extensions/oxc) uses the project-local `oxfmt` and `oxlint` binaries, so install the extension after `bun install`. `.oxfmtrc.json` disables trailing commas for `*.jsonc`; this keeps JSONC configuration files compatible with their JSON schemas while leaving `markdownlint-cli2`'s own parsing unchanged.

## License

This is a fork of [vlabo/cspell-lsp](https://github.com/vlabo/cspell-lsp) based on upstream commit `c7b9a67`, which in turn derives from [cspell](https://github.com/streetsidesoftware/cspell) and [vscode-spell-checker](https://github.com/streetsidesoftware/vscode-spell-checker).

Licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE](./LICENSE) for the full license text and [NOTICE](./NOTICE) for copyright attributions and the modification notice.
