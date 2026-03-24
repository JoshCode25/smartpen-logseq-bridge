/**
 * Transcript Block Updater (v3.0 - Append-Only Mode)
 * Orchestrates incremental updates to LogSeq transcript blocks
 *
 * CRITICAL ARCHITECTURE CHANGE (v3.0):
 * - Append-only: Only creates blocks for strokes WITHOUT blockUuid
 * - Immutable associations: Once a stroke has a blockUuid, it NEVER changes
 * - Existing blocks are NEVER modified during re-transcription
 * - Y-bounds are IMMUTABLE after creation (set once, never updated)
 *
 * Key features:
 * - Checkbox preservation: User edits never lost
 * - Stroke→Block persistence: blockUuid stored on strokes for incremental updates
 * - No orphan auto-deletion: User must confirm block deletions
 */

import {
  getTranscriptBlocks,
  createTranscriptBlockWithProperties,
  updateTranscriptBlockWithPreservation,
  getOrCreateSmartpenPage,
  updatePageStrokes
} from './logseq-api.js';

import {
  updateStrokeBlockUuids,
  getStrokesSnapshot,
  partitionStrokesByTranscriptionStatus
} from '../stores/strokes.js';

// Import makeRequest for internal use
import { makeRequest } from './logseq-api.js';

/**
 * Check if two Y-bounds overlap
 */
function boundsOverlap(bounds1, bounds2) {
  return !(bounds1.maxY < bounds2.minY || bounds2.maxY < bounds1.minY);
}

/**
 * Estimate which strokes belong to a transcription line
 * Uses Y-bounds overlap between stroke dots and line bounding box
 * 
 * @param {Object} line - Transcription line with yBounds
 * @param {Array} strokes - All strokes from the page
 * @param {number} tolerance - Y-tolerance for overlap detection (default 5 units)
 * @returns {Set<string>} Set of stroke timestamps (as strings)
 */
function estimateLineStrokeIds(line, strokes, tolerance = 5) {
  const strokeIds = new Set();
  
  if (!line.yBounds || !strokes || strokes.length === 0) {
    return strokeIds;
  }
  
  const lineMinY = line.yBounds.minY - tolerance;
  const lineMaxY = line.yBounds.maxY + tolerance;
  
  for (const stroke of strokes) {
    if (!stroke.dotArray || stroke.dotArray.length === 0) continue;
    
    // Check if any dot in the stroke falls within line's Y-bounds
    const strokeIntersects = stroke.dotArray.some(dot => 
      dot.y >= lineMinY && dot.y <= lineMaxY
    );
    
    if (strokeIntersects) {
      strokeIds.add(String(stroke.startTime));
    }
  }
  
  return strokeIds;
}

/**
 * Parse stroke IDs from block property string
 * @param {string} strokeIdsStr - Comma-separated stroke timestamps
 * @returns {Set<string>} Set of stroke ID strings
 */
function parseStrokeIds(strokeIdsStr) {
  if (!strokeIdsStr || typeof strokeIdsStr !== 'string') {
    return new Set();
  }
  return new Set(strokeIdsStr.split(',').map(id => id.trim()).filter(Boolean));
}

/**
 * Check if two stroke ID sets have any overlap
 * @param {Set<string>} set1 
 * @param {Set<string>} set2 
 * @returns {boolean}
 */
function strokeSetsOverlap(set1, set2) {
  if (!set1 || !set2 || set1.size === 0 || set2.size === 0) {
    return false;
  }
  for (const id of set1) {
    if (set2.has(id)) return true;
  }
  return false;
}

/**
 * Merge stroke ID sets (for merged lines)
 * @param {Set<string>} set1 
 * @param {Set<string>} set2 
 * @returns {Set<string>}
 */
function mergeStrokeSets(set1, set2) {
  const merged = new Set(set1 || []);
  if (set2) {
    set2.forEach(id => merged.add(id));
  }
  return merged;
}

/**
 * Parse Y-bounds from property string
 */
function parseYBounds(boundsString) {
  if (!boundsString || typeof boundsString !== 'string') {
    return { minY: 0, maxY: 0 };
  }
  const [minY, maxY] = boundsString.split('-').map(parseFloat);
  return { minY: minY || 0, maxY: maxY || 0 };
}

