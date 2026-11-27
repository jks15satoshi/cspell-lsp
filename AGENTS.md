# AGENTS.md

This file records only conventions that tooling cannot enforce. Do not restate rules already guaranteed by configuration or scripts (formatting, linting, types, line endings, ignore patterns); features and usage live in `README.md`.

## Working practices

- Read the relevant code and configuration before changing anything. Verify uncertain APIs against type definitions or upstream docs; never invent them.
- Make the smallest change that satisfies the task. Do not refactor unrelated code or touch unrelated files.
- Fix root causes rather than symptoms. If only a workaround is possible, say so explicitly and note the follow-up.
- Do not commit, create branches, or rewrite history unless explicitly asked.

## Toolchain

- Install dependencies, build, and run through Bun; do not introduce another package manager's workflow.
- Run `bun run check` before handing off and report the actual result. Never claim a check passed without running it.
- Use only the Oxc toolchain for formatting and static checks; do not add Prettier or a separate ESLint setup. ESLint-format plugins loaded by oxlint's `jsPlugins` are allowed.

## Code

- Keep the `.js` suffix on relative imports, and use `import type` for type-only imports.
- Comments should explain intent, constraints, or tradeoffs, not restate code. Add JSDoc to public exports and non-obvious branches.
- When ignoring an error intentionally, state why; never swallow unknown errors silently.
- Keep responsibilities separate: do not pile validation or suggestion-generation logic into the entry module.
- Follow the existing naming style and stay consistent within the same file.

## Configuration and scripts

- Confirm that existing dependencies cannot satisfy the need before adding a new one; update lockfiles and required type packages when you do.
- Keep the `files` field in sync when published content changes, so nothing is missing or shipped by accident.
- Do not loosen global Oxc options or widen ignore patterns; declare exceptions for specific files only.

## Documentation

- Write `README.md` and code comments in English.
- Mark deprecated APIs with `@deprecated` plus the replacement.
- Commands, arguments, and behavior in the docs must match reality; update `README.md` when behavior changes.
- When cspell flags a new proper noun, add it to `words` in `.cspell.json`; do not disable dictionaries or checks.

## Testing

- Treat `bun run check` as the source of truth. Do not present a test suite that does not exist as a quality guarantee.
- When adding tests, provide a runnable script and make sure it passes reliably; never leave a permanently failing script.
- Test observable behavior and LSP contracts (diagnostics, code actions, config file mutations), not internal implementation details or helper call counts.
- Prefer real `TextDocument` instances, real `cspell-lib` validation, and temporary files over mocks; decouple entry-point side effects rather than mocking internal modules.
- Assert exact values and structures derived from requirements; never use weak existence-only assertions or lock in buggy output to make a test pass.

## Licensing

- Keep `GPL-3.0-only`. Do not remove or alter the copyright and origin notices in `LICENSE` and `NOTICE`.
- Keep one umbrella modification notice in `NOTICE` (origin and date). GPL-3.0 §5(a) needs a notice plus a relevant date, not an entry per change; details live in git history. Update `NOTICE` only when attribution or the date changes.
- Any third-party code must be compatible with `GPL-3.0-only` and attributed in `NOTICE`.
