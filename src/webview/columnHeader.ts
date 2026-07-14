import type {
  Column,
  IHeaderComp,
  IHeaderParams,
} from 'ag-grid-community';

// Funnel SVG matches the one M3 set via gridOptions.icons.menu so the
// custom header looks byte-identical to the previous default header.
const FUNNEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1 3l5 6v4l4 1V9l5-6z"/></svg>';

export interface ColumnHeaderParams {
  // Reads the live highlight state for this column's field. Called on init
  // and from `syncHighlight()` so the visual stays in sync with mutations
  // made via Ctrl+click.
  isHighlighted: (field: string) => boolean;
  // Toggles the highlight state for this column's field. The caller is
  // expected to mutate the per-statement state Set directly. We re-read via
  // isHighlighted() right after to update DOM (avoids a stale Boolean if
  // the caller does any extra work).
  toggleHighlight: (field: string) => void;
  // Opens a column context-menu (right-click) anchored at the mouse
  // position. Implemented in index.ts so it can use module-level popover
  // state + call gridApi.applyColumnState for pin / unpin / sort.
  openContextMenu: (field: string, e: MouseEvent) => void;
  // Plain left-click on a header in SELECTION mode → select the whole column
  // (Shift extends the range). Impl in index.ts reads the event for shiftKey.
  selectColumn: (colId: string, e: MouseEvent) => void;
  // True when the color/highlight toggle is on. In that mode a plain click
  // colors (highlights) the column, same as Ctrl/Cmd+click does in any mode.
  isPaintMode: () => boolean;
}

type FullParams = IHeaderParams & ColumnHeaderParams;

/**
 * Minimal vanilla header component. Mirrors AG Grid's default header DOM
 * shape (.ag-cell-label-container > .ag-header-cell-label > text + sort
 * indicator, plus an .ag-header-cell-menu-button funnel) so all existing M3
 * theme CSS (flex-direction overrides, menu-button padding, nested-header
 * tweaks, etc.) continues to apply unchanged.
 *
 * Behaviour:
 * - Plain click on the label area → select the whole column (params.selectColumn).
 *   Sorting moved to the right-click context menu.
 * - Ctrl/Cmd+click on the label area → toggle the column highlight and
 *   stopPropagation/preventDefault so no select fires.
 * - Click on the funnel button → call params.showColumnMenu(funnel) which
 *   opens the M9 filter modal. Stops propagation so neither select nor the
 *   Ctrl+click branch fires.
 * - Header drag (resize) is handled by AG Grid via separate mousedown on
 *   the resize handle and never reaches our click listener.
 *
 * Highlight class is applied to params.eGridHeader (the grid-managed
 * .ag-header-cell wrapper) so the whole cell — not just our inner DOM —
 * gets the inversion treatment.
 */
export class ColumnHeader implements IHeaderComp {
  private params!: FullParams;
  private eGui!: HTMLElement;
  private eLabel!: HTMLElement;
  private eText!: HTMLElement;
  private eSortIndicator!: HTMLElement;
  private eMenu: HTMLElement | null = null;
  private eHeaderCell: HTMLElement | null = null;
  private column!: Column;
  private field = '';
  private sortListener: (() => void) | null = null;
  private filterListener: (() => void) | null = null;