/**
 * Calculate Y-bounds for a line from strokes
 * @param {Object} line - Line object with strokeIds
 * @param {Array} strokes - Array of all strokes
 * @returns {Object} { minY, maxY }
 */
function calculateLineBounds(line, strokes) {
  if (!line.yBounds) {
    // If yBounds not precomputed, calculate from strokes
    if (!line.strokeIds || line.strokeIds.size === 0) {
      return { minY: 0, maxY: 0 };
    }
    
    let minY = Infinity;
    let maxY = -Infinity;
    
    for (const strokeId of line.strokeIds) {
      const stroke = strokes.find(s => s.strokeId === strokeId);
      if (!stroke || !stroke.dotArray) continue;
      
      for (const dot of stroke.dotArray) {
        if (dot.y < minY) minY = dot.y;
        if (dot.y > maxY) maxY = dot.y;
      }
    }
    
    if (minY === Infinity || maxY === -Infinity) {
      return { minY: 0, maxY: 0 };
    }
    
    return { minY, maxY };
  }
  
  return line.yBounds;
}

/**
 * Determine parent UUID for a line based on indentation
 * @param {Object} line - Line object
 * @param {Array} existingBlocks - Array of existing blocks
 * @param {Map} lineToBlockMap - Map of line index to block UUID
 * @returns {string|null} Parent block UUID or null for top-level
 */
/**
 * Determine parent UUID for a line based on indentation and lineToBlockMap
 * CRITICAL: This uses lineToBlockMap which is built level-by-level,
 * ensuring parent blocks exist before children are created
 * @param {Object} line - Line object with indentLevel
 * @param {Array} existingBlocks - Array of existing blocks (not used anymore)
 * @param {Map} lineToBlockMap - Map of line index to block UUID (built progressively)
 * @param {number} currentLineIndex - Current line index in the lines array
 * @returns {string|null} Parent block UUID or null for top-level
 */
function determineParentUuid(line, existingBlocks, lineToBlockMap, currentLineIndex) {
  const indent = line.indentLevel || 0;

  // Top-level block (indent 0) - no parent needed
  if (indent === 0) {
    return null; // Will use "Transcribed Content" section
  }

  // If line has explicit parent line reference from MyScript, use that
  if (line.parent !== null && typeof line.parent === 'number') {
    const parentBlockUuid = lineToBlockMap.get(line.parent);
    if (parentBlockUuid) {
      console.log(`Line ${currentLineIndex} (indent ${indent}): Using explicit parent line ${line.parent} → ${parentBlockUuid.substring(0, 8)}...`);
      return parentBlockUuid;
    }
  }

  // Find nearest preceding line with lower indent level
  // Search backwards through lineToBlockMap for a suitable parent
  for (let i = currentLineIndex - 1; i >= 0; i--) {
    const potentialParentUuid = lineToBlockMap.get(i);
    if (!potentialParentUuid) continue;

    // Need to check indent level of this line
    // We'll need to pass the full lines array to do this properly
    // For now, assume any previously created block at lower level is suitable
    // This is a simplification - ideally we'd track indent levels
    console.log(`Line ${currentLineIndex} (indent ${indent}): Using preceding block at line ${i} → ${potentialParentUuid.substring(0, 8)}...`);
    return potentialParentUuid;
  }

  // Fallback: if no suitable parent found, this is top-level
  console.log(`Line ${currentLineIndex} (indent ${indent}): No parent found, using top-level`);
  return null;
}

/**
 * Handle merge conflict when multiple blocks overlap with new line
 * @param {Object} action - Action object with block, overlappingLines, etc.
 * @param {string} host - LogSeq API host
 * @param {string} token - Auth token
 * @returns {Promise<Object>} Resolution result
 */
