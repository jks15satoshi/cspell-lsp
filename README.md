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

The package installs the `cspell-lsp` executable. Clients that launch the executable use the same stdio command:

```bash
cspell-lsp --stdio
```

#### Global installation

```bash
npm install -g @jks15satoshi/cspell-lsp
```

This puts `cspell-lsp` on your `PATH`. Check which binary your editor will find:

```bash
command -v cspell-lsp
```

On Windows, use `where cspell-lsp`; it finds `cspell-lsp.cmd`, which runs from `cmd.exe` or PowerShell.

#### Local installation

Install the server in the project when you want to pin its version or avoid a global install:

```bash
npm install --save-dev @jks15satoshi/cspell-lsp
./node_modules/.bin/cspell-lsp --stdio
```

For editors that launch processes without a shell, run the JavaScript entry with Node instead of the `.cmd` shim:

```bash
node ./node_modules/@jks15satoshi/cspell-lsp/dist/cspell-lsp.js --stdio
```

Use an absolute path after `node` when the editor's working directory is not the project. On Windows, `node_modules\.bin\cspell-lsp.cmd` works only from a shell.

#### Migrating from `@vlabo/cspell-lsp`

Both packages install a binary named `cspell-lsp`. Uninstall the old package first so the editor cannot keep launching the old server:

```bash
npm uninstall -g @vlabo/cspell-lsp
# In a project:
npm uninstall @vlabo/cspell-lsp
```

If both were installed at different times, remove the stale binary or reinstall this package after uninstalling the old one.

#### PATH notes

- **Windows:** `cspell-lsp.cmd` is a `cmd.exe` shim, not a native executable. Use it only from a shell. For a shell-less client, run `node` with the package entry, for example `node %AppData%\npm\node_modules\@jks15satoshi\cspell-lsp\dist\cspell-lsp.js --stdio` for a global install, or `node node_modules\@jks15satoshi\cspell-lsp\dist\cspell-lsp.js --stdio` for a local install.
- **macOS GUI applications:** applications started from Finder or the Dock usually do not read shell startup files, so they may not see Homebrew or a Node version manager on `PATH`. Use an absolute path such as `/opt/homebrew/bin/cspell-lsp` or `/usr/local/bin/cspell-lsp`, or configure the editor to inherit your shell environment.
- **Version managers (nvm, fnm, Volta, asdf):** use the shim or tool-specific install path, or point the editor at an absolute path. Installing this package locally in each project is another option.

### Editor Setup

The sections below cover the common LSP clients. Where a dedicated, widely used CSpell integration exists, it is listed first; the LSP setup shown here is the alternative for users who specifically want this server. The examples assume `cspell-lsp` is on `PATH`. Replace that first command argument with a local or absolute path when needed. They follow each client's current documentation; the editor integrations are not exercised by this repository's tests. CSpell can check any filetype, so add the filetypes you want checked. Most clients use `.git`, `cspell.json`, `.cspell.json`, and `package.json` as workspace root markers.

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

Add filetypes such as `lua`, `python`, or `typescript` to the list if you want CSpell to check them.

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

The `require('lspconfig')` framework is deprecated on Neovim 0.11 and newer; use the built-in configuration above on those versions. Current nvim-lspconfig releases require Neovim 0.11.3 or newer, so pin an older compatible nvim-lspconfig revision when using this legacy example on Neovim 0.10.

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

Helix replaces a language's built-in `language-servers` list when you specify one, so include other servers you want to keep. Default server lists vary by Helix version; run `hx --health markdown` (or `hx --health` for all languages) to see the active configuration before overriding the language entry.

</details>

<details>
<summary>Emacs</summary>

With Eglot, add the modes you want checked to `eglot-server-programs`:

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((git-commit-mode markdown-mode text-mode)
                 . ("cspell-lsp" "--stdio"))))
