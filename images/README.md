# Screenshots

These images are used by the marketplace listing (`../README.md`) and the
[conditional-formatting manual](../docs/conditional-formatting.md). They are **tracked in
git** but **excluded from the packaged extension** (`images/**` is in `.vscodeignore`), so
they never bloat the `.vsix`.

Capture all screenshots against **Google public data only** (`bigquery-public-data.*`),
using the queries in the repo's local `demo-queries/` folder.

## Privacy scrub — read before capturing

The demo account bills the queries, but **nothing tied to that account may appear** in any
image. Before saving each PNG, confirm:

- [ ] No account email anywhere in frame (hide the VS Code Accounts icon / status bar if it shows one).
- [ ] No project id (e.g. any `*-pr-*` / internal project string) visible — use **single-statement**
      queries so no destination-temp-table `project:dataset.table` leaks into an "All results" view.
- [ ] No internal table, dataset, or column names — every `FROM` is `bigquery-public-data.*`.
- [ ] No other repos, file paths, or tabs in the window that reveal internal work.
- [ ] Prefer a clean VS Code window: close unrelated editors, hide the sidebar if noisy.

## Shot list

| File | Source query | What to show |
| --- | --- | --- |
| `hero.png` | `demo-queries/01_usa_names.sql` | The full results grid, clean, a handful of rows. This is the top listing image. |
| `filter.png` | `01_usa_names.sql` | The `gender` column funnel open, one value unchecked, about to Apply. |
| `pin-column.png` | `01_usa_names.sql` | The `name` column pinned to the left (right-click header -> Pin Column). |
| `conditional-formatting.png` | `01_usa_names.sql` | Rows colored by rules (`total_births > 2000000` green, `avg_per_year < 500` red). |
| `cf-button.png` | `01_usa_names.sql` | Close-up of the footer paint-drop button with its rule-count badge. |
| `cf-rules-popover.png` | `01_usa_names.sql` | The rules popover listing rules with reorder / edit / delete controls. |
| `cf-rule-modal.png` | `01_usa_names.sql` | The add/edit modal: color palette, formula editor, live "matches N of M rows" preview. |
| `formula-autocomplete.png` | `01_usa_names.sql` | Autocomplete dropdown showing column names + functions inside the formula editor. |
| `color-drag.png` | `demo-queries/02_shakespeare.sql` | Highlighting mode ON, a dragged range of rows painted one color. |
| `pin-result.png` | `demo-queries/03_names_timeseries.sql` | The amber "showing pinned result from X — currently editing Y" banner + dashed top border. |
| `export-menu.png` | `03_names_timeseries.sql` | The footer download menu open (CSV / Excel / JSON / Copy to clipboard). |
| `sql-format.png` | `03_names_timeseries.sql` | Before/after of the messy query reformatted with `Ctrl+Alt+B` (or two side-by-side shots). |

## Tips for clean shots

- Set the panel to a comfortable zoom (footer `Aa` button) so text is legible in the image.
- Use the theme that reads best for the listing — the marketplace shows one static image, so
  pick one (dark tends to pop). Keep it consistent across shots.
- Crop tightly to the panel for feature close-ups (`cf-*`, `export-menu`); use a wider frame
  for `hero.png`.
- PNG, please — sharper than JPEG, with no compression artifacts on grid lines and text.