async function handleMergeConflict(action, host, token) {
  // The new structure has: { type, block, overlappingLines, blockBounds }
  // For now, update the existing block with combined text from overlapping lines
  
  if (!action.overlappingLines || action.overlappingLines.length === 0) {
    console.error('Merge conflict with no overlapping lines:', action);
    throw new Error('Invalid merge conflict: no overlapping lines');
  }
  
  // Combine all overlapping lines
  const combinedText = action.overlappingLines.map(ol => ol.line.text).join(' ');
  const combinedCanonical = action.overlappingLines.map(ol => ol.line.canonical).join(' ');
  const newMinY = Math.min(...action.overlappingLines.map(ol => ol.bounds.minY));
  const newMaxY = Math.max(...action.overlappingLines.map(ol => ol.bounds.maxY));
  
  const combinedLine = {
    text: combinedText,
    canonical: combinedCanonical,
    yBounds: { minY: newMinY, maxY: newMaxY },
    mergedLineCount: action.overlappingLines.length,
    indentLevel: action.overlappingLines[0].line.indentLevel || 0
  };
  
  await updateTranscriptBlockWithPreservation(
    action.block.uuid,
    combinedLine,
    action.block.content,
    host,
    token,
    action.block.properties || {}
  );
  
  return { blockUuid: action.block.uuid, strategy: 'merge-all-to-existing' };
}

/**
 * Detect what action to take for each transcription line
 * Uses STROKE ID MATCHING as primary strategy, Y-bounds as fallback
 * 
 * @param {Array} existingBlocks - Existing transcript blocks from LogSeq
 * @param {Array} newLines - New transcription lines (with strokeIds)
 * @param {Array} strokes - All strokes for reference
 * @returns {Promise<Array>} Array of action objects
 */
