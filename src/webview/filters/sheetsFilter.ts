import type {
  IAfterGuiAttachedParams,
  IDoesFilterPassParams,
  IFilterComp,
  IFilterParams,
  IRowNode,
} from 'ag-grid-community';
import type { ParsedColumn } from '../../bq/parseJson';
import {
  buildSheetsFilterUi,
  compileSheetsMatcher,
  type FilterDraft,
  type SheetsFilterModel,
  type SheetsFilterUiHandle,
} from './sheetsFilterUi';

// Handle the host registers each time a filter popup is shown, so it can
// snapshot the in-progress draft before a tab-switch teardown.
export interface ActiveFilterHandle {
  field: string;
  capture: () => FilterDraft;
  isOpen: () => boolean;
}

// filterParams shape — we set this per-column when constructing the colDefs.
// columnType drives operator choices + cell-value parsing in the predicate.
export interface SheetsFilterParams {
  columnType: ParsedColumn['type'];
  // Optional callback fired whenever the filter is applied or cleared. Used
  // by the host to persist filter state on PerStatementState so that
  // re-mounts (page nav, sort, render-mode toggle that keeps the column)
  // restore the right state.
  onFilterChanged?: (field: string, model: SheetsFilterModel | null) => void;
  // Called from afterGuiAttached (popup shown) so the host can track the
  // currently-open filter and snapshot its draft on teardown.
  onShown?: (handle: ActiveFilterHandle) => void;
  // Called from afterGuiAttached to fetch (and clear) any pending draft the
  // host saved for this column before a tab switch — one-shot, so a normal
  // re-open after the draft is consumed shows the committed state.
  consumePendingDraft?: (field: string) => FilterDraft | null;
}

export class SheetsFilterComp implements IFilterComp {
  private params!: IFilterParams;
  private extra!: SheetsFilterParams;
  private field!: string;
  private columnType!: ParsedColumn['type'];
  private ui: SheetsFilterUiHandle | null = null;
  private model: SheetsFilterModel | null = null;
  // Compiled per-row predicate for `model`, built lazily on the first
  // doesFilterPass after a model change and reused across the whole filter
  // pass. Rebuilt (nulled) whenever the model changes so the exclusion Set
  // is constructed once per pass, not once per row. See compileSheetsMatcher.
  private matcher: ((rawValue: unknown) => boolean) | null = null;
  private hidePopup?: () => void;

  init(
    params: IFilterParams & {
      columnType?: ParsedColumn['type'];
      onFilterChanged?: SheetsFilterParams['onFilterChanged'];
      onShown?: SheetsFilterParams['onShown'];
      consumePendingDraft?: SheetsFilterParams['consumePendingDraft'];
    },
  ): void {
    this.params = params;
    // filterParams is mixed into the IFilterParams object by AG Grid, so the
    // columnType / onFilterChanged we set in the colDef show up here.
    this.extra = {
      columnType: (params.columnType ?? 'string') as ParsedColumn['type'],
      onFilterChanged: params.onFilterChanged,
      onShown: params.onShown,
      consumePendingDraft: params.consumePendingDraft,
    };
    this.field = params.colDef.field ?? '';
    this.columnType = this.extra.columnType;

    this.ui = buildSheetsFilterUi({
      field: this.field,
      columnType: this.columnType,
      onApply: (model) => {
        this.model = model;
        this.matcher = null;
        this.extra.onFilterChanged?.(this.field, model);
        this.params.filterChangedCallback();
        this.hidePopup?.();
      },
      onClear: () => {
        this.model = null;
        this.matcher = null;
        this.extra.onFilterChanged?.(this.field, null);
        this.params.filterChangedCallback();
        this.hidePopup?.();
      },
      onCancel: () => {
        // Cancel = close popup without changing the active model. The UI is
        // re-bound from the model on next afterGuiAttached, so any in-popup
        // edits the user made are discarded.
        this.hidePopup?.();
      },
    });
  }

  getGui(): HTMLElement {
    if (!this.ui) throw new Error('SheetsFilterComp.getGui() before init()');
    return this.ui.rootEl;
  }

  afterGuiAttached(p?: IAfterGuiAttachedParams): void {
    this.hidePopup = p?.hidePopup;
    if (!this.ui) return;
    // Re-bind the UI to the current model and the current row set. If the
    // host saved a draft for this column (tab-switch while the popup was
    // open), overlay it on top of the committed model.
    const allRows = this.collectAllRows();
    const draft = this.extra.consumePendingDraft?.(this.field) ?? null;
    this.ui.refresh({ model: this.model, allRows, draft });
    // Register as the active (currently-shown) filter so the host can
    // snapshot the in-progress draft if the grid is torn down while open.
    this.extra.onShown?.({
      field: this.field,
      capture: () => this.ui!.captureDraft(),
      isOpen: () => this.ui?.isOpen() ?? false,
    });
  }

  doesFilterPass(params: IDoesFilterPassParams): boolean {
    if (!this.model) return true;
    // Build the compiled matcher once per pass (the exclusion Set is the
    // expensive part); reused for every row until the model changes.
    if (!this.matcher) {
      this.matcher = compileSheetsMatcher(this.model, this.columnType);
    }
    const v = (params.data as Record<string, unknown> | undefined)?.[this.field];
    return this.matcher(v);
  }

  isFilterActive(): boolean {
    return this.model !== null;
  }

  getModel(): SheetsFilterModel | null {
    return this.model;
  }

  setModel(model: SheetsFilterModel | null): void {
    this.model = model;
    this.matcher = null;
    // No filterChangedCallback here — setModel is grid-driven and AG Grid
    // fires its own onFilterChanged when setFilterModel is called.
  }

  destroy(): void {
    this.ui?.destroy();
    this.ui = null;
  }

  private collectAllRows(): Record<string, unknown>[] {
    // Cascading-filter behaviour: distinct values shown in THIS column's
    // dropdown should reflect rows that pass every OTHER column's active
    // filter — matches Excel / Google Sheets. Without this, opening
    // column C's filter while column A is already filtered shows column
    // C's values across the entire dataset, which is confusing and lets
    // the user "select" values that won't actually appear in the grid.
    //
    // We can't ask AG Grid for "rows that pass all-but-one filter", so
    // we re-evaluate the other columns' models ourselves: pull the full
    // filter model, drop this column's entry, then check each row
    // against each remaining (field, model, columnType) tuple via the
    // same modelMatchesRow predicate the filter uses for grid filtering.
    const allModels = this.params.api.getFilterModel() ?? {};
    // Pre-compile each other column's matcher ONCE (exclusion Set built up
    // front), so the per-leaf-node loop below is O(rows × otherColumns), not
    // O(rows × otherColumns × exclusionValues).
    const otherFilters: {
      field: string;
      test: (rawValue: unknown) => boolean;
    }[] = [];
    for (const [otherField, model] of Object.entries(allModels)) {
      if (otherField === this.field) continue;
      if (!model) continue;
      const col = this.params.api.getColumn(otherField);
      if (!col) continue;
      const fp = col.getColDef().filterParams as
        | { columnType?: ParsedColumn['type'] }
        | undefined;
      otherFilters.push({
        field: otherField,
        test: compileSheetsMatcher(
          model as SheetsFilterModel,
          fp?.columnType ?? 'string',
        ),
      });
    }

    const rows: Record<string, unknown>[] = [];
    this.params.api.forEachLeafNode((node: IRowNode) => {
      if (!node.data) return;
      const data = node.data as Record<string, unknown>;
      for (const f of otherFilters) {
        if (!f.test(data[f.field])) return;
      }
      rows.push(data);
    });
    return rows;
  }
}
