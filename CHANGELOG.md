# Changelog
_All notable changes to **Instant Count** are documented in this file.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
adheres to [Semantic Versioning](https://semver.org/)._

---

## [1.1.0] - 2026-07-03

### Fixed
- **Select All / Peek All no longer miss matches.** The regex scan used by these commands processed the document in independent 50k-char slices, silently dropping any match that spanned a slice boundary. It now streams over the full text, so the count and the selection always agree.
- Zero-length regex matches (e.g. rules like `$TEXT?`) no longer stall the scanner until the watchdog fires.
- A regex scan that hits the watchdog now shows a visible warning in the status bar instead of silently leaving a stale count.
- **Whole Word now applies to highlighted selections.** Word boundaries are added only where the selection edge is a word character, so selections that start or end with punctuation still behave sensibly.
- The config panel no longer risks a false "Failed to execute action" after opening the rules input; actions that open other UI (rules editor, peek, select-all) now close the panel cleanly first.
- The Select All hint in the config panel shows the correct keybinding (was Ctrl+Shift+Alt+L, actual binding is Ctrl+Shift+Alt+S).
- Removed `Next Page` / `Previous Page` from the Command Palette - they were declared but never implemented and errored when invoked.
- Curly quotes are now actually normalized in the status-bar tooltip.

### Added
- **Large-file mode.** Files over 10 MB / 100k lines used to show contradictory warnings and shut off entirely. They now keep literal counting (of the raw selection or word) plus badges around the viewport, up to a 50 MB hard ceiling. Regex rules and whole-word are skipped in this mode for safety.
- **Match navigation.** `Go to Next Match` / `Go to Previous Match` (`Ctrl+Shift+Alt+.` / `Ctrl+Shift+Alt+,`) jump between occurrences with wrap-around - and the active pattern stays pinned while you navigate, even with custom rules.
- Keybinding for the config panel: `Ctrl+Shift+Alt+C`. The panel also stays open while you toggle settings and watch the count change (Esc closes it).
- Gutter badges are theme-aware: darker/heavier on light themes, rebuilt automatically when the color theme changes.
- The `instant-count.debug` setting now actually gates the extension's debug logging.

### Changed
- Consistent keybinding family: `Ctrl+Shift+Alt+C / R / S / P` for panel, rules, select-all, and peek (`Ctrl+Shift+3` still works for peek). macOS uses `Cmd` variants.
- Scans resolve decoration positions only around the viewport, reducing per-match work on files with thousands of matches.


## [1.0.1] – 2025-07-15

### Fixed
- **Special character handling in highlighted text** - Fixed issue where highlighting text containing special regex characters like `)`, `.`, `*`, `+`, etc. would break the counting functionality. The extension now properly distinguishes between literal text matching (for selections) and regex pattern matching, ensuring accurate counts regardless of special characters in the highlighted text.
- **Extension activation compatibility** - Removed `onLanguage:*` activation event to comply with VS Code marketplace validation requirements. Extension now activates using `onStartupFinished` only, ensuring better performance and marketplace compliance while maintaining full functionality.


### Changed
- **Code quality improvements** - Refactored `getSearchPattern()` function to reduce code duplication by extracting common return structures into a `createSearchResult()` helper function, improving maintainability and consistency.

---

## [1.0.0] – 2025-06-21  (first public release)

### Added
- **Live status-bar counter** that updates as you select text.
- **Numbered gutter badges** rendered only in (and near) the viewport.
- **Quick-config panel** (click the counter) to toggle Case, Whole-word, Regex, Gutter Badges, Status Bar.
- **Custom-rule engine**  
  - `$TEXT` placeholder → escapes the current selection.  
  - `$RAWTEXT` placeholder → inserts it raw for advanced patterns.
- **Peek All Matches** (`Ctrl + Shift + 3`) and **Select All Matches** (`Ctrl + Shift + Alt + L`).
- **Performance safeguards**  
  - Chunked scanning & viewport badge rendering.  
  - 500 ms regex timeout guard.  
  - Built-in multiline (`m`) flag so `^` / `$` anchors work line-by-line.

### Fixed
- Gutter badges could freeze after entering or clearing a custom rule; decorations now cleared without disposing their underlying types.
- Regex anchors now honoured across multiple lines (`m` flag added by default).

### Docs
- README with hero GIF, config-panel shot, and **before/after custom-rule** demo.
- Quick-start, advanced recipes, configuration reference and FAQ (“Why not just use VS Code’s native search?”).

---
