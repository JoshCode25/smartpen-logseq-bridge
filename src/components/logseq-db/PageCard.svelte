<!--
  PageCard.svelte - Display a single smartpen page with import button

  Layout: a compact header row (icon · title · badge · expand arrow · Import button)
  with a collapsible transcript section beneath it (only when transcript data exists).
-->
<script>
  import { importStrokesFromLogSeq } from '$lib/logseq-import.js';
  import { getTranscriptLines, updateTranscriptBlocksFromEditor } from '$lib/logseq-api.js';
  import TranscriptionPreview from './TranscriptionPreview.svelte';
  import TranscriptionEditorModal from '../dialog/TranscriptionEditorModal.svelte';
  import SyncStatusBadge from './SyncStatusBadge.svelte';
  import {
    pageTranscriptions,
    logseqHost,
    logseqToken,
    clearPageTranscription,
    clearStrokeBlockUuids,
    getActiveStrokesForPageFromStore,
    log
  } from '$stores';

  export let page; // LogSeqPageData object

  let importing = false;
  let importProgress = { current: 0, total: 0 };
  let editedTranscription = page.transcriptionText || '';
  let showEditorModal = false;
  let editorLines = [];
  let loadingLines = false;
  let transcriptExpanded = false;

  // Update edited transcription when page changes
  $: editedTranscription = page.transcriptionText || '';

  // Convenience flag
  $: hasTranscription = !!(page.transcriptionText || editedTranscription);

  async function handleImport() {
    importing = true;
    importProgress = { current: 0, total: page.strokeCount || 0 };

    try {
      const result = await importStrokesFromLogSeq(page, (current, total) => {
        importProgress = { current, total };
      });
      console.log('Import complete:', result);
    } finally {
      importing = false;
      importProgress = { current: 0, total: 0 };
    }
  }

  function handleTranscriptionChange(event) {
    const newText = event.detail;
    editedTranscription = newText;

    const pageKey = `S0/O0/B${page.book}/P${page.page}`;

    let existingTranscription = null;
    for (const [key, trans] of $pageTranscriptions) {
      if (trans.pageInfo.book === page.book && trans.pageInfo.page === page.page) {
        existingTranscription = trans;
        break;
      }
    }

    const lines = newText.split('\n').map((line, index) => {
      const leadingSpaces = line.match(/^\s*/)[0].length;
      const indentLevel = Math.floor(leadingSpaces / 2);
      return {
        text: line.trimStart(),
        lineNumber: index,
        indentLevel,
        parent: null,
        children: []
      };
    });

    pageTranscriptions.update(pt => {
      const newMap = new Map(pt);
      if (existingTranscription) {
        newMap.set(pageKey, { ...existingTranscription, text: newText, lines });
      } else {
        newMap.set(pageKey, {
          text: newText,
          lines,
          pageInfo: { section: 0, owner: 0, book: page.book, page: page.page },
          strokeCount: page.strokeCount || 0,
          timestamp: Date.now()
        });
      }
      return newMap;
    });
  }

  async function handleOpenEditor() {
    loadingLines = true;
    try {
      const host = $logseqHost || 'http://localhost:12315';
      const token = $logseqToken || '';
      const lines = await getTranscriptLines(page.book, page.page, host, token);

      if (lines.length === 0) {
        alert('No transcription blocks found. Please transcribe the page first.');
        return;
      }

      editorLines = lines;
      showEditorModal = true;
    } catch (error) {
      console.error('Failed to load transcript lines:', error);
      if (error.message.includes('old transcription format')) {
        alert(
          'This page uses the old transcription storage format.\n\n' +
          'To use the line consolidation editor, please:\n' +
          '1. Import the strokes from LogSeq\n' +
          '2. Transcribe the page again\n' +
          '3. Then you can edit the structure\n\n' +
          'This will convert it to the new format that supports merge persistence.'
        );
      } else {
        alert(`Failed to load transcription: ${error.message}`);
      }
    } finally {
      loadingLines = false;
    }
  }

  /**
   * Reset transcript — strips blockUuid from all loaded strokes on this page
   * and clears any in-memory transcription entry so the page can be re-transcribed.
   * LogSeq blocks are not deleted; they will be overwritten on the next save.
   */
  function handleResetTranscript() {
    const pageStrokes = getActiveStrokesForPageFromStore(page.book, page.page);
    const timestamps = pageStrokes.map(s => s.startTime);

    if (timestamps.length > 0) {
      clearStrokeBlockUuids(timestamps);
    }

    for (const [key, trans] of $pageTranscriptions) {
      if (trans.pageInfo?.book === page.book && trans.pageInfo?.page === page.page) {
        clearPageTranscription(key);
        break;
      }
    }

    const strokeMsg = timestamps.length > 0
      ? `${timestamps.length} stroke(s) cleared for re-transcription`
      : 'no strokes loaded in session (import strokes first to clear block associations)';
    log(`Reset transcript for B${page.book}/P${page.page} — ${strokeMsg}`, 'info');
  }

  async function handleSaveEditor(event) {
    const { lines: editedLines } = event.detail;
    try {
      const host = $logseqHost || 'http://localhost:12315';
      const token = $logseqToken || '';

      const result = await updateTranscriptBlocksFromEditor(
        page.book, page.page, editedLines, host, token
      );

      console.log('Transcription updated:', result);

      if (result.success) {
        editedTranscription = editedLines.map(l => '  '.repeat(l.indentLevel || 0) + l.text).join('\n');
        page.syncStatus = result.stats.created > 0 ? 'new_content' : 'synced';
        showEditorModal = false;
        alert(
          `✓ Successfully saved changes!\n\n` +
          `Updated: ${result.stats.updated}\n` +
          `Deleted: ${result.stats.deleted}\n` +
          `Created: ${result.stats.created || 0}\n` +
          `Errors: ${result.stats.errors}`
        );
      } else {
        alert(`Failed to update: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to save transcription:', error);
      alert(`Failed to save: ${error.message}`);
    }
  }
</script>

<div class="page-card">

  <!-- ── Compact header row ─────────────────────────────────────────────── -->
  <div class="page-header">
    <span class="page-icon">📄</span>
    <span class="page-title">Page {page.page}</span>
    <SyncStatusBadge status={page.syncStatus} />
    <span class="spacer"></span>

    {#if hasTranscription}
      <button
        class="expand-btn"
        on:click={() => transcriptExpanded = !transcriptExpanded}
        title={transcriptExpanded ? 'Collapse transcript' : 'Expand transcript'}
        aria-expanded={transcriptExpanded}
      >
        {transcriptExpanded ? '▼' : '▶'}
      </button>
    {/if}

    <button
      class="import-btn"
      on:click={handleImport}
      disabled={importing}
    >
      {#if importing}
        <span class="spinner">⏳</span>
        {#if importProgress.total > 0}
          {importProgress.current}/{importProgress.total}
        {:else}
          Importing…
        {/if}
      {:else}
        Import Strokes
      {/if}
    </button>
  </div>

  <!-- ── Collapsible transcript section ────────────────────────────────── -->
  {#if transcriptExpanded && hasTranscription}
    <div class="transcription-section">
      <div class="section-header">
        <span class="section-label">Transcription:</span>
        <div class="section-actions">
          <button
            class="action-btn"
            on:click={handleOpenEditor}
            disabled={loadingLines}
            title="Edit line structure and merge/split lines"
          >
            {loadingLines ? '⏳' : 'Edit'}
          </button>
          <button
            class="action-btn action-btn--warning"
            on:click={handleResetTranscript}
            title="Reset transcript — removes block associations from strokes so this page can be re-transcribed (LogSeq blocks are not deleted)"
          >
            ↺ Reset
          </button>
        </div>
      </div>
      <TranscriptionPreview
        text={editedTranscription}
        on:change={handleTranscriptionChange}
      />
    </div>
  {/if}

</div>

<TranscriptionEditorModal
  bind:visible={showEditorModal}
  book={page.book}
  page={page.page}
  lines={editorLines}
  on:save={handleSaveEditor}
/>

<style>
  .page-card {
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    padding: 10px 14px;
  }

  .page-card:last-child {
    border-bottom: none;
  }

  /* ── Header row ─────────────────────────────────────────────────────── */

  .page-header {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .page-icon {
    font-size: 1rem;
    flex-shrink: 0;
  }

  .page-title {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .spacer {
    flex: 1;
  }

  .expand-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 2px 5px;
    color: var(--text-tertiary);
    font-size: 0.65rem;
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }

  .expand-btn:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.08);
  }

  .import-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 11px;
    background: var(--accent-color, #2196f3);
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    transition: opacity 0.2s, transform 0.2s;
    white-space: nowrap;
  }

  .import-btn:hover:not(:disabled) {
    opacity: 0.88;
    transform: translateY(-1px);
  }

  .import-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  /* ── Transcript section ─────────────────────────────────────────────── */

  .transcription-section {
    margin-top: 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .section-label {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-right: auto;
  }

  .section-actions {
    display: flex;
    gap: 5px;
  }

  .action-btn {
    padding: 3px 9px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 500;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .action-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-primary);
    border-color: rgba(255, 255, 255, 0.35);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .action-btn--warning {
    border-color: var(--warning, #f59e0b);
    color: var(--warning, #f59e0b);
  }

  .action-btn--warning:hover:not(:disabled) {
    background: var(--warning, #f59e0b);
    color: #1a1a1a;
    border-color: var(--warning, #f59e0b);
  }
</style>
