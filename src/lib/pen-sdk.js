/**
 * Pen SDK Wrapper for Svelte
 * Wraps the web_pen_sdk and updates Svelte stores
 */

import { PenHelper, PenMessageType } from 'web_pen_sdk';
import { 
  addStroke, 
  updateLastStroke, 
  addOfflineStrokes,
  currentPageInfo,
  startBatchMode,
  endBatchMode
} from '$stores/strokes.js';
import { 
  setPenConnected, 
  setPenAuthorized, 
  setPenInfo, 
  setPenController,
  penController,
  updateTransferProgress,
  resetTransferProgress
} from '$stores/pen.js';
import { log, openBookSelectionDialog, setBluetoothStatus } from '$stores/ui.js';

// Local state for tracking current stroke
let currentStrokeData = null;
let canvasRenderer = null;

// ===== DELETION MODE STATE =====
// (Legacy deletion mode flags - kept for safety but no longer used.
//  Deletion now uses RequestOfflineDelete directly instead of
//  RequestOfflineData with deleteOnFinished flag.)
let isDeletionMode = false;
let deletionBooks = [];  // Track which books are being deleted

/**
 * Initialize pen SDK callbacks
 */
export function initializePenSDK() {
  // Dot callback - receives individual dots as you write
  PenHelper.dotCallback = async (mac, dot) => {
    processDot(dot);
  };

  // Message callback - pen events
  PenHelper.messageCallback = async (mac, type, args) => {
    processMessage(mac, type, args);
  };

  // Wrap connectDevice to capture the BluetoothDevice reference so we can
  // force-disconnect it if a connection attempt times out
  const originalConnectDevice = PenHelper.connectDevice;
  PenHelper.connectDevice = async (device) => {
    connectingDevice = device;
    return originalConnectDevice.call(PenHelper, device);
  };

  log('Pen SDK initialized', 'info');
}

/**
 * Set canvas renderer for real-time drawing
 * @param {Object} renderer - CanvasRenderer instance
 */
export function setCanvasRenderer(renderer) {
  canvasRenderer = renderer;
}

// Flag to suppress SDK callbacks after a timeout-forced disconnect
let connectionAborted = false;

// Reference to the BluetoothDevice mid-connection, so we can force-disconnect on timeout
let connectingDevice = null;

/**
 * Forcibly disconnect any in-progress GATT connection attempts.
 * Called after a timeout to prevent the SDK's async GATT operations
 * from completing and triggering connection success callbacks.
 */
function abortPendingConnection() {
  connectionAborted = true;

  // Force-disconnect the device we were trying to connect to
  if (connectingDevice) {
    try {
      connectingDevice.gatt?.disconnect();
    } catch (e) {
      // Ignore
    }
    connectingDevice = null;
  }

  // Disconnect any fully-connected pens the SDK tracks
  try {
    if (PenHelper.pens && PenHelper.pens.length > 0) {
      PenHelper.pens.forEach(controller => {
        try {
          PenHelper.disconnect(controller);
        } catch (e) {
          // Ignore
        }
      });
    }
  } catch (e) {
    // Ignore
  }

  // Clear the SDK's connectingQueue directly — it's a public property.
  // Without this, the SDK permanently thinks it's still connecting and
  // blocks all subsequent connection attempts with "Already connected or connecting".
  try {
    if (Array.isArray(PenHelper.connectingQueue)) {
      PenHelper.connectingQueue = [];
    }
  } catch (e) {
    // Ignore
  }
}

// Resolver/rejecter for the active connectPen() call.
// Signalled by handleConnectionSuccess() or handleDisconnected() via processMessage().
let connectionResolve = null;
let connectionReject = null;

/**
 * Connect to a pen via Bluetooth.
 *
 * Previous approach raced scanPen() against a timeout — but scanPen() resolves
 * immediately after the user picks a device in the browser dialog, long before the
 * SDK has completed GATT binding, characteristic setup, and the VERSION_REQUEST
 * handshake that produces PEN_CONNECTION_SUCCESS. That made the timeout fire too
 * early and had nothing real to race against.
 *
 * Correct approach: start scanPen() (fire-and-forget), then wait for
 * PEN_CONNECTION_SUCCESS (resolve) or PEN_DISCONNECTED (reject) to arrive via
 * processMessage(). The timeout guards that wait, not the scanPen() call itself.
 *
 * @param {number} timeoutMs - How long to wait for PEN_CONNECTION_SUCCESS (default 60s)
 */
