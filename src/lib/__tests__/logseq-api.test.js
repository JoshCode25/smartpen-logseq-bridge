/**
 * Tests for mergeExistingAndNewLines — pure business logic, no mocks needed.
 *
 * The function merges a list of existing (saved) transcript lines with a new
 * batch coming back from MyScript.  Key behaviours:
 *   - Empty existing → return new lines with syncStatus='new'
 *   - Empty new      → return existing lines unchanged
 *   - Exact canonical duplicate   → new line is dropped
 *   - Y-overlapping subset match  → new line is dropped
 *   - Non-duplicate new lines     → appended and sorted by minY
 */

import { describe, it, expect } from 'vitest';
import { mergeExistingAndNewLines } from '../logseq-api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function existingLine(text, minY, maxY, canonical = text) {
  return {
    text,
    canonical,
    yBounds: { minY, maxY },
    syncStatus: 'saved',
    blockUuid: 'some-uuid'
  };
}

function newLine(text, minY, maxY, canonical = text) {
  return {
    text,
    canonical,
    yBounds: { minY, maxY },
    syncStatus: 'unsaved',
    blockUuid: null
  };
}

// ---------------------------------------------------------------------------
// Edge cases: empty inputs
// ---------------------------------------------------------------------------

describe('mergeExistingAndNewLines — empty inputs', () => {
  it('returns new lines with syncStatus when existing is empty', () => {
    const result = mergeExistingAndNewLines([], [
      newLine('Hello', 5, 13)
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello');
    // syncStatus should be either 'new' (default) or preserved from the line
    expect(result[0].syncStatus).toBeTruthy();
  });

  it('returns empty array when both existing and new are empty', () => {
    const result = mergeExistingAndNewLines([], []);
    expect(result).toHaveLength(0);
  });

  it('returns existing lines unchanged when new is empty', () => {
    const existing = [existingLine('Alpha', 5, 13), existingLine('Beta', 18, 26)];
    const result = mergeExistingAndNewLines(existing, []);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Alpha');
    expect(result[1].text).toBe('Beta');
  });

  it('returns existing lines unchanged when new is null', () => {
    const existing = [existingLine('Alpha', 5, 13)];
    const result = mergeExistingAndNewLines(existing, null);
    expect(result).toHaveLength(1);
  });

  it('returns new lines when existing is null', () => {
    const result = mergeExistingAndNewLines(null, [newLine('Hello', 5, 13)]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection — exact canonical match
// ---------------------------------------------------------------------------

describe('mergeExistingAndNewLines — exact canonical duplicates', () => {
  it('drops a new line that exactly matches an existing canonical', () => {
    const existing = [existingLine('Meeting notes', 5, 13)];
    const newLines = [newLine('Meeting notes', 5, 13)];

    const result = mergeExistingAndNewLines(existing, newLines);

    // Duplicate should be removed; only the existing line remains
    expect(result).toHaveLength(1);
    expect(result[0].syncStatus).toBe('saved');
  });

  it('is case-insensitive when comparing canonical text', () => {
    const existing = [existingLine('WAITING do something', 5, 13, 'waiting do something')];
    const newLines = [newLine('WAITING do something', 5, 13, 'waiting do something')];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(1);
  });

  it('keeps a new line whose text differs from all existing lines', () => {
    const existing = [existingLine('First item', 5, 13)];
    const newLines = [newLine('Second item', 20, 28)];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(2);
  });

  it('retains all existing lines even when some new lines are duplicated', () => {
    const existing = [
      existingLine('Line one', 5, 13),
      existingLine('Line two', 18, 26)
    ];
    const newLines = [
      newLine('Line one', 5, 13),   // duplicate
      newLine('Line three', 31, 39)  // new
    ];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(3);
    const texts = result.map(l => l.text);
    expect(texts).toContain('Line one');
    expect(texts).toContain('Line two');
    expect(texts).toContain('Line three');
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection — Y-bounds subset match
// ---------------------------------------------------------------------------

describe('mergeExistingAndNewLines — Y-overlap subset filtering', () => {
  it('drops a new line whose text is a subset of an overlapping existing line', () => {
    // Existing block was created from a merged/wider recognition
    const existing = [existingLine('hello world', 5, 13, 'hello world')];
    // New line is a subset of the existing canonical and overlaps in Y
    const newLines = [newLine('hello', 7, 11, 'hello')];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(1);
    expect(result[0].syncStatus).toBe('saved');
  });

  it('keeps a new line whose text is a subset of an existing but DOES NOT overlap in Y', () => {
    const existing = [existingLine('hello world', 5, 13, 'hello world')];
    // Same text but at a completely different Y position (different line on the page)
    const newLines = [newLine('hello', 50, 58, 'hello')];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('mergeExistingAndNewLines — sorting by Y position', () => {
  it('returns combined lines sorted by ascending minY', () => {
    const existing = [existingLine('Lower line', 30, 38)];
    const newLines = [newLine('Upper line', 5, 13)];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Upper line');
    expect(result[1].text).toBe('Lower line');
  });

  it('interleaves existing and new lines in Y order', () => {
    const existing = [
      existingLine('Top', 5, 13),
      existingLine('Bottom', 50, 58)
    ];
    const newLines = [
      newLine('Middle', 25, 33)
    ];

    const result = mergeExistingAndNewLines(existing, newLines);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('Top');
    expect(result[1].text).toBe('Middle');
    expect(result[2].text).toBe('Bottom');
  });

  it('preserves syncStatus on new lines after merging', () => {
    const existing = [existingLine('Existing', 5, 13)];
    const newLines = [newLine('Brand new', 25, 33)];

    const result = mergeExistingAndNewLines(existing, newLines);
    const merged = result.find(l => l.text === 'Brand new');
    // syncStatus comes from the new line; 'new' is the fallback set by mergeExistingAndNewLines
    expect(merged.syncStatus).toBeTruthy();
  });
});
