# Claude Development Guide

This document provides context for AI assistants (like Claude) working on the smartpen-logseq-bridge project.

## Project Overview

**smartpen-logseq-bridge** is a sophisticated web application that bridges NeoSmartpen (Lamy Safari) devices with LogSeq's knowledge management system. It enables real-time stroke capture, handwriting recognition, advanced stroke manipulation, and seamless LogSeq integration.

**Tech Stack:**
- **Frontend**: Svelte 4 (reactive components)
- **Build Tool**: Vite
- **Pen Integration**: web_pen_sdk (NeoSmartpen Web SDK)
- **Handwriting Recognition**: MyScript Cloud API
- **Knowledge Management**: LogSeq HTTP API
- **Browser APIs**: Web Bluetooth API, Canvas API

## Architecture

### Component Hierarchy
```
App.svelte (Root)
├── Header
│   ├── PenControls (Connect, Fetch, Transcribe)
│   ├── ActionBar (Save to LogSeq, Clear)
│   └── SettingsDropdown (MyScript, LogSeq, Book Aliases)
├── LeftPanel
│   ├── Data Explorer (Tabbed Interface)
│   │   ├── StrokeList (Browse by book/page)
│   │   ├── TranscriptionView (View transcribed text)
│   │   ├── LogSeqDbTab (Database browser)
│   │   └── RawJsonViewer (Technical inspection)
│   └── ActivityLog (Real-time feedback)
└── StrokeCanvas
    ├── Canvas Renderer (Drawing engine)
    ├── CanvasControls (Zoom, fit, reset)
    ├── PageSelector (Multi-page filtering)
    └── FilteredStrokesPanel (Decorative strokes)
```

### State Management (Svelte Stores)

All state is managed through Svelte stores located in `src/stores/`:

**Core Data:**
- `strokes.js` - All captured strokes from pen
- `selection.js` - Selected stroke indices and selection state
- `clipboard.js` - Copied strokes for duplication
- `pasted-strokes.js` - Duplicated/pasted strokes management

**Transcription:**
- `transcription.js` - MyScript transcription results and cache
- Page-level transcription data with hierarchy

**LogSeq Integration:**
- `logseqPages.js` - Scanned database pages
- `storage.js` - Save status tracking and sync state
- `book-aliases.js` - Custom book name mappings

**UI State:**
- `ui.js` - Active tab, canvas zoom, UI preferences
- `page-order.js` - Custom page positioning/layout
- `page-scale.js` - Per-page scaling factors
- `pen.js` - Pen connection state and battery info

**Advanced:**
- `filtered-strokes.js` - Decorative element detection
- `pending-changes.js` - Tracks local changes before sync (deletions, additions per page)
  - `deletedIndices` - Set of stroke indices marked for deletion
  - `pendingChanges` - Derived store computing additions/deletions per page
  - `getDeletedStrokeIdsForPage()` - Converts indices to stroke IDs for API calls
- `settings.js` - Persisted user settings (MyScript keys, LogSeq config)

### Key Libraries

**Core Logic (`src/lib/`):**
- `pen-sdk.js` - NeoSmartpen SDK wrapper and BLE communication
- `canvas-renderer.js` - Canvas drawing engine for stroke visualization
- `myscript-api.js` - MyScript API client for handwriting recognition
- `logseq-api.js` - LogSeq HTTP API client
- `logseq-scanner.js` - Database scanning for existing smartpen pages
- `logseq-import.js` - Page import logic from LogSeq
- `stroke-analyzer.js` - Shape detection and analysis
- `stroke-filter.js` - Decorative element detection (boxes, underlines)
- `stroke-storage.js` - Storage utilities for LogSeq persistence
- `transcript-search.js` - Full-text search across transcriptions
- `transcript-updater.js` - Transcription update logic

## Data Structures

### Stroke Format
```javascript
{
  pageInfo: {
    section: number,      // Ncode section
    owner: number,        // Ncode owner
    book: number,         // Notebook ID
    page: number          // Page number
  },
  startTime: number,      // Unix timestamp (ms)
  endTime: number,        // Unix timestamp (ms)
  dotArray: [
    {
      x: number,          // Ncode X coordinate
      y: number,          // Ncode Y coordinate
      f: number,          // Pressure (force)
      timestamp: number   // Dot timestamp (ms)
    }
  ]
}
```

### Transcription Result
```javascript
{
  text: "Full transcribed text with\nline breaks",
  strokeCount: number,
  pageInfo: { section, owner, book, page },
  lines: [
    {
      text: "Line content",
      indentLevel: 0,        // 0, 1, 2, etc.
      parent: null,          // Index of parent line
      children: [1, 2],      // Indices of child lines
      x: 10.5,               // Leftmost position
      baseline: 25.3,        // Y position
      words: [...]           // Word-level data
    }
  ],
  commands: [
    {
      command: "page",
      value: "Meeting Notes",
      lineIndex: 0
    }
  ]
}
```

