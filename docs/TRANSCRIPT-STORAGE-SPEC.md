# Transcript Storage & Update Specification

**Version:** 3.1 (Append-Only with Explicit Deletions)
**Date:** 2026-02-09 (Updated)
**Status:** Active Implementation - Data Loss Issues RESOLVED

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Structures](#data-structures)
4. [Complete Data Flow](#complete-data-flow)
5. [Storage Format Evolution](#storage-format-evolution)
6. [Update Strategies](#update-strategies)
7. [Known Issues & Data Loss Points](#known-issues--data-loss-points)
8. [Requirements for Fix](#requirements-for-fix)

---

## Overview

### Purpose

This application bridges NeoSmartpen handwritten strokes with LogSeq's knowledge management system. The transcript storage system manages the bidirectional relationship between:

1. **Raw stroke data** (pen coordinates, timestamps)
2. **Transcribed text** (handwriting recognition via MyScript)
3. **LogSeq blocks** (structured note-taking format)

### Key Challenge

Users need to:
- Incrementally add strokes to existing pages
- Update transcriptions without losing manual edits in LogSeq
- Maintain associations between strokes and LogSeq blocks
- Preserve user corrections (spelling, formatting, TODO markers)

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER ACTIONS                                │
└─────────────────────────────────────────────────────────────────────┘
    │
    ├─ Import Strokes (Pen → Canvas)
    ├─ Transcribe (Canvas → MyScript API)
    ├─ Edit Transcript (Modal Editor)
    └─ Save to LogSeq (Store → LogSeq HTTP API)

┌─────────────────────────────────────────────────────────────────────┐
│                        STATE MANAGEMENT                              │
└─────────────────────────────────────────────────────────────────────┘

    strokes.js              → Raw stroke data + blockUuid
    transcription.js        → MyScript results per page
    logseqPages.js          → Scanned LogSeq database
    storage.js              → Save status tracking

┌─────────────────────────────────────────────────────────────────────┐
│                         BUSINESS LOGIC                               │
└─────────────────────────────────────────────────────────────────────┘

    stroke-storage.js       → Format conversion, chunking
    transcript-updater.js   → Block matching, action detection
    logseq-api.js          → HTTP API calls, block CRUD
    myscript-api.js        → Handwriting recognition

┌─────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL SYSTEMS                              │
└─────────────────────────────────────────────────────────────────────┘

    MyScript Cloud API      → Handwriting → Text
    LogSeq HTTP API         → Block storage
```

---

## Data Structures

### 1. Stroke Data Structure

#### In-Memory Format (strokes.js)
```javascript
{
  id: "s1640000000000",           // "s{startTime}" for deduplication
  pageInfo: {
    section: 3,                    // Ncode section
    owner: 1012,                   // Ncode owner
    book: 3017,                    // Notebook ID
    page: 42                       // Page number
  },
  startTime: 1640000000000,        // Unix timestamp (ms)
  endTime: 1640000001500,          // Unix timestamp (ms)
  dotArray: [
    {
      x: 125.5,                    // Ncode X coordinate
      y: 250.3,                    // Ncode Y coordinate
      f: 128,                      // Pressure (0-255)
      timestamp: 1640000000100     // Dot timestamp
    }
    // ... more dots
  ],
  blockUuid: "65abc123-...",       // ⭐ LogSeq block UUID (null if not transcribed)
  isDuplicated: false,             // Flag for temporary strokes
  deleted: false                   // Soft-delete flag
}
```

#### Storage Format (LogSeq)
```javascript
// Simplified format (~60% smaller)
{
  id: "s1640000000000",
  startTime: 1640000000000,
  endTime: 1640000001500,
  points: [
    [125.5, 250.3, 1640000000100],
    [126.1, 251.0, 1640000000200]
    // ... [x, y, timestamp] arrays (no pressure/color)
  ],
  blockUuid: "65abc123-..."        // ⭐ Association to LogSeq block
}
```

**Key Transformations:**
- `dotArray` → `points` (array of [x, y, timestamp])
- Removes: `f` (pressure), `tiltX`, `tiltY`, `color`
- Preserves: `id`, `startTime`, `endTime`, `blockUuid`

**File:** `src/lib/stroke-storage.js`
- `convertToStorageFormat()` (line 109-121)
- `convertFromStorageFormat()` (line 273-286)

---

### 2. Transcription Data Structure

#### MyScript API Response
```javascript
{
  text: "Full transcribed text\nwith line breaks",
  strokeCount: 42,
  pageInfo: { section: 3, owner: 1012, book: 3017, page: 42 },
  lines: [
    {
      text: "First line of text",
      indentLevel: 0,              // 0 = root, 1 = child, etc.
      parent: null,                // Index of parent line
      children: [1, 2],            // Indices of child lines
      x: 125.5,                    // Leftmost X coordinate
      baseline: 250.3,             // Y baseline position
      yBounds: {                   // ⭐ Vertical bounds for stroke matching
        minY: 245.0,
        maxY: 260.0
      },
      words: [                     // Word-level data
        {
          label: "First",
          candidates: ["First", "Hirst"],
          x: 125.5,
          baseline: 250.3
        }
      ],
      strokeIds: ["s1640000000000", "s1640000001500"]  // Associated strokes
    }
    // ... more lines
  ],
  commands: []                     // Extracted commands like [page: ...]
}
```

#### In-Store Format (pageTranscriptions)
```javascript
// Keyed by "book-page"
pageTranscriptions = {
  "3017-42": {
    text: "...",
    strokeCount: 42,
    pageInfo: { ... },
    lines: [
      {
        text: "First line",
        yBounds: { minY: 245.0, maxY: 260.0 },
        blockUuid: "65abc123-...",    // ⭐ Added after LogSeq save
        syncStatus: 'saved',          // 'new', 'saved', 'modified'
        // ... other MyScript data
      }
    ]
  }
}
```

**File:** `src/stores/transcription.js`

---

### 3. LogSeq Block Structure

#### Page Organization
```
smartpen/B3017/P42                          # Page block
├─ properties::
│  ├─ book:: 3017
│  ├─ page:: 42
│  ├─ section:: 3
│  ├─ owner:: 1012
│  ├─ timestamp:: 2024-12-22T10:30:00Z
│  └─ stroke-count:: 247
│
├─ ## Raw Stroke Data                      # Section header
│  ├─ total-strokes:: 247
│  ├─ chunks:: 2
│  ├─ ### Chunk 1 (200 strokes)
│  │  └─ [JSON array of 200 strokes]
│  └─ ### Chunk 2 (47 strokes)
│     └─ [JSON array of 47 strokes]
│
└─ ## Transcribed Content #Display_No_Properties  # Section header
   ├─ First line of text                  # Transcription block
   │  ├─ stroke-y-bounds:: 245.0-260.0   # ⭐ Y-bounds for matching
   │  ├─ stroke-ids:: s1640000000000,s1640000001500  # Stroke associations
   │  └─ canonical-transcript:: firstlineoftext  # Change detection
   ├─ Second line of text
   │  └─ [properties...]
   └─ Third line
      └─ [properties...]
```

#### Block Properties (v3.0 Format)

**Required Properties:**
- `stroke-y-bounds` - Vertical range for stroke matching (e.g., "245.0-260.0")
- `stroke-ids` - Comma-separated stroke IDs (e.g., "s1640000000000,s1640000001500")
- `canonical-transcript` - Normalized text for change detection (lowercase, no spaces/punctuation)

**Optional Properties:**
- User-defined TODO markers (`TODO`, `DOING`, `DONE`)
- Custom tags or properties

**File:** `src/lib/logseq-api.js`
- `createTranscriptBlockWithProperties()` (line 971-1020)
- `updateTranscriptBlockWithPreservation()` (line 944-959)
- `getTranscriptBlocks()` (line 1051-1087)

---

## Complete Data Flow

### Flow 1: Initial Transcription & Save

```
┌────────────────────────────────────────────────────────────────────┐
│ STEP 1: IMPORT STROKES                                             │
└────────────────────────────────────────────────────────────────────┘

User imports strokes from pen
    ├─ PenControls.svelte: handleFetchNotes()
    ├─ pen-sdk.js: fetchOfflineData()
    ├─ strokes.js: addStroke()
    └─ Result: Strokes in store with blockUuid = null

┌────────────────────────────────────────────────────────────────────┐
│ STEP 2: TRANSCRIBE VIA MYSCRIPT                                    │
└────────────────────────────────────────────────────────────────────┘

User clicks "Transcribe" button
    ├─ ActionBar.svelte: handleTranscribe() (line 234-416)
    ├─ Group strokes by page
    ├─ For each page:
    │  ├─ getActiveStrokesForPage() - filter deleted strokes
    │  ├─ myscript-api.js: transcribeStrokes()
    │  │  └─ MyScript API returns lines[] with yBounds
    │  └─ transcription.js: setPageTranscription()
    └─ Result: Transcription stored in pageTranscriptions

┌────────────────────────────────────────────────────────────────────┐
│ STEP 3: SAVE TO LOGSEQ                                             │
└────────────────────────────────────────────────────────────────────┘

User clicks "Save to LogSeq"
    ├─ SaveConfirmDialog.svelte: Shows confirmation
    ├─ ActionBar.svelte: handleSaveToLogseq() (line 423-565)
    └─ For each page:

       ┌────────────────────────────────────────────────────────────┐
       │ SUB-STEP 3A: SAVE STROKES                                  │
       └────────────────────────────────────────────────────────────┘

       ├─ updatePageStrokes(book, page, strokes)
       │  ├─ stroke-storage.js: convertToStorageFormat()
       │  │  └─ Simplify strokes (remove pressure, etc.)
       │  ├─ buildChunkedStorageObjects()
       │  │  └─ Split into 200-stroke chunks
       │  ├─ logseq-api.js: updateBlockContent()
       │  │  ├─ Find/create "Raw Stroke Data" section
       │  │  ├─ Delete old chunks
       │  │  └─ Create new chunks with updated strokes
       │  └─ Result: Strokes saved (still have blockUuid = null)

       ┌────────────────────────────────────────────────────────────┐
       │ SUB-STEP 3B: SAVE TRANSCRIPTION BLOCKS                     │
       └────────────────────────────────────────────────────────────┘

       └─ updateTranscriptBlocks(book, page, strokes, transcription)
          ├─ transcript-updater.js: updateTranscriptBlocks() (line 516-788)
          │
          ├─ 1. Fetch existing blocks from LogSeq
          │    └─ logseq-api.js: getTranscriptBlocks()
          │       └─ Returns [] (empty for first save)
          │
          ├─ 2. Estimate stroke IDs for each line
          │    └─ estimateLineStrokeIds() (line 159-210)
          │       ├─ For each line's yBounds:
          │       │  └─ Find strokes with overlapping Y coordinates
          │       └─ Returns line with strokeIds[] populated
          │
          ├─ 3. Detect block actions
          │    └─ detectBlockActions() (line 245-396)
          │       ├─ For each transcription line:
          │       │  └─ No matching block found → action = 'CREATE'
          │       └─ Returns actions[] (all CREATE for first save)
          │
          ├─ 4. Execute actions
          │    ├─ For each CREATE action:
          │    │  └─ logseq-api.js: createTranscriptBlockWithProperties()
          │    │     ├─ Create child block under "Transcribed Content"
          │    │     ├─ Set content = line.text
          │    │     ├─ Set properties:
          │    │     │  ├─ stroke-y-bounds: "245.0-260.0"
          │    │     │  ├─ stroke-ids: "s1640000000000,..."
          │    │     │  └─ canonical-transcript: "firstline"
          │    │     └─ Returns block with UUID
          │    │
          │    └─ Result: All lines saved as individual blocks
          │
          ├─ 5. Match strokes to blocks
          │    └─ matchStrokesToLines() (line 435-473)
          │       ├─ For each stroke:
          │       │  ├─ Calculate stroke Y range (min/max dot.y)
          │       │  ├─ Find line with best Y-bounds overlap
          │       │  └─ Map: strokeStartTime → blockUuid
          │       └─ Returns Map<startTime, blockUuid>
          │
          ├─ 6. Update strokes with blockUuid
          │    └─ updateStrokeBlockUuids(map) (line 768)
          │       └─ strokes.js: Updates in-memory strokes
          │
          ├─ 7. RE-SAVE strokes with blockUuid
          │    └─ updatePageStrokes() AGAIN (line 770-779)
          │       └─ Strokes now have blockUuid associations
          │
          └─ Result: Strokes linked to LogSeq blocks
```

---

### Flow 2: Incremental Update (Re-Transcribe)

```
┌────────────────────────────────────────────────────────────────────┐
│ STEP 1: ADD NEW STROKES                                            │
└────────────────────────────────────────────────────────────────────┘

User writes more on same page
    ├─ New strokes imported
    └─ New strokes have blockUuid = null (not transcribed yet)

┌────────────────────────────────────────────────────────────────────┐
│ STEP 2: RE-TRANSCRIBE                                              │
└────────────────────────────────────────────────────────────────────┘

User clicks "Transcribe" again
    ├─ MyScript processes ALL strokes (old + new)
    ├─ Returns NEW lines[] (may differ from previous)
    │  ├─ Line boundaries may shift
    │  └─ yBounds may change slightly
    └─ setPageTranscription() OVERWRITES old transcription

⚠️ PROBLEM: Old blockUuid associations in pageTranscriptions are lost

┌────────────────────────────────────────────────────────────────────┐
│ STEP 3: SAVE UPDATE TO LOGSEQ                                      │
└────────────────────────────────────────────────────────────────────┘

User clicks "Save to LogSeq"
    └─ For updated page:

       ┌────────────────────────────────────────────────────────────┐
       │ SUB-STEP 3A: UPDATE STROKES                                │
       └────────────────────────────────────────────────────────────┘

       ├─ updatePageStrokes()
       │  └─ Saves ALL strokes (old with blockUuid + new without)

       ┌────────────────────────────────────────────────────────────┐
       │ SUB-STEP 3B: UPDATE TRANSCRIPTION BLOCKS                   │
       └────────────────────────────────────────────────────────────┘

       └─ updateTranscriptBlocks()
          │
          ├─ 1. Fetch existing blocks from LogSeq
          │    └─ getTranscriptBlocks() (line 1051-1087)
          │       └─ Returns existing blocks with:
          │          ├─ uuid: "65abc123-..."
          │          ├─ content: "First line"
          │          ├─ properties: {
          │          │   'stroke-y-bounds': "245.0-260.0",
          │          │   'stroke-ids': "s1640000000000,...",
          │          │   'canonical-transcript': "firstline"
          │          │ }
          │
          ├─ 2. Estimate stroke IDs for NEW transcription lines
          │    └─ estimateLineStrokeIds()
          │       └─ Returns lines with strokeIds[]
          │
          ├─ 3. Detect block actions
          │    └─ detectBlockActions() (line 245-396)
          │       │
          │       ├─ TIER 1: Match by Stroke IDs (PREFERRED)
          │       │  ├─ For each existing block:
          │       │  │  ├─ Parse stored stroke-ids property
          │       │  │  ├─ Find transcription lines with overlapping IDs
          │       │  │  └─ If found: potential UPDATE/SKIP
          │       │  │
          │       │  └─ Matching algorithm:
          │       │     ├─ Calculate overlap: (line ∩ block) / line
          │       │     ├─ Best match: highest overlap ratio
          │       │     └─ Threshold: >50% overlap required
          │       │
          │       ├─ TIER 2: Match by Y-Bounds (FALLBACK)
          │       │  ├─ If no stroke ID match found
          │       │  ├─ Use Y-bounds overlap
          │       │  └─ Less reliable (can mismatch if writing shifted)
          │       │
          │       ├─ TIER 3: Compare Canonical Text
          │       │  ├─ For matched line/block:
          │       │  │  ├─ Normalize both texts (lowercase, remove spaces)
          │       │  │  ├─ If identical: action = 'SKIP'
          │       │  │  └─ If different: action = 'UPDATE'
          │       │  │
          │       │  └─ Special case: Multiple lines merged
          │       │     ├─ Combine line texts
          │       │     ├─ Compare to block
          │       │     └─ action = 'UPDATE_MERGED'
          │       │
          │       ├─ TIER 4: Handle Orphans
          │       │  ├─ Existing blocks with no matching lines
          │       │  ├─ Check if strokes still exist
          │       │  ├─ If strokes gone: action = 'DELETE'
          │       │  └─ If strokes exist: action = 'PRESERVE'
          │       │
          │       └─ Returns actions[] = [
          │          { action: 'UPDATE', lineIndex: 0, blockUuid: "..." },
          │          { action: 'SKIP', lineIndex: 1, blockUuid: "..." },
          │          { action: 'CREATE', lineIndex: 2 },
          │          { action: 'DELETE', blockUuid: "..." }
          │        ]
          │
          ├─ 4. Execute actions
          │    │
          │    ├─ UPDATE:
          │    │  └─ updateTranscriptBlockWithPreservation() (line 944-959)
          │    │     ├─ Parse existing TODO/DONE markers
          │    │     ├─ Update block content (preserve markers)
          │    │     ├─ Update properties:
          │    │     │  ├─ stroke-y-bounds: NEW bounds from transcription
          │    │     │  ├─ stroke-ids: NEW stroke IDs
          │    │     │  └─ canonical-transcript: NEW canonical text
          │    │     └─ ⚠️ OLD Y-BOUNDS LOST HERE
          │    │
          │    ├─ SKIP:
          │    │  └─ No changes to LogSeq block
          │    │
          │    ├─ CREATE:
          │    │  └─ createTranscriptBlockWithProperties()
          │    │     └─ New block with fresh properties
          │    │
          │    └─ DELETE:
          │       └─ removeBlock(blockUuid)
          │          └─ Block removed from LogSeq
          │
          ├─ 5. Re-match ALL strokes to blocks
          │    └─ matchStrokesToLines()
          │       ├─ Re-calculates Y-bounds overlaps
          │       ├─ ⚠️ May assign different blockUuid than before
          │       └─ Returns NEW Map<startTime, blockUuid>
          │
          ├─ 6. Update strokes with NEW blockUuid
          │    └─ updateStrokeBlockUuids(map)
          │       └─ ⚠️ Overwrites old blockUuid associations
          │
          └─ 7. RE-SAVE strokes with updated blockUuid
             └─ updatePageStrokes()
                └─ ⚠️ Old associations replaced
```

**⚠️ CRITICAL DATA LOSS POINTS IN FLOW 2:**

1. **Line 2.3.4 (UPDATE action)**: Old `stroke-y-bounds` properties overwritten with new values
2. **Line 2.3.5 (Re-match)**: Strokes may be assigned to different blocks if Y-bounds shifted
3. **Line 2.3.6 (Update blockUuid)**: Old stroke→block associations overwritten

---

### Flow 3: Load Existing Page

```
┌────────────────────────────────────────────────────────────────────┐
│ LOAD FROM LOGSEQ                                                   │
└────────────────────────────────────────────────────────────────────┘

User loads previously saved page
    ├─ LogSeqDbTab: Click "Lazy Import"
    ├─ logseq-import.js: loadPageStrokesIntoStore() (line 22-152)
    │
    ├─ 1. Fetch page from LogSeq
    │    └─ logseq-api.js: getPageStrokes()
    │       ├─ Find "Raw Stroke Data" section
    │       ├─ Parse chunks
    │       └─ Returns strokes[] with blockUuid intact
    │
    ├─ 2. Load strokes into store
    │    └─ loadStrokesFromStorage() (line 250-271)
    │       ├─ convertFromStorageFormat() - restore full format
    │       ├─ Deduplicate by stroke.id
    │       └─ strokes.js: addStroke()
    │          └─ Strokes added WITH blockUuid preserved
    │
    ├─ 3. Fetch transcription blocks (optional)
    │    └─ getTranscriptBlocks()
    │       └─ Returns blocks with properties
    │
    └─ Result: Strokes have blockUuid associations from storage
```

---

## Storage Format Evolution

### Version 1.0 (Deprecated)

**Format:** Single code block with all text

```
smartpen/B3017/P42
├─ properties:: ...
├─ ## Raw Stroke Data
│  └─ [stroke data]
└─ ## Transcribed Text
   └─ ```
      - Line 1
      - Line 2
      - Line 3
      ```
```

**Problems:**
- All transcription in single code block
- User edits lost on re-transcription
- No stroke→block associations
- No incremental updates

**Migration:** Cannot auto-migrate; users must re-transcribe

---

### Version 2.0 (Initial Block-by-Block)

**Format:** Individual blocks, minimal properties

```
## Transcribed Content
├─ Line 1
│  └─ stroke-y-bounds:: 245.0-260.0
├─ Line 2
└─ Line 3
```

**Improvements:**
- Individual blocks for each line
- Y-bounds for matching
- TODO/DONE preservation

**Problems:**
- No stroke ID tracking
- No canonical text for change detection
- Re-transcription recreated all blocks

---

### Version 3.0 (Current)

**Format:** Enhanced properties for tracking

```
## Transcribed Content #Display_No_Properties
├─ Line 1
│  ├─ stroke-y-bounds:: 245.0-260.0
│  ├─ stroke-ids:: s1640000000000,s1640000001500
│  └─ canonical-transcript:: line1
├─ Line 2
└─ Line 3
```

**Improvements:**
- Stroke ID tracking for reliable matching
- Canonical text for change detection
- Bidirectional stroke↔block associations
- Better merge/split support

**Current Problems (Being Fixed):**
- Y-bounds reset on update
- Stroke reassignment on re-transcription
- Entire transcript re-created instead of appending

---

## Update Strategies

### Strategy 1: Stroke ID Matching (Primary)

**Algorithm:**
```javascript
// detectBlockActions() line 286-328
for (const existingBlock of existingBlocks) {
  const blockStrokeIds = parseStrokeIds(block.properties['stroke-ids']);

  for (const line of transcriptionLines) {
    const lineStrokeIds = new Set(line.strokeIds);
    const overlap = intersection(blockStrokeIds, lineStrokeIds);
    const overlapRatio = overlap.size / lineStrokeIds.size;

    if (overlapRatio > 0.5) {
      // Match found
      if (canonicalText(line) === block.properties['canonical-transcript']) {
        action = 'SKIP';  // No changes
      } else {
        action = 'UPDATE';  // Text changed
      }
    }
  }
}
```

**Advantages:**
- Reliable: Stroke IDs don't change
- Works even if Y-bounds shift
- Handles line reordering

**Disadvantages:**
- Requires strokes to have IDs
- First transcription has no stroke-ids property in blocks
- Deleted strokes break associations

---

### Strategy 2: Y-Bounds Matching (Fallback)

**Algorithm:**
```javascript
// detectBlockActions() line 343-355
for (const line of unmatchedLines) {
  const blockYBounds = parseYBounds(block.properties['stroke-y-bounds']);
  const overlap = calculateOverlap(line.yBounds, blockYBounds);

  if (overlap > 5) {  // Tolerance = 5 units
    // Potential match
  }
}
```

**Advantages:**
- Works without stroke ID tracking
- Geographic proximity matching
- Handles merged lines

**Disadvantages:**
- Unreliable if handwriting shifted
- Small tolerance (5 units) may miss matches
- Doesn't handle line reordering

---

### Strategy 3: Canonical Text Comparison

**Algorithm:**
```javascript
// canonicalTranscript() line 398-409
function canonicalTranscript(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')  // Remove punctuation, spaces
    .trim();
}

if (canonical(newText) === block.properties['canonical-transcript']) {
  action = 'SKIP';
}
```

**Advantages:**
- Detects unchanged text
- Preserves user edits in LogSeq
- Fast comparison

**Disadvantages:**
- Collisions possible (different texts, same canonical)
- Doesn't detect formatting changes
- Spelling corrections have same canonical form

---

## Known Issues & Data Loss Points

> **Update 2026-02-09:** Critical stroke deletion issue (Issue #6) has been RESOLVED in v3.1.
> See commits 0a836ac and 8c129a8 for fixes.

### Issue 1: Y-Bounds Reset on Update ✅ FIXED (commit 8c129a8)

**Location:** `transcript-updater.js` line 630-655 (UPDATE action execution)

**Problem:**
```javascript
// When updating existing block
await updateTranscriptBlockWithPreservation(
  blockUuid,
  line.text,
  {
    'stroke-y-bounds': formatBounds(line.yBounds),  // ← NEW Y-bounds
    'stroke-ids': line.strokeIds.join(','),
    'canonical-transcript': canonicalTranscript(line.text)
  },
  host, token
);
```

**Result:** Old Y-bounds lost, replaced with new MyScript values

**Impact:**
- On next update, Y-bounds matching may fail
- Strokes may match to wrong blocks
- User loses ability to incrementally update

**Fix (2026-02-09):** `transcript-updater.js` now preserves existing Y-bounds during updates.
Properties are merged rather than replaced, maintaining stroke-to-block associations.

**Example:**
```
Initial save:     stroke-y-bounds: 245.0-260.0
User adds stroke: MyScript returns 243.0-262.0 (slightly different)
Update executed:  stroke-y-bounds: 243.0-262.0  ← OLD BOUNDS LOST
```

---

### Issue 2: Stroke Reassignment on Re-Transcription ⚠️ CRITICAL

**Location:** `transcript-updater.js` line 755-779

**Problem:**
```javascript
// After updating blocks, re-match ALL strokes
const strokeToBlockMap = matchStrokesToLines(
  activeStrokes,
  linesWithBlocks,
  5  // tolerance
);

// Update ALL strokes with new blockUuid
updateStrokeBlockUuids(strokeToBlockMap);

// RE-SAVE strokes with updated blockUuid
await updatePageStrokes(book, page, pageStrokes, host, token);
```

**Result:** Strokes that ALREADY have blockUuid get reassigned

**Impact:**
- Breaks user's manual edits in LogSeq
- Strokes may move to different blocks
- Loss of stroke→block history

**Example:**
```
Initial:       Stroke A → Block 1 (blockUuid: "abc")
User edits:    Block 1 content manually corrected
Re-transcribe: Stroke A Y-range now overlaps Block 2 more
Result:        Stroke A → Block 2 (blockUuid: "xyz")  ← LOST ASSOCIATION
```

---

### Issue 3: Entire Transcript Re-Created Instead of Appending ⚠️ CRITICAL

**Location:** `transcript-updater.js` line 580-681 (Block action execution)

**Problem:**
```javascript
// Process ALL actions (CREATE, UPDATE, SKIP, DELETE)
for (const action of actions) {
  if (action.action === 'CREATE') {
    // Creates new block even if stroke already has blockUuid
  }
}
```

**Result:** Strokes with blockUuid=null trigger CREATE, even for edited lines

**Impact:**
- Duplicate blocks created
- User's corrected spelling appears as new block
- Old block not updated, new block created

**Example:**
```
Initial save:
  Block 1: "Meting notes" (stroke S1, S2, S3)
  User corrects: "Meeting notes" in LogSeq

User adds stroke S4 nearby:
  Re-transcribe returns: "Meeting notes" (strokes S1, S2, S3, S4)
  System creates NEW block: "Meeting notes"
  Old block: "Meeting notes" (user's correction) preserved but orphaned
  Result: TWO blocks with "Meeting notes"
```

---

### Issue 4: Merge Loses Block UUIDs

**Location:** `TranscriptionEditorModal.svelte` line 62-74

**Problem:**
```javascript
const mergedLine = {
  text: linesToMerge.map(l => l.text).join(' '),
  yBounds: {
    minY: Math.min(...linesToMerge.map(l => l.yBounds.minY)),
    maxY: Math.max(...linesToMerge.map(l => l.yBounds.maxY))
  },
  blockUuid: linesToMerge[0].blockUuid,  // ← ONLY FIRST UUID
  strokeIds: [...allStrokeIds],
  syncStatus: 'modified'
};
```

**Result:** UUIDs from lines 2, 3, ... are lost

**Impact:**
- Those blocks become orphans
- Next save may not find them
- Potential duplicate blocks created

---

### Issue 5: Orphan Block Auto-Deletion

**Location:** `transcript-updater.js` line 687-738

**Problem:**
```javascript
const orphanedBlocks = existingBlocks.filter(b =>
  !usedBlockUuids.has(b.uuid)
);

for (const block of orphanedBlocks) {
  const strokeIdsStr = block.properties['stroke-ids'];

  if (!strokeIdsStr) {
    // No stroke IDs - don't delete (safe default)
    continue;
  }

  // Check if strokes still exist
  const strokeIds = strokeIdsStr.split(',');
  const allGone = strokeIds.every(id => !strokeMap.has(id));

  if (allGone) {
    await removeBlock(block.uuid);  // ← AUTOMATIC DELETION
  }
}
```

**Result:** Blocks deleted if all their strokes are gone

**Impact:**
- User deletes strokes, blocks auto-deleted
- Loss of user's manual edits
- No undo capability
- Unexpected for users

---

### Issue 6: Phantom Stroke Deletions ✅ FIXED (commit 0a836ac)

**Location:** `logseq-api.js` line 673-803 (`updatePageStrokesSingle()`)

**Problem (v3.0):**
```javascript
// Old arithmetic deletion detection
deletedCount = Math.max(0, existingData.strokes.length - simplifiedStrokes.length);
allStrokes = simplifiedStrokes;  // ← REPLACES all LogSeq data
```

**Result:** Missing strokes from canvas treated as deletions

**Impact:**
- Partial imports + save = data loss
- Unloaded strokes deleted from LogSeq
- Users lose historical stroke data
- No way to incrementally add strokes

**Example:**
```
LogSeq has: 200 strokes
Canvas loads: 50 strokes (last import)
User saves: 150 strokes DELETED from LogSeq
```

**Fix (v3.1 - 2026-02-09):**
```javascript
// Explicit deletion tracking via pending-changes.js
const deletedStrokeIds = getDeletedStrokeIdsForPage(book, page);

// v3.1 APPEND-ONLY:
// 1. Start from existingData.strokes as base
// 2. Remove ONLY strokes in deletedStrokeIds
// 3. Append new strokes (deduplicated)
// 4. Update blockUuid on existing strokes if changed

mergedStrokes = existingData.strokes.filter(s => !deletedStrokeIds.has(s.id));
const uniqueNew = deduplicateStrokes(mergedStrokes, simplifiedStrokes);
allStrokes = [...mergedStrokes, ...uniqueNew];
```

**Benefits:**
- Missing strokes ≠ deleted strokes
- Explicit deletion tracking in `deletedIndices` store
- Safe partial imports
- Incremental stroke additions work correctly
- User has 15-minute undo window for deletions

---

### Issue 7: No Atomic Transactions

**Problem:** Save operations are multi-step:
1. Save strokes
2. Update blocks
3. Re-match strokes
4. Re-save strokes

If any step fails, data is inconsistent.

**Impact:**
- Partial saves leave mismatched data
- No rollback capability
- Manual recovery required

---

## Requirements for Fix

### Requirement 1: Preserve Existing Transcribed Blocks

**Goal:** Blocks with user edits should never be modified on re-transcription

**Implementation:**
```javascript
// If stroke already has blockUuid, SKIP re-matching
if (stroke.blockUuid && existingBlocks.find(b => b.uuid === stroke.blockUuid)) {
  // Do not reassign this stroke
  // Do not update this block's Y-bounds
  // Only create blocks for strokes with blockUuid=null
}
```

**Benefits:**
- User's spelling corrections preserved
- TODO/DONE states preserved
- Manual formatting preserved
- No duplicate blocks

---

### Requirement 2: Append-Only for New Strokes

**Goal:** Only strokes without blockUuid should create new blocks

**Implementation:**
```javascript
const newStrokes = activeStrokes.filter(s => !s.blockUuid);
const transcription = await transcribeStrokes(newStrokes);  // Only new ones

for (const line of transcription.lines) {
  // All lines are new, all actions are CREATE
  const newBlock = await createTranscriptBlockWithProperties(...);

  // Match only newStrokes to newBlocks
  const strokeToBlockMap = matchStrokesToLines(newStrokes, [line]);
  updateStrokeBlockUuids(strokeToBlockMap);
}
```

**Benefits:**
- Existing blocks untouched
- No re-matching of old strokes
- Incremental updates work correctly

---

### Requirement 3: Preserve Y-Bounds for Existing Blocks

**Goal:** Y-bounds should only be set on CREATE, never on UPDATE

**Implementation:**
```javascript
if (action.action === 'UPDATE') {
  // Do NOT update stroke-y-bounds property
  await updateTranscriptBlockWithPreservation(
    blockUuid,
    line.text,
    {
      // stroke-y-bounds: OMIT (keep existing value)
      'stroke-ids': line.strokeIds.join(','),  // Update if strokes added
      'canonical-transcript': canonicalTranscript(line.text)
    }
  );
}
```

**Benefits:**
- Y-bounds remain stable
- Matching stays consistent
- No drift over time

---

### Requirement 4: Prevent Duplicate Blocks

**Goal:** Never create two blocks with same canonical text

**Implementation:**
```javascript
// Before CREATE, check if canonical text already exists
const existingCanonical = existingBlocks.map(b =>
  b.properties['canonical-transcript']
);

if (existingCanonical.includes(canonicalTranscript(line.text))) {
  // SKIP - block already exists (user may have edited)
  continue;
}
```

**Benefits:**
- No duplicate "Meeting notes" blocks
- Cleaner LogSeq pages
- Less confusion for users

---

### Requirement 5: Smarter Merge Handling

**Goal:** When merging lines, preserve ALL block UUIDs

**Implementation:**
```javascript
const mergedLine = {
  text: linesToMerge.map(l => l.text).join(' '),
  yBounds: expandedBounds,
  blockUuids: linesToMerge.map(l => l.blockUuid).filter(Boolean),  // Array!
  strokeIds: [...allStrokeIds],
  syncStatus: 'modified'
};

// On save, update all blocks or consolidate
if (mergedLine.blockUuids.length > 1) {
  // Option A: Keep first block, delete others
  // Option B: Keep all blocks, update each
  // Option C: Ask user
}
```

**Benefits:**
- No lost block associations
- Clear merge behavior
- User control over consolidation

---

### Requirement 6: User Control Over Block Deletion

**Goal:** Never auto-delete blocks without user confirmation

**Implementation:**
```javascript
// Instead of auto-delete, mark as orphaned
const orphanedBlocks = [];

for (const block of existingBlocks) {
  if (!usedBlockUuids.has(block.uuid)) {
    orphanedBlocks.push(block);
  }
}

if (orphanedBlocks.length > 0) {
  // Show dialog: "Found X orphaned blocks. Delete?"
  const confirmed = await askUser(...);

  if (confirmed) {
    for (const block of orphanedBlocks) {
      await removeBlock(block.uuid);
    }
  }
}
```

**Benefits:**
- User aware of deletions
- Can recover from mistakes
- Explicit control

---

### Requirement 7: Atomic Save Operations

**Goal:** All-or-nothing saves with rollback on failure

**Implementation:**
```javascript
// Pseudo-code for transaction
const transaction = new SaveTransaction();

try {
  transaction.begin();

  const strokesSaved = await transaction.saveStrokes(...);
  const blocksSaved = await transaction.saveBlocks(...);
  const mappingSaved = await transaction.saveMapping(...);

  transaction.commit();
} catch (error) {
  transaction.rollback();  // Restore to previous state
  throw error;
}
```

**Benefits:**
- No partial saves
- Data consistency guaranteed
- Easier error recovery

**Note:** LogSeq HTTP API doesn't support transactions natively. Would need application-level implementation with backup/restore.

---

## Summary

The current implementation has critical data loss issues:

1. **Y-bounds reset** on every update
2. **Stroke reassignment** on re-transcription
3. **Entire transcript re-created** instead of appending
4. **Merge loses blockUuids** for all but first block
5. **Auto-deletion** of orphaned blocks
6. **No atomic transactions** for consistency

The fix requires:

1. **Preserve existing blocks** - never update if stroke has blockUuid
2. **Append-only mode** - only transcribe strokes without blockUuid
3. **Immutable Y-bounds** - set once on CREATE, never UPDATE
4. **Duplicate prevention** - check canonical text before CREATE
5. **Multi-UUID merge** - track all merged block UUIDs
6. **User-controlled deletion** - confirm before removing blocks
7. **Transaction safety** - all-or-nothing saves

These changes will enable true incremental updates while preserving user edits in LogSeq.
