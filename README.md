# CSpell LSP

A language server that spell-checks source code with [CSpell](https://cspell.org/).

<!-- markdownlint-disable MD033 -->
<details>
<summary>About This Fork</summary>

Upstream [`vlabo/cspell-lsp`](https://github.com/vlabo/cspell-lsp) is deprecated in favor of [Codebook](https://github.com/blopker/codebook). In practice, Codebook is not yet a drop-in replacement for CSpell in dictionary coverage or features, so a CSpell-based language server remains useful.

I forked the repository to fix known issues, update it to a modern version of `cspell-lib`, and substantially rework the implementation. Given limited time and capacity, ongoing maintenance relies heavily on LLM agents.

</details>
<!-- markdownlint-enable MD033 -->

## Features

- **Incremental diagnostics:** Publishes `Information`-severity diagnostics for unknown and forbidden words as documents are opened and edited.
- **Quick fixes:** Offers case-matched CSpell suggestions and marks preferred replacements when available.
- **Engine-derived configuration:** Uses the selected CSpell engine for configuration discovery, file watching, and safe serialization across supported formats (see [Configuration Format Support](#configuration-format-support)).
- **Word management:** Adds words to `userWords`, `words`, or writable custom dictionaries via code actions and workspace commands.
- **Automatic revalidation:** Rechecks open documents whenever a configuration file or watched custom dictionary changes, and after a word is added.
- **`ignorePaths` support:** Skips files matching `ignorePaths` in the merged configuration and clears diagnostics when an open file becomes ignored.
- **Multi-root workspaces:** Resolves settings per document and supports independent workspace-local CSpell engines per folder.

## Getting Started

### Requirements

- Node.js 22.18 or newer.
- `cspell` or `cspell-lib` 8.x or newer when using a workspace-installed engine (optional; the server includes a bundled engine).

### Installation

The package installs the `cspell-lsp` executable, which communicates over stdio:

```bash
cspell-lsp --stdio
```

#### Global installation

```bash
npm install -g @jks15satoshi/cspell-lsp
```

If `@vlabo/cspell-lsp` is already installed, [uninstall it first](#migrating-from-vlabocspell-lsp) because both packages provide the same `cspell-lsp` binary.

Verify which binary your editor will find on `PATH`:

```bash
command -v cspell-lsp
```

On Windows, run `where.exe cspell-lsp` (`cmd.exe`) or `Get-Command cspell-lsp` (PowerShell); see [PATH notes](#path-notes) if your client launches servers without a shell.

#### Local installation

Install the server as a dev dependency to pin its version per project or avoid a global install:

```bash
npm install --save-dev @jks15satoshi/cspell-lsp
```

Configure your editor to run `./node_modules/.bin/cspell-lsp --stdio`, or invoke the JavaScript entry directly with `node` when your client launches processes without a shell (or on Windows):

```bash
node ./node_modules/@jks15satoshi/cspell-lsp/dist/cspell-lsp.js --stdio
```

Pass an absolute path (or an editor placeholder such as `${workspaceFolder}`) if the client's working directory is not the project root.

#### Migrating from `@vlabo/cspell-lsp`

Both packages install a binary named `cspell-lsp`. Uninstall `@vlabo/cspell-lsp` first so your editor does not continue launching the old server:

```bash
npm uninstall -g @vlabo/cspell-lsp
# Or in a project:
npm uninstall @vlabo/cspell-lsp
```

If you installed `@jks15satoshi/cspell-lsp` first, uninstalling `@vlabo/cspell-lsp` afterward may remove the shared `cspell-lsp` binary—reinstall `@jks15satoshi/cspell-lsp` (or remove any stale binary) if a conflict remains.

#### PATH notes

- **Windows:**
  - `cspell-lsp.cmd` is a `cmd.exe` shim, not a native executable. Use `cspell-lsp` directly only in clients that launch commands through a shell.
  - Bare `where` in PowerShell is an alias for `Where-Object`; run `where.exe cspell-lsp` in `cmd.exe`, `Get-Command cspell-lsp` in PowerShell, or `npm root -g` to locate your install path.
  - For shell-less clients (which also do not expand `%...%` environment variables), run `node` with an explicit path to `dist\cspell-lsp.js`:
    - Global install (default npm prefix): `node C:\Users\<user>\AppData\Roaming\npm\node_modules\@jks15satoshi\cspell-lsp\dist\cspell-lsp.js --stdio`
    - Local install: `node <project-path>\node_modules\@jks15satoshi\cspell-lsp\dist\cspell-lsp.js --stdio`
- **macOS GUI applications:** Apps started from Finder or the Dock typically do not read shell startup files, so Homebrew or Node version managers may be absent from `PATH`. Configure an absolute path (such as `/opt/homebrew/bin/cspell-lsp` or `/usr/local/bin/cspell-lsp`), or configure the editor to inherit your shell environment.
- **Version managers (nvm, fnm, Volta, asdf):** Point the editor at the manager's shim or version-specific binary path, or install the package locally in each project.

### Editor Setup

The sections below cover common LSP clients. Where an editor has a dedicated CSpell integration, it is noted first; the setups here are for users who specifically want this language server.

Examples assume `cspell-lsp` is on `PATH`; replace it with a local or absolute path where needed (see [PATH notes](#path-notes) for Windows and macOS GUI details). Snippets follow each client's current documentation and are not exercised by this repository's test suite.

Because CSpell can spell-check any file type, add the file types or modes you want checked to your client configuration. Examples that specify workspace root markers use `.git`, `cspell.json`, `.cspell.json`, and `package.json`.

<!-- markdownlint-disable MD033 -->
<details>
<summary>Neovim 0.11+</summary>

```lua
vim.lsp.config('cspell_lsp', {
  cmd = { 'cspell-lsp', '--stdio' },
  filetypes = { 'gitcommit', 'markdown', 'text' },
  root_markers = { '.git', 'cspell.json', '.cspell.json', 'package.json' },
})

vim.lsp.enable('cspell_lsp')
```

Add file types such as `lua`, `python`, or `typescript` to `filetypes` as needed.

</details>

<details>
<summary>Neovim 0.10 and older (nvim-lspconfig)</summary>

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.cspell_lsp then
  configs.cspell_lsp = {
    default_config = {
      cmd = { 'cspell-lsp', '--stdio' },
      filetypes = { 'gitcommit', 'markdown', 'text' },
      root_dir = lspconfig.util.root_pattern(
        '.git',
        'cspell.json',
        '.cspell.json',
        'package.json'
      ),
    },
  }
end

lspconfig.cspell_lsp.setup({})
```

The legacy `require('lspconfig')` framework is deprecated on Neovim 0.11 and newer; use the built-in configuration above instead. Because current `nvim-lspconfig` releases require Neovim 0.11.3 or newer, pin a compatible older revision when using this snippet on Neovim 0.10.

</details>

<details>
<summary>Vim</summary>

With [`vim-lsp`](https://github.com/prabirshrestha/vim-lsp), add this to your `vimrc`:

```vim
augroup cspell_lsp
  autocmd!
  autocmd User lsp_setup call lsp#register_server({
    \ 'name': 'cspell-lsp',
    \ 'cmd': {server_info -> [&shell, &shellcmdflag, 'cspell-lsp --stdio']},
    \ 'allowlist': ['gitcommit', 'markdown', 'text'],
    \ 'root_uri': {server_info -> lsp#utils#path_to_uri(
    \   lsp#utils#find_nearest_parent_file_directory(
    \     lsp#utils#get_buffer_path(),
    \     ['.git/', 'cspell.json', '.cspell.json', 'package.json']))},
    \ })
augroup END
```

With [`coc.nvim`](https://github.com/neoclide/coc.nvim), add this to `coc-settings.json` (open it with `:CocConfig`):

```json
{
  "languageserver": {
    "cspell": {
      "command": "cspell-lsp",
      "args": ["--stdio"],
      "filetypes": ["gitcommit", "markdown", "text"],
      "rootPatterns": [".git", "cspell.json", ".cspell.json", "package.json"]
    }
  }
}
```

</details>

<details>
<summary>Helix</summary>

Add the server and the languages that should use it to `languages.toml`:

```toml
[language-server.cspell-lsp]
command = "cspell-lsp"
args = ["--stdio"]

[[language]]
name = "markdown"
language-servers = ["cspell-lsp"]

[[language]]
name = "git-commit"
language-servers = ["cspell-lsp"]
```

Helix replaces a language's built-in `language-servers` list when you specify one, so include any other servers you want to keep. Default server lists vary by Helix version; run `hx --health markdown` (or `hx --health` for all languages) to inspect the active configuration before overriding a language entry.

</details>

<details>
<summary>Emacs</summary>

With **Eglot**, add the modes you want checked to `eglot-server-programs`:

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((git-commit-mode markdown-mode text-mode)
                 . ("cspell-lsp" "--stdio"))))
```

`git-commit-mode` comes from Magit and `markdown-mode` is a separate package; omit either mode if it is not installed.

With **lsp-mode**, register an add-on client so CSpell runs alongside each language's primary server:

```elisp
(with-eval-after-load 'lsp-mode
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection '("cspell-lsp" "--stdio"))
    :activation-fn (lsp-activate-on "git-commit" "markdown" "plaintext")
    :server-id 'cspell-lsp
    :add-on? t)))
```

</details>

<details>
<summary>Sublime Text</summary>

For most users, the preferred option is [LSP-cspell](https://packages.sublimetext.io/packages/LSP-cspell), installed alongside [LSP](https://lsp.sublimetext.io/) via Package Control.

To use this server instead, install [LSP](https://lsp.sublimetext.io/), open **Preferences > Package Settings > LSP > Server Configurations** (`Packages/User/LanguageServers.sublime-settings`), and add:

```json
{
  "cspell-lsp": {
    "enabled": true,
    "command": ["cspell-lsp", "--stdio"],
    "selector": "source | text"
  }
}
```

Narrow `selector` to the syntaxes you want checked.

</details>

<details>
<summary>Kate</summary>

Enable the built-in **LSP Client** plugin, then open **Settings > Configure Kate > LSP Client > User Server Settings** and add:

```json
{
  "servers": {
    "markdown": {
      "highlightingModeRegex": "^Markdown$",
      "servers": {
        "cspell-lsp": {
          "command": ["cspell-lsp", "--stdio"],
          "rootIndicationFileNames": [
            ".git",
            "cspell.json",
            ".cspell.json",
            "package.json"
          ],
          "url": "https://github.com/jks15satoshi/cspell-lsp"
        }
      }
    }
  }
}
```

This attaches `cspell-lsp` to Kate's Markdown mode. Copy the `cspell-lsp` block into other language entries—or add a new top-level entry with a matching `highlightingModeRegex`—to check additional file types. Kate merges your user file with its defaults; set `"disabled": true` on any server entry you want to disable.

</details>

<details>
<summary>VS Code, VSCodium, Cursor, and Windsurf</summary>

For most users in VS Code-family editors, the preferred option is [Code Spell Checker](https://marketplace.visualstudio.com/items?itemName=streetsidesoftware.code-spell-checker) (`streetsidesoftware.code-spell-checker`), also published on [Open VSX](https://open-vsx.org/extension/streetsidesoftware/code-spell-checker).

Use this server instead only if you want a standalone LSP setup or identical CSpell LSP behavior across editors. There is no official extension; connect it via [Simple LSP Client](https://marketplace.visualstudio.com/items?itemName=wdomitrz.simple-lsp-client) (`wdomitrz.simple-lsp-client`, also on [Open VSX](https://open-vsx.org/extension/wdomitrz/simple-lsp-client)) by adding this to your user or workspace settings:

```json
{
  "simpleLspClient.servers": {
    "cspell": {
      "cmd": ["cspell-lsp", "--stdio"],
      "filetypes": ["git-commit", "markdown", "plaintext"]
    }
  }
}
```

Add other VS Code language IDs (such as `typescript`, `javascript`, `python`, or `json`) to `filetypes` to check additional file types. Because Simple LSP Client spawns processes without a shell, Windows users need the `node` form pointing to `dist/cspell-lsp.js` (see [PATH notes](#path-notes)): e.g. `["node", "${userHome}/AppData/Roaming/npm/node_modules/@jks15satoshi/cspell-lsp/dist/cspell-lsp.js", "--stdio"]` for a default global install, or `["node", "${workspaceFolder}/node_modules/@jks15satoshi/cspell-lsp/dist/cspell-lsp.js", "--stdio"]` for a local install. Reload the window after changing settings.

</details>

<details>
<summary>JetBrains IDEs</summary>

For most users, the preferred option is the dedicated [CSpell Check](https://plugins.jetbrains.com/plugin/20676-cspell-check) plugin, which parses the project's CSpell configuration and syncs custom vocabularies into the IDE dictionary.

To use this server instead, install [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij), open **Settings > Languages & Frameworks > Language Servers (LSP4IJ)**, and click **+**:

1. On the **Server** tab, set the name to `CSpell` and the command to `cspell-lsp --stdio`.
2. On the **Mappings** tab, add the file types or file name patterns you want checked, such as Markdown and plain text.
3. Apply the settings. Use the LSP console to inspect the server log if it does not start.

</details>

<details>
<summary>Zed</summary>

Install the [jks15satoshi/zed-cspell](https://github.com/jks15satoshi/zed-cspell) fork as a dev extension; its `main` branch uses `@jks15satoshi/cspell-lsp`.

Prerequisites: [Rust](https://rustup.rs/) installed via `rustup` (Zed compiles dev extensions with Rust) and Node.js 22.18 or newer (for the extension to install and run the server).

Clone the repository:

```bash
git clone https://github.com/jks15satoshi/zed-cspell
```

Then run `zed: install dev extension` and select the clone. The extension installs the server package automatically; restart it with `editor: restart language server` after changing configuration.

The upstream `mantou132/zed-cspell` extension is a separate project and does not switch to this fork automatically.

</details>

<details>
<summary>Other clients</summary>

Register a stdio language server with:

- **Command:** `cspell-lsp`
- **Arguments:** `--stdio`
- **Root markers:** `.git`, `cspell.json`, `.cspell.json`, `package.json`
- **Filetypes:** the languages you want checked

Clients such as Eclipse/LSP4E, Lapce, or Nova require their own generic server registration or an extension bridge; this repository does not ship one.

</details>
<!-- markdownlint-enable MD033 -->

## Configuration

### CSpell Configuration

The server searches for a CSpell configuration starting from the document's directory. If `--config` is passed, that file is used instead of searching. Accepted file names and formats come from the selected engine's `defaultConfigFilenames` (see [Configuration Format Support](#configuration-format-support)).

Configuration sources are merged in this order, with later sources taking precedence:

1. CSpell defaults
2. Global CSpell configuration
3. `initializationOptions.defaultSettings`
4. Project configuration or the file passed with `--config`

Clients can pass fallback CSpell settings through `initializationOptions.defaultSettings` during LSP initialization; `workspace/didChangeConfiguration` is not used for settings.

Files matching `ignorePaths` are skipped:

- **Config-file patterns:** Resolved relative to the configuration file's `globRoot` or directory.
- **Imported configs:** Patterns declared by imported configurations are resolved relative to the imported file's `globRoot` or directory.
- **`initializationOptions.defaultSettings`:** String patterns use its `globRoot` when set, or fall back to the matching workspace folder (or `cwd` for files outside any workspace).
- **Object patterns:** Use their own `root` when provided, or fall back to the matching workspace folder (or `cwd`).
- **Negative patterns:** Patterns starting with `!` (such as `!dist/keep/**`) are ignored, matching CSpell CLI behavior so they cannot re-include paths covered by an earlier ignore pattern.
- **Windows UNC paths:** Patterns rooted at a UNC path apply only to documents on the same server; patterns beginning with `**` apply regardless of server.

The global configuration is read from `cspell.json` in:

| Platform | Path                            |
| -------- | ------------------------------- |
| Linux    | `~/.config/cspell/`             |
| macOS    | `~/Library/Preferences/cspell/` |
| Windows  | `%AppData%\cspell\Config\`      |

### Configuration Format Support

The selected engine's `defaultConfigFilenames` determines which files are discovered and watched. The table below describes the bundled engine (currently `cspell-lib` 10.x); a workspace engine may support a different set.

| Format                                                               | Editing                               | Behavior and limitations                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON / JSONC (`cspell.json`, `.cspell.json`, `cspell.jsonc`, ...)    | Yes                                   | Preserves JSONC comments and unrelated keys; whitespace and formatting may be normalized.                                                                              |
| YAML / YML (`cspell.yaml`, `.cspell.yml`, `cspell.config.yaml`, ...) | Yes                                   | Comment preservation depends on the selected engine's writer (bundled `cspell-lib` 10 preserves comments; `cspell-lib` 8 does not). Formatting may be normalized.      |
| `package.json` with a `cspell` object                                | Yes                                   | Discovered only when a `cspell` object already exists. Updates `cspell.words` and `cspell.userWords` while preserving other fields; JSON formatting may be normalized. |
| TOML (`cspell.config.toml`, `.cspell.config.toml`)                   | When supported by the selected engine | Comments and formatting are rewritten and number representations may be normalized, while CSpell setting values are preserved.                                         |
| Executable JS/TS (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`)      | No                                    | Read-only; diagnostics still work.                                                                                                                                     |
| Other formats                                                        | Only with a safe writer               | Read-only unless the selected engine provides a safe writer.                                                                                                           |

Editing and discovery behavior:

- Malformed, read-only, remote, and virtual configuration files are never written. Config-edit actions are hidden when a file cannot be edited safely; invoking the workspace command directly returns an error.
- Edits are not byte-for-byte: serializers may normalize whitespace and formatting, although original line endings (`LF` / `CRLF`) are restored.
- A YAML `words` or `userWords` value that is an alias is materialized into a concrete list when that setting is edited, leaving the anchored list unchanged; any comment attached to the alias itself is not preserved.
- Configuration edits are serialized per resolved file path within a server process so concurrent add-word requests do not overwrite each other (including across symlink aliases). External processes are not locked.
- When adding a word to `words` or `userWords` and no project configuration exists (with `--config` unset), the server creates `cspell.json` at the workspace root, seeded with any settings from `initializationOptions.defaultSettings`.
- An explicit `--config` file must already exist and be readable; missing, unreadable, or malformed files fail with an error instead of silently falling back to default settings.

### Word Management

Code actions add unknown or forbidden words through three workspace commands:

- `AddToUserWordsConfig`: adds the word to `userWords` in the resolved CSpell configuration.
- `AddToWorkspaceWordsConfig`: adds the word to `words` in the resolved CSpell configuration.
- `AddToCustomDictionary`: appends the word to an enabled writable custom dictionary.

A custom dictionary is offered as writable when its entry in `dictionaryDefinitions` specifies both `path` and `addWords: true`, and its `name` is active in `dictionaries` (not negated with `!name`). `AddToCustomDictionary` appends `<word>\n` directly to the dictionary file—assuming LF line endings with a trailing newline—then refreshes the dictionary cache and revalidates open documents.

### File Watching

- The server watches configuration files listed in each workspace engine's `defaultConfigFilenames`, an explicit `--config` file, the global `cspell.json` (when its directory exists), and writable custom dictionaries discovered in resolved document settings.
- When `package.json` is included in `defaultConfigFilenames`, it is part of the workspace watcher patterns. Clients that support file-watcher exclusions should exclude `node_modules`.
- Clients that do not advertise `relativePatternSupport` receive absolute string watcher globs with literal path segments escaped for glob syntax.

### Command-Line Arguments

| Argument              | Description                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stdio`             | Use stdio for LSP communication (required).                                                                                                    |
| `-c, --config <path>` | Use the given CSpell configuration file instead of searching. Relative paths resolve from `cwd`. Watched and editable according to its format. |
| `--sortWords`         | Sort `words` and `userWords` alphabetically (case-insensitive) when adding a word.                                                             |
| `--engine <path>`     | Load the CSpell engine from the given package directory, `package.json`, or entry file. Relative paths resolve from `cwd`.                     |
| `--engine bundled`    | Ignore workspace packages and use the engine bundled with this server.                                                                         |

### CSpell Engine Selection

By default, the server resolves the CSpell engine for each workspace folder in this order:

1. The `cspell-lib` dependency of the workspace's installed `cspell` package.
2. A `cspell-lib` package installed directly in the workspace.
3. The `cspell-lib` bundled with this server.

Local `cspell-lib` packages must be version 8 or newer and expose the API required by the server. The server falls back to the bundled engine when packages are missing, older than version 8, fail to import, or lack required exports. For each workspace folder, the startup log records the selected mode, version, package path, and any fallback reason.

Package directories are resolved using Node's ESM `exports` conditions in declaration order. When `exports` is present and not `null`, it is the sole entry-point selector; `module`, `main`, and `index.js` are consulted only when `exports` is absent or `null`. A condition mapped to `null` blocks resolution, and `require`-only entries are not selected—pass the entry file path directly to `--engine` when it is the only supported entry point.

An invalid path passed to `--engine` is a configuration error: the server exits with an error message rather than falling back to the bundled engine.

Engines are resolved at startup. Restart the server after modifying `cspell`, `cspell-lib`, or `node_modules`, or after adding or removing a workspace folder. Yarn PnP is not supported yet; those workspaces use the bundled engine.

## Limitations

- **Document size limit:** Only the first 1,048,576 characters (1 MiB) of each document are checked.
- **Configuration editing:** Editing is limited by format and engine capabilities; executable JS/TS configurations are read-only (see [Configuration Format Support](#configuration-format-support)).
- **Engine resolution:** Workspace `cspell-lib` 7.x and earlier and Yarn PnP workspaces fall back to the bundled engine, and `node_modules` is not watched, so installed engine changes require restarting the server (see [CSpell Engine Selection](#cspell-engine-selection)).

## Development

Building requires [Bun](https://bun.sh/); running the built server requires Node.js 22.18 or newer.

### Build and Run

```bash
bun install
bun run build
bun run start -- --stdio
```

The build writes the server entry to `dist/cspell-lsp.js`; `bun run start -- --stdio` runs it with Node over stdio (`--stdio` is required). Runtime dependencies stay external and are installed by `bun install` locally or by `npm` when published, so third-party sources are not embedded in `dist`. The build resolves `cspell-lib` through module resolution, supporting dependencies hoisted to an ancestor `node_modules` (such as in a monorepo).

### Checks, Formatting, and Linting

Formatting and linting use the [Oxc](https://oxc.rs/) toolchain (`oxlint` and `oxfmt`). Run all checks together:

```bash
bun run check
```

Individual commands:

```bash
bun test              # Run the Bun test suite
bun run typecheck     # Type-check with TypeScript (tsc --noEmit)
bun run lint          # Lint with oxlint
bun run lint:fix      # Auto-fix lint issues with oxlint
bun run format        # Format files with oxfmt
bun run format:check  # Check formatting with oxfmt
```

## License

Licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE](./LICENSE) for the full license text and [NOTICE](./NOTICE) for copyright attributions and the modification notice.
