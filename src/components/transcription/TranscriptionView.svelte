<!--
  TranscriptionView.svelte - Per-page transcription display with import checkboxes
-->
<script>
  import { 
    isTranscribing,
    pageTranscriptionsArray,
    hasPageTranscriptions,
    selectedPagesForImport,
    togglePageSelection,
    selectAllPages,
    deselectAllPages,
    clearPageTranscription,
    updatePageTranscriptionLines,
    log,
    logseqConnected,
    getLogseqSettings,
    pageTranscriptionCount
  } from '$stores';
  import { bookAliases } from '$stores';
  import { sendToLogseq, getTranscriptLines, mergeExistingAndNewLines, updateTranscriptBlocksFromEditor } from '$lib/logseq-api.js';
  import { formatBookName, filterTranscriptionProperties } from '$utils/formatting.js';
  
  import LogseqPreview from './LogseqPreview.svelte';
  import TranscriptionEditorModal from '$components/dialog/TranscriptionEditorModal.svelte';
  
  let isSending = false;
  // Track which pages are expanded - using object for better reactivity
  let expandedPages = {};
  
  // Editor modal state
  let showEditorModal = false;
  let editingPageData = null;
  
  // Toggle page expansion
  function togglePageExpansion(pageKey) {
    expandedPages[pageKey] = !expandedPages[pageKey];
    expandedPages = { ...expandedPages }; // Trigger reactivity
  }
  
  // Handle select all / deselect all
  function handleSelectAll() {
    if ($selectedPagesForImport.size === $pageTranscriptionCount) {
      deselectAllPages();
    } else {
      selectAllPages();
    }
  }
  
  // Send selected pages to LogSeq
  async function handleSendToLogseq() {
    if (!$hasPageTranscriptions) {
      log('No transcriptions to send. Transcribe strokes first.', 'warning');
      return;
    }
    
    if ($selectedPagesForImport.size === 0) {
      log('No pages selected for import. Check the boxes next to pages you want to import.', 'warning');
      return;
    }
    
    isSending = true;
    log(`Sending ${$selectedPagesForImport.size} page(s) to LogSeq...`, 'info');
    
    try {
      const { host, token } = getLogseqSettings();
      let successCount = 0;
      let errorCount = 0;
      
      // Send each selected page
      for (const pageData of $pageTranscriptionsArray) {
        if (!$selectedPagesForImport.has(pageData.pageKey)) {
          continue; // Skip unselected pages
        }
        
        const { book, page } = pageData.pageInfo;
        
        try {
          const result = await sendToLogseq(pageData.lines, host, token);
          
          if (result.success) {
            log(`✓ Sent Book ${book}/Page ${page}: ${result.blockCount} blocks`, 'success');
            successCount++;
          } else {
            log(`✗ Failed Book ${book}/Page ${page}: ${result.error}`, 'error');
            errorCount++;
          }
        } catch (error) {
          log(`✗ Error sending Book ${book}/Page ${page}: ${error.message}`, 'error');
          errorCount++;
        }
      }
      
      // Summary
      if (successCount > 0) {
        log(`Import complete: ${successCount} page(s) sent successfully`, 'success');
      }
      if (errorCount > 0) {
        log(`${errorCount} page(s) failed to import`, 'error');
      }
    } catch (error) {
      log(`Send error: ${error.message}`, 'error');
    } finally {
      isSending = false;
    }
  }
  
  // Format page label with alias
  function formatPageLabel(pageInfo) {
    return `${formatBookName(pageInfo.book, $bookAliases, 'full')} / Page ${pageInfo.page}`;
  }
  
  // Get summary stats for a page
  function getPageStats(pageData) {
    return {
      lines: pageData.lines?.length || 0,
      words: pageData.words?.length || 0,
      characters: pageData.text?.length || 0,
      hasIndentation: pageData.lines?.some(l => l.indentLevel > 0) || false,
      commands: pageData.commands?.length || 0
    };
  }
  
  // Open editor modal for a page
  // Fetches existing LogSeq blocks and merges with new MyScript lines
  let isLoadingEditor = false;

  async function handleEditStructure(pageData) {
    isLoadingEditor = true;

    const { host, token } = getLogseqSettings();
    let existingLines = [];

    // Fetch existing transcript blocks from LogSeq if connected
    if (host && $logseqConnected) {
      try {
        existingLines = await getTranscriptLines(
          pageData.pageInfo.book,
          pageData.pageInfo.page,
          host,
          token
        );
        if (existingLines.length > 0) {
          log(`Loaded ${existingLines.length} existing transcript block(s) from LogSeq`, 'info');
        }
      } catch (e) {
        log(`Could not fetch existing transcription: ${e.message}`, 'warning');
        existingLines = [];
      }
    }

    // Merge existing LogSeq blocks with new MyScript lines (deduplicated)
    const mergedLines = mergeExistingAndNewLines(existingLines, pageData.lines || []);

    editingPageData = { ...pageData, mergedLines };
    isLoadingEditor = false;
    showEditorModal = true;
  }
  
  // Handle editor modal save
  // Updates only the local store - LogSeq save happens via "Save to LogSeq" button
  function handleEditorSave(event) {
    const { lines, book, page, mergedBlockPairs } = event.detail;

    if (!editingPageData) return;

    // Update the transcription lines in the local store only
    // LogSeq save will happen when user clicks "Save to LogSeq" button
    updatePageTranscriptionLines(editingPageData.pageKey, lines);

    log(`Updated structure for Book ${book}/Page ${page} (use "Save to LogSeq" to persist changes)`, 'success');

    // Close modal
    showEditorModal = false;
    editingPageData = null;
  }
  
  // Handle editor modal close
  function handleEditorClose() {
    showEditorModal = false;
    editingPageData = null;
  }