async function detectBlockActions(existingBlocks, newLines, strokes) {
  const actions = [];
  const consumedLineIndices = new Set();
  const usedBlockUuids = new Set();
  
  // Build stroke timestamp set for existence checks
  const currentStrokeTimestamps = new Set(strokes.map(s => String(s.startTime)));
  
  console.log('=== Block Matching Debug ===');
  console.log(`Existing blocks: ${existingBlocks.length}`);
  console.log(`New lines: ${newLines.length}`);
  console.log(`Current strokes: ${currentStrokeTimestamps.size}`);
  
  // STRATEGY 1: Match blocks by stroke ID overlap (preferred)
  for (const block of existingBlocks) {
    const blockStrokeIds = parseStrokeIds(block.properties?.['stroke-ids']);
    const blockBounds = parseYBounds(block.properties?.['stroke-y-bounds'] || '0-0');
    const mergedCount = parseInt(block.properties?.['merged-lines']) || 1;
    const storedCanonical = block.properties?.['canonical-transcript'] || '';
    
    console.log(`\nChecking block ${block.uuid.substring(0, 8)}...`);
    console.log(`  Stroke IDs: ${blockStrokeIds.size}, Y-bounds: ${block.properties?.['stroke-y-bounds']}`);
    
    // Find lines with overlapping stroke IDs
    let overlappingLines = [];
    
    if (blockStrokeIds.size > 0) {
      // Primary: Match by stroke IDs
      newLines.forEach((line, index) => {
        if (consumedLineIndices.has(index)) return;
        
        if (line.strokeIds && strokeSetsOverlap(blockStrokeIds, line.strokeIds)) {
          const lineBounds = line.yBounds || calculateLineBounds(line, strokes);
          overlappingLines.push({ line, index, bounds: lineBounds });
          console.log(`  → Matched line ${index} by stroke IDs: "${line.text.substring(0, 30)}..."`);
        }
      });
    }
    
    // Fallback: If no stroke ID matches AND block has no stroke IDs, try Y-bounds
    if (overlappingLines.length === 0 && blockStrokeIds.size === 0) {
      console.log(`  No stroke IDs - falling back to Y-bounds matching`);
      newLines.forEach((line, index) => {
        if (consumedLineIndices.has(index)) return;
        
        const lineBounds = line.yBounds || calculateLineBounds(line, strokes);
        if (boundsOverlap(blockBounds, lineBounds)) {
          overlappingLines.push({ line, index, bounds: lineBounds });
          console.log(`  → Matched line ${index} by Y-bounds: "${line.text.substring(0, 30)}..."`);
        }
      });
    }
    
    // Process matches
    if (overlappingLines.length === 0) {
      // No matches - check if block's strokes still exist on canvas
      const strokesExist = blockStrokeIds.size > 0 && 
        [...blockStrokeIds].some(id => currentStrokeTimestamps.has(id));
      
      if (strokesExist || blockStrokeIds.size === 0) {
        // Strokes exist OR no stroke IDs to verify - PRESERVE
        console.log(`  → PRESERVE (${strokesExist ? 'strokes exist' : 'no stroke IDs'})`);
        actions.push({
          type: 'PRESERVE',
          reason: strokesExist ? 'strokes-exist-no-new-lines' : 'no-stroke-ids',
          blockUuid: block.uuid
        });
        usedBlockUuids.add(block.uuid);
      } else {
        console.log(`  → Will be deleted (strokes removed from canvas)`);
      }
      continue;
    }
    
    // Handle matched lines
    // Combine all overlapping lines for comparison
    const combinedCanonical = overlappingLines.map(ol => ol.line.canonical).join(' ');
    const combinedStrokeIds = new Set();
    overlappingLines.forEach(ol => {
      if (ol.line.strokeIds) {
        ol.line.strokeIds.forEach(id => combinedStrokeIds.add(id));
      }
    });
    
    // Check if canonical text matches
    if (combinedCanonical === storedCanonical) {
      // No change - skip
      console.log(`  → SKIP (canonical unchanged)`);
      actions.push({
        type: overlappingLines.length > 1 ? 'SKIP_MERGED' : 'SKIP',
        reason: 'canonical-unchanged',
        blockUuid: block.uuid,
        mergedCount: overlappingLines.length,
        consumedLines: overlappingLines.map(ol => ol.index)
      });
    } else {
      // Text changed - update
      console.log(`  → UPDATE (canonical changed)`);
      const combinedText = overlappingLines.map(ol => ol.line.text).join(' ');
      const newMinY = Math.min(...overlappingLines.map(ol => ol.bounds.minY));
      const newMaxY = Math.max(...overlappingLines.map(ol => ol.bounds.maxY));
      
      actions.push({
        type: overlappingLines.length > 1 ? 'UPDATE_MERGED' : 'UPDATE',
        blockUuid: block.uuid,
        line: {
          text: combinedText,
          canonical: combinedCanonical,
          yBounds: { minY: newMinY, maxY: newMaxY },
          strokeIds: combinedStrokeIds,
          mergedLineCount: overlappingLines.length,
          indentLevel: overlappingLines[0].line.indentLevel || 0
        },
        oldContent: block.content,
        consumedLines: overlappingLines.map(ol => ol.index)
      });
    }
    
    // Mark lines and block as used
    overlappingLines.forEach(ol => consumedLineIndices.add(ol.index));
    usedBlockUuids.add(block.uuid);
  }
  
  // STRATEGY 2: Create blocks for unconsumed lines (new content)
  newLines.forEach((line, index) => {
    if (consumedLineIndices.has(index)) return;
    
    console.log(`\nNew line ${index}: "${line.text.substring(0, 30)}..." → CREATE`);
    
    const lineBounds = line.yBounds || calculateLineBounds(line, strokes);
    actions.push({
      type: 'CREATE',
      lineIndex: index,  // CRITICAL: Track which line this action corresponds to
      line: {
        ...line,
        yBounds: lineBounds,
        strokeIds: line.strokeIds || new Set()
      },
      bounds: lineBounds,
      canonical: line.canonical,
      parentUuid: null
    });
  });
  
  console.log('\n=== Action Summary ===');
  console.log(`SKIP: ${actions.filter(a => a.type === 'SKIP' || a.type === 'SKIP_MERGED').length}`);
  console.log(`UPDATE: ${actions.filter(a => a.type === 'UPDATE' || a.type === 'UPDATE_MERGED').length}`);
  console.log(`CREATE: ${actions.filter(a => a.type === 'CREATE').length}`);
  console.log(`PRESERVE: ${actions.filter(a => a.type === 'PRESERVE').length}`);
  
  return actions;
}

