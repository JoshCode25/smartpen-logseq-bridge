# Quick Architecture Reference

**Current Version:** 3.1 (Append-Only with Explicit Deletions)
**Last Updated:** 2026-03-24

This document provides a quick reference for AI assistants working on the smartpen-logseq-bridge project.

---

## Critical Architecture Principles (v3.1)

### ✅ DO:
1. **Always start from existing LogSeq data** when updating pages
2. **Use explicit deletion tracking** via `pending-changes.js`
3. **Deduplicate strokes** using stroke IDs (`s{startTime}`)
4. **Preserve blockUuid** associations during updates
5. **Preserve Y-bounds** properties during transcript updates

### ❌ DON'T:
1. **Never replace entire LogSeq datasets** (use append-only)
2. **Never infer deletions from count differences**
3. **Never ignore missing strokes** from canvas as deletions
4. **Never overwrite Y-bounds** during updates
5. **Never assume canvas state = LogSeq state**

---

## Key Files & Responsibilities

### Stroke Management
- `src/stores/strokes.js` - In-memory stroke data with blockUuid
- `src/lib/stroke-storage.js` - Format conversion, deduplication, ID generation
- `src/lib/logseq-api.js:673-803` - **updatePageStrokesSingle()** - v3.1 append-only save

### Deletion Tracking
- `src/stores/pending-changes.js` - Tracks deletions, additions, changes per page
  - `deletedIndices` (line 12) - Set of deleted stroke indices
  - `getDeletedStrokeIdsForPage()` (line 264-282) - Converts indices to IDs
  - `pendingChanges` (line 124-216) - Derived store with per-page changes

### Transcription
- `src/stores/transcription.js` - MyScript results cache
- `src/lib/myscript-api.js` - Handwriting recognition API client
- `src/lib/transcript-updater.js` - Block matching, update logic (preserves Y-bounds)

### UI Components
- `src/components/header/ActionBar.svelte` - Save handler (passes deletedStrokeIds)
- `src/components/dialog/SaveConfirmDialog.svelte` - Shows accurate change counts
- `src/components/dialog/TranscriptionEditorModal.svelte` - Single-column editor
- `src/components/logseq-db/PageCard.svelte` - Per-page card in LogSeq DB tab
  - Compact header row: sync badge · icon · page title · ▶ expand · Import Strokes
  - Collapsible transcript section (expand arrow only shown when transcript exists)
  - Transcript section header: `TRANSCRIPTION:` · `[Edit]` · `[↺ Reset]`
  - Reset Transcript clears `blockUuid` from loaded strokes + in-memory transcription entry
- `src/components/logseq-db/TranscriptionPreview.svelte` - Read-only transcript display (inline edit button removed)

### Canvas / Live Writing
- `src/lib/canvas-renderer.js` - Drawing engine; coordinate transforms; zoom/pan
  - `calculateBounds()` - Computes page offsets; `offsetY = bounds.minY - globalMinY`
  - `fitToContent()` - Zoom-to-fit all content (used for offline import)
  - `setLiveWritingView()` - Fixed 3× zoom at top-left (used for live writing)
  - `clear(resetBounds)` - Clears canvas; **does NOT reset zoom/pan**
- `src/lib/pen-sdk.js` - BLE pen connection; `processDot()` filters invalid `{x:-1,y:-1}` pen-down dots
- `src/components/canvas/StrokeCanvas.svelte` - Canvas host; auto-fit logic distinguishes live vs. offline

---

## Data Flow: Save to LogSeq

```
User clicks "Save to LogSeq"
    ↓
SaveConfirmDialog shows changes per page
    ↓
For each page:
    ├─ getActiveStrokesForPage(book, page)         [canvas strokes, not deleted]
    ├─ getDeletedStrokeIdsForPage(book, page)      [explicit deletion IDs]
    ↓
updatePageStrokesSingle(book, page, newStrokes, host, token, deletedStrokeIds)
    ├─ Get existing LogSeq strokes (base)
    ├─ Remove strokes in deletedStrokeIds         [explicit only]
    ├─ Deduplicate and append new strokes         [no duplicates]
    ├─ Update blockUuid on existing if changed    [preserve associations]
    ├─ Build chunked storage (200 per chunk)
    └─ Write to LogSeq
```

---

## Common Patterns

### Getting Strokes for Save
```javascript
import { getActiveStrokesForPage, getDeletedStrokeIdsForPage } from '../stores/pending-changes.js';

// Get non-deleted strokes for this page
const activeStrokes = getActiveStrokesForPage(book, page);

// Get explicitly deleted stroke IDs
const deletedIds = getDeletedStrokeIdsForPage(book, page);

// Pass to save
await updatePageStrokes(book, page, activeStrokes, host, token, deletedIds);
```

### Checking for Changes
```javascript
import { pendingChanges, hasPendingChanges } from '../stores/pending-changes.js';

// Check if any changes exist
if ($hasPendingChanges) {
  // Show save button
}

// Get changes per page
$pendingChanges.forEach((pageChanges, pageKey) => {
  console.log(`${pageKey}: +${pageChanges.additions.length}, -${pageChanges.deletions.length}`);
});
```

