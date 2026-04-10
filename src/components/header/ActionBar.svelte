<!--
  ActionBar.svelte - Compact action buttons for header
-->
<script>
  import { 
    penConnected, 
    penAuthorized, 
    log, 
    clearStrokes, 
    strokeCount,
    hasSelection,
    selectionCount,
    selectedStrokes,
    selectedIndices,
    clearSelection,
    adjustSelectionAfterDeletion,
    strokes,
    removeStrokesByIndices,
    hasMyScriptCredentials,
    isTranscribing,
    setTranscription,
    setPageTranscription,
    clearTranscription,
    setIsTranscribing,
    setActiveTab,
    getMyScriptCredentials,
    logseqConnected,
    getLogseqSettings,
    hasTranscription,
    hasPageTranscriptions,
    lastTranscription,
    pageTranscriptions,
    transferProgress,
    transferPercent,
    hasPendingDeletions,
    canUndo,
    markStrokesDeleted,
    undoLastDeletion,
    clearDeletedIndices,
    getActiveStrokesForPage,
    hasPendingChanges,
    deletedIndices
  } from '$stores';
  import { getUntranscribedStrokes } from '$stores/strokes.js';
  import { getDeletedStrokeIdsForPage } from '$stores/pending-changes.js';
  import { writable } from 'svelte/store';
  import SaveConfirmDialog from '$components/dialog/SaveConfirmDialog.svelte';
  
  // Transcription progress state
  const transcriptionProgress = writable({
    active: false,
    currentPage: 0,
    totalPages: 0,
    currentBook: 0,
    currentPageNum: 0,
    successCount: 0,
    errorCount: 0,
    elapsedSeconds: 0
  });
  import { connectPen, disconnectPen, fetchOfflineData, cancelOfflineTransfer } from '$lib/pen-sdk.js';
  import { transcribeStrokes } from '$lib/myscript-api.js';
  import { updatePageStrokes } from '$lib/logseq-api.js';
  import { updateTranscriptBlocks } from '$lib/transcript-updater.js'; // NEW: v2.0 updater
  // Removed filtered-strokes import - now handled via user-controlled deselection
  import {
    setStorageSaving,
    recordSuccessfulSave,
    recordStorageError
  } from '$stores/storage.js';
  
  let isConnecting = false;
  let isFetchingOffline = false;
  let isSavingToLogseq = false;
  let showSaveConfirmDialog = false;
  
  // Determine what data is available to save
  $: hasSaveableData = $strokeCount > 0;
  $: canDelete = $hasSelection;
  $: saveButtonText = (() => {
    if (isSavingToLogseq) return 'Saving...';
    // Check if there are pending changes
    if ($hasPendingChanges) return 'Save Changes to LogSeq';
    // Check if any page has transcription available
    if ($hasPageTranscriptions || $hasTranscription) return 'Save to LogSeq (Strokes + Text)';
    return 'Save to LogSeq (Strokes)';
  })();
  
  // Determine which strokes to transcribe (selected or all)
  $: strokesToTranscribe = $hasSelection ? $selectedStrokes : $strokes;
  $: transcribeCount = $hasSelection ? $selectionCount : $strokeCount;
  $: hasStrokes = $strokeCount > 0;
  $: canTranscribe = $hasMyScriptCredentials && hasStrokes && !$isTranscribing;
  
  // Calculate untranscribed strokes
  $: untranscribedStrokes = getUntranscribedStrokes($strokes);
  $: untranscribedCount = untranscribedStrokes.length;
  $: allTranscribed = $strokeCount > 0 && untranscribedCount === 0;
  
  // For selected strokes, count how many are untranscribed
  $: selectedUntranscribedCount = $hasSelection ? getUntranscribedStrokes($selectedStrokes).length : untranscribedCount;
  
  async function handleConnect() {
    isConnecting = true;
    try {
      await connectPen();
    } catch (error) {
      log(`Connection failed: ${error.message}`, 'error');
    } finally {
      isConnecting = false;
    }
  }
  
  async function handleDisconnect() {
    try {
      await disconnectPen();
    } catch (error) {
      log(`Disconnect failed: ${error.message}`, 'error');
    }
  }
  
  async function handleFetchOffline() {
    isFetchingOffline = true;
    try {
      await fetchOfflineData();
    } catch (error) {
      log(`Failed to fetch offline data: ${error.message}`, 'error');
    } finally {
      isFetchingOffline = false;
    }
  }
  
  function handleClearCanvas() {
    clearStrokes();
    clearDeletedIndices();
    log('Canvas cleared', 'info');
  }
  
  function handleDeleteSelected() {
    const indices = Array.from($selectedIndices);
    if (indices.length === 0) return;
    
    markStrokesDeleted(indices);
    clearSelection();
    log(`Marked ${indices.length} stroke(s) for deletion`, 'info');
  }
  
  function handleUndo() {
    const success = undoLastDeletion();
    if (success) {
      log('Undid last deletion', 'info');
    }
  }
  
  function handleShowSaveDialog() {
    if (!$logseqConnected) {
      log('Please configure LogSeq connection in Settings', 'warning');
      return;
    }
    
    if (!$strokeCount) {
      log('No strokes to save', 'warning');
      return;
    }
    
    showSaveConfirmDialog = true;
  }
  
  function handleCancelSave() {
    showSaveConfirmDialog = false;
  }
  
  async function handleTranscribe() {
    if (!$hasMyScriptCredentials) {
      log('Please configure MyScript API credentials in Settings', 'warning');
      return;
    }

    if (!hasStrokes) {
      log('No strokes available for transcription', 'warning');
      return;
    }

    setIsTranscribing(true);
    const transcribeLabel = $hasSelection ? 'selected' : 'all';
    const { host, token } = getLogseqSettings();

    // CRITICAL FIX: Filter strokes by page and handle Y-bounds overlap
    const strokesByPage = new Map();
    strokesToTranscribe.forEach(stroke => {
      const pageInfo = stroke.pageInfo || {};
      const pageKey = `S${pageInfo.section || 0}/O${pageInfo.owner || 0}/B${pageInfo.book || 0}/P${pageInfo.page || 0}`;

      if (!strokesByPage.has(pageKey)) {
        strokesByPage.set(pageKey, {
          allStrokes: [],          // All strokes (for Y-bounds calculation)
          untranscribedStrokes: [], // Only strokes without blockUuid (for MyScript)
          pageInfo: {
            section: pageInfo.section || 0,
            owner: pageInfo.owner || 0,
            book: pageInfo.book || 0,
            page: pageInfo.page || 0
          }
        });
      }

      const pageData = strokesByPage.get(pageKey);
      pageData.allStrokes.push(stroke);

      // Only add to untranscribed list if no blockUuid
      if (!stroke.blockUuid) {
        pageData.untranscribedStrokes.push(stroke);
      }
    });
    
    // Count pages that actually have untranscribed strokes
    const pagesWithNewStrokes = Array.from(strokesByPage.values()).filter(
      pageData => pageData.untranscribedStrokes.length > 0
    );
    const totalPages = pagesWithNewStrokes.length;

    if (totalPages === 0) {
      log('All selected strokes have already been transcribed', 'info');
      setIsTranscribing(false);
      return;
    }

    const totalUntranscribed = pagesWithNewStrokes.reduce(
      (sum, pageData) => sum + pageData.untranscribedStrokes.length,
      0
    );
    log(`Transcribing ${totalUntranscribed} untranscribed ${transcribeLabel} strokes from ${totalPages} page(s)...`, 'info');

    // Don't clear previous transcriptions - we're appending
    // clearTranscription();

    // Start progress tracking
    const startTime = Date.now();
    let progressInterval;

    transcriptionProgress.set({
      active: true,
      currentPage: 0,
      totalPages,
      currentBook: 0,
      currentPageNum: 0,
      successCount: 0,
      errorCount: 0,
      elapsedSeconds: 0
    });

    // Update elapsed time every second
    progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      transcriptionProgress.update(p => ({ ...p, elapsedSeconds: elapsed }));
    }, 1000);

    try {
      const { appKey, hmacKey } = getMyScriptCredentials();
      let successCount = 0;
      let errorCount = 0;
      let currentPageIndex = 0;

      // Transcribe each page separately
      for (const [pageKey, pageData] of strokesByPage) {
        // Skip pages with no untranscribed strokes
        if (pageData.untranscribedStrokes.length === 0) {
          log(`Skipping Book ${pageData.pageInfo.book}/Page ${pageData.pageInfo.page} - all strokes already transcribed`, 'info');
          continue;
        }

        currentPageIndex++;
        const { book, page } = pageData.pageInfo;

        // Update progress
        transcriptionProgress.update(p => ({
          ...p,
          currentPage: currentPageIndex,
          currentBook: book,
          currentPageNum: page
        }));

        try {
          log(`Transcribing ${pageData.untranscribedStrokes.length} new stroke(s) on Book ${book}, Page ${page}...`, 'info');

          // CRITICAL: Only send untranscribed strokes to MyScript
          const result = await transcribeStrokes(pageData.untranscribedStrokes, appKey, hmacKey);

          // Store transcription for this page
          // CRITICAL: Pass the actual transcribed strokes so we can track which strokes get blockUuid
          setPageTranscription(
            pageKey,
            result,
            pageData.pageInfo,
            pageData.allStrokes.length,  // Total stroke count includes both transcribed and untranscribed
            pageData.untranscribedStrokes  // NEW: The strokes that were actually sent to MyScript
          );

          log(`✓ Book ${book}/Page ${page}: ${result.text?.length || 0} characters, ${result.lines?.length || 0} lines`, 'success');
          successCount++;

          transcriptionProgress.update(p => ({ ...p, successCount }));
        } catch (error) {
          log(`✗ Failed to transcribe Book ${book}/Page ${page}: ${error.message}`, 'error');
          errorCount++;

          transcriptionProgress.update(p => ({ ...p, errorCount }));
        }
      }
      
      setActiveTab('transcription');
      
      if (successCount > 0) {
        log(`Transcription complete: ${successCount}/${totalPages} pages successful`, 'success');
      }
      if (errorCount > 0) {
        log(`${errorCount} page(s) failed to transcribe`, 'error');
      }
    } catch (error) {
      log(`Transcription failed: ${error.message}`, 'error');
    } finally {
      clearInterval(progressInterval);
      transcriptionProgress.set({
        active: false,
        currentPage: 0,
        totalPages: 0,
        currentBook: 0,
        currentPageNum: 0,
        successCount: 0,
        errorCount: 0,
        elapsedSeconds: 0
      });
      setIsTranscribing(false);
    }
  }

  
  async function handleSaveToLogseq(event) {
    // Close dialog
    showSaveConfirmDialog = false;
    
    // Get selected pages from dialog event
    const selectedPageKeys = event?.detail?.selectedPages || [];
    console.log('[SaveToLogseq] Selected page keys:', selectedPageKeys);
    
    if (selectedPageKeys.length === 0) {
      log('No pages selected for save', 'warning');
      return;
    }
    
    // Convert selected page keys to Set for fast lookup
    const selectedSet = new Set(selectedPageKeys);
    console.log('[SaveToLogseq] Selected set:', Array.from(selectedSet));
    
    isSavingToLogseq = true;
    setStorageSaving(true);
    
    let savedStrokesCount = 0;
    let savedTranscriptionCount = 0;
    let errorCount = 0;
    
    try {
      const { host, token } = getLogseqSettings();
      
      // Get all pages with changes (additions or deletions)
      const pagesToSave = new Map();
      
      // Group strokes by page, filtering out deleted ones and checking selection
      $strokes.forEach((stroke, index) => {
        const pageInfo = stroke.pageInfo;
        if (!pageInfo || pageInfo.book === undefined || pageInfo.page === undefined) return;
        
        const key = `${pageInfo.book}-${pageInfo.page}`;
        
        // Skip if this page is not selected
        if (!selectedSet.has(key)) {
          console.log(`[SaveToLogseq] Skipping stroke from unselected page: ${key}`);
          return;
        }
        
        if (!pagesToSave.has(key)) {
          pagesToSave.set(key, {
            book: pageInfo.book,
            page: pageInfo.page,
            strokes: []
          });
        }
        
        pagesToSave.get(key).strokes.push(stroke);
      });
      
      if (pagesToSave.size === 0) {
        log('No selected pages have strokes to save', 'warning');
        return;
      }
      
      log(`Saving ${pagesToSave.size} selected page(s)...`, 'info');
      
      // Save each page
      for (const [key, pageData] of pagesToSave) {
        const { book, page, strokes: pageStrokes } = pageData;
        
        console.log(`[SaveToLogseq] Processing page: ${key} (book=${book}, page=${page})`);
        
        // Get active strokes (excluding deleted ones) for this page
        const activeStrokes = getActiveStrokesForPage(book, page);
        
        if (activeStrokes.length === 0) {
          log(`Skipping B${book}/P${page} (no active strokes)`, 'info');
          continue;
        }
        
        try {
          // Get explicit deletion IDs for this page (only strokes user selected + deleted)
          const deletedIds = getDeletedStrokeIdsForPage(book, page);
          const result = await updatePageStrokes(book, page, activeStrokes, host, token, deletedIds);
          
          if (result.success) {
            recordSuccessfulSave(`B${book}/P${page}`, result);
            
            // Show chunk info if using chunked storage
            const chunkInfo = result.chunks ? ` (${result.chunks} chunks)` : '';
            
            // Build message showing actual changes
            const parts = [];
            if (result.added > 0) parts.push(`+${result.added} new`);
            if (result.deleted > 0) parts.push(`-${result.deleted} deleted`);
            const changes = parts.length > 0 ? parts.join(', ') + ', ' : '';
            
            log(`Saved ${result.page}: ${changes}${result.total} total${chunkInfo}`, 'success');
            savedStrokesCount++;
            
            // Step 2: Check for page-specific transcription (only if page is selected)
            const pageInfo = activeStrokes[0]?.pageInfo || { section: 0, owner: 0, book, page };
            const pageKey = `S${pageInfo.section || 0}/O${pageInfo.owner || 0}/B${book}/P${page}`;
            const pageTranscription = $pageTranscriptions.get(pageKey);

            // Only save transcription if this page is in the selected set
            if (pageTranscription && selectedSet.has(key)) {
              // NEW v2.0: Save page-specific transcription with property-based blocks
              log(`Saving transcription blocks to ${result.page}...`, 'info');

              try {
                // CRITICAL: Pass ALL strokes (including those with blockUuid) for Y-bounds context
                // The updateTranscriptBlocks function will filter internally
                const transcriptResult = await updateTranscriptBlocks(
                  book,
                  page,
                  activeStrokes,      // Pass all active strokes for Y-bounds calculation
                  pageTranscription,   // MyScript result with lines (from untranscribed strokes only)
                  host,
                  token
                );

                if (transcriptResult.success) {
                  const { stats } = transcriptResult;
                  const actions = [];
                  if (stats.created > 0) actions.push(`${stats.created} new`);
                  if (stats.updated > 0) actions.push(`${stats.updated} updated`);
                  if (stats.skipped > 0) actions.push(`${stats.skipped} preserved`);

                  log(`✅ Transcription saved: ${actions.join(', ')}`, 'success');
                  savedTranscriptionCount++;
                } else {
                  log(`Failed to save transcription: ${transcriptResult.error}`, 'warning');
                }
              } catch (transcriptError) {
                log(`Error saving transcription: ${transcriptError.message}`, 'warning');
              }
            } else if ($hasTranscription && selectedSet.has(key)) {
              // Fallback to legacy single transcription if no page-specific one exists
              // AND the page is in the selected set
              // Check if transcription is for this page
              const transcriptionStrokes = $selectedStrokes.length > 0 ? $selectedStrokes : $strokes;
              const firstTranscriptionStroke = transcriptionStrokes[0];
              
              if (firstTranscriptionStroke && 
                  firstTranscriptionStroke.pageInfo.book === book && 
                  firstTranscriptionStroke.pageInfo.page === page) {
                
                log(`Saving legacy transcription to ${result.page}...`, 'info');
                
                try {
                  const transcriptResult = await updateTranscriptBlocks(
                    book,
                    page,
                    transcriptionStrokes,
                    $lastTranscription,
                    host,
                    token
                  );
                  
                  if (transcriptResult.success) {
                    const { stats } = transcriptResult;
                    const actions = [];
                    if (stats.created > 0) actions.push(`${stats.created} new`);
                    if (stats.updated > 0) actions.push(`${stats.updated} updated`);
                    if (stats.skipped > 0) actions.push(`${stats.skipped} preserved`);
                    
                    log(`✅ Transcription saved: ${actions.join(', ')}`, 'success');
                    savedTranscriptionCount++;
                  } else {
                    log(`Failed to save transcription: ${transcriptResult.error}`, 'warning');
                  }
                } catch (transcriptError) {
                  log(`Error saving transcription: ${transcriptError.message}`, 'warning');
                }
              }
            }
          } else {
            recordStorageError(result.error);
            log(`Failed to save page ${book}/${page}: ${result.error}`, 'error');
            errorCount++;
          }
        } catch (error) {
          recordStorageError(error.message);
          log(`Error saving page ${book}/${page}: ${error.message}`, 'error');
          errorCount++;
        }
      }
      
      // Summary
      if (savedStrokesCount > 0) {
        const summary = savedTranscriptionCount > 0 
          ? `Saved ${savedStrokesCount} page(s) with strokes and transcription`
          : `Saved ${savedStrokesCount} page(s) with strokes`;
        log(summary, 'success');
        
        // Remove deleted strokes from the store after successful save
        const deletedStrokeIndices = Array.from($deletedIndices).sort((a, b) => b - a);
        if (deletedStrokeIndices.length > 0) {
          // First adjust selection to account for removal
          adjustSelectionAfterDeletion(deletedStrokeIndices);
          
          // Then remove the strokes
          removeStrokesByIndices(deletedStrokeIndices);
          
          log(`Removed ${deletedStrokeIndices.length} deleted stroke(s) from canvas`, 'info');
        }
        
        // Clear deleted indices after removal
        clearDeletedIndices();
      }
      if (errorCount > 0) {
        log(`Failed to save ${errorCount} page(s)`, 'error');
      }
    } finally {
      isSavingToLogseq = false;
    }
  }