### LogSeq Storage Format
```
smartpen/B3017/P42
  properties::
    book:: 3017
    page:: 42
    section:: 3
    owner:: 1012
    timestamp:: 2024-12-22T10:30:00Z
    stroke-count:: 247

  transcription:: This is the transcribed text
  with multiple lines and proper indentation

  stroke-data:: [JSON array of stroke objects]
```

## Development Guidelines

### Code Style
1. **Svelte Components**: Follow Svelte 4 best practices
   - Use `$:` for reactive statements
   - Prefer stores over prop drilling
   - Keep components focused and single-purpose

2. **State Management**: Always use stores for shared state
   - Never pass stores as props (import them directly)
   - Use derived stores for computed values
   - Persist important state to localStorage via settings.js

3. **Async Operations**: Handle errors gracefully
   - Show user feedback in ActivityLog
   - Use try/catch blocks
   - Display progress for long operations

4. **Canvas Operations**: Performance is critical
   - Optimize rendering for >1000 strokes
   - Use requestAnimationFrame for animations
   - Debounce expensive operations

### File Organization

**Components** (`src/components/`):
- Group by feature area (canvas, dialog, header, etc.)
- Keep components under 300 lines when possible
- Extract reusable UI into shared components

**Stores** (`src/stores/`):
- One store per concern
- Export both store and helper functions
- Document store shape in comments

**Libraries** (`src/lib/`):
- Pure business logic, no UI
- Fully testable without DOM
- Clear API boundaries

### Common Patterns

**Adding a new feature:**
1. Create/update relevant stores in `src/stores/`
2. Add business logic to `src/lib/`
3. Create UI components in `src/components/`
4. Wire up in App.svelte or parent component
5. Update ActivityLog for user feedback
6. Consider persistence needs (settings.js)

**Working with strokes:**
```javascript
import { strokes } from './stores/strokes.js';
import { selection } from './stores/selection.js';

// Get selected strokes
const selectedStrokes = $strokes.filter((_, i) => $selection.has(i));

// Manipulate and update
strokes.update(s => [...s, newStroke]);
```

**Calling LogSeq API:**
```javascript
import { logseqApi } from '../lib/logseq-api.js';
import { addLog } from '../stores/ui.js';

try {
  await logseqApi.createPage('smartpen/B3017/P42', content);
  addLog('success', 'Page saved successfully');
} catch (error) {
  addLog('error', `Failed to save: ${error.message}`);
}
```

## Important Implementation Notes

### Web Bluetooth Constraints
- **Only works in Chrome/Edge** (not Firefox/Safari)
- **Requires HTTPS** (or localhost for development)
- User must explicitly pair via browser dialog
- Connection can drop; implement reconnection logic

### Canvas Coordinate System
- Ncode coordinates are in pen's coordinate space (typically 0-15000 range)
- Canvas coordinates are scaled and translated for display
- Page positioning is customizable (stored in pagePositions store)
- Page scaling is per-page (stored in pageScales store)

### MyScript API Limitations
- **2,000 requests/month** on free tier
- Rate limiting applies
- Requires HMAC authentication
- Process strokes page-by-page to avoid overwhelming API

### LogSeq API Patterns
- Uses HTTP API (default port 12315)
- Optional authorization token
- Pages organized in `smartpen/B###/P##` format
- Stroke data stored as JSON in `stroke-data` property
- Transcription stored in `transcription` property

### Stroke Persistence Strategy (v3.1 Append-Only)
- **Append-Only Updates**: LogSeq saves start from existing strokes as base, never replace entire dataset
- **Explicit Deletions Only**: Deletions tracked in `pending-changes.js` via `deletedIndices` store
- **No Phantom Deletions**: Missing strokes from canvas ≠ deleted strokes in LogSeq
- **Stroke IDs**: Format `s{startTime}` for deduplication (see `src/lib/stroke-storage.js`)
- **BlockUuid Tracking**: Each stroke links to its LogSeq block UUID for bi-directional sync
- **Duplicated Strokes**: Temporary strokes (isDuplicated: true) can be converted to original when creating new pages
- **Deletion Timeout**: 15-minute undo window for deleted strokes (see `pending-changes.js`)

## Known Issues and Gotchas

1. **Stroke Deduplication**: Uses timestamp-based IDs (`s{startTime}`) to avoid duplicates when importing from LogSeq. See `stroke-storage.js` for implementation.

2. **Append-Only Updates**: Save operations NEVER replace entire LogSeq datasets. Always start from existing strokes and only apply explicit changes (additions/deletions).

3. **Deletion Tracking**: Deletions are tracked via `pending-changes.js` store (`deletedIndices`). The `getDeletedStrokeIdsForPage()` function converts indices to stroke IDs for LogSeq API calls.

4. **Page Coordinate Fuzzy Matching**: LogSeq import uses fuzzy matching for section/owner to handle Ncode variations. Focus on book/page for uniqueness.