### Marking Strokes for Deletion
```javascript
import { markStrokesDeleted, undoLastDeletion } from '../stores/pending-changes.js';

// Delete selected strokes
markStrokesDeleted([1, 5, 10, 15]);  // stroke indices

// Undo (within 15 minutes)
undoLastDeletion();
```

---

## Stroke ID Format

### Generation
```javascript
// In stroke-storage.js:109
export function generateStrokeId(stroke) {
  return `s${stroke.startTime}`;
}
```

### Purpose
- Deduplication across imports
- Explicit deletion tracking
- BlockUuid association

### Example
```
Stroke with startTime: 1640000000000
         Stroke ID: "s1640000000000"
```

---

## Storage Format (LogSeq)

### Page Structure
```
smartpen/B3017/P42
├─ properties:: { book: 3017, page: 42, ... }
├─ ## Raw Stroke Data
│  ├─ total-strokes:: 247
│  ├─ chunks:: 2
│  ├─ ### Chunk 1 (200 strokes)
│  │  └─ [JSON array of 200 strokes]
│  └─ ### Chunk 2 (47 strokes)
│     └─ [JSON array of 47 strokes]
└─ ## Transcribed Content
   ├─ First line of text
   │  ├─ stroke-y-bounds:: 245.0-260.0
   │  ├─ stroke-ids:: s1640000000000,s1640000001500
   │  └─ canonical-transcript:: firstlineoftext
   └─ ...
```

### Simplified Stroke Format
```javascript
{
  id: "s1640000000000",           // Unique identifier
  startTime: 1640000000000,
  endTime: 1640000001500,
  points: [                       // [x, y, timestamp] arrays
    [125.5, 250.3, 1640000000100],
    [126.1, 251.0, 1640000000200]
  ],
  blockUuid: "65abc123-..."       // LogSeq block association
}
```

---

## Recent Fixes

### March 2026

#### ✅ LogSeq DB Tab — PageCard UX Overhaul (2026-03-24)
Redesigned `src/components/logseq-db/PageCard.svelte` for better scalability with large page lists:

- **Compact header row** — icon · page title · sync badge · expand arrow · Import Strokes button, all on one line; no separate metadata row
- **Collapsible transcript** — transcript section hidden by default; expand arrow (▶/▼) only appears when a page has transcription data, so scrolling through many pages is no longer interrupted by tall preview boxes
- **Transcript section header** — `TRANSCRIPTION:` label with inline `[Edit]` and `[↺ Reset]` action buttons; Reset button styled in warning amber
- **Reset Transcript action** — clears `blockUuid` from all session-loaded strokes for the page and removes the in-memory `pageTranscriptions` entry, allowing re-transcription of pages where the previous run was truncated; logs outcome to ActivityLog; does not delete LogSeq blocks
- **Removed**: separate `page-actions` row, stroke count / last-updated metadata (returned stale data), and the floating inline edit-pencil button from `TranscriptionPreview.svelte`
- **Sync badge** pinned left of the flex spacer (right of page title) so its position is stable regardless of expand-arrow presence

---

#### ✅ Decorative Stroke Filter — Single-stroke Only (2026-03-24)
Rewrote `src/lib/stroke-filter.js` to detect only individual strokes — no multi-stroke grouping:

- **Removed**: 2-stroke H+V box detection (`detect2StrokeBoxes`) and vertical-line detection
- **Replaced**: `StrokeAnalyzer`-based rectangle check (fragile corner detection) with two simpler geometric tests:
  1. **Perimeter fraction** — ≥85% of dots must lie within 1.5mm of a bounding-box edge
  2. **Path ratio** — `pathLength / 2(w+h)` must be in `[0.80, 1.40]` (circles score ~0.785, spirals > 1.40)
- **Added**: Explicit closure check in mm (`BOX_MAX_CLOSURE_MM = 5.0`) instead of Ncode units
- **Type priority fix**: `underline > box > circle` so a closed rectangle isn't mis-labelled as a circle

Detection types remain: underlines (long, straight, horizontal), single-stroke boxes (closed rectangle with content), circles/ovals (closed curve with content).

---

#### ✅ Offline Import Performance (2026-03-19)
Two changes to `src/lib/pen-sdk.js` to reduce import time for multi-book syncs:

1. **Resolve on `OFFLINE_DATA_SEND_SUCCESS`** — the SDK fires this event after delivering all stroke data for a book. The code now resolves the per-book transfer promise immediately after `handleOfflineDataReceived()` processes the strokes, rather than waiting for a 10-second idle timeout. The idle timeout is retained as a fallback for cases where `SEND_SUCCESS` never fires.

2. **`INTER_BOOK_DELAY_MS` reduced from 1000ms → 500ms** — the delay between requesting sequential books (BLE stabilisation).

Result: a 5-book import that previously took ~55s now takes ~13s. No change to data safety — strokes are fully processed before the promise resolves.

Key config: `TRANSFER_CONFIG` object at `src/lib/pen-sdk.js:511`

---

#### ✅ Live Capture & Canvas View Stability (2026-03-11)
Four issues fixed across three files:

1. **Invalid pen-down dot** (`pen-sdk.js` — `processDot()`)
   - SDK emits `{x:-1, y:-1, f:0}` before resolving position; `pageInfo` is stale from prior session
   - Fix: skip invalid dots; latch `pageInfo` from first real pen-move dot
   - Result: no more origin-lines; correct book/page on first stroke

2. **`calculateBounds` offsetY double-subtraction** (`canvas-renderer.js`)
   - `offset.offsetY = -globalMinY` caused `ncodeToScreen` to subtract `globalMinY` twice → content off-screen
   - Fix: `offset.offsetY = offset.bounds.minY - globalMinY`

3. **Zoom/pan reset on every stroke** (`canvas-renderer.js`)
   - `clear(resetBounds=true)` was resetting `zoom=1, panX=0, panY=0` after every stroke
   - Fix: removed zoom/pan reset; view state managed only by `fitToContent()` / `setLiveWritingView()`

4. **Auto-fit jumping during live writing** (`StrokeCanvas.svelte`)
   - Old logic: `fitContent()` fired on first stroke AND every 10 strokes → view jumped repeatedly
   - Fix: new `setLiveWritingView()` (3× zoom, top-left anchor) called once per session on first live stroke; `fitContent()` used only for offline import (first load only)

See: `docs/Archive/2026-03-live-capture-canvas-fixes/LIVE-CAPTURE-CANVAS-FIXES.md`

---

### February 2026

#### ✅ Phantom Stroke Deletions (commit 0a836ac)
- Changed from arithmetic to explicit deletion tracking
- Implemented append-only update strategy
- Added `getDeletedStrokeIdsForPage()` function

#### ✅ Y-Bounds Preservation (commit 8c129a8)
- Fixed transcript updates to preserve Y-bounds
- Maintains stroke-to-block matching data

#### ✅ Edit Structure UI (commit 0a836ac)
- Single-column layout
- Clearer visual hierarchy

---

## Unit Test Coverage

Run tests with `npm test` (single run) or `npm run test:watch` (watch mode).

Framework: **Vitest 4.1.1** with happy-dom environment.

| File | Coverage |
|------|----------|
| `src/lib/__tests__/stroke-storage.test.js` | `generateStrokeId`, `convertToStorageFormat` (blockUuid preservation), `convertFromStorageFormat` (round-trip), `calculateBounds`, `deduplicateStrokes`, `buildPageStorageObject`, `splitStrokesIntoChunks`, `buildChunkedStorageObjects`, `parseChunkedJsonBlocks`, `parseJsonBlock`/`formatJsonBlock`, `formatTranscribedText`, `formatPageName`, `getPageProperties` |
| `src/lib/__tests__/logseq-api.test.js` | `mergeExistingAndNewLines` — empty inputs, exact canonical dedup, Y-bounds subset filtering, sorting |
| `src/lib/__tests__/transcript-updater.test.js` | `updateTranscriptBlocks` — validLines filter (Y-bounds gating, empty text), duplicate prevention, dedupedLines index correctness |
| `src/lib/__tests__/myscript-api.test.js` | `parseMyScriptResponse` — line parsing, Y-bounds calculation, fallback interpolation, indentation, checkbox normalisation |
| `src/lib/__tests__/transcript-search.test.js` | `tokenize` (hyphen preservation, property filtering), `searchPages` (partial matching, ranking), `highlightMatches` (HTML escaping, mark injection) |
| `src/lib/__tests__/stroke-filter.test.js` | `filterDecorativeStrokes` — underline/circle/single-stroke-box detection (perimeter-fraction + path-ratio), threshold behaviour, `detectDecorativeIndices`, regression for vertical lines and multi-stroke grouping |

---

## Testing Checklist

When making changes to stroke/transcription logic, test:

1. **Partial Import** → Save → Verify no phantom deletions
2. **Explicit Deletion** → Save → Verify only deleted strokes removed
3. **Incremental Addition** → Save → Verify no duplicates
4. **Undo Deletion** → Save → Verify restoration works
5. **Y-Bounds** → Re-transcribe → Verify properties preserved

---

## Documentation Links

- [CLAUDE.md](../CLAUDE.md) - Full development guide
- [app-specification.md](app-specification.md) - Complete technical spec
- [TRANSCRIPT-STORAGE-SPEC.md](TRANSCRIPT-STORAGE-SPEC.md) - Storage architecture
- [DATA-LOSS-FIXES-SUMMARY.md](Archive/2026-02-data-loss-fixes/DATA-LOSS-FIXES-SUMMARY.md) - Fix details
- [Memory](~/.claude/projects/.../memory/MEMORY.md) - Issue history

---

## Questions to Ask Before Changes

1. **Will this affect stroke persistence?** → Review append-only strategy
2. **Does this involve deletions?** → Use explicit tracking, never arithmetic
3. **Am I updating existing blocks?** → Preserve Y-bounds and blockUuid
4. **Could this create duplicates?** → Use stroke ID deduplication
5. **Is this modifying LogSeq data?** → Start from existing, apply changes

---

**Remember:** The v3.1 architecture is designed to prevent data loss. When in doubt, preserve existing data and only apply explicit changes.