  init(params: FullParams): void {
    this.params = params;
    this.column = params.column;
    this.field = params.column.getColDef().field ?? '';
    this.eHeaderCell = params.eGridHeader;

    this.eGui = document.createElement('div');
    this.eGui.className = 'ag-cell-label-container col-header';
    this.eGui.setAttribute('role', 'presentation');

    // Menu (funnel) button — only rendered when filtering is enabled for
    // this column. Nested columns (struct / array / json / bytes) ship with
    // filter: false in buildColDef and therefore should have no funnel
    // (matches the M9 behaviour the user already knows).
    if (params.enableMenu) {
      this.eMenu = document.createElement('span');
      this.eMenu.className = 'ag-header-icon ag-header-cell-menu-button';
      this.eMenu.setAttribute('aria-hidden', 'true');
      this.eMenu.innerHTML = FUNNEL_SVG;
      this.eMenu.addEventListener('click', (e) => {
        // Always stop here: don't trigger sort, don't trigger highlight.
        e.stopPropagation();
        e.preventDefault();
        params.showColumnMenu(this.eMenu!);
      });
      this.eGui.appendChild(this.eMenu);
    }

    this.eLabel = document.createElement('div');
    this.eLabel.className = 'ag-header-cell-label';
    this.eLabel.setAttribute('role', 'presentation');

    this.eText = document.createElement('span');
    this.eText.className = 'ag-header-cell-text';
    this.eText.textContent = params.displayName;
    this.eLabel.appendChild(this.eText);

    this.eSortIndicator = document.createElement('span');
    this.eSortIndicator.className = 'ag-sort-indicator-container';
    this.eLabel.appendChild(this.eSortIndicator);

    this.eGui.appendChild(this.eLabel);

    // Click handling on the label area. AG Grid's own sort-on-click wiring
    // lives inside its default HeaderComp — by supplying our own header we
    // replace that, so we have to call progressSort() ourselves on plain
    // clicks. Ctrl/Cmd+click is the highlight branch.
    // Listener on eGui (the full-width .ag-cell-label-container) so a click
    // anywhere in the header — text OR the empty space — selects the column.
    // The funnel button stops propagation, so it stays filter-only.
    this.eGui.addEventListener('click', (e) => {
      // Color (highlight) the column: Ctrl/Cmd+click in any mode, OR a plain
      // click while the color toggle (paint mode) is on.
      if (e.ctrlKey || e.metaKey || params.isPaintMode()) {
        e.stopPropagation();
        e.preventDefault();
        if (!this.field) return;
        params.toggleHighlight(this.field);
        this.syncHighlight();
        return;
      }
      // Selection mode, plain click → select the whole column.
      params.selectColumn(this.column.getColId(), e);
    });

    // Right-click → custom context menu (pin / unpin). preventDefault
    // suppresses the browser's native context menu; stopPropagation keeps
    // the click from also triggering sort or highlight handlers.
    this.eGui.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.field) return;
      params.openContextMenu(this.field, e);
    });

    // Sort indicator updates: subscribe to the column's sortChanged event.
    // We remove the listener in destroy() so a re-mounted grid doesn't leak.
    this.sortListener = () => this.refreshSortIndicator();
    this.column.addEventListener('sortChanged', this.sortListener);

    // Filter indicator updates: subscribe to filterChanged so the funnel
    // can light up / dim when the user applies or clears this column's
    // filter. Same destroy() cleanup as sortListener.
    this.filterListener = () => this.refreshFilterIndicator();
    this.column.addEventListener('filterChanged', this.filterListener);

    this.refreshSortIndicator();
    this.refreshFilterIndicator();
    this.syncHighlight();
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  refresh(params: FullParams): boolean {
    this.params = params;
    this.eText.textContent = params.displayName;
    this.refreshSortIndicator();
    this.refreshFilterIndicator();
    this.syncHighlight();
    // Returning true tells AG Grid we successfully refreshed in place; no
    // need to re-create the component on colDef updates.
    return true;
  }

  destroy(): void {
    if (this.sortListener) {
      this.column.removeEventListener('sortChanged', this.sortListener);
      this.sortListener = null;
    }
    if (this.filterListener) {
      this.column.removeEventListener('filterChanged', this.filterListener);
      this.filterListener = null;
    }
  }

  // Public so the host can force a re-read after toggling (called from the
  // label click handler above; could also be invoked externally if a future
  // module changes columnHighlights from outside the header).
  syncHighlight(): void {
    if (!this.eHeaderCell) return;
    if (!this.field) {
      this.eHeaderCell.classList.remove('col-highlighted');
      return;
    }
    const on = this.params.isHighlighted(this.field);
    this.eHeaderCell.classList.toggle('col-highlighted', on);
  }

  private refreshFilterIndicator(): void {
    // Toggle a `filter-active` class on the funnel button so CSS can give
    // it a prominent appearance when the column has an applied filter.
    // No-op if the column has no menu button (nested columns ship with
    // filter: false → no funnel rendered in init).
    if (!this.eMenu) return;
    const active = this.column.isFilterActive();
    this.eMenu.classList.toggle('filter-active', active);
  }

  private refreshSortIndicator(): void {
    const sort = this.column.getSort();
    // We render the AG Grid built-in sort glyphs via the same class names
    // the default header uses (.ag-sort-ascending-icon / -descending-icon).
    // Theme CSS already sizes / colors them.
    this.eSortIndicator.innerHTML = '';
    if (sort === 'asc') {
      const span = document.createElement('span');
      span.className = 'ag-sort-indicator-icon ag-sort-ascending-icon';
      span.innerHTML =
        '<span class="ag-icon ag-icon-asc" unselectable="on" role="presentation"></span>';
      this.eSortIndicator.appendChild(span);
    } else if (sort === 'desc') {
      const span = document.createElement('span');
      span.className = 'ag-sort-indicator-icon ag-sort-descending-icon';
      span.innerHTML =
        '<span class="ag-icon ag-icon-desc" unselectable="on" role="presentation"></span>';
      this.eSortIndicator.appendChild(span);
    }
  }
}
