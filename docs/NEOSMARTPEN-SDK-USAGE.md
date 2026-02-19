# NeoSmartpen SDK Usage Summary

This document provides a comprehensive reference for how the smartpen-logseq-bridge application integrates with the NeoSmartpen Web SDK.

## Overview

The application uses the **NeoSmartpen Web SDK** (`web_pen_sdk`) for local Bluetooth connectivity with Lamy Safari (NeoSmartpen) devices. The SDK integration is wrapped in `src/lib/pen-sdk.js` and provides three core capabilities:

1. **Real-time stroke capture** - Live dot streaming as user writes
2. **Offline data sync** - Sequential download of strokes from pen memory
3. **Memory management** - Direct deletion of books from pen storage

## SDK Methods Reference

| **SDK Method** | **Used In** | **Purpose & Flow** |
|---|---|---|
| **`PenHelper.scanPen()`** | Connection Flow | Initiates Web Bluetooth pairing dialog. 15-second timeout wrapper. Returns controller on success. |
| **`PenHelper.disconnect(controller)`** | Disconnection Flow | Clean disconnect from pen. Updates stores to reflect disconnected state. |
| **`PenHelper.dotCallback`** | Real-Time Capture | **Callback:** Receives individual dot events as user writes. Builds strokes from dot sequence (type 0=pen down, 1=move, 2=pen up). Feeds canvas renderer for live drawing. |
| **`PenHelper.messageCallback`** | Event Processing | **Callback:** Handles all pen messages (connection, authorization, battery, offline data, deletion responses). Central event dispatcher for 14+ message types. |
| **`controller.InputPassword(password)`** | Authorization | Sends 4-digit PIN for password-protected pens. Handles retry count (max 10 attempts). |
| **`controller.RequestAvailableNotes(null, null, null)`** | Real-Time Setup | Enables real-time capture for **ALL** notebooks (null = all sections/owners/books). Called after authorization with 300ms GATT delay. |
| **`controller.SetHoverEnable(true)`** | Real-Time Setup | Enables hover detection. Called after `RequestAvailableNotes` with GATT serialization delay. |
| **`controller.RequestOfflineNoteList()`** | Offline Sync - Discovery | Requests list of notebooks stored in pen memory. Triggers `OFFLINE_DATA_NOTE_LIST` message with available books. |
| **`controller.RequestOfflineData(section, owner, bookId, deleteAfter, pages[])`** | Offline Sync - Download | **Sequential downloads only** (never parallel). Downloads strokes from one book at a time. `deleteAfter=false` (explicit deletion via separate method). `pages=[]` (all pages). Triggers `OFFLINE_DATA_SEND_START/STATUS/SUCCESS` messages. |
| **`controller.RequestOfflineDelete(section, owner, noteIds[])`** | Memory Management - Deletion | **Direct deletion** without re-downloading data. Grouped by Section/Owner pairs for BLE efficiency. Triggers `OFFLINE_DATA_DELETE_RESPONSE` (type 165). Fast operation (~30s timeout). |

## Message Types Handled

All messages are received via `PenHelper.messageCallback` and dispatched through `processMessage()`:

| **Message Type** | **Code** | **Handled Action** |
|---|---|---|
| `PEN_CONNECTION_SUCCESS` | 1 | Sets `penConnected=true`, logs success |
| `PEN_SETTING_INFO` | 2 | Stores pen info (battery %, MAC address) |
| `PEN_AUTHORIZED` | 3 | Triggers `RequestAvailableNotes()` + `SetHoverEnable()` for real-time capture |
| `PEN_DISCONNECTED` | 4 | Sets `penConnected=false`, logs warning |
| `PEN_PASSWORD_REQUEST` | 5 | Prompts user for 4-digit PIN, shows retry count |
| `OFFLINE_DATA_NOTE_LIST` | 6 | Opens book selection dialog OR routes to deletion dialog |
| `AVAILABLE_NOTE_RESPONSE` | 26 | Confirms note set configured (silent confirmation) |
| `PEN_SETTING_CHANGE_RESPONSE` | 18 | Confirms pen setting updated (e.g., hover enable) |
| `OFFLINE_DATA_RESPONSE` | 49 | Pen reports stroke count for requested book, updates status to "receiving" |
| `OFFLINE_DATA_SEND_START` | 50 | Transfer started, logs progress |
| `OFFLINE_DATA_SEND_STATUS` | 51 | Progress percentage (logged every 25%) |
| `OFFLINE_DATA_SEND_SUCCESS` | 52 | Converts SDK format → internal format, adds strokes to store, updates canvas |
| `OFFLINE_DATA_SEND_FAILURE` | 53 | Logs error, resolves promise to continue to next book |
| `OFFLINE_DATA_DELETE_RESPONSE` | 165 | Confirms deletion complete, resolves deletion promise |

## Data Flow Patterns

### Real-Time Capture Flow
```
User writes on Ncode paper
  ↓
PenHelper.dotCallback receives dots (type 0=down, 1=move, 2=up)
  ↓
processDot() builds stroke object
  ↓
addStroke() updates Svelte store
  ↓
Canvas renderer draws in real-time
```

