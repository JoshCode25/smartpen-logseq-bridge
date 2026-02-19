# Data Loss Fixes Summary (v3.1)

**Date:** February 6-9, 2026
**Status:** ✅ RESOLVED
**Commits:** 0a836ac, 8c129a8

---

## Overview

Three critical data loss issues were identified and resolved in the smartpen-logseq-bridge application. These fixes transition the storage strategy from v3.0 (with implicit deletion detection) to v3.1 (explicit append-only with tracked deletions).

---

## Issue 1: Phantom Stroke Deletions ✅ FIXED

### The Problem

**Location:** `src/lib/logseq-api.js:673-803` (`updatePageStrokesSingle()`)

The stroke save logic used arithmetic to infer deletions:
```javascript
// v3.0 - PROBLEMATIC
deletedCount = Math.max(0, existingData.strokes.length - simplifiedStrokes.length);
allStrokes = simplifiedStrokes;  // Replaces ALL LogSeq data
```

This meant:
- Missing strokes from canvas = treated as deleted
- Partial imports + save = permanent data loss
- No way to safely add strokes incrementally

**Example scenario:**
```
LogSeq database: 200 strokes
Canvas (after import): 50 strokes
User clicks Save: 150 strokes DELETED
```

### The Solution

**Commit:** 0a836ac

Implemented explicit deletion tracking via `pending-changes.js`:

```javascript
// v3.1 - APPEND-ONLY
const deletedStrokeIds = getDeletedStrokeIdsForPage(book, page);

// Step 1: Remove explicitly deleted strokes
mergedStrokes = existingData.strokes.filter(s => !deletedStrokeIds.has(s.id));

// Step 2: Append new strokes (deduplicated)
const uniqueNew = deduplicateStrokes(mergedStrokes, simplifiedStrokes);
allStrokes = [...mergedStrokes, ...uniqueNew];
```

**Key Changes:**
- Start from existing LogSeq data as base
- Only remove strokes explicitly in `deletedStrokeIds` set
- Append new strokes (deduplicated against existing)
- Update `blockUuid` on existing strokes if changed
- Never infer deletions from count differences

**Files Modified:**
- `src/lib/logseq-api.js` - Append-only logic in `updatePageStrokesSingle()`
- `src/stores/pending-changes.js` - Added `getDeletedStrokeIdsForPage()`
- `src/components/header/ActionBar.svelte` - Pass explicit deletions to save
- `src/components/dialog/SaveConfirmDialog.svelte` - Show accurate deletion counts

---

## Issue 2: Edit Structure UI Improvements ✅ FIXED

### The Problem

**Location:** `src/components/dialog/TranscriptionEditorModal.svelte`

The Edit Structure dialog had:
- Complex two-column layout
- Confusing visual hierarchy
- Only showed MyScript results (not existing LogSeq blocks)

### The Solution

**Commit:** 0a836ac

Redesigned to single-column layout:
- Clearer visual hierarchy
- Better editing experience
- More intuitive line management

**Files Modified:**
- `src/components/dialog/TranscriptionEditorModal.svelte` - Complete UI overhaul

---

## Issue 3: Y-Bounds Properties Not Preserved ✅ FIXED

### The Problem

**Location:** `src/lib/transcript-updater.js`

When updating transcript blocks, Y-bounds properties were being replaced instead of preserved:
```javascript
// v3.0 - PROBLEMATIC
properties: {
  'stroke-y-bounds': formatBounds(line.yBounds),  // NEW bounds
  'stroke-ids': line.strokeIds.join(','),
  'canonical-transcript': canonicalTranscript(line.text)
}
```

This broke stroke-to-block matching on subsequent updates.

### The Solution

**Commit:** 8c129a8

Modified update logic to preserve existing Y-bounds:
- Merge properties instead of replacing
- Maintain stroke-to-block associations across updates
- Preserve historical matching data

**Files Modified:**
- `src/lib/transcript-updater.js` - Property preservation logic
- `src/lib/logseq-api.js` - Update helpers

---

## Architecture Changes (v3.0 → v3.1)

### v3.0 (Problematic)
```
Canvas strokes → LogSeq
                 ↓
            [REPLACE ALL]
                 ↓
        Implicit deletions via arithmetic
```

### v3.1 (Fixed)
```
LogSeq strokes (base)
        ↓
    Remove explicit deletions (deletedStrokeIds)
        ↓
    Append new strokes (deduplicated)
        ↓
    Update blockUuid on existing
        ↓
    Save merged result
```

---

## Benefits

### Data Safety
- ✅ No phantom deletions
- ✅ Safe partial imports
- ✅ Incremental stroke additions work correctly
- ✅ 15-minute undo window for deletions

### User Experience
- ✅ Clearer Edit Structure dialog
- ✅ Accurate deletion counts in confirmations
- ✅ Better visual feedback

### Technical
- ✅ Explicit deletion tracking
- ✅ Append-only updates
- ✅ Preserved Y-bounds for matching
- ✅ BlockUuid updates without data loss

---

## Testing Checklist

When testing v3.1, verify:

1. **Partial Import Safety**
   - Import 50 of 200 strokes
   - Save to LogSeq
   - Verify all 200 strokes still in LogSeq (150 not deleted)

2. **Explicit Deletion**
   - Delete 10 strokes from canvas
   - Save to LogSeq
   - Verify exactly 10 strokes removed (not more)

3. **Incremental Addition**
   - Import existing page (100 strokes)
   - Add 20 new strokes from pen
   - Save to LogSeq
   - Verify 120 total strokes (no duplicates)

4. **Undo Deletion**
   - Delete strokes
   - Use Undo (within 15 minutes)
   - Save to LogSeq
   - Verify strokes preserved

5. **Y-Bounds Preservation**
   - Save transcription
   - Add new strokes
   - Re-transcribe and save
   - Check LogSeq blocks have original Y-bounds

---

## Migration Notes

### For Users
- No migration needed - v3.1 reads v3.0 data correctly
- Existing LogSeq pages work without modification
- Deletion tracking starts fresh (no historical deletions)

### For Developers
- Review `pending-changes.js` for deletion tracking API
- Use `getDeletedStrokeIdsForPage()` when saving
- Always pass `deletedStrokeIds` to `updatePageStrokesSingle()`
- Understand append-only strategy (base + changes)

---

## Related Documentation

- [CLAUDE.md](../../CLAUDE.md) - Updated with v3.1 architecture
- [TRANSCRIPT-STORAGE-SPEC.md](../TRANSCRIPT-STORAGE-SPEC.md) - Updated Known Issues section
- [data-loss-issues.md](~/.claude/projects/.../memory/data-loss-issues.md) - Original issue analysis
- [MEMORY.md](~/.claude/projects/.../memory/MEMORY.md) - Memory file updated

---

## Future Considerations

### Still Open Issues
- Issue 2: Stroke reassignment on re-transcription
- Issue 3: Entire transcript re-creation instead of appending
- Issue 4: Merge loses block UUIDs
- Issue 5: Orphan block auto-deletion
- Issue 7: No atomic transactions

See [TRANSCRIPT-STORAGE-SPEC.md](../TRANSCRIPT-STORAGE-SPEC.md) for details.

### Potential Improvements
- Add batch undo/redo beyond 15-minute window
- Implement transaction rollback for failed saves
- Add conflict resolution UI for edge cases
- Consider optimistic UI updates with background sync

---

## Credits

**Analysis:** Claude (2026-02-06)
**Implementation:** Josh Gannon (2026-02-09)
**Commits:** 0a836ac, 8c129a8
**Version:** 3.1 (Append-Only with Explicit Deletions)
