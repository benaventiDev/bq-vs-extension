# Changelog

All notable changes to **Warehouse Data Explorer** (formerly BigQuery Data Explorer) are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Snowflake support (preview).** Runs on the connection you already have in
  `connections.toml` / `config.toml` (any login method), with exact numbers, full-precision
  timestamps and times, VARIANT / OBJECT / ARRAY in the nested viewers, statement-by-statement
  scripts, cancel, and the same result-size cap as BigQuery.
- Default-warehouse routing for Shift+Enter and the Run buttons, plus per-warehouse Run
  commands that can each get their own shortcut, and a **Select Default Warehouse** command.

### Changed
- Renamed the extension to **Warehouse Data Explorer** (display name only; the extension ID
  is unchanged, so existing installs and settings carry over).
- Commands, Run buttons and the results panel no longer say BigQuery. Every command is
  grouped under *Warehouse Data Explorer* (*Run Selected Query*, *Run Query File*,
  *Run Selected Query on Snowflake*, *Select Default Warehouse*, …), and the panel is
  **Query Results**.
- Rows-per-page selector adds 2,000 and 3,000.
- TIMESTAMP columns with time-zone offsets sort and compare in formulas by instant.

## [0.3.2] - 2026-07-14

### Changed
- Updated the author display name.

## [0.3.1] - 2026-07-14

### Changed
- Renamed the extension to **BigQuery Data Explorer** (display name only; the extension
  ID is unchanged).

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