```

`git-commit-mode` comes from Magit and `markdown-mode` is a separate package; omit either mode if it is not installed.

With lsp-mode, register an add-on client so CSpell runs alongside the language's main server:

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

For most users, the preferred option is [LSP-cspell](https://packages.sublimetext.io/packages/LSP-cspell), which is installed alongside [LSP](https://lsp.sublimetext.io/) through Package Control. It provides the dedicated CSpell integration for Sublime Text.

To use this server directly instead, install LSP, then open **Preferences > Package Settings > LSP > Server Configurations** and add:

```json
{
  "cspell-lsp": {
    "enabled": true,
    "command": ["cspell-lsp", "--stdio"],
    "selector": "source | text"
  }
}
```

Narrow `selector` to the syntaxes you want checked. The file is `Packages/User/LanguageServers.sublime-settings`.

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

This adds CSpell to Kate's Markdown language entry. Add the same server block to other language entries, or define another top-level entry with an appropriate `highlightingModeRegex`, to check more filetypes. Kate merges the user file with its defaults; set `"disabled": true` on a server entry you do not want.

</details>

<details>
<summary>VS Code, VSCodium, Cursor, and Windsurf</summary>

For most users in VS Code-family editors, the preferred option is [Code Spell Checker](https://marketplace.visualstudio.com/items?itemName=streetsidesoftware.code-spell-checker) (`streetsidesoftware.code-spell-checker`), the most integrated spelling extension for these editors. It is also published on [Open VSX](https://open-vsx.org/extension/streetsidesoftware/code-spell-checker).

This language server is an alternative for users who specifically want this server, shared CSpell configuration, or the same LSP across editors. There is no official extension for it; connect it through the generic [Simple LSP Client](https://marketplace.visualstudio.com/items?itemName=wdomitrz.simple-lsp-client) extension (`wdomitrz.simple-lsp-client`), which is also published on [Open VSX](https://open-vsx.org/extension/wdomitrz/simple-lsp-client), then add this to your user or workspace settings:

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

Add VS Code language IDs such as `typescript`, `javascript`, `python`, or `json` to `filetypes` for other filetypes. For a project-local install, set `cmd` to `["node", "${workspaceFolder}/node_modules/@jks15satoshi/cspell-lsp/dist/cspell-lsp.js", "--stdio"]`; keep `cspell-lsp.cmd` only for clients that launch through a shell. Reload the window after changing the setting.

</details>

<details>
<summary>JetBrains IDEs</summary>

For most users, the preferred option is the mainstream [CSpell Check](https://plugins.jetbrains.com/plugin/20676-cspell-check) plugin. It parses the project's CSpell configuration and syncs custom vocabularies into the IDE dictionary.

This language server is an alternative for users who want its diagnostics and quick fixes. Install the [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij) plugin, then open **Settings > Languages & Frameworks > Language Servers (LSP4IJ)** and click **+**:

1. On the **Server** tab, set the name to `CSpell` and the command to `cspell-lsp --stdio`.
2. On the **Mappings** tab, add the file types or file name patterns you want checked, for example Markdown and plain text.
3. Apply the settings. Use the LSP console to inspect the server log if it does not start.

</details>

<details>
<summary>Zed</summary>

Use the [jks15satoshi/zed-cspell](https://github.com/jks15satoshi/zed-cspell) fork as a dev extension. Clone the fork and check out the version that targets `@jks15satoshi/cspell-lsp`:

```bash
git clone https://github.com/jks15satoshi/zed-cspell
```

Then run `zed: install dev extension` and select the clone. The extension obtains the server package itself; restart it with `editor: restart language server` after changing configuration.

The upstream `mantou132/zed-cspell` extension is a separate project and is not automatically switched to this fork.

</details>

<details>
<summary>Other clients</summary>

Register a stdio language server with:

- **Command:** `cspell-lsp`
- **Arguments:** `--stdio`
- **Root markers:** `.git`, `cspell.json`, `.cspell.json`, `package.json`
- **Filetypes:** the languages you want checked

Clients such as Eclipse/LSP4E, Lapce, or Nova need their own generic server registration or an extension bridge; this repository does not ship a bridge for them.

</details>
<!-- markdownlint-enable MD033 -->

## Configuration

### CSpell Configuration

The server searches for a CSpell configuration starting from the document's directory. If `--config` is provided, that file is used instead of searching. The accepted file names and formats come from the selected engine's `defaultConfigFilenames`; see [Configuration Format Support](#configuration-format-support).

Configuration sources are merged in this order, with later sources taking precedence:

1. CSpell defaults
2. global CSpell configuration
3. `initializationOptions.defaultSettings`
4. project configuration or the file passed with `--config`

Files matching `ignorePaths` are not checked. Patterns from a configuration file are resolved relative to that file's `globRoot` or directory, including patterns declared by imported configurations. String patterns from `initializationOptions.defaultSettings` use its `globRoot` when set. Object patterns keep their own `root`; without one, they use the matching workspace folder. On Windows, a pattern rooted at a UNC path applies only to documents on the same server; patterns beginning with `**` are not tied to a server.

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
- An explicit `--config` file must already exist and be readable; missing,
  unreadable, or malformed files fail validation with an error instead of
  silently falling back to default settings.
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

The build writes the server entry to `dist/cspell-lsp.js`; `bun run start` runs it with Node. Runtime packages stay external and are installed by npm, so the package does not embed third-party sources in `dist`. The build resolves `cspell-lib` through module resolution, so dependencies hoisted to an ancestor `node_modules` (for example, in a monorepo) are supported.

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
