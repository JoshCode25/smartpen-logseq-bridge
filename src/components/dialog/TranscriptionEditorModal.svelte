<!--
  TranscriptionEditorModal.svelte - Single-column editor for transcription lines
  v3.1: Existing LogSeq blocks are editable; changes saved by UUID
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { reassignStrokes, getStrokesSnapshot, updateStrokeBlockUuids, getStrokesInYRange } from '$stores/strokes.js';

  export let book;
  export let page;
  export let lines = []; // Array of line objects (merged: existing LogSeq + new MyScript)
  export let visible = false;

  const dispatch = createEventDispatcher();

  // Local state for editing
  let editedLines = [];
  let selectedIndices = new Set();
  let history = [];
  let historyIndex = -1;

  // Snapshot of original content for existing blocks (blockUuid → text)
  // Used to detect which existing blocks were actually modified
  let originalContent = new Map();

  // Initialize edited lines when modal opens
  $: if (visible && lines.length > 0) {
    initializeEditor();
  }

  function initializeEditor() {
    editedLines = lines.map((line, index) => ({
      ...line,
      id: `line-${index}`,
      originalIndex: index,
      userModified: false
    }));

    // Snapshot original text for existing blocks
    originalContent = new Map();
    lines.forEach(line => {
      if (line.blockUuid) {
        originalContent.set(line.blockUuid, line.text);
      }
    });

    selectedIndices = new Set();
    history = [JSON.parse(JSON.stringify(editedLines))];
    historyIndex = 0;
  }

  // Add to history for undo/redo
  function addToHistory() {
    // Remove any future history if we're not at the end
    history = history.slice(0, historyIndex + 1);
    history.push(JSON.parse(JSON.stringify(editedLines)));
    historyIndex++;
  }

  // Merge selected lines or adjacent lines
  function mergeLines(startIndex) {
    if (editedLines.length < 2) return;

    let indices;
    if (selectedIndices.size >= 2) {
      // Merge selected lines
      indices = Array.from(selectedIndices).sort((a, b) => a - b);
    } else {
      // Merge current line with next
      if (startIndex >= editedLines.length - 1) return;
      indices = [startIndex, startIndex + 1];
    }

    // Get lines to merge
    const linesToMerge = indices.map(i => editedLines[i]);

    // Track ALL block UUIDs for proper stroke reassignment and deletion
    const allBlockUuids = linesToMerge
      .map(l => l.blockUuid)
      .filter(Boolean);

    const mergedLine = {
      text: linesToMerge.map(l => l.text).join(' '),
      canonical: linesToMerge.map(l => l.canonical).join(' '),
      yBounds: {
        minY: Math.min(...linesToMerge.map(l => l.yBounds.minY)),
        maxY: Math.max(...linesToMerge.map(l => l.yBounds.maxY))
      },
      mergedLineCount: linesToMerge.reduce((sum, l) => sum + (l.mergedLineCount || 1), 0),
      indentLevel: linesToMerge[0].indentLevel || 0,
      blockUuid: linesToMerge[0].blockUuid,
      mergedBlockUuids: allBlockUuids,
      blocksToDelete: allBlockUuids.slice(1),
      syncStatus: 'modified',
      id: linesToMerge[0].id,
      originalIndex: linesToMerge[0].originalIndex,
      userModified: true,
      sourceLines: linesToMerge.map(l => l.originalIndex)
    };

    // Build new lines array
    const newLines = [];
    let merged = false;
    editedLines.forEach((line, index) => {
      if (indices.includes(index)) {
        if (!merged) {
          newLines.push(mergedLine);
          merged = true;
        }
      } else {
        newLines.push(line);
      }
    });

    editedLines = newLines;
    selectedIndices.clear();
    selectedIndices = selectedIndices;
    addToHistory();
  }

  // Split a line at cursor position
  function splitLine(index, splitText1, splitText2) {
    const line = editedLines[index];

    const midY = (line.yBounds.minY + line.yBounds.maxY) / 2;

    const line1 = {
      text: splitText1.trim(),
      canonical: splitText1.trim(),
      yBounds: { minY: line.yBounds.minY, maxY: midY },
      mergedLineCount: 1,
      indentLevel: line.indentLevel || 0,
      blockUuid: line.blockUuid,
      syncStatus: line.blockUuid ? 'modified' : (line.syncStatus || 'synced'),
      id: line.id,
      originalIndex: line.originalIndex,
      userModified: true
    };

    const line2 = {
      text: splitText2.trim(),
      canonical: splitText2.trim(),
      yBounds: { minY: midY, maxY: line.yBounds.maxY },
      mergedLineCount: 1,
      indentLevel: line.indentLevel || 0,
      syncStatus: 'new',
      id: `${line.id}-split`,
      originalIndex: line.originalIndex,
      userModified: true
    };

    editedLines = [
      ...editedLines.slice(0, index),
      line1,
      line2,
      ...editedLines.slice(index + 1)
    ];

    addToHistory();
  }

  // Increase indent level for selected lines
  function indentLines() {
    if (selectedIndices.size === 0) return;

    editedLines = editedLines.map((line, index) => {
      if (selectedIndices.has(index)) {
        return {
          ...line,
          indentLevel: Math.min((line.indentLevel || 0) + 1, 5),
          userModified: true
        };
      }
      return line;
    });

    addToHistory();
  }

  // Decrease indent level for selected lines
  function outdentLines() {
    if (selectedIndices.size === 0) return;

    editedLines = editedLines.map((line, index) => {
      if (selectedIndices.has(index)) {
        return {
          ...line,
          indentLevel: Math.max((line.indentLevel || 0) - 1, 0),
          userModified: true
        };
      }
      return line;
    });

    addToHistory();
  }

  // Undo last change
  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      editedLines = JSON.parse(JSON.stringify(history[historyIndex]));
      selectedIndices.clear();
      selectedIndices = selectedIndices;
    }
  }

  // Redo last undone change
  function redo() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      editedLines = JSON.parse(JSON.stringify(history[historyIndex]));
      selectedIndices.clear();
      selectedIndices = selectedIndices;
    }
  }

  // Toggle line selection
  function toggleSelection(index) {
    if (selectedIndices.has(index)) {
      selectedIndices.delete(index);
    } else {
      selectedIndices.add(index);
    }
    selectedIndices = selectedIndices;
  }

  // Select all lines
  function selectAll() {
    selectedIndices = new Set(editedLines.map((_, i) => i));
  }

  // Smart merge suggestions
  function detectMergeSuggestions() {
    const suggestions = [];

    for (let i = 0; i < editedLines.length - 1; i++) {
      const current = editedLines[i];
      const next = editedLines[i + 1];

      const sameLine =
        current.indentLevel === next.indentLevel &&
        !current.text.match(/[.!?]$/) &&
        next.text.match(/^[a-z]/) &&
        Math.abs(current.yBounds.maxY - next.yBounds.minY) < 20;

      if (sameLine) {
        suggestions.push({ indices: [i, i + 1], confidence: 0.8 });
      }
    }

    return suggestions;
  }

  // Apply smart merge suggestions
  function applySmartMerge() {
    const suggestions = detectMergeSuggestions();
    if (suggestions.length > 0) {
      const indices = suggestions[0].indices;
      indices.forEach(i => selectedIndices.add(i));
      selectedIndices = selectedIndices;
      mergeLines(indices[0]);
    }
  }

  // Handle text input on a line
  function handleLineInput(index, newText) {
    editedLines[index].text = newText;
    editedLines[index].canonical = newText.trim();
    editedLines[index].userModified = true;
    // If this is an existing block being edited, mark as modified
    if (editedLines[index].blockUuid && editedLines[index].syncStatus === 'synced') {
      editedLines[index].syncStatus = 'modified';
    }
    editedLines = editedLines;
  }

  // Save changes locally and close modal (does NOT save to LogSeq)
  function handleSave() {
    // Track stroke reassignments for merges
    const mergedBlockPairs = [];

    for (const line of editedLines) {
      if (line.blocksToDelete && line.blocksToDelete.length > 0 && line.blockUuid) {
        console.log(`Processing merge: ${line.blocksToDelete.length} blocks to delete, survivor: ${line.blockUuid}`);

        for (const deletedBlockUuid of line.blocksToDelete) {
          if (deletedBlockUuid !== line.blockUuid) {
            mergedBlockPairs.push({
              deletedBlockUuid: deletedBlockUuid,
              survivingBlockUuid: line.blockUuid
            });
          }
        }
      }
      else if (line.sourceLines && line.sourceLines.length > 1 && line.blockUuid) {
        const sourceLineIndices = line.sourceLines;

        for (let i = 1; i < sourceLineIndices.length; i++) {
          const originalLine = lines[sourceLineIndices[i]];
          if (originalLine && originalLine.blockUuid && originalLine.blockUuid !== line.blockUuid) {
            mergedBlockPairs.push({
              deletedBlockUuid: originalLine.blockUuid,
              survivingBlockUuid: line.blockUuid
            });
          }
        }
      }
    }

    // Reassign strokes from deleted blocks to surviving blocks (local only)
    for (const { deletedBlockUuid, survivingBlockUuid } of mergedBlockPairs) {
      const count = reassignStrokes(deletedBlockUuid, survivingBlockUuid);
      if (count > 0) {
        console.log(`Reassigned ${count} strokes from ${deletedBlockUuid} to ${survivingBlockUuid}`);
      }
    }

    // Handle splits
    const splitBlocks = editedLines.filter(line => line.syncStatus === 'new' && line.yBounds);
    for (const splitBlock of splitBlocks) {
      console.log(`Split block detected at Y: ${splitBlock.yBounds.minY}-${splitBlock.yBounds.maxY}`);
    }

    dispatch('save', {
      lines: editedLines,
      book,
      page,
      mergedBlockPairs
    });
    handleClose();
  }

  // Close modal without saving
  function handleClose() {
    visible = false;
    dispatch('close');
  }

  // Handle keyboard shortcuts
  function handleKeydown(event) {
    if (!visible) return;

    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (event.key === 'z' && event.shiftKey || event.key === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key === 'a') {
        event.preventDefault();
        selectAll();
      } else if (event.key === 'j') {
        event.preventDefault();
        if (selectedIndices.size >= 2) {
          mergeLines(Array.from(selectedIndices)[0]);
        }
      } else if (event.key === ']') {
        event.preventDefault();
        indentLines();
      } else if (event.key === '[') {
        event.preventDefault();
        outdentLines();
      }
    } else if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey) {
        outdentLines();
      } else {
        indentLines();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    }
  }

  // Get status label for a line
  function getStatusLabel(line) {
    if (line.syncStatus === 'synced' && !line.userModified) return 'synced';
    if (line.syncStatus === 'modified' || line.userModified) return 'modified';
    if (line.syncStatus === 'new') return 'new';
    if (line.blockUuid) return 'synced';
    return 'new';
  }

  // Calculate statistics
  $: stats = {
    totalLines: editedLines.length,
    selected: selectedIndices.size,
    merged: editedLines.filter(l => l.mergedLineCount > 1).length,
    modified: editedLines.filter(l => l.userModified).length,
    synced: editedLines.filter(l => l.blockUuid && !l.userModified).length,
    newLines: editedLines.filter(l => !l.blockUuid && l.syncStatus !== 'modified').length
  };

  $: mergeSuggestions = detectMergeSuggestions();
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
<div class="modal-backdrop" on:click={handleClose}>
  <div class="modal-container" on:click|stopPropagation>
    <div class="modal-header">
      <h2>Edit Transcription &mdash; B{book}/P{page}</h2>
      <div class="header-stats">
        {stats.totalLines} lines
        {#if stats.synced > 0}<span class="stat-badge synced">{stats.synced} synced</span>{/if}
        {#if stats.newLines > 0}<span class="stat-badge new">{stats.newLines} new</span>{/if}
        {#if stats.modified > 0}<span class="stat-badge modified">{stats.modified} modified</span>{/if}
      </div>
      <button class="close-btn" on:click={handleClose} title="Close (Esc)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="modal-toolbar">
      <div class="toolbar-group">
        <button
          class="tool-btn"
          on:click={undo}
          disabled={historyIndex <= 0}
          title="Undo (Ctrl+Z)"
        >
          &#8630; Undo
        </button>
        <button
          class="tool-btn"
          on:click={redo}
          disabled={historyIndex >= history.length - 1}
          title="Redo (Ctrl+Shift+Z)"
        >
          &#8631; Redo
        </button>
      </div>

      <div class="toolbar-group">
        <button
          class="tool-btn"
          on:click={selectAll}
          title="Select All (Ctrl+A)"
        >
          Select All
        </button>
        <button
          class="tool-btn primary"
          on:click={() => mergeLines(Array.from(selectedIndices)[0])}
          disabled={selectedIndices.size < 2}
          title="Merge Selected (Ctrl+J)"
        >
          Merge ({selectedIndices.size})
        </button>
      </div>

      <div class="toolbar-group">
        <button
          class="tool-btn"
          on:click={outdentLines}
          disabled={selectedIndices.size === 0}
          title="Decrease Indent (Ctrl+[)"
        >
          &#8592; Outdent
        </button>
        <button
          class="tool-btn"
          on:click={indentLines}
          disabled={selectedIndices.size === 0}
          title="Increase Indent (Ctrl+])"
        >
          Indent &#8594;
        </button>
      </div>

      {#if mergeSuggestions.length > 0}
      <div class="toolbar-group">
        <button
          class="tool-btn suggest"
          on:click={applySmartMerge}
          title="Apply smart merge suggestion"
        >
          Smart Merge ({mergeSuggestions.length})
        </button>
      </div>
      {/if}
    </div>

    <div class="modal-body">
      <div class="lines-list">
        {#each editedLines as line, index}
          {@const status = getStatusLabel(line)}
          <div
            class="line-item"
            class:selected={selectedIndices.has(index)}
            class:merged={line.mergedLineCount > 1}
            class:status-synced={status === 'synced'}
            class:status-modified={status === 'modified'}
            class:status-new={status === 'new'}
          >
            <div class="line-row" style="padding-left: {(line.indentLevel || 0) * 24}px">
              <!-- Selection checkbox -->
              <input
                type="checkbox"
                class="line-checkbox"
                checked={selectedIndices.has(index)}
                on:change={() => toggleSelection(index)}
              />

              <!-- Indent guide -->
              {#if (line.indentLevel || 0) > 0}
                <span class="indent-guide">
                  {#each Array(line.indentLevel) as _, i}
                    <span class="indent-bar" style="left: {-(line.indentLevel - i) * 24 + 8}px"></span>
                  {/each}
                </span>
              {/if}

              <!-- Bullet point -->
              <span class="bullet">&#8226;</span>

              <!-- Editable text -->
              <input
                type="text"
                class="line-text"
                value={line.text}
                on:input={(e) => handleLineInput(index, e.target.value)}
                on:blur={() => addToHistory()}
                placeholder="Empty line..."
              />

              <!-- Per-line action buttons -->
              <div class="line-actions">
                <button
                  class="action-btn"
                  on:click={() => mergeLines(index)}
                  disabled={index >= editedLines.length - 1}
                  title="Merge with next line"
                >
                  &#8595;
                </button>
                <button
                  class="action-btn"
                  on:click={() => {
                    const text = line.text;
                    const mid = Math.floor(text.length / 2);
                    splitLine(index, text.slice(0, mid), text.slice(mid));
                  }}
                  title="Split line"
                >
                  &#8596;
                </button>
                <button
                  class="action-btn"
                  on:click={() => { selectedIndices = new Set([index]); outdentLines(); }}
                  disabled={(line.indentLevel || 0) <= 0}
                  title="Outdent"
                >
                  &#8592;
                </button>
                <button
                  class="action-btn"
                  on:click={() => { selectedIndices = new Set([index]); indentLines(); }}
                  disabled={(line.indentLevel || 0) >= 5}
                  title="Indent"
                >
                  &#8594;
                </button>
              </div>

              <!-- Status badge -->
              <span class="status-badge {status}" title="{status === 'synced' ? 'Saved in LogSeq' : status === 'modified' ? 'Modified locally' : 'New (will create block)'}">
                {status}
              </span>
            </div>

            {#if line.mergedLineCount > 1}
              <div class="merge-info" style="padding-left: {(line.indentLevel || 0) * 24 + 28}px">
                merged from {line.mergedLineCount} lines
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <div class="modal-footer">
      <div class="footer-info">
        {#if stats.selected > 0}
          <span class="selection-info">{stats.selected} selected</span>
        {/if}
        {#if stats.modified > 0}
          <span class="modified-warning">{stats.modified} line{stats.modified !== 1 ? 's' : ''} modified</span>
        {/if}
      </div>
      <div class="footer-actions">
        <button class="btn btn-cancel" on:click={handleClose}>Cancel</button>
        <button class="btn btn-primary" on:click={handleSave}>Confirm</button>
      </div>
    </div>
  </div>
</div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    backdrop-filter: blur(2px);
  }

  .modal-container {
    background: var(--bg-primary);
    border-radius: 12px;
    width: 90vw;
    max-width: 900px;
    height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    border: 1px solid var(--border);
  }

  /* Header */
  .modal-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.15rem;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .header-stats {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 0.8rem;
    color: var(--text-secondary);
    flex: 1;
  }

  .stat-badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .stat-badge.synced { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }
  .stat-badge.new { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  .stat-badge.modified { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .close-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  /* Toolbar */
  .modal-toolbar {
    display: flex;
    gap: 12px;
    padding: 10px 24px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }

  .toolbar-group {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .tool-btn {
    padding: 5px 10px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .tool-btn:hover:not(:disabled) {
    background: var(--bg-primary);
    border-color: var(--accent);
  }

  .tool-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tool-btn.primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .tool-btn.primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .tool-btn.suggest {
    background: #f59e0b;
    color: white;
    border-color: #f59e0b;
  }

  /* Body — single column */
  .modal-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .lines-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  /* Line items — LogSeq-style rendered blocks */
  .line-item {
    border-radius: 6px;
    margin-bottom: 2px;
    transition: background 0.15s;
  }

  .line-item:hover {
    background: var(--bg-secondary);
  }

  .line-item.selected {
    background: rgba(59, 130, 246, 0.08);
  }

  .line-item.merged {
    border-left: 3px solid #22c55e;
  }

  /* Status-based left border */
  .line-item.status-synced {
    border-left: 3px solid transparent;
  }

  .line-item.status-modified {
    border-left: 3px solid #f59e0b;
  }

  .line-item.status-new {
    border-left: 3px solid var(--accent);
  }

  .line-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    position: relative;
  }

  .line-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  /* Indent guides */
  .indent-guide {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    pointer-events: none;
  }

  .indent-bar {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: var(--border);
  }

  .bullet {
    color: var(--text-tertiary);
    font-size: 1rem;
    flex-shrink: 0;
    line-height: 1;
  }

  /* Editable text — styled like rendered text, not code */
  .line-text {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 0.9rem;
    line-height: 1.5;
    transition: border-color 0.15s, background 0.15s;
  }

  .line-text:hover {
    border-color: var(--border);
  }

  .line-text:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--bg-primary);
  }

  .line-text::placeholder {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* Per-line action buttons — compact icon row */
  .line-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }

  .line-item:hover .line-actions,
  .line-item.selected .line-actions {
    opacity: 1;
  }

  .action-btn {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s;
    padding: 0;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-primary);
    color: var(--text-primary);
    border-color: var(--accent);
  }

  .action-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }

  /* Status badges */
  .status-badge {
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 8px;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .status-badge.synced {
    background: rgba(107, 114, 128, 0.15);
    color: #9ca3af;
  }

  .status-badge.modified {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
    opacity: 1;
  }

  .status-badge.new {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    opacity: 1;
  }

  .merge-info {
    font-size: 0.7rem;
    color: #22c55e;
    font-weight: 500;
    padding-bottom: 4px;
  }

  /* Footer */
  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
  }

  .footer-info {
    display: flex;
    gap: 16px;
    font-size: 0.8rem;
  }

  .selection-info {
    color: var(--accent);
    font-weight: 500;
  }

  .modified-warning {
    color: #f59e0b;
    font-weight: 500;
  }

  .footer-actions {
    display: flex;
    gap: 10px;
  }

  .btn {
    padding: 8px 20px;
    border: none;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-cancel {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }

  .btn-cancel:hover {
    background: var(--bg-primary);
  }

  .btn-primary {
    background: var(--accent);
    color: white;
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  /* Scrollbar */
  .lines-list::-webkit-scrollbar {
    width: 8px;
  }

  .lines-list::-webkit-scrollbar-track {
    background: var(--bg-tertiary);
    border-radius: 4px;
  }

  .lines-list::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }

  .lines-list::-webkit-scrollbar-thumb:hover {
    background: var(--accent);
  }
</style>