export async function connectPen(timeoutMs = 60000) {
  connectionAborted = false;

  log('Scanning for pens...', 'info');
  log('💡 Make sure your pen is awake (tap on paper or press button)', 'info');

  // The full connection flow is:
  //   scanPen() → requestDevice() [user picks] → connectDevice() → gatt.connect()
  //   → serviceBinding → characteristicBinding → OnConnected() → 500ms delay
  //   → VERSION_REQUEST → VERSION_RESPONSE → PEN_CONNECTION_SUCCESS
  //
  // scanPen() awaits ALL of this internally — it never returns until the full
  // handshake completes (or fails). So we must NOT await it here or we block
  // before we can set up our timeout.
  //
  // Instead: fire scanPen() without awaiting, and race two signals:
  //   1. connectionPromise — resolves via handleConnectionSuccess(),
  //                          rejects via handleDisconnected() or our timeout
  //   2. scanErrorPromise  — rejects if scanPen() itself throws (user cancelled
  //                          the device picker before any connection attempt)

  const connectionPromise = new Promise((resolve, reject) => {
    connectionResolve = resolve;
    connectionReject = reject;
  });

  // Capture any early error from scanPen() (e.g. user closes device picker)
  const scanErrorPromise = new Promise((_, reject) => {
    PenHelper.scanPen().catch(reject);
  });

  // Timeout fires if neither success nor disconnect arrives in time
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('Connection timeout - pen did not respond')),
      timeoutMs
    )
  );

  try {
    await Promise.race([connectionPromise, scanErrorPromise, timeoutPromise]);
    return true;
  } catch (error) {
    const isTimeout = error.message.includes('timeout');
    const isCancelled = error.message.toLowerCase().includes('cancel')
                     || error.message.toLowerCase().includes('chosen')
                     || error.message.toLowerCase().includes('user');

    if (isTimeout) {
      log(`Connection error: ${error.message}`, 'error');
      log('💡 Troubleshooting tips:', 'warning');
      log('1. Make sure pen is awake (tap on Ncode paper or press button)', 'info');
      log('2. Remove and reinsert pen cap to reset', 'info');
      log('3. Try disconnecting other Bluetooth devices', 'info');
      log('4. Refresh the page and try again', 'info');

      // Unblock the Bluetooth dialog
      setBluetoothStatus('error', 'Connection timed out. Make sure the pen is awake and try again.');

      // Tell Electron to cancel its pending Bluetooth callback
      if (window.electronAPI) {
        window.electronAPI.cancelBluetoothScan();
      }
    } else if (!isCancelled) {
      log(`Connection error: ${error.message}`, 'error');
    }

    // Abort in-progress GATT operations and clear SDK connecting queue
    abortPendingConnection();
    setPenConnected(false);
    throw error;
  } finally {
    connectionResolve = null;
    connectionReject = null;
  }
}

/**
 * Disconnect from the pen
 */
export async function disconnectPen() {
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();
  
  if (controller) {
    try {
      PenHelper.disconnect(controller);
      setPenConnected(false);
      log('Disconnected from pen', 'info');
    } catch (error) {
      log(`Disconnect error: ${error.message}`, 'error');
      throw error;
    }
  }
}

/**
 * Fetch offline data from pen
 */
