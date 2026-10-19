# CONTINUUM IDE feature benchmark

Last reviewed: 2026-10-19

This document records public open-source IDE/editor patterns used to guide the native CONTINUUM workbench. It is a feature benchmark and roadmap, not a claim that CONTINUUM already implements every listed capability. The implementations in those projects are not copied into CONTINUUM; the references are used to prioritize familiar interactions.

## References

| Project | Technology / licensing reference | Useful product patterns |
|---|---|---|
| VS Code / Code - OSS | https://github.com/microsoft/vscode | Activity bar, Explorer, command palette, Quick Open, editor groups, integrated terminal, Problems/Output panels, debugging and source-control views |
| KDE Kate | https://github.com/KDE/kate and https://kate-editor.org/about-kate/ | Qt-native UI, projects, split views, multi-cursor editing, project-wide search/replace, LSP, DAP, terminal, Git and plugins |
| Lapce | https://github.com/lapce/lapce and https://lap.dev/lapce/ | Native-feeling interface, Tree-sitter highlighting, built-in LSP, terminal, modal editing and WASI plugins |
| Eclipse Theia | https://github.com/eclipse-theia/theia-ide and https://theia-ide.org/docs/extensions/ | Modular desktop/cloud IDE platform and runtime extension model |
| QScintilla | https://github.com/brCreate/QScintilla | Editor component capabilities: language-aware styling, code folding, completion, call tips, error markers, debugger margins and multiple views |
| Devpad | https://github.com/Semagsoft/Devpad | Qt6/QScintilla reference with terminal, LSP, project tree, find-in-files, themes and session tools |

## Current CONTINUUM constraints

CONTINUUM is a native PySide6 / Qt application. The local editor must stay usable without a network connection. Supabase-backed shared projects and Vercel-hosted AI agents are optional cloud features. The application sends source context only when an explicit cloud-agent action asks it to; proposals must be reviewed before applying to local files.

CONTINUUM is not a VS Code extension host or a language-server implementation. Features like IntelliSense, semantic navigation, debugging, and plugin marketplaces require additional integrations and should be labeled unavailable until they work end-to-end.

## Feature status and priority

### P0 — Workbench usability

- [x] Consistent activity rail, Explorer, tabbed editor, status bar and collapsible cloud tool pane.
- [x] Persistent light/dark appearance.
- [x] Local-first workspace and safe save path validation.
- [x] Cloud sign-in, shared projects, persistent cloud-agent sessions and review-before-apply.
- [ ] Keep cloud panel reachable when signed in (header action and View menu).
- [ ] Complete first-run Welcome actions and recent-workspace access.
- [ ] Run an end-to-end Windows smoke test on every native UI change.

### P1 — Baseline editor productivity

- [ ] Command palette and quick-open file picker.
- [ ] Find in editor, replace in editor, and project-wide search with click-to-open results.
- [ ] Integrated command runner panel with output, stop/cancel, and workspace cwd.
- [ ] File tree context menu: new file/folder, rename, delete with confirmation, reveal/copy path.
- [ ] Go to line, matching bracket insertion, tab indentation, dirty-file indicators and session restore.
- [ ] Git status and safe Git operations surfaced without silently committing/pushing.

### P2 — Language tooling

- [ ] Configurable Language Server Protocol (LSP) client for completions, diagnostics, symbols, hover and rename.
- [ ] Tree-sitter or an equivalent proper parser for robust multi-language syntax highlighting and folding.
- [ ] Debug Adapter Protocol (DAP) integration.
- [ ] Formatter/linter discovery, explicit task runner, Problems panel with real diagnostics.
- [ ] Split editor views and multi-cursor editing.

### P3 — Extensibility and team workflows

- [ ] Extension/tool registry with a permission model and clear provenance.
- [ ] Custom command/task definitions in workspace config.
- [ ] Terminal profiles, environment configuration and remote development integrations.
- [ ] Plugin/extension installation UI only after isolation, updates, signature/source and permission controls exist.

## Design rules

1. Use one primary toolbar, a compact activity rail, Explorer on the left, editor in the center, and optional tool windows at the right or bottom. Do not duplicate connection state across multiple confusing buttons.
2. Preserve familiar keyboard shortcuts: Ctrl+P quick open, Ctrl+Shift+P command palette, Ctrl+F find, Ctrl+H replace, Ctrl+` terminal, Ctrl+B Explorer, Ctrl+S save.
3. Sidebars must have unambiguous toggles and recoverable visibility. A hidden panel must be reopenable through both its activity button and View menu.
4. Do not show an IDE capability as available unless there is a working implementation. Distinguish "not configured", "not connected", "running", and "failed".
5. Keep local project navigation/editing available offline. Treat terminal commands as user-initiated local execution; keep cloud-model credentials on the server; keep agent-generated file changes review-gated.
6. Use accessible contrast, restrained accent colors, consistent spacing, keyboard focus cues, and adaptive panel sizes. Test at standard laptop and high-DPI sizes.

## Licensing note

These repositories have different licenses (for example, the Eclipse Theia IDE repository uses MIT and Kate has LGPL/MIT contribution licensing; other projects use their own licenses). CONTINUUM should not copy implementation code or assets without reviewing the exact license and notices for the selected upstream component. This benchmark borrows product concepts only.