</script>

<!-- Save Confirmation Dialog -->
<SaveConfirmDialog 
  visible={showSaveConfirmDialog} 
  on:confirm={handleSaveToLogseq}
  on:cancel={handleCancelSave}
/>

<div class="action-bar">
  <!-- Transcription Progress Popup -->
  {#if $transcriptionProgress.active}
    <div class="transcription-popup">
      <div class="transcription-header">
        <span>✍️ Transcribing Handwriting</span>
      </div>
      <div class="transcription-bar">
        <div 
          class="transcription-fill" 
          style="width: {($transcriptionProgress.currentPage / $transcriptionProgress.totalPages) * 100}%"
        ></div>
      </div>
      <div class="transcription-stats">
        <span>
          Page {$transcriptionProgress.currentPage}/{$transcriptionProgress.totalPages}
          {#if $transcriptionProgress.currentBook > 0}
            - Book {$transcriptionProgress.currentBook}, Page {$transcriptionProgress.currentPageNum}
          {/if}
        </span>
        <span>{$transcriptionProgress.elapsedSeconds}s</span>
      </div>
      {#if $transcriptionProgress.successCount > 0 || $transcriptionProgress.errorCount > 0}
        <div class="transcription-results">
          {#if $transcriptionProgress.successCount > 0}
            <span class="success-count">✓ {$transcriptionProgress.successCount}</span>
          {/if}
          {#if $transcriptionProgress.errorCount > 0}
            <span class="error-count">✗ {$transcriptionProgress.errorCount}</span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  
  <!-- Transfer Progress Popup -->
  {#if $transferProgress.active}
    <div class="transfer-popup">
      <div class="transfer-header">
        <span>📥 Importing Offline Data</span>
        {#if $transferProgress.canCancel}
          <button class="cancel-btn" on:click={cancelOfflineTransfer} title="Cancel transfer">✕</button>
        {/if}
      </div>
      <div class="transfer-bar">
        {#if $transferProgress.expectedStrokes > 0}
          <div class="transfer-fill" style="width: {$transferPercent}%"></div>
        {:else}
          <div class="transfer-fill indeterminate"></div>
        {/if}
      </div>
      <div class="transfer-stats">
        <span>
          {#if $transferProgress.currentBook > 0}
            Book {$transferProgress.currentBook}/{$transferProgress.totalBooks}
            {#if $transferProgress.expectedStrokes > 0}
              · {$transferProgress.currentBookStrokes}/{$transferProgress.expectedStrokes} strokes ({$transferPercent}%)
            {:else}
              · {$transferProgress.currentBookStrokes} strokes
            {/if}
          {:else}
            {$transferProgress.status === 'requesting' ? 'Requesting...' : 'Waiting...'}
          {/if}
        </span>
        <span>{$transferProgress.elapsedSeconds}s</span>
      </div>
    </div>
  {/if}

  {#if !$penConnected}
    <button 
      class="action-btn connect-btn" 
      on:click={handleConnect}
      disabled={isConnecting}
      title="Connect to SmartPen via Bluetooth"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v20M17 7l-5 5 5 5M7 7l5 5-5 5"/>
      </svg>
      {#if isConnecting}
        Connecting...
      {:else}
        Connect
      {/if}
    </button>
  {:else}
    <button 
      class="action-btn disconnect-btn" 
      on:click={handleDisconnect}
      title="Disconnect from SmartPen"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
      Disconnect
    </button>
  {/if}
  
  <button 
    class="action-btn"
    on:click={handleFetchOffline}
    disabled={!$penConnected || !$penAuthorized || isFetchingOffline || $transferProgress.active}
    title="Fetch offline notes from pen memory"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    {#if isFetchingOffline || $transferProgress.active}
      Fetching...
    {:else}
      Fetch Notes
    {/if}
  </button>
  
  <button 
    class="action-btn save-logseq-btn"
    on:click={handleShowSaveDialog}
    disabled={!hasSaveableData || isSavingToLogseq || !$logseqConnected}
    title="Save strokes and transcription (if available) to LogSeq storage"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>
    {saveButtonText}
  </button>
  
  <button 
    class="action-btn delete-btn"
    on:click={handleDeleteSelected}
    disabled={!canDelete}
    title="Delete selected strokes (can be undone)"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <line x1="10" y1="11" x2="10" y2="17"/>
      <line x1="14" y1="11" x2="14" y2="17"/>
    </svg>
    Delete ({$selectionCount})
  </button>
  
  <button 
    class="action-btn undo-btn"
    on:click={handleUndo}
    disabled={!$canUndo}
    title="Undo last deletion"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 7v6h6"/>
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
    </svg>
    Undo
  </button>
  
  <button 
    class="action-btn"
    on:click={handleClearCanvas}
    title="Clear all strokes from canvas"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
    Clear
  </button>
  
  <div class="divider"></div>
  
  <button 
    class="action-btn transcribe-btn"
    class:all-transcribed={allTranscribed}
    on:click={handleTranscribe}
    disabled={!canTranscribe}
    title={allTranscribed ? 'All strokes already transcribed' : `Transcribe ${selectedUntranscribedCount} untranscribed stroke(s)`}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
    </svg>
    {#if $isTranscribing}
      Transcribing...
    {:else if allTranscribed}
      Transcribed ✓
    {:else}
      Transcribe ({selectedUntranscribedCount}/{transcribeCount})
    {/if}
  </button>
  
  {#if hasStrokes && untranscribedCount !== $strokeCount}
  <div class="transcription-status" title="{$strokeCount - untranscribedCount} strokes already transcribed">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
    <span>{$strokeCount - untranscribedCount}/{$strokeCount} transcribed</span>
  </div>
  {/if}
</div>

<style>
  .action-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    position: relative;
  }

  .action-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    white-space: nowrap;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .connect-btn {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .connect-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .disconnect-btn {
    background: var(--bg-tertiary);
  }

  .transcribe-btn {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .transcribe-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  
  .transcribe-btn.all-transcribed {
    background: var(--success);
    border-color: var(--success);
  }
  
  .transcribe-btn.all-transcribed:hover:not(:disabled) {
    background: #22c55e;
    border-color: #22c55e;
  }
  
  .save-logseq-btn {
    background: var(--success);
    color: white;
    border-color: var(--success);
  }
  
  .save-logseq-btn:hover:not(:disabled) {
    background: #22c55e;
    border-color: #22c55e;
  }
  
  .delete-btn {
    background: var(--error);
    color: white;
    border-color: var(--error);
  }
  
  .delete-btn:hover:not(:disabled) {
    background: #dc2626;
    border-color: #dc2626;
  }
  
  .undo-btn:hover:not(:disabled) {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .divider {
    width: 1px;
    height: 24px;
    background: var(--border);
    margin: 0 4px;
  }

  .action-btn svg {
    flex-shrink: 0;
  }

  /* Responsive: hide text labels on smaller screens */
  @media (max-width: 1400px) {
    .action-btn {
      padding: 8px 12px;
      font-size: 0;
    }
    
    .action-btn svg {
      margin: 0;
    }
  }

  /* Transcription Progress Popup */
  .transcription-popup {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 300px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 100;
  }

  .transcription-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .transcription-bar {
    height: 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .transcription-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-hover));
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .transcription-stats {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }

  .transcription-stats span:first-child {
    color: var(--accent);
  }
  
  .transcription-results {
    display: flex;
    gap: 12px;
    font-size: 0.8rem;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  
  .success-count {
    color: var(--success);
    font-weight: 600;
  }
  
  .error-count {
    color: var(--error);
    font-weight: 600;
  }

  /* Transfer Progress Popup */
  .transfer-popup {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 280px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 100;
  }

  .transfer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .cancel-btn {
    background: var(--error);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.2s;
  }

  .cancel-btn:hover {
    background: #dc2626;
  }

  .transfer-bar {
    height: 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .transfer-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--success), #22c55e);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .transfer-fill.indeterminate {
    width: 30% !important;
    animation: transfer-indeterminate 1.5s infinite ease-in-out;
  }

  @keyframes transfer-indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  .transfer-stats {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .transfer-stats span:first-child {
    color: var(--success);
  }
  
  /* Transcription Status Indicator */
  .transcription-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--success);
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--success);
    font-weight: 500;
  }
  
  .transcription-status svg {
    flex-shrink: 0;
  }
  
  @media (max-width: 1400px) {
    .transcription-status span {
      display: none;
    }
    
    .transcription-status {
      padding: 8px;
    }
  }
</style>