/**
 * Get or create the "Transcribed Content" section parent block
 * @param {string} pageName - Page name
 * @param {string} host - LogSeq API host
 * @param {string} token - Auth token
 * @returns {Promise<string>} Parent block UUID
 */
async function getOrCreateTranscriptSection(pageName, host, token) {
  const blocks = await makeRequest(host, token, 'logseq.Editor.getPageBlocksTree', [pageName]);
  
  // Find existing section
  if (blocks && blocks.length > 0) {
    for (const block of blocks) {
      if (block.content && block.content.includes('## Transcribed Content')) {
        return block.uuid;
      }
    }
  }
  
  // Create new section with Display_No_Properties tag to hide properties by default
  const sectionBlock = await makeRequest(host, token, 'logseq.Editor.appendBlockInPage', [
    pageName,
    '## Transcribed Content #Display_No_Properties',
    {}
  ]);
  
  return sectionBlock.uuid;
}

/**
 * Match strokes to transcription lines using Y-bounds overlap
 * CRITICAL: Only processes strokes WITHOUT blockUuid (append-only mode)
 *
 * @param {Array} strokes - Strokes to match (should be pre-filtered to only untranscribed strokes)
 * @param {Array} linesWithBlocks - Lines with yBounds and blockUuid (newly created blocks)
 * @param {number} tolerance - Y-tolerance for overlap (default 5)
 * @returns {Map<string, string>} Map of stroke startTime → blockUuid
 */
function matchStrokesToLines(strokes, linesWithBlocks, tolerance = 5) {
  console.log(`[matchStrokesToLines] Processing ${strokes.length} strokes against ${linesWithBlocks.length} blocks`);

  const strokeToBlockMap = new Map();
  let matchedCount = 0;
  let unmatchedCount = 0;
  let skippedCount = 0;

  for (const stroke of strokes) {
    if (!stroke.dotArray || stroke.dotArray.length === 0) {
      console.warn(`Stroke ${stroke.startTime} has no dotArray, skipping`);
      skippedCount++;
      continue;
    }

    // CRITICAL: If stroke already has blockUuid, DO NOT reassign
    // This should not happen if caller filters properly, but double-check
    if (stroke.blockUuid) {
      console.warn(`Stroke ${stroke.startTime} already has blockUuid - skipping (should not happen in append-only mode)`);
      skippedCount++;
      continue;
    }

    // Get stroke's Y range
    const strokeYs = stroke.dotArray.map(d => d.y);
    const strokeMinY = Math.min(...strokeYs);
    const strokeMaxY = Math.max(...strokeYs);

    // Find the line with best Y-bounds overlap
    let bestMatch = null;
    let bestOverlap = 0;

    for (const line of linesWithBlocks) {
      if (!line.yBounds || !line.blockUuid) continue;

      const lineMinY = line.yBounds.minY - tolerance;
      const lineMaxY = line.yBounds.maxY + tolerance;

      // Calculate overlap
      const overlapMin = Math.max(strokeMinY, lineMinY);
      const overlapMax = Math.min(strokeMaxY, lineMaxY);
      const overlap = Math.max(0, overlapMax - overlapMin);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = line;
      }
    }

    if (bestMatch) {
      strokeToBlockMap.set(String(stroke.startTime), bestMatch.blockUuid);
      matchedCount++;
      if (matchedCount <= 3) {
        console.log(`  ✓ Stroke ${stroke.startTime} → Block ${bestMatch.blockUuid.substring(0, 8)}...`);
      }
    } else {
      unmatchedCount++;
      if (unmatchedCount <= 3) {
        console.warn(`  ✗ Stroke ${stroke.startTime} (Y: ${strokeMinY.toFixed(1)}-${strokeMaxY.toFixed(1)}) - NO MATCH`);
      }
    }
  }

  console.log(`[matchStrokesToLines] Results: ${matchedCount} matched, ${unmatchedCount} unmatched, ${skippedCount} skipped`);

  return strokeToBlockMap;
}

