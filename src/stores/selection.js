/**
 * Selection Store - Manages selected stroke indices
 * Supports multi-select with Ctrl+click and range with Shift+click
 */
import { writable, derived, get } from 'svelte/store';
import { strokes } from './strokes.js';

// Set of selected stroke indices
export const selectedIndices = writable(new Set());

// Last selected index (for shift+click range selection)
export const lastSelectedIndex = writable(null);

// Selected strokes (actual stroke objects)
export const selectedStrokes = derived(
  [strokes, selectedIndices],
  ([$strokes, $selectedIndices]) => {
    return Array.from($selectedIndices)
      .map(i => $strokes[i])
      .filter(Boolean);
  }
);

// Selection count
export const selectionCount = derived(
  selectedIndices, 
  $sel => $sel.size
);

// Whether any strokes are selected
export const hasSelection = derived(
  selectedIndices,
  $sel => $sel.size > 0
);

/**
 * Select or deselect a single stroke
 * @param {number} index - Stroke index
 * @param {boolean} multi - Whether to toggle (Ctrl+click behavior)
 */
export function selectStroke(index, multi = false) {
  selectedIndices.update(sel => {
    const newSel = multi ? new Set(sel) : new Set();
    if (newSel.has(index)) {
      newSel.delete(index);
    } else {
      newSel.add(index);
    }
    return newSel;
  });
  lastSelectedIndex.set(index);
}

/**
 * Select a range of strokes (Shift+click behavior)
 * @param {number} fromIndex - Start of range
 * @param {number} toIndex - End of range
 * @param {boolean} addToExisting - Whether to add to existing selection
 */
export function selectRange(fromIndex, toIndex, addToExisting = false) {
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  
  selectedIndices.update(sel => {
    const newSel = addToExisting ? new Set(sel) : new Set();
    for (let i = start; i <= end; i++) {
      newSel.add(i);
    }
    return newSel;
  });
  
  // Also adjust lastSelectedIndex if needed
  lastSelectedIndex.update(lastIndex => {
    if (lastIndex === null) return null;
    
    // If the last selected index was deleted, clear it
    if (removedIndices.includes(lastIndex)) {
      return null;
    }
    
    // Count how many removed indices are before it
    let shift = 0;
    for (const removedIndex of sorted) {
      if (removedIndex < lastIndex) {
        shift++;
      } else {
        break;
      }
    }
    
    return lastIndex - shift;
  });
}

/**
 * Select all strokes
 * @param {number} count - Total number of strokes
 */
export function selectAll(count) {
  selectedIndices.update(() => {
    const newSel = new Set();
    for (let i = 0; i < count; i++) {
      newSel.add(i);
    }
    return newSel;
  });
}

/**
 * Clear all selection
 */
export function clearSelection() {
  selectedIndices.set(new Set());
  lastSelectedIndex.set(null);
}

/**
 * Set selection from box selection
 * @param {number[]} indices - Array of stroke indices to select
 * @param {string} mode - Selection mode: 'replace', 'add', or 'toggle'
 */
export function selectFromBox(indices, mode = 'replace') {
  selectedIndices.update(sel => {
    let newSel;
    
    if (mode === 'replace') {
      // Replace selection with new indices
      newSel = new Set(indices);
    } else if (mode === 'add') {
      // Add to existing selection
      newSel = new Set(sel);
      indices.forEach(i => newSel.add(i));
    } else if (mode === 'toggle') {
      // Toggle each index (add if not present, remove if present)
      newSel = new Set(sel);
      indices.forEach(i => {
        if (newSel.has(i)) {
          newSel.delete(i);
        } else {
          newSel.add(i);
        }
      });
    } else {
      // Default to replace if invalid mode
      newSel = new Set(indices);
    }
    
    return newSel;
  });
  
  if (indices.length > 0) {
    lastSelectedIndex.set(indices[indices.length - 1]);
  }
}

/**
 * Handle stroke click with modifier keys
 * @param {number} index - Clicked stroke index
 * @param {boolean} ctrlKey - Whether Ctrl/Cmd was held
 * @param {boolean} shiftKey - Whether Shift was held
 */
export function handleStrokeClick(index, ctrlKey, shiftKey) {
  if (shiftKey || ctrlKey) {
    // Both Shift and Ctrl toggle individual stroke selection
    selectStroke(index, true);
  } else {
    // Plain click = single selection
    selectStroke(index, false);
  }
  
  lastSelectedIndex.set(index);
}

/**
 * Deselect specific indices
 * @param {number[]} indices - Array of stroke indices to deselect
 */
export function deselectIndices(indices) {
  selectedIndices.update(sel => {
    const newSel = new Set(sel);
    indices.forEach(i => newSel.delete(i));
    return newSel;
  });
}

/**
 * Add specific indices to selection
 * @param {number[]} indices - Array of stroke indices to select
 */
export function selectIndices(indices) {
  selectedIndices.update(sel => {
    const newSel = new Set(sel);
    indices.forEach(i => newSel.add(i));
    return newSel;
  });
}

/**
 * Adjust selection indices after strokes are deleted
 * When strokes are removed, all indices after them shift down
 * @param {number[]} removedIndices - Sorted array of removed indices
 */
export function adjustSelectionAfterDeletion(removedIndices) {
  if (!removedIndices || removedIndices.length === 0) return;
  
  // Sort removed indices to process in order
  const sorted = [...removedIndices].sort((a, b) => a - b);
  
  selectedIndices.update(sel => {
    const newSel = new Set();
    
    sel.forEach(index => {
      // Count how many removed indices are before this one
      let shift = 0;
      for (const removedIndex of sorted) {
        if (removedIndex < index) {
          shift++;
        } else {
          break;
        }
      }
      
      // Add the adjusted index (if not in removed list)
      if (!removedIndices.includes(index)) {
        newSel.add(index - shift);
      }
    });

    return newSel;
  });
}

/**
 * Get the Ncode bounding box of currently selected strokes.
 * Returns { minX, minY, maxX, maxY } or null if no selection.
 */
export function getSelectedBounds() {
  const indices = get(selectedIndices);
  const allStrokes = get(strokes);
  if (indices.size === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of indices) {
    const stroke = allStrokes[i];
    if (!stroke || !stroke.dotArray) continue;
    for (const dot of stroke.dotArray) {
      if (dot.x < minX) minX = dot.x;
      if (dot.y < minY) minY = dot.y;
      if (dot.x > maxX) maxX = dot.x;
      if (dot.y > maxY) maxY = dot.y;
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}
