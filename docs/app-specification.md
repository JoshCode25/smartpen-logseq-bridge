# SmartPen-LogSeq Bridge - Technical Specification

**Version:** 0.2.0 (Svelte 4)  
**Last Updated:** December 2024  
**Status:** Functional MVP with real-time capture, offline sync, and MyScript transcription

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Pen Data: Raw Format and Meaning](#pen-data-raw-format-and-meaning)
4. [Data Flow and Processing](#data-flow-and-processing)
5. [MyScript API Integration](#myscript-api-integration)
6. [LogSeq HTTP API Integration](#logseq-http-api-integration)
7. [Current Features](#current-features)
8. [Future Plans: Command Support](#future-plans-command-support)
9. [Technical Requirements](#technical-requirements)
10. [Appendix: Store Architecture](#appendix-store-architecture)

---

## Overview

### Purpose

The SmartPen-LogSeq Bridge is a web application that captures handwritten notes from a NeoSmartpen (Lamy Safari / NWP-F80), converts them to searchable text using MyScript's cloud-based handwriting recognition, and imports them into LogSeq while preserving hierarchical structure (indentation).

### Why This Exists

Handwritten notes offer cognitive benefits over typing, but they're not searchable or easily integrated into digital knowledge management systems. This bridge solves that problem by:

1. **Capturing** handwriting data from a smartpen via Bluetooth
2. **Converting** strokes to structured text with line/indent detection
3. **Importing** into LogSeq with proper block hierarchy
4. **Enabling** future command processing (e.g., `[page: Meeting Notes]`) to route content

### Design Philosophy

- **Trust proven APIs**: MyScript's line detection is superior to custom algorithms—we use their newline detection rather than reimplementing baseline grouping
- **Preserve hierarchy**: Indentation in handwriting translates to parent-child block relationships in LogSeq
- **Transparent processing**: Users can see raw strokes, transcription results, and LogSeq preview before sending
- **Stable toolchain**: Using Svelte 4 (not 5) to avoid breaking changes during active development

---

## Architecture

### High-Level Data Flow

```
┌──────────────────┐                    ┌─────────────────────────────────────────────────────┐
│   NeoSmartpen    │                    │              Bridge Application                     │
│   (Lamy F80)     │                    │                                                     │
│                  │    Bluetooth       │  ┌─────────┐    ┌──────────┐    ┌───────────────┐  │
│  ┌────────────┐  │    Web API         │  │ Pen SDK │───►│ Strokes  │───►│ Canvas        │  │
│  │ Ncode Dots │──┼───────────────────►│  │ Wrapper │    │ Store    │    │ Renderer      │  │
│  │ Pressure   │  │                    │  └─────────┘    └────┬─────┘    └───────────────┘  │
│  │ Timestamps │  │                    │                      │                             │
│  └────────────┘  │                    │                      ▼                             │
└──────────────────┘                    │               ┌──────────────┐                     │
                                        │               │ MyScript API │                     │
                                        │               │ (Cloud)      │                     │
                                        │               └──────┬───────┘                     │
                                        │                      │                             │
                                        │                      ▼                             │
                                        │  ┌─────────────────────────────────────────────┐  │
                                        │  │           Transcription Store               │  │
                                        │  │  • Raw text with \n line breaks             │  │
                                        │  │  • Words with bounding boxes                │  │
                                        │  │  • Lines with X position → indent level     │  │
                                        │  │  • Parent/child hierarchy                   │  │
                                        │  │  • Detected [command: value] patterns       │  │
                                        │  └──────────────────────┬──────────────────────┘  │
                                        │                         │                         │
                                        │                         ▼                         │
                                        │                  ┌─────────────┐                  │
                                        │                  │ LogSeq API  │                  │
                                        │                  │ (HTTP)      │                  │
                                        │                  └──────┬──────┘                  │
                                        └─────────────────────────┼─────────────────────────┘
                                                                  │
                                                                  ▼
                                                         ┌───────────────┐
                                                         │    LogSeq     │
                                                         │  (localhost)  │
                                                         └───────────────┘
```

### Component Architecture (Svelte 4)

```
src/
├── App.svelte                    # Root component, global styles
├── main-svelte.js                # Entry point, polyfill loading
│
├── components/
│   ├── layout/
│   │   ├── Header.svelte         # App header
│   │   ├── Sidebar.svelte        # Left panel (pen, settings, log)
│   │   ├── TabContainer.svelte   # Right panel (data explorer tabs)
│   │   └── ActivityLog.svelte    # Message log display
│   │
│   ├── canvas/
│   │   ├── StrokeCanvas.svelte   # Main canvas with pan/zoom
│   │   └── CanvasControls.svelte # Zoom buttons
│   │
│   ├── pen/
│   │   ├── PenControls.svelte    # Connect/disconnect buttons
│   │   └── PenInfo.svelte        # Battery, model display
│   │
│   ├── settings/
│   │   ├── MyScriptSettings.svelte   # API keys, transcribe button
│   │   └── LogseqSettings.svelte     # Host, token, send button
│   │
│   ├── strokes/
│   │   ├── StrokeList.svelte     # Stroke list with selection
│   │   ├── StrokeItem.svelte     # Individual stroke display
│   │   ├── SelectionInfo.svelte  # Selection count, select all
│   │   ├── AnalysisView.svelte   # Stroke analysis data
│   │   └── RawJsonViewer.svelte  # Raw JSON display
│   │
│   └── transcription/
│       ├── TranscriptionView.svelte  # Main transcription display
│       ├── LineDisplay.svelte        # Single line with indent
│       ├── CommandList.svelte        # Detected commands
│       ├── HierarchyTree.svelte      # Visual hierarchy
│       └── LogseqPreview.svelte      # LogSeq-formatted preview
│
├── stores/
│   ├── index.js              # Re-exports all stores
│   ├── strokes.js            # Stroke data, pages map
│   ├── selection.js          # Selected stroke indices
│   ├── pen.js                # Connection state, pen info
│   ├── transcription.js      # Transcription results
│   ├── settings.js           # API keys, connection status
│   └── ui.js                 # Active tab, zoom, log messages
│
├── lib/
│   ├── pen-sdk.js            # NeoSmartpen SDK wrapper
│   ├── canvas-renderer.js    # Canvas drawing, pan/zoom
│   ├── myscript-api.js       # MyScript API wrapper
│   ├── logseq-api.js         # LogSeq API wrapper
│   ├── polyfills.js          # Buffer/process for web_pen_sdk
│   └── zlib-shim.js          # Pako-based zlib for browser
│
└── [legacy .js files]        # Original vanilla JS (kept for reference)
```

---

## Pen Data: Raw Format and Meaning

### Ncode Coordinate System

NeoSmartpens write on special "Ncode" paper that has an invisible dot pattern. The pen's camera reads this pattern to determine precise position. Coordinates are reported in Ncode units.

**Conversion Factor:** `1 Ncode unit × 2.371 = 1 millimeter`

### Dot Data (Real-time)

When writing, the pen sends individual dots via Bluetooth:

```javascript
{
  x: 234.567,           // X position in Ncode units
  y: 123.456,           // Y position in Ncode units  
  f: 512,               // Force/pressure (0-1000 typical range)
  dotType: 0|1|2|3,     // See below
  timeStamp: 1765403005055,  // Unix timestamp (milliseconds)
  pageInfo: {
    section: 3,         // Ncode section (paper manufacturer)
    owner: 27,          // Owner code (paper product line)
    book: 161,          // Notebook ID
    page: 1             // Page number within notebook
  }
}
```

**Dot Types:**
- `0` = Pen Down (stroke start)
- `1` = Pen Move (mid-stroke)
- `2` = Pen Up (stroke end)
- `3` = Hover (pen near paper but not touching)

### Stroke Data (Aggregated)

Dots are aggregated into strokes by the app:

```javascript
{
  pageInfo: {
    section: 3,
    owner: 27,
    book: 161,
    page: 1
  },
  startTime: 1765403005055,    // First dot timestamp
  endTime: 1765403005892,      // Last dot timestamp
  dotArray: [
    { x: 234.567, y: 123.456, f: 512, timestamp: 1765403005055 },
    { x: 235.123, y: 123.789, f: 498, timestamp: 1765403005072 },
    // ... more dots
  ]
}
```

### Page Identification

Strokes are grouped by their Ncode page identifier:

```
S{section}/O{owner}/B{book}/P{page}
Example: S3/O27/B161/P1
```

This allows filtering strokes by physical page and supports multi-page documents.

### Offline Data

The pen stores strokes in internal memory when not connected. When fetched:

1. App requests offline note list from pen
2. User confirms download
3. Pen transmits stored strokes with progress updates
4. Strokes are converted to same format as real-time data
5. Canvas auto-fits to show imported content

---

## Data Flow and Processing

### 1. Pen Connection

```
User clicks "Connect Pen"
    │
    ▼
PenHelper.scanPen() ──► Browser Bluetooth dialog
    │
    ▼
User selects pen ──► GATT connection established
    │
    ▼
PEN_CONNECTION_SUCCESS ──► setPenConnected(true)
    │
    ▼
PEN_SETTING_INFO ──► setPenInfo({ Battery, Memory, ... })
    │
    ▼
PEN_AUTHORIZED ──► Enable real-time capture
    │
    ▼
RequestAvailableNotes([0], [0], null) ──► Accept all paper types
    │
    ▼
SetHoverEnable(true) ──► Ready for writing
```

### 2. Real-time Stroke Capture

```
Pen writes on paper
    │
    ▼
PenHelper.dotCallback(mac, dot)
    │
    ▼
processDot(dot) {
    │
    ├── dotType 0 (Pen Down)
    │       └── Create new currentStrokeData
    │
    ├── dotType 1 (Pen Move)
    │       └── Append dot to currentStrokeData.dotArray
    │
    └── dotType 2 (Pen Up)
            ├── Finalize stroke
            ├── addStroke(stroke) ──► Svelte store update
            └── Trigger canvas re-render
}
```

### 3. Transcription Pipeline

```
User clicks "Transcribe All/Selected"
    │
    ▼
Get strokes (selected or all)
    │
    ▼
convertStrokesToMyScript(strokes)
    ├── Calculate bounds (min/max X, Y)
    ├── Convert Ncode → pixels: (x - minX) × 2.371 × (96/25.4) + padding
    └── Format for MyScript: { x: [...], y: [...], t: [...], p: [...] }
    │
    ▼
Generate HMAC-SHA512 signature
    ├── Key: applicationKey + hmacKey (concatenated)
    └── Message: JSON request body
    │
    ▼
POST to https://cloud.myscript.com/api/v4.0/iink/batch
    │
    ▼
Parse response:
    ├── result.label ──► Full text with \n line breaks (TRUST THIS!)
    ├── result.words ──► Word bounding boxes for position data
    └── result.chars ──► Character-level data (optional)
    │
    ▼
buildLinesFromLabel(labelText, words)
    ├── Split text by \n (MyScript's line detection)
    ├── Match words to lines by text content
    └── Sort words by X position within each line
    │
    ▼
detectIndentation(lines, metrics)
    ├── Find leftmost X position (base indent = 0)
    ├── Calculate indent unit from word height
    └── indentLevel = round((lineX - baseX) / indentUnit)
    │
    ▼
buildLineHierarchy(lines)
    ├── For each line, look backwards for lower indent
    └── Establish parent/children references
    │
    ▼
extractCommands(text, lines)
    └── Match /\[(\w+):\s*([^\]]+)\]/g patterns
    │
    ▼
setTranscription(result) ──► Update Svelte store
```

---

## MyScript API Integration

### Registration and Keys

1. Create account at [developer.myscript.com](https://developer.myscript.com/)
2. Create a new application
3. Enable "Text" recognition type
4. Copy **Application Key** (UUID format)
5. Copy **HMAC Key** (UUID format)

**Free Tier:** 2,000 requests/month

### Authentication

MyScript uses HMAC-SHA512 for request signing:

```javascript
// Key = applicationKey + hmacKey (concatenated strings)
const userKey = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" + 
                "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy";

// Message = JSON request body
const message = JSON.stringify(requestBody);

// Signature = HMAC-SHA512(key, message) as hex string
const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
```

### Request Format

```javascript
POST https://cloud.myscript.com/api/v4.0/iink/batch

Headers:
  Content-Type: application/json
  Accept: application/json, application/vnd.myscript.jiix, text/plain
  applicationKey: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  hmac: [128-char hex signature]

Body:
{
  "xDPI": 96,
  "yDPI": 96,
  "contentType": "Text",
  "configuration": {
    "lang": "en_US",
    "text": {
      "guides": { "enable": false },
      "mimeTypes": ["text/plain", "application/vnd.myscript.jiix"]
    },
    "export": {
      "jiix": {
        "bounding-box": true,
        "strokes": true,
        "text": { "chars": true, "words": true }
      }
    }
  },
  "strokeGroups": [{
    "strokes": [
      { "x": [10, 20, 30], "y": [10, 15, 10], "t": [...], "p": [...] }
    ]
  }],
  "width": 800,
  "height": 600
}
```

### Response Format (JIIX)

```javascript
{
  "type": "Text",
  "label": "Hello World\nThis is line two",  // \n = line breaks!
  "words": [
    {
      "label": "Hello",
      "bounding-box": { "x": 10, "y": 5, "width": 45, "height": 12 },
      "candidates": ["Hello", "Helo", "Mello"],
      "first-char": 0,
      "last-char": 4
    },
    // ... more words
  ],
  "chars": [
    { "label": "H", "bounding-box": {...}, "word": 0 },
    // ... more chars
  ]
}
```

### Why We Trust MyScript's Line Detection

Previous approaches tried to group words into lines by analyzing baseline Y positions. This failed because:

1. **Descender problem**: Letters like `g`, `y`, `p` extend below the baseline, skewing calculations
2. **Handwriting variance**: Natural writing has inconsistent baselines
3. **Small words**: Short words like "a", "1", "I" can have ambiguous positions

MyScript's recognition engine already solves this—it returns `\n` characters in the `label` field where it detects line breaks. We simply split on `\n` and use word bounding boxes only for **X position** (indentation), not Y position (line grouping).

---

## LogSeq HTTP API Integration

### Enabling the API

1. Open LogSeq desktop app
2. Go to **Settings** → **Advanced**
3. Enable **Developer mode**
4. Enable **HTTP APIs server**
5. Default port: `12315`
6. Optionally set authorization token

### API Endpoint

```
POST http://127.0.0.1:12315/api

Headers:
  Content-Type: application/json
  Authorization: Bearer [token]  (optional)

Body:
{
  "method": "logseq.Editor.appendBlockInPage",
  "args": ["2024-12-11", "Hello World", { "properties": {} }]
}
```

### Common Methods Used

| Method | Purpose |
|--------|---------|
| `logseq.App.getCurrentGraph` | Test connection, get graph name |
| `logseq.Editor.appendBlockInPage` | Add block to end of page |
| `logseq.Editor.insertBlock` | Insert block relative to another |
| `logseq.Editor.getPage` | Check if page exists |
| `logseq.Editor.createPage` | Create new page |

### Block Insertion with Hierarchy

```javascript
// Build block stack based on indentation
const blockStack = [{ uuid: headerBlock.uuid, indent: -1 }];

for (const line of lines) {
  const indent = line.indentLevel || 0;
  
  // Pop stack until we find a parent with lower indent
  while (blockStack.length > 1 && 
         blockStack[blockStack.length - 1].indent >= indent) {
    blockStack.pop();
  }
  
  const parentBlock = blockStack[blockStack.length - 1];
  
  // Insert as child of parent
  const newBlock = await api.request('logseq.Editor.insertBlock', [
    parentBlock.uuid,
    line.text,
    { sibling: false }  // false = child, true = sibling
  ]);
  
  blockStack.push({ uuid: newBlock.uuid, indent });
}
```

---

## Current Features

### Pen Connection
- ✅ Bluetooth pairing via Web Bluetooth API
- ✅ Automatic authorization handling
- ✅ Password prompt for locked pens
- ✅ Battery and memory status display
- ✅ Graceful disconnect

### Stroke Capture
- ✅ Real-time stroke rendering as you write
- ✅ Offline note download from pen memory
- ✅ Multi-page support with page filtering
- ✅ Pressure-sensitive line rendering

### Canvas Interaction
- ✅ Pan: Shift+drag, middle-click drag, scroll wheel
- ✅ Zoom: Ctrl+scroll, zoom buttons
- ✅ Fit to content (auto-centers on strokes)
- ✅ Auto-fit when strokes are imported
- ✅ Stroke selection (click, Ctrl+click, Shift+click)
- ✅ SVG and JSON export

### Transcription
- ✅ MyScript Cloud API integration
- ✅ HMAC-SHA512 authentication
- ✅ Line detection (trusting MyScript's `\n`)
- ✅ Indentation analysis from X positions
- ✅ Parent/child hierarchy building
- ✅ Transcribe all or selected strokes
- ✅ Command pattern detection `[command: value]`

### LogSeq Integration
- ✅ HTTP API connection test
- ✅ Block insertion with hierarchy
- ✅ Journal page detection
- ✅ Connection status display

### UI/UX
- ✅ Dark theme
- ✅ Responsive layout
- ✅ Activity log with timestamps
- ✅ Tab-based data explorer
- ✅ LogSeq-formatted preview

---

## Future Plans: Command Support

### Concept

Commands embedded in handwritten notes will control how content is routed and processed:

```
[page: Meeting Notes]
  - Discussed Q1 roadmap
  - Action items below
```

### Planned Commands

| Command | Syntax | Effect |
|---------|--------|--------|
| `page` | `[page: Page Name]` | Route this line and children to specified page |
| `sketch` | `[sketch:]` | Render strokes enclosed in this box as an image rather than transcribing them |

### Command Scope

Commands affect the line they're on **plus all indented children**:

```
[page: Daily Notes]        ← Command on this line
  Meeting with team        ← Affected (child)
    Discussed budget       ← Affected (grandchild)
  Lunch break              ← Affected (child)
Next section               ← NOT affected (same or lower indent)
```

This leverages the hierarchy already built during transcription (`line.children` array).

### Implementation Plan

1. **Detection** (✅ Done): Regex extraction during `parseResult()`
2. **Scope Resolution**: Use `getDescendants(lines, lineIndex)` to find affected lines
3. **Processing Pipeline**: Before sending to LogSeq, transform lines based on commands
4. **Page Routing**: Group lines by target page, send to each page separately
5. **Property Injection**: Add LogSeq properties for deadlines, tags, etc.

### Example Transformation

**Input (transcribed):**
```javascript
lines: [
  { text: "[page: Meeting Notes]", indentLevel: 0, children: [1, 2] },
  { text: "Discussed roadmap", indentLevel: 1, parent: 0 },
  { text: "[todo: Follow up with design team]", indentLevel: 1, parent: 0 }
]
```

**Output (to LogSeq):**
```javascript
// Sent to page "Meeting Notes":
blocks: [
  { content: "Discussed roadmap", parent: headerBlock },
  { content: "TODO Follow up with design team", parent: headerBlock }
]
```

---

## Technical Requirements

### Browser Requirements
- Chrome 56+ or Edge 79+ (Web Bluetooth API)
- Firefox not supported (no Web Bluetooth)

### Dependencies

```json
{
  "dependencies": {
    "web_pen_sdk": "^0.7.8"        // NeoSmartpen SDK
  },
  "devDependencies": {
    "svelte": "^4.2.18",           // UI framework (NOT v5)
    "@sveltejs/vite-plugin-svelte": "^3.1.1",
    "vite": "^5.4.0",              // Build tool
    "buffer": "^6.0.3",            // Node polyfill
    "process": "^0.11.10",         // Node polyfill
    "stream-browserify": "^3.0.0", // Node polyfill
    "pako": "^2.1.0"               // zlib for browser
  }
}
```

### External Services

| Service | Purpose | Cost |
|---------|---------|------|
| MyScript Cloud | Handwriting recognition | Free: 2,000 req/mo |
| LogSeq HTTP API | Block insertion | Free (local) |

### Hardware

- NeoSmartpen with Bluetooth (tested: Lamy Safari / NWP-F80)
- Ncode paper (required for position tracking)

---

## Appendix: Store Architecture

### Store Relationships

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   strokes   │────►│   pages      │     │ selectedIndices │
│  (writable) │     │  (derived)   │     │   (writable)    │
└─────────────┘     └──────────────┘     └────────┬────────┘
       │                                          │
       │            ┌──────────────┐              │
       └───────────►│selectedStrokes│◄────────────┘
                    │  (derived)    │
                    └───────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ MyScript API │
                    └──────┬───────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   lastTranscription    │
              │      (writable)        │
              └───────────┬────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────────┐ ┌───────────┐ ┌──────────────┐
│ transcribedText │ │   lines   │ │  commands    │
│    (derived)    │ │ (derived) │ │  (derived)   │
└─────────────────┘ └───────────┘ └──────────────┘
```

### Key Stores

| Store | Type | Purpose |
|-------|------|---------|
| `strokes` | writable | Raw stroke data from pen |
| `pages` | derived | Strokes grouped by Ncode page |
| `selectedIndices` | writable | Set of selected stroke indices |
| `selectedStrokes` | derived | Actual stroke objects for selection |
| `penConnected` | writable | Bluetooth connection state |
| `penInfo` | writable | Battery, model, MAC address |
| `lastTranscription` | writable | Full MyScript result |
| `transcribedLines` | derived | Lines with hierarchy |
| `detectedCommands` | derived | Extracted `[command: value]` |
| `myscriptAppKey` | writable | MyScript Application Key |
| `myscriptHmacKey` | writable | MyScript HMAC Key |
| `logseqHost` | writable | LogSeq API URL |
| `logseqConnected` | writable | API connection state |

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 0.2.1 | Feb 2026 | Data loss fixes (v3.1 append-only), explicit deletion tracking |
| 0.2.0 | Dec 2024 | Svelte 4 migration, pan/zoom, auto-fit |
| 0.1.0 | Nov 2024 | Initial vanilla JS implementation |