</script>

<div class="transcription-view">
  {#if $isTranscribing}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Transcribing handwriting...</p>
    </div>
  {:else if !$hasPageTranscriptions}
    <div class="empty-state">
      <p>Select strokes and click "Transcribe" to convert handwriting to text.</p>
      <p class="hint">
        <a href="https://developer.myscript.com/" target="_blank" rel="noopener">
          Get MyScript API keys (free: 2,000 requests/month)
        </a>
      </p>
    </div>
  {:else}
    <!-- Action Bar -->
    <div class="action-section">
      <div class="action-header">
        <h3>{$pageTranscriptionCount} Page{$pageTranscriptionCount !== 1 ? 's' : ''} Transcribed</h3>
        <button 
          class="btn-text select-all-btn"
          on:click={handleSelectAll}
        >
          {$selectedPagesForImport.size === $pageTranscriptionCount ? 'Deselect All' : 'Select All'}
        </button>
      </div>
      
      <button 
        class="btn btn-success send-btn"
        on:click={handleSendToLogseq}
        disabled={isSending || !$logseqConnected || $selectedPagesForImport.size === 0}
        title="Send selected pages to LogSeq journal"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <polyline points="19 12 12 19 5 12"/>
        </svg>
        {#if isSending}
          Sending...
        {:else if $selectedPagesForImport.size === 0}
          Select Pages to Send
        {:else}
          Send {$selectedPagesForImport.size} Page{$selectedPagesForImport.size !== 1 ? 's' : ''} to Journal
        {/if}
      </button>
      
      {#if !$logseqConnected}
        <p class="hint">Configure LogSeq connection in Settings</p>
      {/if}
    </div>
    
    <!-- Page List -->
    <div class="page-list">
      {#each $pageTranscriptionsArray as pageData (pageData.pageKey)}
        {@const stats = getPageStats(pageData)}
        {@const isExpanded = expandedPages[pageData.pageKey] || false}
        {@const isSelected = $selectedPagesForImport.has(pageData.pageKey)}
        
        <div class="page-card" class:selected={isSelected}>
          <!-- Page Header -->
          <div class="page-header">
            <label class="checkbox-label">
              <input 
                type="checkbox" 
                checked={isSelected}
                on:change={() => togglePageSelection(pageData.pageKey)}
              />
              <span class="page-title">
                <span class="book-name">{formatBookName(pageData.pageInfo.book, $bookAliases, 'full')}</span>
                <span class="page-number">/ P{pageData.pageInfo.page}</span>
              </span>
            </label>
            
            <div class="page-header-actions">
              <span class="stroke-count">{pageData.strokeCount} strokes</span>
              <button 
                class="btn-icon expand-btn"
                on:click={() => togglePageExpansion(pageData.pageKey)}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                <svg 
                  width="16" 
                  height="16" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  stroke-width="2"
                  class:rotated={isExpanded}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <button 
                class="btn-icon delete-btn"
                on:click={() => clearPageTranscription(pageData.pageKey)}
                title="Remove this transcription"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          
          <!-- Page Stats (always visible) -->
          <div class="page-stats">
            <div class="stat-item">
              <span class="stat-value">{stats.lines}</span>
              <span class="stat-label">lines</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">{stats.words}</span>
              <span class="stat-label">words</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">{stats.characters}</span>
              <span class="stat-label">chars</span>
            </div>
            {#if stats.hasIndentation}
              <div class="stat-item">
                <span class="stat-value">✓</span>
                <span class="stat-label">indented</span>
              </div>
            {/if}
            {#if stats.commands > 0}
              <div class="stat-item">
                <span class="stat-value">{stats.commands}</span>
                <span class="stat-label">commands</span>
              </div>
            {/if}
          </div>
          
          <!-- Expanded Details -->
          {#if isExpanded}
            <div class="page-details">
              <!-- Edit Structure Button -->
              <div class="detail-section">
                <button 
                  class="btn btn-edit"
                  on:click={() => handleEditStructure(pageData)}
                  title="Edit line structure, merge lines, adjust hierarchy"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Edit Structure
                </button>
              </div>
              
              <!-- Transcribed Text -->
              <div class="detail-section">
                <h4>Transcribed Text</h4>
                <pre class="text-output">{filterTranscriptionProperties(pageData.text) || 'No text'}</pre>
              </div>
              
              <!-- LogSeq Preview -->
              {#if pageData.lines && pageData.lines.length > 0}
                <div class="detail-section">
                  <h4>LogSeq Preview</h4>
                  <LogseqPreview lines={pageData.lines} />
                </div>
              {/if}
              
              <!-- Commands (if any) -->
              {#if pageData.commands && pageData.commands.length > 0}
                <div class="detail-section">
                  <h4>Detected Commands</h4>
                  <div class="command-list">
                    {#each pageData.commands as cmd}
                      <div class="command-item">
                        <span class="command-name">[{cmd.command}]</span>
                        {#if cmd.value}
                          <span class="command-value">{cmd.value}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Transcription Editor Modal -->
{#if showEditorModal && editingPageData}
<TranscriptionEditorModal
  book={editingPageData.pageInfo.book}
  page={editingPageData.pageInfo.page}
  lines={editingPageData.mergedLines || editingPageData.lines}
  visible={showEditorModal}
  on:save={handleEditorSave}
  on:close={handleEditorClose}
/>
{/if}

<style>
  .transcription-view {
    display: flex;
    flex-direction: column;
    gap: 15px;
    height: 100%;
    overflow-y: auto;
    padding-right: 5px;
  }

  .empty-state, .loading-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-secondary);
  }

  .empty-state .hint {
    margin-top: 15px;
  }

  .empty-state a {
    color: var(--accent);
    text-decoration: none;
  }

  .empty-state a:hover {
    text-decoration: underline;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 15px;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Action Section */
  .action-section {
    background: var(--bg-tertiary);
    border-radius: 8px;
    padding: 15px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .action-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .action-header h3 {
    font-size: 0.95rem;
    margin: 0;
    color: var(--text-primary);
  }

  .select-all-btn {
    font-size: 0.8rem;
    color: var(--accent);
    cursor: pointer;
    background: none;
    border: none;
    padding: 4px 8px;
  }

  .select-all-btn:hover {
    text-decoration: underline;
  }

  .btn {
    width: 100%;
    padding: 12px 20px;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .send-btn {
    background: var(--success);
    color: var(--bg-primary);
  }

  .send-btn:hover:not(:disabled) {
    background: #22c55e;
  }
  
  .btn-edit {
    width: 100%;
    background: var(--accent);
    color: white;
    border: 1px solid var(--accent);
  }
  
  .btn-edit:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-align: center;
    margin: 0;
  }

  /* Page List */
  .page-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .page-card {
    background: var(--bg-tertiary);
    border-radius: 8px;
    padding: 12px;
    border: 2px solid transparent;
    transition: all 0.2s;
  }

  .page-card.selected {
    border-color: var(--success);
    background: var(--bg-secondary);
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }

  .checkbox-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--success);
  }

  .page-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .book-name {
    color: var(--text-primary);
    font-weight: 600;
    font-size: 0.85rem;
  }

  .page-number {
    color: var(--text-secondary);
    font-weight: 500;
    font-size: 0.85rem;
  }

  .page-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .stroke-count {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .btn-icon {
    background: transparent;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .btn-icon:hover {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .expand-btn svg {
    transition: transform 0.2s;
  }

  .expand-btn svg.rotated {
    transform: rotate(180deg);
  }

  .delete-btn:hover {
    color: var(--error);
  }

  /* Page Stats */
  .page-stats {
    display: flex;
    gap: 15px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .stat-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--accent);
  }

  .stat-label {
    font-size: 0.7rem;
    color: var(--text-secondary);
    text-transform: uppercase;
  }

  /* Page Details (expanded) */
  .page-details {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .detail-section {
    background: var(--bg-primary);
    border-radius: 6px;
    padding: 10px;
  }

  .detail-section h4 {
    font-size: 0.85rem;
    margin-bottom: 8px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .text-output {
    background: var(--bg-secondary);
    padding: 10px;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 200px;
    overflow-y: auto;
    line-height: 1.5;
  }

  .command-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .command-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-size: 0.85rem;
  }

  .command-name {
    color: var(--accent);
    font-weight: 600;
  }

  .command-value {
    color: var(--text-primary);
  }

  /* Scrollbar styling */
  .transcription-view::-webkit-scrollbar,
  .text-output::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .transcription-view::-webkit-scrollbar-track,
  .text-output::-webkit-scrollbar-track {
    background: var(--bg-tertiary);
    border-radius: 4px;
  }

  .transcription-view::-webkit-scrollbar-thumb,
  .text-output::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }

  .transcription-view::-webkit-scrollbar-thumb:hover,
  .text-output::-webkit-scrollbar-thumb:hover {
    background: var(--accent);
  }
</style>