5. **Memory Management**: Large stroke datasets (>2000 strokes) can impact canvas performance. Use page filtering to reduce visible strokes.

6. **LocalStorage Limits**: Settings, page positions, and scales persist to localStorage. Monitor size (~5MB typical limit).

7. **Deletion Undo Timeout**: Stroke deletions have a 15-minute timeout for undo capability. After timeout, deletions are permanent once saved to LogSeq.

## Testing Considerations

When making changes, consider testing:
- Pen connection/disconnection flows
- Offline sync from pen memory
- Real-time stroke capture
- Selection (box, individual, keyboard shortcuts)
- Duplication and dragging strokes
- Page creation from duplicates
- Transcription with MyScript
- LogSeq save/load operations
- Database scanning and search
- Canvas pan/zoom/navigation
- Page positioning and scaling
- Browser compatibility (Chrome/Edge only)

## Useful Commands

```bash
# Development server (localhost:3000)
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

## Resources

### Primary Documentation
- [README.md](README.md) - User-facing documentation
- [docs/QUICK-ARCHITECTURE-REFERENCE.md](docs/QUICK-ARCHITECTURE-REFERENCE.md) - **START HERE** - Quick v3.1 reference
- [docs/app-specification.md](docs/app-specification.md) - Complete technical specification
- [docs/TRANSCRIPT-STORAGE-SPEC.md](docs/TRANSCRIPT-STORAGE-SPEC.md) - Transcript storage v3.1 architecture

### Implementation Details
- [docs/Archive/2026-02-data-loss-fixes/DATA-LOSS-FIXES-SUMMARY.md](docs/Archive/2026-02-data-loss-fixes/DATA-LOSS-FIXES-SUMMARY.md) - Recent fixes (Feb 2026)
- [docs/bridge-uuid-system.md](docs/bridge-uuid-system.md) - Custom UUID system documentation
- [docs/Archive/ARCHIVE-INDEX.md](docs/Archive/ARCHIVE-INDEX.md) - Archived implementation docs index

### External APIs
- [NeoSmartpen Web SDK](https://github.com/NeoSmartpen/WEB-SDK2.0) - SDK documentation
- [MyScript API Docs](https://developer.myscript.com/) - Handwriting recognition API
- [LogSeq HTTP API](https://logseq.github.io/plugins/) - Plugin and API documentation
- [Svelte 4 Docs](https://svelte.dev/docs/svelte/overview) - Framework reference

## Recent Changes (Git History Context)

### Major Fixes (February 2026)

**Data Loss Prevention (commit 0a836ac):**
- Fixed stroke deletion to be explicit only (no phantom deletions from partial imports)
- Updated `updatePageStrokesSingle()` to use append-only strategy
- Changed deletion counting from arithmetic (`existing - current`) to explicit tracking via `deletedStrokeIds`
- Stroke saves now preserve all LogSeq data unless explicitly marked for deletion in `pending-changes.js`

**Edit Structure UI Overhaul (commit 0a836ac):**
- Converted TranscriptionEditorModal to single-column layout
- Improved visual hierarchy and editing experience
- Fixed deletion counts in SaveConfirmDialog to use explicit deletion tracking

**Y-Bounds Preservation (commit 8c129a8):**
- Fixed transcript updates to preserve Y-bounds properties
- Ensures stroke-to-block matching data survives LogSeq round-trips

### Earlier Work
- Electron desktop app conversion (electron/ directory, vite.config.js updates)
- Hierarchical block creation order fix (parent blocks before children)
- Transcript data loss fixes (Y-bounds, blockUuid preservation, merge logic)
- BlockUUID over-assignment bug fix (scoping transcription to correct strokes)
- Persistent UUID implementation to avoid duplicate strokes
- Custom UUID system to avoid conflicts with pen SDK
- Transcript storage v3.0 architecture (see `docs/TRANSCRIPT-STORAGE-SPEC.md`)

When working with stroke management or transcription storage, be aware of these architectural changes.

## Questions to Ask Before Major Changes

1. **State**: Which stores need to be updated? Should state persist to localStorage?
2. **Performance**: Will this impact canvas rendering with 1000+ strokes?
3. **User Feedback**: Should this operation show progress or log messages?
4. **Error Handling**: What happens if LogSeq/MyScript API fails?
5. **Persistence**: Should this survive page refresh? Where is it stored?
6. **Browser Compatibility**: Does this rely on Chrome-specific APIs?

## Tips for Working with This Codebase

- **Start with stores**: Understanding the data model is key to understanding the app
- **Follow the data flow**: Pen → Strokes → Canvas/Transcription → LogSeq
- **Check ActivityLog**: Most operations log their progress for debugging
- **Use browser DevTools**: Stores are debuggable in Svelte DevTools extension
- **Test with real pen**: Some behaviors only manifest with actual hardware
- **Reference docs**: app-specification.md has detailed technical documentation