### Offline Sync Flow
```
User clicks "Fetch Offline"
  ↓
controller.RequestOfflineNoteList()
  ↓
OFFLINE_DATA_NOTE_LIST message → User selects books in dialog
  ↓
FOR EACH selected book (sequentially):
  - startBatchMode() (pause canvas updates)
  - controller.RequestOfflineData(section, owner, bookId, false, [])
  - OFFLINE_DATA_RESPONSE (stroke count notification)
  - OFFLINE_DATA_SEND_START
  - OFFLINE_DATA_SEND_STATUS (progress %)
  - OFFLINE_DATA_SEND_SUCCESS (stroke data arrives)
    → Convert SDK format to internal format
    → addOfflineStrokes() to store
  - endBatchMode() (trigger single canvas update)
  - Wait 1000ms before next book
  ↓
resetTransferProgress() after all books complete
```

### Memory Deletion Flow
```
User clicks "Delete from Pen"
  ↓
controller.RequestOfflineNoteList()
  ↓
OFFLINE_DATA_NOTE_LIST → User selects books to delete
  ↓
Group books by Section/Owner pairs
  ↓
FOR EACH group:
  - controller.RequestOfflineDelete(section, owner, [noteId1, noteId2, ...])
  - Wait for OFFLINE_DATA_DELETE_RESPONSE (30s timeout)
  - Mark books as deleted
  - Wait 500ms for BLE stability
  ↓
Log final deletion results
```

## Key Implementation Patterns

### BLE Timing Safety
The SDK requires careful timing to avoid BLE stack collisions:

- **300ms delay** between sequential GATT commands (e.g., `RequestAvailableNotes` → `SetHoverEnable`)
- **1000ms delay** between book downloads during offline sync
- **Serial downloads only** - never request multiple books in parallel
- **500ms delay** between deletion groups for stability

### Transfer Completion Detection
Offline transfers use **idle timeout detection** instead of global timeouts:

- Transfer completes when **no new data for 10 seconds**
- Checks every 1 second for idle status
- No global timeout - allows large books to transfer without interruption
- `lastDataReceivedTime` tracks when last chunk arrived

### Performance Optimization
Large imports use batch mode to prevent UI lag:

```javascript
startBatchMode();  // Pause canvas updates
// ... receive strokes, add to store ...
endBatchMode();    // Single canvas redraw with all new strokes
```

### Progress Tracking
Comprehensive user feedback during transfers:

```javascript
updateTransferProgress({
  active: true,
  currentBook: 2,           // Book 2 of 5
  totalBooks: 5,
  receivedStrokes: 1247,    // Running total across all books
  elapsedSeconds: 15,       // Updated every 1 second
  status: 'receiving',      // requesting | receiving | waiting | complete | error
  canCancel: true
});
```

### Book ID Normalization
The SDK may return book IDs as numbers or strings depending on context. All book IDs are normalized to strings for consistent comparison:

```javascript
function normalizeBookId(bookId) {
  if (bookId === null || bookId === undefined) {
    return 'unknown';
  }
  return String(bookId);
}
```

### Error Handling
- Connection failures include troubleshooting tips for users
- Transfer failures for individual books don't stop the overall sync
- Cancellation is graceful - cleans up state and logs clearly
- Deletion failures are logged per-group but don't block subsequent groups

## SDK Data Format Conversion

The SDK returns strokes in a different format than the app's internal representation. Conversion happens in `handleOfflineDataReceived()`:

**SDK Format (from `OFFLINE_DATA_SEND_SUCCESS`):**
```javascript
{
  Dots: [
    {
      x: number,
      y: number,
      f: number,
      timeStamp: number,
      pageInfo: {
        section: number,
        owner: number,
        book: number,
        page: number
      },
      dotType: 0 | 1 | 2
    }
  ]
}
```

**Internal Format (stored in Svelte stores):**
```javascript
{
  pageInfo: {
    section: number,
    owner: number,
    book: number,
    page: number
  },
  startTime: number,      // First dot timestamp
  endTime: number,        // Last dot timestamp
  dotArray: [
    {
      x: number,
      y: number,
      f: number,
      timestamp: number
    }
  ]
}
```

## Browser Requirements

The Web Bluetooth API has specific requirements:

- **Chrome or Edge only** (Firefox/Safari not supported)
- **HTTPS required** (localhost OK for development)
- User must explicitly pair via browser Bluetooth dialog
- Connection can drop; implement reconnection logic

## Configuration Constants

Defined in `pen-sdk.js` (`TRANSFER_CONFIG`):

```javascript
{
  IDLE_TIMEOUT_MS: 10000,       // 10 seconds of no data = transfer complete
  IDLE_CHECK_INTERVAL_MS: 1000, // Check idle status every second
  INTER_BOOK_DELAY_MS: 1000,    // Wait 1 second between book downloads
}
```

## Debugging Tips

The SDK wrapper includes extensive console logging with styled output:

- **Connection events**: Blue background, white text
- **Offline data**: Orange background for start/end boundaries
- **Deletion mode**: Yellow/orange background
- **Errors**: Red background
- **Book statistics**: Cyan color for stroke/page counts

Enable browser console to see detailed transfer progress, timing information, and BLE protocol messages.

## Related Files

- `src/lib/pen-sdk.js` - Main SDK wrapper (967 lines)
- `src/stores/pen.js` - Pen connection state and transfer progress
- `src/stores/strokes.js` - Stroke data management
- `src/components/header/PenControls.svelte` - UI for connect/fetch/disconnect

## External Resources

- [NeoSmartpen Web SDK GitHub](https://github.com/NeoSmartpen/WEB-SDK2.0)
- [Web Bluetooth API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
- [Smartpen Web SDK README](../docs/Smartpen%20Web%20SDK%20README.md) - SDK documentation
