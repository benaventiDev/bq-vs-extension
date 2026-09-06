import type { IHeaderComp, IHeaderParams } from 'ag-grid-community';

// Three short vertical bars (mimicking table columns) with a magnifying
// glass overlapping the bottom-right, so the icon reads as "search columns"
// rather than a generic search glyph.
const SEARCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" ' +
  'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="2.2" y1="2.4" x2="2.2" y2="8"/>' +
  '<line x1="5.3" y1="2.4" x2="5.3" y2="8"/>' +
  '<line x1="8.4" y1="2.4" x2="8.4" y2="8"/>' +
  '<circle cx="10.5" cy="10" r="3.1"/>' +
  '<line x1="12.7" y1="12.2" x2="14.8" y2="14.3"/>' +
  '</svg>';

export interface ColumnJumpHeaderParams {
  // Opens the "jump to column" search popover, anchored at the button
  // element. Implemented in index.ts, which owns the shared popover state
  // (same convention as ColumnHeaderParams in columnHeader.ts).
  openJumpPopover: (anchor: HTMLElement) => void;
}

type FullParams = IHeaderParams & ColumnJumpHeaderParams;

/**
 * Header component for the row-number gutter's header cell — normally blank
 * (headerName: ''). Renders a single search-icon button in that otherwise
 * empty top-left corner. No label, sort, or filter — the gutter column has
 * none of those, so unlike ColumnHeader this needs no refresh wiring.
 */
export class ColumnJumpHeader implements IHeaderComp {
  private eGui!: HTMLElement;

  init(params: FullParams): void {
    this.eGui = document.createElement('div');
    this.eGui.className = 'col-jump-header';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'col-jump-btn';
    btn.title = 'Jump to column';
    btn.innerHTML = SEARCH_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      params.openJumpPopover(btn);
    });
    this.eGui.appendChild(btn);
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  refresh(): boolean {
    return true;
  }

  destroy(): void {}
}
