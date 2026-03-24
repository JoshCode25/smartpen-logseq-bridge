<!--
  TranscriptionPreview.svelte - Display and edit transcribed text with preserved formatting
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { filterTranscriptionProperties } from '$utils/formatting.js';
  
  export let text; // Transcribed text with indentation
  export let editable = false; // Whether to allow editing
  
  const dispatch = createEventDispatcher();
  
  let isEditing = false;
  let editedText = text;
  
  // Filter out properties for display
  $: displayText = filterTranscriptionProperties(text);
  
  // Update editedText when text prop changes
  $: if (!isEditing) {
    editedText = text;
  }
  
  function handleEdit() {
    isEditing = true;
  }
  
  function handleSave() {
    isEditing = false;
    dispatch('change', editedText);
  }
  
  function handleCancel() {
    isEditing = false;
    editedText = text;
  }
  
  function handleKeydown(event) {
    // Save on Ctrl+Enter or Cmd+Enter
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSave();
    }
    // Cancel on Escape
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
    }
  }
</script>

<div class="transcription-preview">
  {#if !displayText}
    <div class="empty">No transcription text</div>
  {:else if isEditing}
    <div class="editor">
      <textarea
        bind:value={editedText}
        on:keydown={handleKeydown}
        class="edit-textarea"
        placeholder="Enter transcribed text..."
      ></textarea>
      <div class="editor-actions">
        <button class="btn btn-save" on:click={handleSave}>Save</button>
        <button class="btn btn-cancel" on:click={handleCancel}>Cancel</button>
        <span class="hint">Ctrl+Enter to save, Esc to cancel</span>
      </div>
    </div>
  {:else}
    <div class="preview-wrapper">
      <pre>{displayText}</pre>
    </div>
  {/if}
</div>

<style>
  .transcription-preview {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    padding: 12px;
    max-height: 300px;
    overflow-y: auto;
    position: relative;
  }
  
  .preview-wrapper {
    position: relative;
  }
  
  pre {
    margin: 0;
    font-family: 'Courier New', monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  
  .empty {
    color: var(--text-tertiary);
    font-style: italic;
    font-size: 0.875rem;
  }
  
.editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .edit-textarea {
    width: 100%;
    min-height: 150px;
    padding: 8px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    resize: vertical;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }
  
  .edit-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .btn {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .btn-save {
    background: var(--success);
    color: white;
  }
  
  .btn-save:hover {
    background: #22c55e;
  }
  
  .btn-cancel {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  
  .btn-cancel:hover {
    background: var(--bg-secondary);
  }
  
  .hint {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    margin-left: auto;
  }
</style>
