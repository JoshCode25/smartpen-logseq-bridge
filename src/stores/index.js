/**
 * Store Index - Export all stores from one place
 */

// Strokes
export {
  strokes,
  pages,
  strokeCount,
  currentPageInfo,
  batchMode,
  addStroke,
  updateLastStroke,
  addOfflineStrokes,
  startBatchMode,
  endBatchMode,
  clearStrokes,
  removeStrokesByIndices,
  clearStrokeBlockUuids,
  getActiveStrokesForPageFromStore
} from './strokes.js';

// Selection
export {
  selectedIndices,
  lastSelectedIndex,
  selectedStrokes,
  selectionCount,
  hasSelection,
  selectStroke,
  selectRange,
  selectAll,
  clearSelection,
  handleStrokeClick,
  selectFromBox,
  deselectIndices,
  selectIndices,
  adjustSelectionAfterDeletion
} from './selection.js';

// Pen
export {
  penConnected,
  penAuthorized,
  penInfo,
  penController,
  penReady,
  penBattery,
  penMemory,
  transferProgress,
  transferPercent,
  setPenConnected,
  setPenAuthorized,
  setPenInfo,
  setPenController,
  updateTransferProgress,
  resetTransferProgress
} from './pen.js';

// Transcription
export {
  lastTranscription,
  pageTranscriptions,
  selectedPagesForImport,
  isTranscribing,
  transcribedText,
  transcribedLines,
  detectedCommands,
  transcriptionSummary,
  lineMetrics,
  transcribedWords,
  hasTranscription,
  transcriptionSourcePages,
  transcriptionByPage,
  pageTranscriptionsArray,
  pageTranscriptionCount,
  hasPageTranscriptions,
  setTranscription,
  setPageTranscription,
  togglePageSelection,
  selectAllPages,
  deselectAllPages,
  clearTranscription,
  clearPageTranscription,
  setIsTranscribing,
  updatePageTranscriptionLines
} from './transcription.js';

// Settings
export {
  myscriptAppKey,
  myscriptHmacKey,
  logseqHost,
  logseqToken,
  logseqConnected,
  logseqStatusText,
  hasMyScriptCredentials,
  setLogseqStatus,
  getMyScriptCredentials,
  getLogseqSettings
} from './settings.js';

// UI
export {
  activeTab,
  sidebarCollapsed,
  canvasZoom,
  showLineGuides,
  showFilteredStrokes,
  logMessages,
  showSearchTranscriptsDialog,
  log,
  setActiveTab,
  toggleSidebar,
  setCanvasZoom,
  toggleLineGuides,
  toggleFilteredStrokes,
  clearLog,
  openSearchTranscriptsDialog,
  closeSearchTranscriptsDialog,
  svgExportDialog,
  openSvgExportDialog,
  closeSvgExportDialog
} from './ui.js';

// Storage
export {
  storageStatus,
  storageStats,
  storageStatusMessage,
  hasSavedPages,
  setStorageSaving,
  recordSuccessfulSave,
  recordStorageError,
  clearStorageStatus,
  isPageSaved
} from './storage.js';

// Filtered Strokes
export {
  filteredStrokes,
  filterStats,
  setFilteredStrokes,
  clearFilteredStrokes,
  getFilteredStrokeByIndex
} from './filtered-strokes.js';

// LogSeq Pages
export {
  logseqPages,
  isScanning,
  lastScanTime,
  pagesByBook,
  bookIds,
  setLogseqPages,
  setScanning,
  clearLogseqPages,
  updatePageSyncStatus
} from './logseqPages.js';

// Book Aliases
export {
  bookAliases,
  knownBookIds,
  booksWithoutAliases,
  setBookAliases,
  setBookAlias,
  removeBookAlias,
  getBookAlias,
  registerBookId,
  registerBookIds,
  clearBookAliases
} from './book-aliases.js';

// Page Positions (Spatial Layout)
export {
  pagePositions,
  useCustomPositions,
  setPagePosition,
  movePageBy,
  getPagePosition,
  resetPagePositions,
  clearPagePositions,
  autoArrangePages
} from './page-order.js';

// Pending Changes (Deletions & Undo)
export {
  deletedIndices,
  deletedCount,
  hasPendingDeletions,
  canUndo,
  pendingChanges,
  hasPendingChanges,
  markStrokesDeleted,
  undoLastDeletion,
  clearDeletedIndices,
  isStrokeDeleted,
  getActiveStrokesForPage,
  getDeletedStrokeIdsForPage,
  getPendingChangesSummary
} from './pending-changes.js';

// Page Scales (Per-Page Resize)
export {
  pageScales,
  hasScaledPages,
  setPageScale,
  getPageScale,
  resetPageScale,
  resetAllPageScales,
  hasCustomScale
} from './page-scale.js';

// Clipboard
export {
  clipboardStrokes,
  hasClipboardContent,
  copyToClipboard,
  clearClipboard
} from './clipboard.js';

// Pasted Strokes
export {
  pastedStrokes,
  pastedSelection,
  pastedCount,
  selectedPastedStrokes,
  hasPastedSelection,
  duplicateStrokes,
  movePastedStrokes,
  deleteSelectedPasted,
  clearPastedStrokes,
  selectPastedStroke,
  clearPastedSelection,
  getPastedAsNewPage
} from './pasted-strokes.js';
