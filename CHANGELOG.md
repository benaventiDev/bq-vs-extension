# Changelog

All notable changes to **BigQuery Result Explorer** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-13

First public release on the Visual Studio Marketplace.

### Added
- **Per-file results grid** — run a selected query with `Shift+Enter`; each `.sql`
  file keeps its own result in the **Results** panel.
- **Conditional formatting rules** — color rows from a spreadsheet-style formula
  language (`IF`, `AND`/`OR`/`NOT`, `CONTAINS`, `COUNTIF`/`COUNTIFS`, date and text
  helpers) with a Monaco-powered editor: autocomplete, hover, signature help,
  snippets, and a live "matches N of M rows" preview.
- **Manual row/column coloring** — click or drag to paint rows; Ctrl/Cmd-click a
  header to highlight a column. Rule colors and manual colors coexist.
- **Filtering** — Google Sheets-style per-column filter popups, with a
  "clear all filters" action.
- **Pinning** — pin columns to the left, and pin one file's result so it stays
  visible regardless of editor focus.
- **SQL formatter** — format the active query (`Ctrl+Alt+B` / `Cmd+Alt+B`, or
  format-on-save) with configurable keyword case, indent, width, and spacing.
- **Multi-statement scripts** — a console-style "All results" overview with
  per-statement status/timing and drill-in.
- **Export** — CSV, TSV (clipboard), JSON, and Excel (`.xlsx`).
- Rich cell rendering for nested/struct/array/JSON/bytes values, pagination,
  panel zoom, light/dark themes, and cell-range selection + copy.
- Optional **sponsor** support: a gentle, usage-gated nudge after queries
  (disable any time via `bqVsExtension.showSponsorNudge`), plus **Sponsor** and
  **Preview Sponsor Message** commands.