/**
 * Main orchestrator for transcript block updates (v3.0 - Append-Only)
 *
 * CRITICAL CHANGES in v3.0:
 * 1. Only creates blocks for strokes WITHOUT blockUuid
 * 2. NEVER modifies existing blocks during re-transcription
 * 3. NEVER reassigns strokes that already have blockUuid
 * 4. Y-bounds are IMMUTABLE after creation
 * 5. Orphaned blocks are PRESERVED (no auto-deletion)
 *
 * @param {number} book - Book ID
 * @param {number} page - Page number
 * @param {Array} allStrokes - All strokes for the page (both with and without blockUuid)
 * @param {Object} newTranscription - Transcription result from MyScript (ONLY from untranscribed strokes)
 * @param {string} host - LogSeq API host
 * @param {string} token - Auth token
 * @returns {Promise<Object>} Update result with stats
 */
export async function updateTranscriptBlocks(book, page, allStrokes, newTranscription, host, token = '') {
  try {
    // Ensure page exists
    const pageObj = await getOrCreateSmartpenPage(book, page, host, token);
    const pageName = pageObj.name || pageObj.originalName;

    console.log('=== Transcript Update v3.0 (Append-Only) ===');
    console.log(`Incoming transcription: ${newTranscription.lines?.length || 0} lines`);
    console.log(`Total strokes provided: ${allStrokes.length}`);

    // CRITICAL: Partition strokes - this is the foundation of append-only mode
    const { transcribed: strokesWithBlockUuid, untranscribed: strokesWithoutBlockUuid } =
      partitionStrokesByTranscriptionStatus(allStrokes.filter(s => !s.deleted));

    console.log(`Strokes: ${strokesWithBlockUuid.length} already transcribed, ${strokesWithoutBlockUuid.length} new`);

    // DEBUG: Log transcription source info
    if (newTranscription.transcribedStrokeIds) {
      console.log(`Transcription was created from ${newTranscription.transcribedStrokeIds.length} specific strokes`);
    }

    // If there are no new lines to process, we're done
    if (!newTranscription.lines || newTranscription.lines.length === 0) {
      console.log('No new transcription lines to process');
      return {
        success: true,
        page: pageName,
        results: [],
        strokesAssigned: 0,
        stats: { created: 0, updated: 0, skipped: 0, preserved: 0, merged: 0, deleted: 0, errors: 0 }
      };
    }

    // DEFENSIVE: Check for lines missing yBounds (should never happen from fresh MyScript results)
    const linesWithoutBounds = newTranscription.lines.filter(l => !l.yBounds);
    if (linesWithoutBounds.length > 0) {
      console.warn(`⚠️  ${linesWithoutBounds.length} lines missing yBounds - possible stale transcription data`);
      console.warn('First line without bounds:', linesWithoutBounds[0]?.text?.substring(0, 50));
    }

    // Estimate stroke IDs for each NEW transcription line
    // These lines came from ONLY the untranscribed strokes sent to MyScript
    const linesWithStrokeIds = newTranscription.lines.map(line => {
      const lineBounds = line.yBounds || calculateLineBounds(line, strokesWithoutBlockUuid);
      const strokeIds = estimateLineStrokeIds({ yBounds: lineBounds }, strokesWithoutBlockUuid);

      return {
        ...line,
        yBounds: lineBounds,
        strokeIds: strokeIds
      };
    });

    // Filter out lines with invalid Y-bounds (0.0-0.0) or empty text.
    // Y-bounds validity is the primary check — stroke ID matching is used for block
    // associations but must NOT gate whether a line is saved (unit mismatch between
    // MyScript pixel/mm space and Ncode mm space can produce empty strokeId sets for
    // perfectly valid lines).
    const validLines = linesWithStrokeIds.filter((line, i) => {
      const hasValidBounds = line.yBounds &&
                             (line.yBounds.minY !== 0 || line.yBounds.maxY !== 0);
      const hasText = line.text && line.text.trim().length > 0;
      const isValid = hasValidBounds && hasText;

      if (!isValid) {
        console.warn(`Skipping line ${i}: "${line.text?.substring(0, 50)}..." - no valid Y-bounds or empty text`);
      }

      return isValid;
    });

    console.log(`Processing ${validLines.length}/${linesWithStrokeIds.length} valid NEW lines from untranscribed strokes`);

    // Duplicate prevention: fetch existing transcript blocks and skip lines whose
    // canonical text already exists. This prevents duplicate transcript runs when
    // updateTranscriptBlocks is called more than once for the same page content.
    let existingCanonicals = new Set();
    try {
      const existingBlocks = await getTranscriptBlocks(book, page, host, token);
      if (existingBlocks.length > 0) {
        console.log(`Found ${existingBlocks.length} existing transcript blocks — checking for duplicates`);
        existingBlocks.forEach(b => {
          // Compare against both the stored canonical-transcript property (if present)
          // and the raw block text (stripped of property lines).
          const propCanonical = b.properties?.['canonical-transcript'];
          if (propCanonical) existingCanonicals.add(propCanonical.trim().toLowerCase());
          if (b.content) {
            const rawText = b.content
              .replace(/^-\s*/, '')
              .replace(/\n[\w-]+::.*$/gm, '')
              .trim()
              .toLowerCase();
            if (rawText) existingCanonicals.add(rawText);
          }
        });
      }
    } catch (e) {
      console.warn('Could not fetch existing blocks for duplicate check:', e.message);
    }

    const dedupedLines = existingCanonicals.size > 0
      ? validLines.filter((line, i) => {
          const canonical = (line.canonical || line.text || '').trim().toLowerCase();
          if (existingCanonicals.has(canonical)) {
            console.log(`Skipping duplicate line ${i}: "${line.text?.substring(0, 40)}..."`);
            return false;
          }
          return true;
        })
      : validLines;

    if (dedupedLines.length < validLines.length) {
      console.log(`Duplicate check removed ${validLines.length - dedupedLines.length} already-saved lines`);
    }

    // Build CREATE actions for valid new lines only (append-only - no UPDATE/SKIP/DELETE)
    const actions = dedupedLines.map((line, i) => ({
      type: 'CREATE',
      lineIndex: i,
      line: line,
      bounds: line.yBounds,
      canonical: line.canonical,
      parentUuid: null
    }));

    console.log(`Creating ${actions.length} new blocks (append-only mode)`);

    // Execute CREATE actions
    const results = [];
    const lineToBlockMap = new Map();
    const lineIndentLevels = new Map();

    // Store indent levels for parent lookups
    for (const action of actions) {
      lineIndentLevels.set(action.lineIndex, action.line?.indentLevel || 0);
    }

    // Group actions by indent level for hierarchical processing
    const actionsByLevel = new Map();
    let maxLevel = 0;

    for (const action of actions) {
      const level = action.line?.indentLevel || 0;
      maxLevel = Math.max(maxLevel, level);

      if (!actionsByLevel.has(level)) {
        actionsByLevel.set(level, []);
      }
      actionsByLevel.get(level).push(action);
    }

    // Helper to find parent UUID
    function findParentUuid(currentLineIndex, currentIndent) {
      if (currentIndent === 0) return null;

      for (let i = currentLineIndex - 1; i >= 0; i--) {
        const lineIndent = lineIndentLevels.get(i);
        const lineUuid = lineToBlockMap.get(i);

        if (lineIndent !== undefined && lineIndent < currentIndent && lineUuid) {
          return lineUuid;
        }
      }
      return null;
    }

    // Process level by level (ensures parents exist before children)
    for (let level = 0; level <= maxLevel; level++) {
      const levelActions = actionsByLevel.get(level) || [];
      if (levelActions.length === 0) continue;

      console.log(`Level ${level}: Creating ${levelActions.length} blocks`);

      for (const action of levelActions) {
        try {
          const lineIdx = action.lineIndex;
          const indent = action.line?.indentLevel || 0;

          // Determine parent
          let parentUuid = null;
          if (indent > 0) {
            parentUuid = findParentUuid(lineIdx, indent);
          }

          // If no parent found, use the "Transcribed Content" section
          if (!parentUuid) {
            parentUuid = await getOrCreateTranscriptSection(pageName, host, token);
          }

          // Create the block
          const newBlock = await createTranscriptBlockWithProperties(
            parentUuid,
            action.line,
            host,
            token
          );

          console.log(`  ✓ Created block ${newBlock.uuid.substring(0, 8)}... for line ${lineIdx}`);

          lineToBlockMap.set(lineIdx, newBlock.uuid);
          results.push({
            type: 'created',
            uuid: newBlock.uuid,
            lineIndex: lineIdx,
            indentLevel: indent
          });

        } catch (error) {
          console.error(`Failed to create block for line ${action.lineIndex}:`, error);
          results.push({
            type: 'error',
            action: 'CREATE',
            error: error.message,
            lineIndex: action.lineIndex
          });
        }
      }
    }

    // CRITICAL: Assign blockUuid to ONLY the strokes that were ACTUALLY TRANSCRIBED
    // This uses the transcribedStrokeIds stored with the transcription result
    try {
      const linesWithBlocks = results
        .filter(r => r.type === 'created')
        .map(r => {
          const line = dedupedLines[r.lineIndex];
          if (!line || !line.yBounds) return null;

          return {
            blockUuid: r.uuid,
            yBounds: line.yBounds
          };
        })
        .filter(Boolean);

      // CRITICAL FIX: Only match strokes that were ACTUALLY sent to MyScript
      // newTranscription.transcribedStrokeIds contains the IDs of strokes that were transcribed
      const transcribedStrokeIds = newTranscription.transcribedStrokeIds
        ? new Set(newTranscription.transcribedStrokeIds)
        : null;

      // Filter strokesWithoutBlockUuid to ONLY include strokes that were actually transcribed
      let strokesToMatch;
      if (transcribedStrokeIds) {
        strokesToMatch = strokesWithoutBlockUuid.filter(s =>
          transcribedStrokeIds.has(String(s.startTime))
        );
        console.log(`Filtering: ${strokesWithoutBlockUuid.length} untranscribed strokes → ${strokesToMatch.length} actually transcribed`);
      } else {
        // Fallback: if no transcribedStrokeIds, use all untranscribed strokes (legacy behavior)
        strokesToMatch = strokesWithoutBlockUuid;
        console.warn('No transcribedStrokeIds found - using all untranscribed strokes (legacy fallback)');
      }

      console.log(`Matching ${strokesToMatch.length} transcribed strokes to ${linesWithBlocks.length} new blocks`);

      // ONLY match strokes that were actually transcribed
      const strokeToBlockMap = matchStrokesToLines(strokesToMatch, linesWithBlocks);

      console.log(`Assigning blockUuid to ${strokeToBlockMap.size} strokes`);

      // Update in-memory strokes
      updateStrokeBlockUuids(strokeToBlockMap);

      // Persist strokes with new blockUuid assignments to LogSeq
      const updatedStrokes = getStrokesSnapshot();
      const pageStrokes = updatedStrokes.filter(s =>
        s.pageInfo?.book === book && s.pageInfo?.page === page && !s.deleted
      );

      if (pageStrokes.length > 0) {
        console.log(`Persisting ${pageStrokes.length} strokes to LogSeq`);
        await updatePageStrokes(book, page, pageStrokes, host, token);
        console.log(`✓ Stroke data persisted with blockUuid associations`);
      }

    } catch (error) {
      console.error('Failed to persist stroke→block associations:', error);
      // Don't fail - blocks are still created
    }

    console.log('=== Transcript Update Complete ===');

    return {
      success: true,
      page: pageName,
      results,
      strokesAssigned: results.filter(r => r.type === 'created').length,
      stats: {
        created: results.filter(r => r.type === 'created').length,
        updated: 0, // v3.0: No updates in append-only mode
        skipped: 0, // v3.0: No skips in append-only mode
        preserved: 0, // v3.0: Existing blocks are always preserved (not tracked)
        merged: 0,
        deleted: 0, // v3.0: No auto-deletion
        errors: results.filter(r => r.type === 'error').length
      }
    };

  } catch (error) {
    console.error('Failed to update transcript blocks:', error);
    return {
      success: false,
      error: error.message,
      stats: { created: 0, updated: 0, skipped: 0, preserved: 0, merged: 0, deleted: 0, errors: 0 }
    };
  }
}
