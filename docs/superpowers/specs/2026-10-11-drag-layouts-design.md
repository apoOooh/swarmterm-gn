# Drag to split and snap layouts — design

## Goal

Let the user rearrange panes by dragging, beyond today's swap:

- **A — Drag to split.** Drop a pane onto a side of another pane; the target's
  slot is split between the two. Example: `[A | B]` over `C` — drop A on C's
  left → B widens across the top, the bottom becomes `[A | C]`.
- **B — Snap layouts.** Like Windows 11's snap bar: while dragging, a strip of
  layout previews appears at the top of the workspace; dropping on one of a
  preview's slots rebuilds the whole workspace as that layout with the dragged
  pane in that slot.

## Interaction

- **Dock picker** (in `TerminalPane`): shown on the pane under the pointer while
  another pane is dragged — a plus of tiles: left / right / top / bottom dock,
  centre "Swap" (no droppable: falls through to the pane's existing reorder
  droppable). Hovering a side shades the half the dragged pane takes.
- **Snap bar** (in `Workspace`): visible for the whole drag of a pane of this
  workspace when ≥2 panes are visible. Presets: 2 panes → side by side,
  stacked; ≥3 → also grid (the composer's `paneLayoutFor` shape), main-left,
  main-top. Hovering a slot outlines the resulting layout over the workspace.
- The drag ghost is a small card beside the cursor so it never covers targets.
- Dropping elsewhere keeps the old behaviour (reorder, War Room join/move).

## Model

- `layout-tree.ts`: `moveLeafBeside(tree, from, to, side, splitId)` — close the
  dragged leaf first (so a sibling target collapses correctly), then
  `splitLeaf(..., position)` with the new `'before' | 'after'` position.
- `layout-presets.ts`: `presetsFor(n)`, `slotRects(tree)` (unit rectangles, used
  for thumbnails and the outline), `applyPreset(layout, drawerIds, preset,
  dragged, slot, mkId)`. Only visible panes are arranged; drawered leaves are
  appended after the arranged block (alive, restored at the end — their old slot
  cannot survive a full rebuild).
- Whole leaf nodes move in both cases, so terminals are only re-parented and
  focus / broadcast / War Room state follows them.

## Drag plumbing

- Drop ids `dock:<leafId>:<side>` and `snap:<presetId>:<slot>`; parsed from the
  last `:` so leaf ids may contain colons. `resolveDragEnd` returns new
  `dock` / `snap` actions; malformed ids are `none`, never a reorder; member
  chips ignore them.
- `preferLayoutTargets` wraps `pointerWithin`: a hit layout target beats the pane
  under it (corner-distance ordering is not z-order).
- `MeasuringStrategy.Always`: the targets mount after drag start.
- Store: `dockPane`, `applySnapLayout` — both end zoom and focus the dragged
  pane; no-ops for drawered/unknown panes.

## Non-goals

No persistence of layouts, no keyboard snapping, no Rust changes. The preview
webview lives in the right panel, which a pane drag flips to the War Room, so
no overlay hiding is needed.