export async function fetchOfflineData() {
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();
  
  if (!controller) {
    log('No pen connected', 'warning');
    return [];
  }
  
  try {
    log('Requesting offline note list...', 'info');
    controller.RequestOfflineNoteList();
    // The actual data will come via messageCallback
    return [];
  } catch (error) {
    log(`Failed to fetch offline data: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Process individual dots from pen
 */
function processDot(dot) {
  // The SDK sends {x: -1, y: -1, f: 0} on pen-down before it has resolved
  // the actual position, and the pageInfo at that moment is stale (from the
  // last page used). Skip these invalid placeholder dots entirely.
  const isInvalidDot = dot.x === -1 && dot.y === -1;

  // Handle stroke building based on dot type
  switch (dot.dotType) {
    case 0: // Pen down - start new stroke
      // Open a new stroke but leave pageInfo null until the first real dot
      // arrives with confirmed coordinates and correct page info.
      currentStrokeData = {
        pageInfo: isInvalidDot ? null : { ...dot.pageInfo },
        startTime: dot.timeStamp,
        dotArray: isInvalidDot ? [] : [{ x: dot.x, y: dot.y, f: dot.f, timestamp: dot.timeStamp }]
      };
      break;

    case 1: // Pen move - add to current stroke
      if (currentStrokeData) {
        // Latch the correct pageInfo from the first real dot if the pen-down
        // dot was invalid and left it null.
        if (!currentStrokeData.pageInfo) {
          currentStrokeData.pageInfo = { ...dot.pageInfo };
        }
        currentStrokeData.dotArray.push({
          x: dot.x,
          y: dot.y,
          f: dot.f,
          timestamp: dot.timeStamp
        });
      }
      break;

    case 2: // Pen up - finalize stroke
      if (currentStrokeData) {
        currentStrokeData.endTime = dot.timeStamp;
        // Only save strokes that have confirmed page info and at least one real dot
        if (currentStrokeData.pageInfo && currentStrokeData.dotArray.length > 0) {
          addStroke(currentStrokeData);
        }
        currentStrokeData = null;
      }
      break;
  }

  // Update the current page info store and render to canvas only for valid dots
  if (!isInvalidDot) {
    currentPageInfo.set(dot.pageInfo);
    if (canvasRenderer) {
      canvasRenderer.addDot(dot);
    }
  }
}

/**
 * Process pen messages
 */
function processMessage(mac, type, args) {
  // More detailed logging for connection-related messages
  const messageTypeNames = {
    1: 'PEN_CONNECTION_SUCCESS',
    2: 'PEN_SETTING_INFO',
    3: 'PEN_AUTHORIZED',
    4: 'PEN_DISCONNECTED',
    5: 'PEN_PASSWORD_REQUEST',
    6: 'OFFLINE_DATA_NOTE_LIST',
    18: 'PEN_SETTING_CHANGE_RESPONSE',
    26: 'AVAILABLE_NOTE_RESPONSE',
    49: 'OFFLINE_DATA_RESPONSE',
    50: 'OFFLINE_DATA_SEND_START',
    51: 'OFFLINE_DATA_SEND_STATUS',
    52: 'OFFLINE_DATA_SEND_SUCCESS',
    53: 'OFFLINE_DATA_SEND_FAILURE',
    165: 'OFFLINE_DATA_DELETE_RESPONSE'
  };
  
  const typeName = messageTypeNames[type] || `UNKNOWN(${type})`;
  console.log(`Pen message [${typeName}]:`, { mac, type, args });
  
  switch (type) {
    case PenMessageType.PEN_CONNECTION_SUCCESS:
      handleConnectionSuccess(mac);
      break;
      
    case PenMessageType.PEN_SETTING_INFO:
      handleSettingInfo(mac, args);
      break;
      
    case PenMessageType.PEN_AUTHORIZED:
      handleAuthorized(mac);
      break;
      
    case PenMessageType.PEN_DISCONNECTED:
      handleDisconnected();
      break;
      
    case PenMessageType.PEN_PASSWORD_REQUEST:
      handlePasswordRequest(args);
      break;
      
    case PenMessageType.OFFLINE_DATA_NOTE_LIST:
      handleOfflineNoteList(args);
      break;
    
    case 49: // OFFLINE_DATA_RESPONSE - pen tells us how much data to expect
      handleOfflineDataResponse(args);
      break;
      
    case PenMessageType.OFFLINE_DATA_SEND_START:
      console.log('%c🚀 OFFLINE_DATA_SEND_START received', 'background: #4CAF50; color: white; padding: 2px 6px; border-radius: 3px;');
      log('Receiving offline data...', 'info');
      break;
      
    case PenMessageType.OFFLINE_DATA_SEND_STATUS:
      lastStatusPercentage = args; // cumulative % — used to estimate total stroke count
      // Only log every 25% to reduce noise
      if (args % 25 < 5 || args > 95) {
        console.log(`📊 Progress: ${Math.round(args)}%`);
      }
      log(`Offline sync: ${Math.round(args)}%`, 'info');
      break;
      
    case PenMessageType.OFFLINE_DATA_SEND_SUCCESS:
      console.log('%c✅ OFFLINE_DATA_SEND_SUCCESS - Processing data...', 'background: #2196F3; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold;');
      // handleOfflineDataReceived returns false on book ID mismatch — in that case
      // we leave the resolver live so the correct book's data can still resolve it.
      if (handleOfflineDataReceived(args) && offlineTransferResolver) {
        // Resolve immediately — SDK has confirmed successful delivery of all data.
        // Clear resolver BEFORE calling to prevent retransmitted BLE events from
        // resolving the NEXT book's promise once the loop advances.
        const resolver = offlineTransferResolver;
        offlineTransferResolver = null;
        resolver({ success: true });
      }
      break;

    case PenMessageType.OFFLINE_DATA_SEND_FAILURE:
      console.log('%c❌ OFFLINE_DATA_SEND_FAILURE', 'background: #f44336; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold;');
      log('Failed to receive offline data', 'error');
      // Resolve the pending transfer with failure so we can move to the next book
      if (offlineTransferResolver) {
        const resolver = offlineTransferResolver;
        offlineTransferResolver = null;
        resolver({ failed: true });
      }
      break;
      
    case PenMessageType.EVENT_DOT_PUI:
      log(`PUI touched: ${JSON.stringify(args)}`, 'info');
      break;

    case 165: // OFFLINE_DATA_DELETE_RESPONSE
      console.log('%c🗑️ OFFLINE_DATA_DELETE_RESPONSE received', 'background: #f59e0b; color: white; padding: 2px 6px; border-radius: 3px;', args);
      handleOfflineDeleteResponse(args);
      break;
    
    case 26: // AVAILABLE_NOTE_RESPONSE - confirmation that note set was configured
      if (args?.Result) {
        console.log('Note set configured successfully');
      }
      break;
    
    case 18: // PEN_SETTING_CHANGE_RESPONSE - confirmation of setting change (e.g., hover enable)
      if (args?.result) {
        console.log('Pen setting updated:', args.SettingType);
      }
      break;
      
    default:
      // Log unknown events for debugging
      console.log(`Unknown pen event ${type}:`, args);
  }
}

function handleConnectionSuccess(mac) {
  connectingDevice = null; // Clear — connection succeeded, no need to force-disconnect
  if (connectionAborted) {
    console.warn('Ignoring late connection success — connection was aborted after timeout');
    setPenConnected(false);
    return;
  }
  // Signal connectPen() that the full handshake is complete
  if (connectionResolve) {
    connectionResolve();
  }
  setPenConnected(true);
  log('Pen connected!', 'success');
}

function handleSettingInfo(mac, args) {
  if (connectionAborted) return;
  const controller = PenHelper.pens.find(c => c.info.MacAddress === mac);
  setPenController(controller);
  setPenInfo(args);
  log(`Pen settings received: Battery ${args.Battery}%`, 'info');
}

async function handleAuthorized(mac) {
  if (connectionAborted) return;
  setPenAuthorized(true);
  log('Pen authorized successfully', 'success');
  
  // Request real-time data for all papers
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();
  
  if (controller) {
    // GATT operations must be serialized - add delays between commands
    try {
      // Request ALL sections and owners (null means all)
      controller.RequestAvailableNotes(null, null, null);
      // Wait for GATT operation to complete before next command
      await new Promise(resolve => setTimeout(resolve, 300));
      controller.SetHoverEnable(true);
      log('Pen ready for real-time capture (all notebooks)', 'info');
    } catch (error) {
      console.warn('GATT setup warning:', error);
      // Non-fatal - pen may still work
    }
  }
}

function handleDisconnected() {
  // If a connection attempt is in progress, a disconnect means it failed
  if (connectionReject) {
    connectionReject(new Error('Pen disconnected during connection attempt'));
  }
  setPenConnected(false);
  log('Pen disconnected', 'warning');
}

function handlePasswordRequest(args) {
  const password = prompt(
    `Enter pen password (4 digits)\nAttempts: ${args.RetryCount}/10\n⚠️ Data will be reset after 10 failed attempts`
  );
  
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();
  
  if (password && password.length === 4 && controller) {
    controller.InputPassword(password);
  }
}

// Track ongoing offline data transfers
let pendingOfflineTransfer = null;  // String - normalized book ID
let offlineTransferResolver = null;
let receivedStrokesTotal = 0;        // Total strokes across all books
let lastDataReceivedTime = null;     // Track when last data chunk arrived
let dataReceivedForCurrentTransfer = false;  // Track if we've received ANY data
let transferStartTime = null;        // Track when transfer started for timing info
let transferCancelled = false;       // Flag to cancel transfer
let elapsedTimerInterval = null;     // Timer to update elapsed seconds
// Per-book chunk tracking: the pen sends one OFFLINE_DATA_SEND_SUCCESS per PAGE,
// not per book. We estimate the total from the first STATUS percentage and keep
// waiting until cumulative received >= estimated total before resolving.
// Note: OFFLINE_DATA_RESPONSE (type 49) is handled internally by the SDK and is
// NOT passed to our messageCallback, so we cannot use it directly.
let expectedStrokesForCurrentTransfer = 0;  // estimated from STATUS %
let receivedStrokesForCurrentTransfer = 0;  // matched strokes received so far
let lastStatusPercentage = 0;               // latest OFFLINE_DATA_SEND_STATUS %

// Configuration for timeouts (can be adjusted based on experience)
const TRANSFER_CONFIG = {
  IDLE_TIMEOUT_MS: 10000,      // 10 seconds of no data = complete (no global timeout!)
  IDLE_CHECK_INTERVAL_MS: 1000, // Check idle status every second
  INTER_BOOK_DELAY_MS: 500,    // Wait 500ms between books
};

/**
 * Cancel the current offline transfer
 * @returns {boolean} True if a transfer was cancelled
 */
export function cancelOfflineTransfer() {
  if (pendingOfflineTransfer && offlineTransferResolver) {
    console.log('%c❌ Transfer cancelled by user', 'background: #f44336; color: white; padding: 2px 6px; border-radius: 3px;');
    transferCancelled = true;
    const resolver = offlineTransferResolver;
    offlineTransferResolver = null;
    resolver({ cancelled: true });
    return true;
  }
  return false;
}

// ===== DELETION PROMISE STATE =====
let pendingDeletionResolver = null;

/**
 * Delete books from pen memory
 * Uses RequestOfflineDelete SDK method for direct deletion (no re-download needed)
 * @param {Array} books - Array of book objects to delete (from note list)
 * @returns {Promise<Object>} Deletion results
 */
export async function deleteBooksFromPen(books) {
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();

  if (!controller) {
    throw new Error('No pen connected');
  }

  if (!books || books.length === 0) {
    return { success: true, deletedBooks: [] };
  }

  console.log('%c🗑️ DELETION MODE ACTIVATED',
    'background: #f59e0b; color: white; padding: 3px 8px; border-radius: 3px; font-weight: bold; font-size: 14px;');
  console.log(`📋 Books to delete: ${books.length}`);

  log(`🗑️ Deleting ${books.length} book(s) from pen memory...`, 'warning');

  const results = {
    success: true,
    deletedBooks: [],
    failedBooks: [],
    totalBooks: books.length
  };

  // Group books by Section+Owner since RequestOfflineDelete takes notes[] per S/O pair
  const groups = {};
  books.forEach(book => {
    const key = `${book.Section}_${book.Owner}`;
    if (!groups[key]) {
      groups[key] = { section: book.Section, owner: book.Owner, books: [] };
    }
    groups[key].books.push(book);
  });

  try {
    for (const [groupKey, group] of Object.entries(groups)) {
      const noteIds = group.books.map(b => b.Note);

      console.log(`%c🗑️ Deleting ${noteIds.length} book(s) from S${group.section}/O${group.owner}: [${noteIds.join(', ')}]`,
        'color: #f59e0b; font-weight: bold;');
      log(`🗑️ Deleting ${noteIds.length} book(s) from Section ${group.section}...`, 'info');

      try {
        // Create promise that resolves when OFFLINE_DATA_DELETE_RESPONSE arrives
        const deletionComplete = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            console.warn(`⏰ Deletion timeout for S${group.section}/O${group.owner}`);
            pendingDeletionResolver = null;
            reject(new Error(`Timeout deleting books from Section ${group.section}`));
          }, 30000);  // 30 second timeout (deletion is fast, no data transfer)

          pendingDeletionResolver = (args) => {
            clearTimeout(timeout);
            resolve(args);
          };
        });

        // Use RequestOfflineDelete - direct deletion without re-downloading
        console.log(`[Deletion] Calling RequestOfflineDelete(${group.section}, ${group.owner}, [${noteIds.join(', ')}])`);
        controller.RequestOfflineDelete(group.section, group.owner, noteIds);

        // Wait for response
        const deleteResponse = await deletionComplete;

        console.log(`[Deletion] Response received:`, deleteResponse);

        // Mark all books in this group as deleted
        group.books.forEach(book => {
          const bookId = normalizeBookId(book.Note);
          console.log(`✅ Book ${bookId} deleted from pen`);
          log(`✅ Book ${bookId} deleted`, 'success');
          results.deletedBooks.push(book);
        });

        // Reset resolver
        pendingDeletionResolver = null;

        // Brief delay between groups for BLE stability
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`❌ Exception deleting books from S${group.section}/O${group.owner}:`, error);

        group.books.forEach(book => {
          const bookId = normalizeBookId(book.Note);
          log(`❌ Failed to delete Book ${bookId}: ${error.message}`, 'error');
          results.failedBooks.push(book);
        });
        results.success = false;

        // Reset state and continue to next group
        pendingDeletionResolver = null;
      }
    }

  } finally {
    console.log('%c🗑️ DELETION MODE DEACTIVATED',
      'background: #10b981; color: white; padding: 3px 8px; border-radius: 3px; font-weight: bold;');
  }

  // Log final results
  if (results.success) {
    console.log(`✅ Successfully deleted ${results.deletedBooks.length} books from pen`);
    log(`✅ Successfully deleted ${results.deletedBooks.length} books from pen memory`, 'success');
  } else {
    console.warn(`⚠️ Deleted ${results.deletedBooks.length} books, ${results.failedBooks.length} failed`);
    log(`⚠️ Deleted ${results.deletedBooks.length} books, ${results.failedBooks.length} failed`, 'warning');
  }

  return results;
}

/**
 * Normalize book ID to string for consistent comparison
 * @param {*} bookId - Book ID from note list or stroke data
 * @returns {string} Normalized book ID as string
 */
function normalizeBookId(bookId) {
  if (bookId === null || bookId === undefined) {
    return 'unknown';
  }
  return String(bookId);
}

/**
 * Handle OFFLINE_DATA_RESPONSE (message type 49)
 * This tells us the pen is ready to send data (we don't rely on stroke count)
 */
function handleOfflineDataResponse(args) {
  console.log('%c📋 OFFLINE_DATA_RESPONSE received', 'background: #9C27B0; color: white; padding: 2px 6px; border-radius: 3px;', args);
  
  if (pendingOfflineTransfer) {
    const strokeCount = args?.stroke;
    const byteCount = args?.bytes;
    
    console.log(`📊 Book ${pendingOfflineTransfer}: Pen reports ${strokeCount || 0} strokes (${byteCount || 'unknown'} bytes)`);

    // Store expected count so handleOfflineDataReceived knows when all chunks arrived.
    // The pen sends one OFFLINE_DATA_SEND_SUCCESS per page, so we must accumulate.
    if (strokeCount > 0) {
      expectedStrokesForCurrentTransfer = strokeCount;
    }

    // Update status to receiving
    updateTransferProgress({
      status: 'receiving'
    });

    // If stroke count is 0, resolve immediately
    if (strokeCount === 0) {
      console.log(`📋 Book ${pendingOfflineTransfer} has 0 strokes - resolving immediately`);
      if (offlineTransferResolver) {
        const resolver = offlineTransferResolver;
        offlineTransferResolver = null;
        resolver({ empty: true });
      }
    }
  } else {
    console.warn('⚠️ Received OFFLINE_DATA_RESPONSE but no pending transfer');
  }
}

/**
 * Handle OFFLINE_DATA_DELETE_RESPONSE (message type 165)
 * This confirms the pen has deleted the requested offline data
 */
function handleOfflineDeleteResponse(args) {
  console.log('[Deletion] Delete response args:', args);

  if (pendingDeletionResolver) {
    console.log('[Deletion] Resolving pending deletion promise');
    pendingDeletionResolver(args);
  } else {
    console.warn('[Deletion] Received delete response but no pending resolver');
  }
}

async function handleOfflineNoteList(noteList) {
  console.log('%c===== OFFLINE NOTE LIST RECEIVED =====', 'background: #222; color: #bada55; font-size: 14px; padding: 4px;');
  console.log('📚 Note list:', noteList);
  
  // NEW: Check if this is for deletion dialog
  if (window.__pendingNoteListResolver) {
    console.log('📋 Routing note list to deletion dialog');
    window.__pendingNoteListResolver(noteList);
    window.__pendingNoteListResolver = null;
    return;
  }
  
  if (!noteList || noteList.length === 0) {
    log('No offline notes found', 'warning');
    return;
  }
  
  log(`Found ${noteList.length} offline note(s)`, 'info');
  
  let controller;
  const unsubscribe = penController.subscribe(c => controller = c);
  unsubscribe();
  
  // Show what we found with type info for debugging
  const noteInfo = noteList.map(n => {
    const bookId = normalizeBookId(n.Note);
    return `S${n.Section}/O${n.Owner}/B${bookId}`;
  }).join(', ');
  
  console.log('📚 Note details with types:', noteList.map(n => ({
    Section: n.Section,
    Owner: n.Owner,
    Note: n.Note,
    NoteType: typeof n.Note,
    PageCount: n.PageCount
  })));
  
  // Show book selection dialog
  let selectedBooks;
  try {
    selectedBooks = await openBookSelectionDialog(noteList);
  } catch (error) {
    console.log('❌ Download cancelled by user');
    return;
  }
  
  if (selectedBooks && selectedBooks.length > 0 && controller) {
    console.log('%c📥 Requesting offline data sequentially (waiting for each to complete)...', 'color: #4CAF50; font-weight: bold;');
    
    // Initialize transfer progress
    transferCancelled = false;
    receivedStrokesTotal = 0;
    transferStartTime = Date.now();
    
    updateTransferProgress({
      active: true,
      currentBook: 0,
      totalBooks: selectedBooks.length,
      receivedStrokes: 0,
      elapsedSeconds: 0,
      status: 'requesting',
      canCancel: true
    });
    
    // Start elapsed timer
    if (elapsedTimerInterval) clearInterval(elapsedTimerInterval);
    elapsedTimerInterval = setInterval(() => {
      if (transferStartTime) {
        updateTransferProgress({
          elapsedSeconds: Math.round((Date.now() - transferStartTime) / 1000)
        });
      }
    }, 1000);
    
    // CRITICAL: Request one book at a time and wait for its transfer to complete
    for (let i = 0; i < selectedBooks.length; i++) {
      // Check for cancellation
      if (transferCancelled) {
        console.log('❌ Transfer cancelled - stopping');
        log('Transfer cancelled', 'warning');
        break;
      }
      
      const note = selectedBooks[i];
      const normalizedBookId = normalizeBookId(note.Note);
      
      console.log(`%c📖 Requesting note ${i + 1}/${selectedBooks.length}: S${note.Section}/O${note.Owner}/B${normalizedBookId}`, 'color: #2196F3; font-weight: bold;', {
        Section: note.Section,
        Owner: note.Owner,
        Book: note.Note,
        BookType: typeof note.Note,
        NormalizedBookId: normalizedBookId,
        PageCount: note.PageCount || 'unknown'
      });
      
      // Reset per-transfer state
      dataReceivedForCurrentTransfer = false;
      lastDataReceivedTime = null;
      expectedStrokesForCurrentTransfer = 0;
      receivedStrokesForCurrentTransfer = 0;
      lastStatusPercentage = 0;
      
      // Update progress for this book (reset per-book counters for clean display)
      updateTransferProgress({
        currentBook: i + 1,
        status: 'requesting',
        currentBookStrokes: 0,
        expectedStrokes: 0
      });
      
      // Create a promise that resolves when this transfer completes
      const transferComplete = new Promise((resolve, reject) => {
        pendingOfflineTransfer = normalizedBookId;
        offlineTransferResolver = resolve;
        
        // Enable batch mode to pause canvas updates during import
        startBatchMode();
        console.log(`📊 Batch mode enabled for book ${normalizedBookId}`);
        
        // Only use idle detection - no global timeout!
        // Transfer completes when no new data for IDLE_TIMEOUT_MS
        const idleCheckInterval = setInterval(() => {
          // Check for cancellation
          if (transferCancelled) {
            clearInterval(idleCheckInterval);
            return;
          }
          
          if (pendingOfflineTransfer !== normalizedBookId) {
            clearInterval(idleCheckInterval);
            return;
          }
          
          if (dataReceivedForCurrentTransfer && lastDataReceivedTime) {
            const idleTime = Date.now() - lastDataReceivedTime;
            
            // Log progress periodically (every 2-3 seconds of idle)
            if (idleTime > 2000 && idleTime < 3000) {
              const elapsed = Math.round((Date.now() - transferStartTime) / 1000);
              console.log(`📊 Transfer status: ${receivedStrokesTotal} strokes, ${elapsed}s elapsed, idle ${Math.round(idleTime/1000)}s`);
            }
            
            if (idleTime > TRANSFER_CONFIG.IDLE_TIMEOUT_MS) {
              const elapsed = Math.round((Date.now() - transferStartTime) / 1000);
              console.log(`📋 No new data for ${Math.round(idleTime/1000)}s - book transfer complete`);
              clearInterval(idleCheckInterval);
              resolve({ idleTimeout: true });
            }
          }
        }, TRANSFER_CONFIG.IDLE_CHECK_INTERVAL_MS);
      });
      
      // Request the data
      controller.RequestOfflineData(
        note.Section, 
        note.Owner, 
        note.Note,  // Use original value for SDK call
        false, // Don't delete after download
        []     // All pages
      );
      
      // Wait for this transfer to complete before requesting the next one
      try {
        const result = await transferComplete;
        
        if (result?.cancelled) {
          console.log(`❌ Book ${normalizedBookId} transfer was cancelled`);
          updateTransferProgress({ status: 'cancelled' });
        } else if (result?.failed) {
          console.error(`❌ Book ${normalizedBookId} transfer reported failure`);
          updateTransferProgress({ status: 'error' });
        } else if (result?.empty) {
          console.log(`📋 Book ${normalizedBookId} was empty`);
        } else if (result?.idleTimeout) {
          console.log(`✅ Book ${normalizedBookId} completed`);
        } else {
          console.log(`✅ Book ${normalizedBookId} transfer completed normally`);
        }
        
        // Disable batch mode to trigger canvas update
        endBatchMode();
        console.log(`🎨 Batch mode disabled - canvas updating`);
        
        // Longer delay between books to ensure BLE connection stabilizes
        if (i < selectedBooks.length - 1 && !transferCancelled) {
          updateTransferProgress({ status: 'waiting' });
          console.log(`⏳ Waiting ${TRANSFER_CONFIG.INTER_BOOK_DELAY_MS}ms before next request...`);
          await new Promise(resolve => setTimeout(resolve, TRANSFER_CONFIG.INTER_BOOK_DELAY_MS));
        }
      } catch (error) {
        console.error(`❌ Transfer failed for book ${normalizedBookId}:`, error);
        
        // Disable batch mode even on failure
        endBatchMode();
        updateTransferProgress({ status: 'error' });
        // Continue to next book even if this one failed
      }
    }
    
    // Stop elapsed timer
    if (elapsedTimerInterval) {
      clearInterval(elapsedTimerInterval);
      elapsedTimerInterval = null;
    }
    
    // Reset transfer state
    pendingOfflineTransfer = null;
    offlineTransferResolver = null;
    dataReceivedForCurrentTransfer = false;
    lastDataReceivedTime = null;
    transferCancelled = false;
    
    // Log final stats
    const totalElapsed = Math.round((Date.now() - transferStartTime) / 1000);
    console.log(`✅ All offline data transfers completed: ${receivedStrokesTotal} strokes in ${totalElapsed}s`);
    
    // Clear progress after a short delay so user can see "complete" status
    updateTransferProgress({ status: 'complete', canCancel: false });
    setTimeout(() => {
      resetTransferProgress();
    }, 2000);
  } else {
    console.log('❌ Download cancelled by user');
  }
  console.log('%c===== END OFFLINE NOTE LIST PROCESSING =====', 'background: #222; color: #bada55; font-size: 14px; padding: 4px;');
}

function handleOfflineDataReceived(data) {
  const receiveTime = Date.now();
  
  // ========================================
  // DELETION MODE CHECK - PROCESS BUT DON'T STORE
  // ========================================
  let deletionMode = isDeletionMode;
  if (deletionMode) {
    console.log('%c🗑️ DELETION MODE - Processing data for pen acknowledgment', 
      'background: #f59e0b; color: white; padding: 2px 6px; border-radius: 3px;');
    
    // Count strokes for logging
    const strokeCount = Array.isArray(data) ? data.length : 0;
    console.log(`📦 Received ${strokeCount} strokes (will be discarded after processing)`);
    
    // Continue processing to ensure proper BLE protocol completion
    // but we'll skip the addOfflineStrokes() call at the end
  }
  
  // ========================================
  // NORMAL IMPORT MODE - EXISTING LOGIC
  // ========================================
  
  const timeSinceStart = transferStartTime ? Math.round((receiveTime - transferStartTime) / 1000) : 0;
  const timeSinceLast = lastDataReceivedTime ? Math.round((receiveTime - lastDataReceivedTime) / 1000) : 0;
  
  console.log('%c===== OFFLINE DATA RECEIVED =====', 'background: #FF9800; color: white; font-size: 14px; padding: 4px;');
  console.log(`⏱️ Timing: ${timeSinceStart}s since start${timeSinceLast > 0 ? `, ${timeSinceLast}s since last chunk` : ''}`);
  console.log('📦 Raw data type:', Array.isArray(data) ? 'array' : typeof data);
  console.log('📦 Raw data length:', Array.isArray(data) ? data.length : 'N/A');
  
  // Update timing for idle detection
  lastDataReceivedTime = Date.now();
  dataReceivedForCurrentTransfer = true;
  
  if (!Array.isArray(data)) {
    console.error('❌ Data is not an array!', data);
    return false;
  }
  
  const convertedStrokes = [];
  const bookStats = {}; // Track strokes per book
  const pageStats = {};  // Track strokes per page
  let skippedCount = 0;
  let detectedBook = null;
  let detectedBookRaw = null;  // Keep raw value for debugging
  
  // Process offline strokes
  data.forEach((stroke, index) => {
    if (stroke.Dots && Array.isArray(stroke.Dots)) {
      const firstDot = stroke.Dots[0];
      const pageInfo = firstDot?.pageInfo || {};
      const bookIdRaw = pageInfo.book;
      const bookId = normalizeBookId(bookIdRaw);
      
      // Track which book this batch belongs to
      if (!detectedBook) {
        detectedBook = bookId;
        detectedBookRaw = bookIdRaw;
      }
      
      // Track which books we're seeing
      if (!bookStats[bookId]) {
        bookStats[bookId] = 0;
      }
      bookStats[bookId]++;
      
      // Track which pages we're seeing
      const pageKey = `B${bookId}/P${pageInfo.page || 0}`;
      if (!pageStats[pageKey]) {
        pageStats[pageKey] = 0;
      }
      pageStats[pageKey]++;
      
      // Log first stroke from each book for debugging
      if (bookStats[bookId] === 1) {
        console.log(`%c📖 First stroke from book B${bookId}`, 'color: #9C27B0; font-weight: bold;', {
          strokeIndex: index,
          section: pageInfo.section,
          owner: pageInfo.owner,
          book: bookIdRaw,
          bookType: typeof bookIdRaw,
          normalizedBook: bookId,
          page: pageInfo.page,
          dotCount: stroke.Dots.length
        });
      }
      
      const convertedStroke = {
        pageInfo: pageInfo,
        startTime: firstDot?.timeStamp || 0,
        endTime: stroke.Dots[stroke.Dots.length - 1]?.timeStamp || 0,
        dotArray: stroke.Dots.map(d => ({
          x: d.x,
          y: d.y,
          f: d.f,
          timestamp: d.timeStamp
        })),
        _raw: stroke
      };
      
      convertedStrokes.push(convertedStroke);
      
      // Skip canvas rendering during batch mode - will update once at the end
      // Only render in real-time mode
      if (canvasRenderer && !pendingOfflineTransfer) {
        stroke.Dots.forEach(dot => canvasRenderer.addDot(dot));
      }
    } else {
      skippedCount++;
      if (skippedCount <= 5) {
        console.warn(`⚠️ Stroke ${index} has no Dots array (${skippedCount} total skipped so far)`);
      }
    }
  });
  
  // Log final skipped count if more than 5
  if (skippedCount > 5) {
    console.warn(`⚠️ Total strokes skipped (no Dots array): ${skippedCount}`);
  }
  
  console.log('%c📊 Book Statistics:', 'color: #00BCD4; font-weight: bold; font-size: 13px;', bookStats);
  console.log('%c📄 Page Statistics:', 'color: #00BCD4; font-weight: bold; font-size: 13px;', pageStats);
  console.log(`✅ Total converted strokes: ${convertedStrokes.length} across ${Object.keys(pageStats).length} pages${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`);
  
  // Debug: Log comparison values
  console.log('%c🔍 Transfer Matching Debug:', 'color: #FF5722; font-weight: bold;', {
    detectedBook,
    detectedBookRaw,
    detectedBookType: typeof detectedBookRaw,
    pendingOfflineTransfer,
    pendingType: typeof pendingOfflineTransfer,
    match: detectedBook === pendingOfflineTransfer
  });
  
  // Add strokes to store (UNLESS in deletion mode)
  if (deletionMode) {
    console.log(`🗑️ DELETION MODE - Skipping addOfflineStrokes() to discard data`);
    
    // Resolve the pending transfer (deletion successful).
    // Return false so processMessage doesn't attempt a second resolution.
    if (offlineTransferResolver) {
      const resolver = offlineTransferResolver;
      offlineTransferResolver = null;
      resolver({ deleted: true });
    }

    log(`🗑️ Deleted ${convertedStrokes.length} strokes from pen (data discarded)`, 'success');
    console.log('%c===== END DELETION DATA PROCESSING =====', 'background: #f59e0b; color: white; font-size: 14px; padding: 4px;');
    return false; // Exit early — resolver already called above
  } else {
    // Normal import - add strokes to store
    addOfflineStrokes(convertedStrokes);
  }
  
  const elapsed = transferStartTime ? Math.round((Date.now() - transferStartTime) / 1000) : 0;
  const rate = elapsed > 0 ? Math.round(convertedStrokes.length / elapsed) : convertedStrokes.length;
  log(`Received ${convertedStrokes.length} strokes from ${Object.keys(bookStats).length} book(s) (${elapsed}s, ~${rate} strokes/sec)`, 'success');
  console.log('%c===== END OFFLINE DATA PROCESSING =====', 'background: #FF9800; color: white; font-size: 14px; padding: 4px;');
  
  // Track progress - running stroke total
  if (detectedBook && pendingOfflineTransfer && detectedBook === pendingOfflineTransfer) {
    // Add to running totals
    receivedStrokesTotal += convertedStrokes.length;
    receivedStrokesForCurrentTransfer += convertedStrokes.length;

    // The pen sends one OFFLINE_DATA_SEND_SUCCESS per page, so we must keep
    // waiting until the cumulative received count reaches the expected total.
    //
    // OFFLINE_DATA_RESPONSE (type 49) is consumed internally by the SDK and never
    // reaches our callback, so we derive the expected total from the STATUS
    // percentage that fires just before each SUCCESS:
    //   STATUS fires with cumulative% = strokes_so_far / total_strokes * 100
    //   Therefore: total_strokes = strokes_so_far / (cumulative% / 100)
    if (expectedStrokesForCurrentTransfer === 0 && lastStatusPercentage > 0) {
      const estimated = Math.round(receivedStrokesForCurrentTransfer / (lastStatusPercentage / 100));
      if (estimated > 0) {
        expectedStrokesForCurrentTransfer = estimated;
        console.log(`📊 Estimated total from STATUS ${lastStatusPercentage.toFixed(2)}%: ${estimated} strokes`);
      }
    }

    // Push current per-book counts to the UI store
    updateTransferProgress({
      receivedStrokes: receivedStrokesTotal,
      currentBookStrokes: receivedStrokesForCurrentTransfer,
      expectedStrokes: expectedStrokesForCurrentTransfer,
      status: 'receiving'
    });

    if (expectedStrokesForCurrentTransfer > 0 &&
        receivedStrokesForCurrentTransfer < expectedStrokesForCurrentTransfer) {
      console.log(`📊 Chunk received: ${receivedStrokesForCurrentTransfer}/${expectedStrokesForCurrentTransfer} strokes — waiting for more pages`);
      return false; // more chunks expected
    }

    console.log(`📊 Transfer complete: ${receivedStrokesForCurrentTransfer} strokes` +
      (expectedStrokesForCurrentTransfer > 0 ? `/${expectedStrokesForCurrentTransfer} expected` : ' (no count tracking)'));
    return true; // all strokes received — safe to resolve
  } else if (detectedBook && pendingOfflineTransfer && detectedBook !== pendingOfflineTransfer) {
    // Data arrived for a different book than requested (e.g. BLE retransmission or
    // pen firmware sends books out of order). Strokes were still added to the store,
    // but we must NOT resolve the pending transfer — keep waiting for the correct
    // book's data. The idle timeout acts as the ultimate fallback.
    console.warn('%c⚠️ BOOK ID MISMATCH — not resolving transfer', 'background: #f44336; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold;');
    console.warn(`   Received data for book: ${detectedBook} (raw: ${detectedBookRaw}, type: ${typeof detectedBookRaw})`);
    console.warn(`   But waiting for book: ${pendingOfflineTransfer} (type: ${typeof pendingOfflineTransfer})`);
    console.warn(`   Strokes added to store. Waiting for correct book data (idle timeout is fallback).`);
    return false; // mismatch — do NOT resolve; keep the promise live
  }

  // No book tracking active (e.g. no pendingOfflineTransfer), safe to resolve
  return true;
}
