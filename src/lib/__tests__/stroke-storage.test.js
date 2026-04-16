/**
 * Tests for stroke-storage.js — serialisation/deserialisation of pen strokes
 * for LogSeq persistence.
 *
 * These are pure functions with no Svelte store dependencies, so no mocks are
 * needed beyond the module itself.
 *
 * Coverage:
 *   - generateStrokeId
 *   - convertToStorageFormat (including blockUuid preservation)
 *   - convertFromStorageFormat (round-trip fidelity + blockUuid restoration)
 *   - calculateBounds (empty, single, multi-stroke, degenerate)
 *   - deduplicateStrokes
 *   - buildPageStorageObject
 *   - buildJsonExportData (single-page, multi-page, format, grouping, edge cases)
 *   - splitStrokesIntoChunks
 *   - buildChunkedStorageObjects
 *   - parseChunkedJsonBlocks
 *   - parseJsonBlock / formatJsonBlock (round-trip)
 *   - formatTranscribedText
 *   - formatPageName
 *   - getPageProperties
 */

import { describe, it, expect } from 'vitest';

import {
  generateStrokeId,
  convertToStorageFormat,
  convertFromStorageFormat,
  calculateBounds,
  deduplicateStrokes,
  buildPageStorageObject,
  buildJsonExportData,
  splitStrokesIntoChunks,
  buildChunkedStorageObjects,
  parseChunkedJsonBlocks,
  parseJsonBlock,
  formatJsonBlock,
  formatTranscribedText,
  formatPageName,
  getPageProperties
} from '../stroke-storage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal raw pen stroke as produced by the pen SDK */
function makeStroke(startTime, dots, blockUuid = null) {
  return {
    pageInfo: { section: 3, owner: 1012, book: 3017, page: 42 },
    startTime,
    endTime: startTime + 1000,
    blockUuid,
    dotArray: dots.map(([x, y]) => ({ x, y, f: 512, timestamp: startTime + x }))
  };
}

/** Build a simplified storage-format stroke (as returned by convertToStorageFormat) */
function makeSimplified(id, startTime, blockUuid = null) {
  return {
    id,
    startTime,
    endTime: startTime + 1000,
    blockUuid,
    points: [[10, 20, startTime], [15, 25, startTime + 50]]
  };
}

const PAGE_INFO = { section: 3, owner: 1012, book: 3017, page: 42 };

// ---------------------------------------------------------------------------
// generateStrokeId
// ---------------------------------------------------------------------------

describe('generateStrokeId', () => {
  it('produces the expected "s{startTime}" format', () => {
    const stroke = makeStroke(1765313505107, [[10, 20]]);
    expect(generateStrokeId(stroke)).toBe('s1765313505107');
  });

  it('two strokes with different startTimes produce different IDs', () => {
    const a = makeStroke(1000, [[1, 1]]);
    const b = makeStroke(2000, [[1, 1]]);
    expect(generateStrokeId(a)).not.toBe(generateStrokeId(b));
  });

  it('two strokes with the same startTime produce the same ID (content hash not needed)', () => {
    const a = makeStroke(9999, [[1, 1]]);
    const b = makeStroke(9999, [[2, 2]]);
    expect(generateStrokeId(a)).toBe(generateStrokeId(b));
  });
});

// ---------------------------------------------------------------------------
// convertToStorageFormat
// ---------------------------------------------------------------------------

