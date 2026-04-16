/**
 * Split strokes into chunks for multi-block storage
 * @param {Array} strokes - Simplified strokes array
 * @param {number} chunkSize - Maximum strokes per chunk (default 200)
 * @returns {Array<Array>} Array of stroke chunks
 */
export function splitStrokesIntoChunks(strokes, chunkSize = 200) {
  const chunks = [];
  for (let i = 0; i < strokes.length; i += chunkSize) {
    chunks.push(strokes.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Build chunked storage objects (metadata + stroke blocks)
 * @param {Object} pageInfo - Page info from pen
 * @param {Array} strokes - All simplified strokes
 * @param {number} chunkSize - Maximum strokes per chunk (default 200)
 * @returns {Object} { metadata, strokeChunks }
 */
export function buildChunkedStorageObjects(pageInfo, strokes, chunkSize = 200) {
  const bounds = calculateBounds(strokes);
  const chunks = splitStrokesIntoChunks(strokes, chunkSize);
  
  const metadata = {
    version: "1.0",
    pageInfo: {
      section: pageInfo.section,
      owner: pageInfo.owner,
      book: pageInfo.book,
      page: pageInfo.page
    },
    metadata: {
      lastUpdated: Date.now(),
      totalStrokes: strokes.length,
      bounds: bounds,
      chunks: chunks.length,
      chunkSize: chunkSize
    }
  };
  
  const strokeChunks = chunks.map((chunk, index) => ({
    chunkIndex: index,
    strokeCount: chunk.length,
    strokes: chunk
  }));
  
  return { metadata, strokeChunks };
}

/**
 * Parse chunked JSON blocks from LogSeq
 * @param {Array} childBlocks - All child blocks under "Raw Stroke Data"
 * @returns {Object|null} Reconstructed storage object or null
 */
export function parseChunkedJsonBlocks(childBlocks) {
  if (!childBlocks || childBlocks.length === 0) return null;
  
  try {
    // First block is metadata
    const metadata = parseJsonBlock(childBlocks[0].content);
    if (!metadata) return null;
    
    // Remaining blocks are stroke chunks
    const allStrokes = [];
    for (let i = 1; i < childBlocks.length; i++) {
      const chunk = parseJsonBlock(childBlocks[i].content);
      if (chunk && chunk.strokes) {
        allStrokes.push(...chunk.strokes);
      }
    }
    
    // Reconstruct original format for backward compatibility
    return {
      version: metadata.version,
      pageInfo: metadata.pageInfo,
      strokes: allStrokes,
      metadata: metadata.metadata
    };
  } catch (error) {
    console.error('Failed to parse chunked blocks:', error);
    return null;
  }
}

/**
 * Stroke Storage Utilities
 * Transforms pen stroke data into LogSeq-optimized format
 */

/**
 * Generate unique stroke ID from timestamp
 * @param {Object} stroke - Raw stroke object
 * @returns {string} Unique ID (e.g., "s1765313505107")
 */
export function generateStrokeId(stroke) {
  return `s${stroke.startTime}`;
}

/**
 * Convert raw pen strokes to simplified storage format
 * Removes artistic metadata (pressure, tilt, color) to reduce storage by ~60%
 * Now includes blockUuid for incremental transcription tracking
 * 
 * @param {Array} strokes - Raw strokes from pen (with optional blockUuid)
 * @returns {Array} Simplified strokes with essential data + blockUuid
 */
export function convertToStorageFormat(strokes) {
  const withBlockUuid = strokes.filter(s => s.blockUuid).length;
  console.log(`[convertToStorageFormat] Converting ${strokes.length} strokes (${withBlockUuid} have blockUuid)`);

  return strokes.map(stroke => ({
    id: generateStrokeId(stroke),
    startTime: stroke.startTime,
    endTime: stroke.endTime,
    blockUuid: stroke.blockUuid || null,  // NEW: Persist block reference
    points: stroke.dotArray.map(dot => [
      dot.x,
      dot.y,
      dot.timestamp
    ])
  }));
}

/**
 * Calculate bounding box for strokes
 * @param {Array} strokes - Simplified stroke array
 * @returns {Object} Bounds { minX, maxX, minY, maxY }
 */
export function calculateBounds(strokes) {
  if (!strokes || strokes.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  
  strokes.forEach(stroke => {
    stroke.points.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
  });
  
  return { minX, maxX, minY, maxY };
}

/**
 * Deduplicate strokes by ID
 * Used for incremental updates when offline strokes may overlap with real-time
 * 
 * @param {Array} existingStrokes - Strokes already in storage
 * @param {Array} newStrokes - New strokes to add
 * @returns {Array} Only unique new strokes (not in existing)
 */
export function deduplicateStrokes(existingStrokes, newStrokes) {
  const existingIds = new Set(existingStrokes.map(s => s.id));
  return newStrokes.filter(s => !existingIds.has(s.id));
}

/**
 * Build page storage object with metadata
 * @param {Object} pageInfo - Page info from pen (section, owner, book, page)
 * @param {Array} strokes - Simplified strokes array
 * @returns {Object} Complete storage object for LogSeq
 */
export function buildPageStorageObject(pageInfo, strokes) {
  const bounds = calculateBounds(strokes);
  
  return {
    version: "1.0",
    pageInfo: {
      section: pageInfo.section,
      owner: pageInfo.owner,
      book: pageInfo.book,
      page: pageInfo.page
    },
    strokes: strokes,
    metadata: {
      lastUpdated: Date.now(),
      strokeCount: strokes.length,
      bounds: bounds
    }
  };
}

/**
 * Build the JSON export payload (editor Format 1: { slug, strokes }).
 *
 * Produces a flat strokes array sorted by startTime. Points are [x, y] pairs.
 * Multi-page exports add a `pageGroup` field to each stroke so the editor can
 * separate them. Single-page exports omit pageGroup.
 *
 * @param {Array} rawStrokes - Raw pen strokes (pageInfo + dotArray)
 * @returns {{ exportData: Object, filename: string }}
 */
export function buildJsonExportData(rawStrokes) {
  const pageMap = new Map();
  rawStrokes.forEach(stroke => {
    const pi = stroke.pageInfo || {};
    const key = `B${pi.book || 0}/P${pi.page || 0}`;
    if (!pageMap.has(key)) pageMap.set(key, { pageInfo: pi, strokes: [] });
    pageMap.get(key).strokes.push(stroke);
  });

  const pages = Array.from(pageMap.values());
  const isMultiPage = pages.length > 1;

  const allStrokes = [];
  pages.forEach(({ pageInfo, strokes }) => {
    const pi = pageInfo || {};
    const pageGroup = `B${pi.book || 0}-P${pi.page || 0}`;
    convertToStorageFormat(strokes).forEach(s => {
      const stroke = { id: s.id, startTime: s.startTime, points: s.points.map(([x, y]) => [x, y]) };
      if (isMultiPage) stroke.pageGroup = pageGroup;
      allStrokes.push(stroke);
    });
  });

  allStrokes.sort((a, b) => a.startTime - b.startTime);

  const slug = pages.length === 1
    ? `B${pages[0].pageInfo?.book || 0}-P${pages[0].pageInfo?.page || 0}`
    : 'strokes';

  const exportData = { slug, strokes: allStrokes };
  const filename = pages.length === 1
    ? `B${pages[0].pageInfo?.book || 0}_P${pages[0].pageInfo?.page || 0}_strokes.json`
    : 'strokes.json';

  return { exportData, filename };
}

/**
 * Build Markdown export payloads (editor Format 4: front-matter + json blocks).
 *
 * Generates one file per page. Each file contains LogSeq-style front matter
 * (book:: / page::), a metadata json block, and a single chunk block with all
 * strokes for that page. Points are [x, y] pairs, strokes sorted by startTime.
 *
 * @param {Array} rawStrokes - Raw pen strokes (pageInfo + dotArray)
 * @returns {Array<{ content: string, filename: string }>}
 */
export function buildMdExportData(rawStrokes) {
  const pageMap = new Map();
  rawStrokes.forEach(stroke => {
    const pi = stroke.pageInfo || {};
    const key = `B${pi.book || 0}/P${pi.page || 0}`;
    if (!pageMap.has(key)) pageMap.set(key, { pageInfo: pi, strokes: [] });
    pageMap.get(key).strokes.push(stroke);
  });

  return Array.from(pageMap.values()).map(({ pageInfo, strokes }) => {
    const pi = pageInfo || {};
    const book = pi.book || 0;
    const page = pi.page || 0;

    const exportStrokes = convertToStorageFormat(strokes)
      .map(s => ({ id: s.id, startTime: s.startTime, points: s.points.map(([x, y]) => [x, y]) }))
      .sort((a, b) => a.startTime - b.startTime);

    const metadata = { version: "1.0", pageInfo: { section: pi.section, owner: pi.owner, book, page } };
    const chunk = { chunkIndex: 0, strokes: exportStrokes };

    const content = [
      `book:: ${book}`,
      `page:: ${page}`,
      ``,
      '```json',
      JSON.stringify(metadata),
      '```',
      ``,
      '```json',
      JSON.stringify(chunk),
      '```',
    ].join('\n');

    return { content, filename: `B${book}_P${page}_strokes.md` };
  });
}

/**
 * Build transcription storage object
 * @param {Object} transcription - Transcription result from MyScript
 * @param {number} strokeCount - Number of strokes transcribed
 * @returns {Object} Transcription storage object for LogSeq
 */
export function buildTranscriptionStorageObject(transcription, strokeCount) {
  return {
    version: "1.0",
    transcribedAt: Date.now(),
    engine: "myscript",
    engineVersion: "2.0",
    text: transcription.text || "",
    lines: transcription.lines || [],
    commands: transcription.commands || [],
    metadata: {
      strokeCount: strokeCount,
      confidence: transcription.confidence || 0,
      processingTime: transcription.processingTime || 0
    }
  };
}

/**
 * Format page name for LogSeq namespace
 * @param {number} book - Book ID
 * @param {number} page - Page number
 * @returns {string} Page name (e.g., "Smartpen Data/B3017/P42")
 */
export function formatPageName(book, page) {
  return `Smartpen Data/B${book}/P${page}`;
}

/**
 * Parse JSON from LogSeq code block
 * @param {string} blockContent - Full block content with code fence
 * @returns {Object|null} Parsed JSON or null if invalid
 */
export function parseJsonBlock(blockContent) {
  try {
    // Extract JSON from code block (remove ```json and ```)
    const jsonMatch = blockContent.match(/```json\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      // Try without language specifier
      const plainMatch = blockContent.match(/```\n([\s\S]*?)\n```/);
      if (!plainMatch) return null;
      return JSON.parse(plainMatch[1]);
    }
    return JSON.parse(jsonMatch[1]);
  } catch (error) {
    console.error('Failed to parse JSON block:', error);
    return null;
  }
}

/**
 * Format JSON for LogSeq code block
 * @param {Object} data - Object to serialize
 * @returns {string} Formatted code block with JSON
 */
export function formatJsonBlock(data) {
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

/**
 * Format page properties for LogSeq (only Book and Page)
 * @param {Object} pageInfo - Page information
 * @returns {Object} Properties object for LogSeq
 */
export function getPageProperties(pageInfo) {
  return {
    'Book': pageInfo.book.toString(),
    'Page': pageInfo.page.toString()
  };
}

/**
 * Convert stored strokes back to in-memory format
 * Restores blockUuid from storage for session continuity
 * 
 * @param {Array} storedStrokes - Simplified strokes from LogSeq
 * @param {Object} pageInfo - Page info to attach
 * @returns {Array} Full stroke objects for strokes store
 */
export function convertFromStorageFormat(storedStrokes, pageInfo) {
  return storedStrokes.map(stored => ({
    pageInfo: pageInfo,
    startTime: stored.startTime,
    endTime: stored.endTime,
    blockUuid: stored.blockUuid || null,  // Restore block reference
    dotArray: stored.points.map(([x, y, timestamp]) => ({
      x,
      y,
      f: 512,  // Default pressure (not stored)
      timestamp
    }))
  }));
}

/**
 * Format transcribed text for LogSeq (with block dashes and indentation)
 * @param {Array} lines - Line objects with text and indentLevel
 * @returns {string} Formatted text with LogSeq block syntax
 */
export function formatTranscribedText(lines) {
  if (!lines || lines.length === 0) return '';
  
  return lines.map(line => {
    const indent = '  '.repeat(line.indentLevel || 0);
    const text = line.text;
    
    // Check if the line already starts with a dash (from MyScript recognition)
    // If so, don't add another dash - just use indentation
    const startsWithDash = text.trimStart().startsWith('-');
    
    if (startsWithDash) {
      // Line already has a dash, just add indentation
      return indent + text.trimStart();
    } else {
      // Line doesn't have a dash, add one
      return indent + '- ' + text;
    }
  }).join('\n');
}
