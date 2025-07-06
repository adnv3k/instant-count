# Changelog
_All notable changes to **Instant Count** are documented in this file.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
adheres to [Semantic Versioning](https://semver.org/)._

---

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