describe('convertToStorageFormat', () => {
  it('converts a single stroke to simplified format', () => {
    const stroke = makeStroke(1000, [[10, 20], [15, 25]]);
    const result = convertToStorageFormat([stroke]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1000');
    expect(result[0].startTime).toBe(1000);
    expect(result[0].endTime).toBe(2000);
    expect(result[0].points).toHaveLength(2);
    // points are [x, y, timestamp] triples
    expect(result[0].points[0][0]).toBe(10);  // x
    expect(result[0].points[0][1]).toBe(20);  // y
  });

  it('strips pressure (f) from points — only x, y, timestamp stored', () => {
    const stroke = makeStroke(1000, [[10, 20]]);
    const [stored] = convertToStorageFormat([stroke]);
    // Each point must be a 3-element array [x, y, t] — pressure is not stored
    expect(stored.points[0]).toHaveLength(3);
  });

  it('preserves blockUuid when present', () => {
    const stroke = makeStroke(1000, [[10, 20]], 'uuid-abc');
    const [stored] = convertToStorageFormat([stroke]);
    expect(stored.blockUuid).toBe('uuid-abc');
  });

  it('stores null blockUuid when not present on stroke', () => {
    const stroke = makeStroke(1000, [[10, 20]]);
    const [stored] = convertToStorageFormat([stroke]);
    expect(stored.blockUuid).toBeNull();
  });

  it('converts multiple strokes in order', () => {
    const strokes = [
      makeStroke(1000, [[1, 1]]),
      makeStroke(2000, [[2, 2]]),
      makeStroke(3000, [[3, 3]])
    ];
    const result = convertToStorageFormat(strokes);
    expect(result).toHaveLength(3);
    expect(result.map(s => s.id)).toEqual(['s1000', 's2000', 's3000']);
  });

  it('handles empty stroke array', () => {
    expect(convertToStorageFormat([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// convertFromStorageFormat
// ---------------------------------------------------------------------------

describe('convertFromStorageFormat', () => {
  it('restores a single stroke from storage format', () => {
    const stored = makeSimplified('s1000', 1000);
    const [restored] = convertFromStorageFormat([stored], PAGE_INFO);

    expect(restored.startTime).toBe(1000);
    expect(restored.endTime).toBe(2000);
    expect(restored.pageInfo).toEqual(PAGE_INFO);
    expect(restored.dotArray).toHaveLength(2);
  });

  it('restores x and y coordinates correctly', () => {
    const stored = {
      id: 's1000',
      startTime: 1000,
      endTime: 2000,
      blockUuid: null,
      points: [[5, 10, 1000], [6, 11, 1001]]
    };
    const [restored] = convertFromStorageFormat([stored], PAGE_INFO);
    expect(restored.dotArray[0].x).toBe(5);
    expect(restored.dotArray[0].y).toBe(10);
    expect(restored.dotArray[1].x).toBe(6);
    expect(restored.dotArray[1].y).toBe(11);
  });

  it('assigns default pressure of 512 to restored dots', () => {
    const stored = makeSimplified('s1000', 1000);
    const [restored] = convertFromStorageFormat([stored], PAGE_INFO);
    restored.dotArray.forEach(dot => {
      expect(dot.f).toBe(512);
    });
  });

  it('restores blockUuid from stored value', () => {
    const stored = makeSimplified('s1000', 1000, 'uuid-xyz');
    const [restored] = convertFromStorageFormat([stored], PAGE_INFO);
    expect(restored.blockUuid).toBe('uuid-xyz');
  });

  it('restores null blockUuid when absent', () => {
    const stored = makeSimplified('s1000', 1000, null);
    const [restored] = convertFromStorageFormat([stored], PAGE_INFO);
    expect(restored.blockUuid).toBeNull();
  });

  it('attaches the provided pageInfo to every restored stroke', () => {
    const stored = [makeSimplified('s1000', 1000), makeSimplified('s2000', 2000)];
    const restored = convertFromStorageFormat(stored, PAGE_INFO);
    restored.forEach(s => expect(s.pageInfo).toBe(PAGE_INFO));
  });

  it('round-trips through convert-to then convert-from with data intact', () => {
    const original = [
      makeStroke(5000, [[10, 20], [11, 21], [12, 22]], 'block-1'),
      makeStroke(6000, [[30, 40]], null)
    ];
    const stored = convertToStorageFormat(original);
    const restored = convertFromStorageFormat(stored, PAGE_INFO);

    expect(restored).toHaveLength(2);
    // First stroke
    expect(restored[0].startTime).toBe(5000);
    expect(restored[0].blockUuid).toBe('block-1');
    expect(restored[0].dotArray).toHaveLength(3);
    // Second stroke
    expect(restored[1].startTime).toBe(6000);
    expect(restored[1].blockUuid).toBeNull();
  });

  it('handles empty stored array', () => {
    expect(convertFromStorageFormat([], PAGE_INFO)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// calculateBounds
// ---------------------------------------------------------------------------

describe('calculateBounds', () => {
  it('returns all-zero bounds for empty array', () => {
    expect(calculateBounds([])).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it('returns all-zero bounds for null/undefined', () => {
    expect(calculateBounds(null)).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
    expect(calculateBounds(undefined)).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it('computes bounds for a single stroke with one point', () => {
    const strokes = [{ points: [[5, 10, 0]] }];
    expect(calculateBounds(strokes)).toEqual({ minX: 5, maxX: 5, minY: 10, maxY: 10 });
  });

  it('computes correct bounds across multiple strokes', () => {
    const strokes = [
      { points: [[1, 2, 0], [3, 4, 0]] },
      { points: [[0, 10, 0], [5, 1, 0]] }
    ];
    const bounds = calculateBounds(strokes);
    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(5);
    expect(bounds.minY).toBe(1);
    expect(bounds.maxY).toBe(10);
  });

  it('handles negative coordinates', () => {
    const strokes = [{ points: [[-5, -3, 0], [2, 7, 0]] }];
    const bounds = calculateBounds(strokes);
    expect(bounds.minX).toBe(-5);
    expect(bounds.maxX).toBe(2);
    expect(bounds.minY).toBe(-3);
    expect(bounds.maxY).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// deduplicateStrokes
// ---------------------------------------------------------------------------

describe('deduplicateStrokes', () => {
  it('returns all new strokes when existing is empty', () => {
    const newStrokes = [makeSimplified('s1', 1), makeSimplified('s2', 2)];
    expect(deduplicateStrokes([], newStrokes)).toHaveLength(2);
  });

  it('filters out new strokes whose IDs are already in existing', () => {
    const existing = [makeSimplified('s1000', 1000)];
    const newStrokes = [
      makeSimplified('s1000', 1000),  // duplicate
      makeSimplified('s2000', 2000)   // new
    ];
    const result = deduplicateStrokes(existing, newStrokes);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s2000');
  });

  it('returns empty array when all new strokes are duplicates', () => {
    const existing = [makeSimplified('s1', 1), makeSimplified('s2', 2)];
    const newStrokes = [makeSimplified('s1', 1), makeSimplified('s2', 2)];
    expect(deduplicateStrokes(existing, newStrokes)).toHaveLength(0);
  });

  it('returns empty array when new is empty', () => {
    const existing = [makeSimplified('s1', 1)];
    expect(deduplicateStrokes(existing, [])).toHaveLength(0);
  });

  it('does not modify the existing array', () => {
    const existing = [makeSimplified('s1', 1)];
    const newStrokes = [makeSimplified('s2', 2)];
    const existingCopy = [...existing];
    deduplicateStrokes(existing, newStrokes);
    expect(existing).toEqual(existingCopy);
  });
});

// ---------------------------------------------------------------------------
// buildPageStorageObject
// ---------------------------------------------------------------------------

describe('buildPageStorageObject', () => {
  it('includes version, pageInfo, strokes, and metadata fields', () => {
    const strokes = [makeSimplified('s1', 1000)];
    const result = buildPageStorageObject(PAGE_INFO, strokes);

    expect(result.version).toBe('1.0');
    expect(result.pageInfo).toEqual(PAGE_INFO);
    expect(result.strokes).toEqual(strokes);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.strokeCount).toBe(1);
    expect(result.metadata.bounds).toBeDefined();
    expect(typeof result.metadata.lastUpdated).toBe('number');
  });

  it('bounds in metadata reflect actual stroke positions', () => {
    const strokes = [{ points: [[5, 10, 0], [15, 30, 0]] }];
    const result = buildPageStorageObject(PAGE_INFO, strokes);
    expect(result.metadata.bounds.minX).toBe(5);
    expect(result.metadata.bounds.maxX).toBe(15);
    expect(result.metadata.bounds.minY).toBe(10);
    expect(result.metadata.bounds.maxY).toBe(30);
  });

  it('handles empty strokes array without throwing', () => {
    expect(() => buildPageStorageObject(PAGE_INFO, [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildJsonExportData
// ---------------------------------------------------------------------------

/** Build a raw pen stroke for a specific book/page */
function makeStrokeOnPage(startTime, book, page, dots = [[10, 20], [15, 25]], blockUuid = null) {
  return {
    pageInfo: { section: 3, owner: 1012, book, page },
    startTime,
    endTime: startTime + 1000,
    blockUuid,
    dotArray: dots.map(([x, y]) => ({ x, y, f: 512, timestamp: startTime + x }))
  };
}

describe('buildJsonExportData', () => {
  // --- format shape ---

  it('returns exportData and filename properties', () => {
    const result = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    expect(result).toHaveProperty('exportData');
    expect(result).toHaveProperty('filename');
  });

  // --- single-page export ---

  it('returns a single object (not an array) for one page', () => {
    const { exportData } = buildJsonExportData([
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 3017, 42)
    ]);
    expect(Array.isArray(exportData)).toBe(false);
    expect(typeof exportData).toBe('object');
  });

  it('single-page filename is B{book}_P{page}_strokes.json', () => {
    const { filename } = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    expect(filename).toBe('B3017_P42_strokes.json');
  });

  it('single-page exportData has correct version, pageInfo, strokes, and metadata', () => {
    const { exportData } = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    expect(exportData.version).toBe('1.0');
    expect(exportData.pageInfo.book).toBe(3017);
    expect(exportData.pageInfo.page).toBe(42);
    expect(Array.isArray(exportData.strokes)).toBe(true);
    expect(exportData.strokes).toHaveLength(1);
    expect(exportData.metadata).toBeDefined();
    expect(exportData.metadata.strokeCount).toBe(1);
    expect(exportData.metadata.bounds).toBeDefined();
  });

  // --- format matches LogSeq (simplified, no pressure) ---

  it('strokes use simplified format: id, startTime, endTime, blockUuid, points', () => {
    const { exportData } = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    const stroke = exportData.strokes[0];
    expect(stroke.id).toBe('s1000');
    expect(stroke.startTime).toBe(1000);
    expect(stroke.endTime).toBe(2000);
    expect(stroke).toHaveProperty('blockUuid');
    expect(Array.isArray(stroke.points)).toBe(true);
  });

  it('points are [x, y, timestamp] triples — pressure (f) is stripped', () => {
    const { exportData } = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    exportData.strokes.forEach(s =>
      s.points.forEach(pt => {
        expect(pt).toHaveLength(3); // x, y, timestamp only
      })
    );
  });

  it('preserves blockUuid through the export pipeline', () => {
    const stroke = makeStrokeOnPage(1000, 3017, 42, [[10, 20]], 'uuid-abc');
    const { exportData } = buildJsonExportData([stroke]);
    expect(exportData.strokes[0].blockUuid).toBe('uuid-abc');
  });

  it('all strokes are in a single flat array — no chunking', () => {
    const rawStrokes = Array.from({ length: 250 }, (_, i) =>
      makeStrokeOnPage(i * 10, 3017, 42)
    );
    const { exportData } = buildJsonExportData(rawStrokes);
    // Should be a flat array of 250 strokes, not split into chunks
    expect(exportData.strokes).toHaveLength(250);
    expect(exportData.strokes[0]).not.toHaveProperty('chunkIndex');
  });

  it('does not include raw dotArray on exported strokes', () => {
    const { exportData } = buildJsonExportData([makeStrokeOnPage(1000, 3017, 42)]);
    exportData.strokes.forEach(s => {
      expect(s).not.toHaveProperty('dotArray');
    });
  });

  // --- multi-page export ---

  it('returns an array for strokes spanning multiple pages', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 3017, 43)
    ];
    const { exportData } = buildJsonExportData(rawStrokes);
    expect(Array.isArray(exportData)).toBe(true);
    expect(exportData).toHaveLength(2);
  });

  it('multi-page filename is strokes.json', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 3017, 43)
    ];
    const { filename } = buildJsonExportData(rawStrokes);
    expect(filename).toBe('strokes.json');
  });

  it('groups strokes correctly across pages — each page object contains only its strokes', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 3017, 42),
      makeStrokeOnPage(3000, 3017, 43)
    ];
    const { exportData } = buildJsonExportData(rawStrokes);
    const page42 = exportData.find(p => p.pageInfo.page === 42);
    const page43 = exportData.find(p => p.pageInfo.page === 43);
    expect(page42.strokes).toHaveLength(2);
    expect(page43.strokes).toHaveLength(1);
  });

  it('each page object in multi-page export has the correct pageInfo', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 9001, 7)
    ];
    const { exportData } = buildJsonExportData(rawStrokes);
    const books = exportData.map(p => p.pageInfo.book);
    expect(books).toContain(3017);
    expect(books).toContain(9001);
  });

  it('each entry in multi-page export has version, pageInfo, strokes, and metadata', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42),
      makeStrokeOnPage(2000, 3017, 43)
    ];
    const { exportData } = buildJsonExportData(rawStrokes);
    exportData.forEach(pageObj => {
      expect(pageObj.version).toBe('1.0');
      expect(pageObj.pageInfo).toBeDefined();
      expect(Array.isArray(pageObj.strokes)).toBe(true);
      expect(pageObj.metadata).toBeDefined();
      expect(pageObj.metadata.strokeCount).toBeGreaterThan(0);
    });
  });

  // --- edge cases ---

  it('handles empty stroke array without throwing', () => {
    expect(() => buildJsonExportData([])).not.toThrow();
    const { exportData } = buildJsonExportData([]);
    // No pages → array of zero entries
    expect(Array.isArray(exportData)).toBe(true);
    expect(exportData).toHaveLength(0);
  });

  it('handles strokes with missing pageInfo gracefully', () => {
    const stroke = { startTime: 1000, endTime: 2000, dotArray: [{ x: 1, y: 2, f: 512, timestamp: 1000 }] };
    expect(() => buildJsonExportData([stroke])).not.toThrow();
  });

  it('output is serialisable to JSON without error', () => {
    const rawStrokes = [
      makeStrokeOnPage(1000, 3017, 42, [[10, 20], [11, 21]], 'uuid-1'),
      makeStrokeOnPage(2000, 3017, 43)
    ];
    const { exportData } = buildJsonExportData(rawStrokes);
    expect(() => JSON.stringify(exportData)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// splitStrokesIntoChunks
// ---------------------------------------------------------------------------

describe('splitStrokesIntoChunks', () => {
  const STROKES_20 = Array.from({ length: 20 }, (_, i) => makeSimplified(`s${i}`, i));

  it('returns a single chunk when total <= chunkSize', () => {
    const chunks = splitStrokesIntoChunks(STROKES_20, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(20);
  });

  it('splits into correct number of chunks', () => {
    const chunks = splitStrokesIntoChunks(STROKES_20, 6);
    // 20 / 6 = ceil(3.33) = 4 chunks
    expect(chunks).toHaveLength(4);
  });

  it('last chunk contains the remainder', () => {
    const chunks = splitStrokesIntoChunks(STROKES_20, 6);
    expect(chunks[chunks.length - 1]).toHaveLength(20 % 6 || 6); // 2 remaining
    expect(chunks[chunks.length - 1]).toHaveLength(2);
  });

  it('all chunks combined equal the original array', () => {
    const chunks = splitStrokesIntoChunks(STROKES_20, 7);
    const combined = chunks.flat();
    expect(combined).toHaveLength(20);
    expect(combined).toEqual(STROKES_20);
  });

  it('uses default chunk size of 200', () => {
    const strokes = Array.from({ length: 201 }, (_, i) => makeSimplified(`s${i}`, i));
    const chunks = splitStrokesIntoChunks(strokes);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(1);
  });

  it('handles empty array', () => {
    expect(splitStrokesIntoChunks([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildChunkedStorageObjects
// ---------------------------------------------------------------------------

describe('buildChunkedStorageObjects', () => {
  const strokes = Array.from({ length: 5 }, (_, i) =>
    makeSimplified(`s${i * 1000}`, i * 1000)
  );

  it('returns metadata and strokeChunks', () => {
    const { metadata, strokeChunks } = buildChunkedStorageObjects(PAGE_INFO, strokes, 3);
    expect(metadata).toBeDefined();
    expect(strokeChunks).toBeDefined();
  });

  it('metadata has correct totalStrokes and chunk count', () => {
    const { metadata, strokeChunks } = buildChunkedStorageObjects(PAGE_INFO, strokes, 3);
    expect(metadata.metadata.totalStrokes).toBe(5);
    expect(metadata.metadata.chunks).toBe(strokeChunks.length);
    // 5 strokes with chunkSize 3 → 2 chunks
    expect(strokeChunks).toHaveLength(2);
  });

  it('each chunk has chunkIndex, strokeCount, and strokes', () => {
    const { strokeChunks } = buildChunkedStorageObjects(PAGE_INFO, strokes, 3);
    strokeChunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
      expect(typeof chunk.strokeCount).toBe('number');
      expect(Array.isArray(chunk.strokes)).toBe(true);
    });
  });

  it('all stroke data is preserved across chunks', () => {
    const { strokeChunks } = buildChunkedStorageObjects(PAGE_INFO, strokes, 3);
    const allIds = strokeChunks.flatMap(c => c.strokes.map(s => s.id));
    expect(allIds).toHaveLength(5);
    expect(allIds).toContain('s0');
    expect(allIds).toContain('s4000');
  });

  it('metadata pageInfo matches provided pageInfo', () => {
    const { metadata } = buildChunkedStorageObjects(PAGE_INFO, strokes, 3);
    expect(metadata.pageInfo.book).toBe(3017);
    expect(metadata.pageInfo.page).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// parseChunkedJsonBlocks
// ---------------------------------------------------------------------------

describe('parseChunkedJsonBlocks', () => {
  /** Build fake child blocks (metadata + chunks) as LogSeq would return */
  function buildChildBlocks(strokes, chunkSize = 3) {
    const { metadata, strokeChunks } = buildChunkedStorageObjects(PAGE_INFO, strokes, chunkSize);
    return [
      { content: formatJsonBlock(metadata) },
      ...strokeChunks.map(c => ({ content: formatJsonBlock(c) }))
    ];
  }

  const strokes = Array.from({ length: 5 }, (_, i) => makeSimplified(`s${i * 1000}`, i * 1000));

  it('returns null for null/empty input', () => {
    expect(parseChunkedJsonBlocks(null)).toBeNull();
    expect(parseChunkedJsonBlocks([])).toBeNull();
  });

  it('reconstructs the correct number of strokes', () => {
    const blocks = buildChildBlocks(strokes, 3);
    const result = parseChunkedJsonBlocks(blocks);
    expect(result).not.toBeNull();
    expect(result.strokes).toHaveLength(5);
  });

  it('reconstructed stroke IDs match originals', () => {
    const blocks = buildChildBlocks(strokes, 3);
    const result = parseChunkedJsonBlocks(blocks);
    const ids = result.strokes.map(s => s.id);
    expect(ids).toContain('s0');
    expect(ids).toContain('s4000');
  });

  it('returns pageInfo from the metadata block', () => {
    const blocks = buildChildBlocks(strokes, 3);
    const result = parseChunkedJsonBlocks(blocks);
    expect(result.pageInfo.book).toBe(3017);
    expect(result.pageInfo.page).toBe(42);
  });

  it('returns null when first block has invalid JSON', () => {
    const blocks = [{ content: 'not json at all' }];
    expect(parseChunkedJsonBlocks(blocks)).toBeNull();
  });

  it('ignores corrupted chunk blocks gracefully', () => {
    const blocks = buildChildBlocks(strokes, 3);
    // Corrupt the second chunk
    blocks[2] = { content: 'corrupt' };
    const result = parseChunkedJsonBlocks(blocks);
    // Should still return something, just with fewer strokes
    expect(result).not.toBeNull();
    // 5 strokes in 2 chunks (3+2); chunk 1 had 3 strokes, chunk 2 corrupted
    expect(result.strokes.length).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// parseJsonBlock / formatJsonBlock (round-trip)
// ---------------------------------------------------------------------------

describe('parseJsonBlock / formatJsonBlock — round-trip', () => {
  const data = { foo: 'bar', count: 42, arr: [1, 2, 3] };

  it('formatJsonBlock wraps data in ```json code fence', () => {
    const formatted = formatJsonBlock(data);
    expect(formatted).toMatch(/^```json\n/);
    expect(formatted).toMatch(/\n```$/);
  });

  it('parseJsonBlock extracts JSON from ```json code fence', () => {
    const formatted = formatJsonBlock(data);
    const parsed = parseJsonBlock(formatted);
    expect(parsed).toEqual(data);
  });

  it('parseJsonBlock handles ``` fence without language specifier', () => {
    const content = '```\n{"key":"value"}\n```';
    const parsed = parseJsonBlock(content);
    expect(parsed).toEqual({ key: 'value' });
  });

  it('parseJsonBlock returns null for content without code fence', () => {
    expect(parseJsonBlock('just some text')).toBeNull();
  });

  it('parseJsonBlock returns null for invalid JSON inside fence', () => {
    expect(parseJsonBlock('```json\nnot valid json\n```')).toBeNull();
  });

  it('parseJsonBlock handles complex nested objects', () => {
    const complex = {
      metadata: { chunks: 3, totalStrokes: 600 },
      pageInfo: PAGE_INFO,
      strokes: [{ id: 's1', points: [[1, 2, 3]] }]
    };
    const roundTripped = parseJsonBlock(formatJsonBlock(complex));
    expect(roundTripped).toEqual(complex);
  });
});

// ---------------------------------------------------------------------------
// formatTranscribedText
// ---------------------------------------------------------------------------

describe('formatTranscribedText', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(formatTranscribedText(null)).toBe('');
    expect(formatTranscribedText(undefined)).toBe('');
    expect(formatTranscribedText([])).toBe('');
  });

  it('formats a single line at indent 0 with a dash prefix', () => {
    const lines = [{ text: 'Hello world', indentLevel: 0 }];
    expect(formatTranscribedText(lines)).toBe('- Hello world');
  });

  it('indents nested lines with 2 spaces per level', () => {
    const lines = [
      { text: 'Parent', indentLevel: 0 },
      { text: 'Child',  indentLevel: 1 },
      { text: 'Grandchild', indentLevel: 2 }
    ];
    const result = formatTranscribedText(lines);
    const resultLines = result.split('\n');
    expect(resultLines[0]).toBe('- Parent');
    expect(resultLines[1]).toBe('  - Child');
    expect(resultLines[2]).toBe('    - Grandchild');
  });

  it('does NOT add a second dash when line text already starts with a dash', () => {
    const lines = [{ text: '- Already has dash', indentLevel: 0 }];
    const result = formatTranscribedText(lines);
    expect(result).toBe('- Already has dash');
    expect(result.startsWith('- -')).toBe(false);
  });

  it('handles missing indentLevel (treats as 0)', () => {
    const lines = [{ text: 'No level' }];
    expect(formatTranscribedText(lines)).toBe('- No level');
  });

  it('joins multiple lines with newline', () => {
    const lines = [
      { text: 'Line one', indentLevel: 0 },
      { text: 'Line two', indentLevel: 0 }
    ];
    const result = formatTranscribedText(lines);
    expect(result).toBe('- Line one\n- Line two');
  });
});

// ---------------------------------------------------------------------------
// formatPageName
// ---------------------------------------------------------------------------

describe('formatPageName', () => {
  it('produces "Smartpen Data/B{book}/P{page}" format', () => {
    expect(formatPageName(3017, 42)).toBe('Smartpen Data/B3017/P42');
  });

  it('works with small book and page numbers', () => {
    expect(formatPageName(1, 1)).toBe('Smartpen Data/B1/P1');
  });

  it('works with large numbers', () => {
    expect(formatPageName(99999, 999)).toBe('Smartpen Data/B99999/P999');
  });
});

// ---------------------------------------------------------------------------
// getPageProperties
// ---------------------------------------------------------------------------

describe('getPageProperties', () => {
  it('returns Book and Page as string properties', () => {
    const props = getPageProperties({ book: 3017, page: 42, section: 3, owner: 1012 });
    expect(props.Book).toBe('3017');
    expect(props.Page).toBe('42');
  });

  it('does not include section or owner in properties', () => {
    const props = getPageProperties({ book: 1, page: 1, section: 3, owner: 1012 });
    expect(props.section).toBeUndefined();
    expect(props.owner).toBeUndefined();
  });
});
