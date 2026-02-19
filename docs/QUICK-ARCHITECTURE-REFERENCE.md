# Quick Architecture Reference

**Current Version:** 3.1 (Append-Only with Explicit Deletions)
**Last Updated:** 2026-02-10

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

## Recent Fixes (February 2026)

### ✅ Phantom Stroke Deletions (commit 0a836ac)
- Changed from arithmetic to explicit deletion tracking
- Implemented append-only update strategy
- Added `getDeletedStrokeIdsForPage()` function

### ✅ Y-Bounds Preservation (commit 8c129a8)
- Fixed transcript updates to preserve Y-bounds
- Maintains stroke-to-block matching data

### ✅ Edit Structure UI (commit 0a836ac)
- Single-column layout
- Clearer visual hierarchy

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
