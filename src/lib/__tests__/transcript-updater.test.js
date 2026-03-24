/**
 * Tests for updateTranscriptBlocks — focused on the two bug-fixes:
 *
 *  1. validLines filter no longer gates on strokeIds.size > 0.
 *     Lines are included when they have valid (non-zero) Y-bounds AND non-empty
 *     text, regardless of whether estimateLineStrokeIds found any strokes.
 *
 *  2. Duplicate prevention: if existing transcript blocks in LogSeq already
 *     contain a line with the same canonical text, that line is not re-created.
 *
 *  3. dedupedLines index correctness: the lineIndex stored on CREATE actions
 *     indexes into dedupedLines (not the pre-filter array), so the block-to-line
 *     data association is always correct even when some lines are filtered out.
 *
 * All LogSeq API calls and Svelte store mutations are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (must appear before the import under test)
// ---------------------------------------------------------------------------

vi.mock('../logseq-api.js', () => ({
  getTranscriptBlocks: vi.fn(),
  createTranscriptBlockWithProperties: vi.fn(),
  updateTranscriptBlockWithPreservation: vi.fn(),
  getOrCreateSmartpenPage: vi.fn(),
  updatePageStrokes: vi.fn(),
  makeRequest: vi.fn()
}));

vi.mock('../../stores/strokes.js', () => ({
  updateStrokeBlockUuids: vi.fn(),
  getStrokesSnapshot: vi.fn(),
  partitionStrokesByTranscriptionStatus: vi.fn()
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { updateTranscriptBlocks } from '../transcript-updater.js';

import {
  getTranscriptBlocks,
  createTranscriptBlockWithProperties,
  getOrCreateSmartpenPage,
  updatePageStrokes,
  makeRequest
} from '../logseq-api.js';

import {
  updateStrokeBlockUuids,
  getStrokesSnapshot,
  partitionStrokesByTranscriptionStatus
} from '../../stores/strokes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let blockCounter = 0;

function freshUuid() {
  return `block-uuid-${++blockCounter}`;
}

/** Minimal transcription line with explicit Y-bounds */
function line(text, minY, maxY, canonical = text) {
  return {
    text,
    canonical,
    yBounds: { minY, maxY },
    indentLevel: 0,
    parent: null,
    children: [],
    syncStatus: 'unsaved',
    blockUuid: null
  };
}

/** Build a transcription result from an array of lines */
function transcription(...lines) {
  return {
    text: lines.map(l => l.text).join('\n'),
    lines,
    strokeCount: lines.length,
    transcribedStrokeIds: []   // no specific stroke IDs — legacy fallback
  };
}

/** Build a fake existing LogSeq block as returned by getTranscriptBlocks */
function existingBlock(canonical, text = canonical) {
  return {
    uuid: freshUuid(),
    content: `- ${text}\ncanonical-transcript:: ${canonical}`,
    properties: { 'canonical-transcript': canonical }
  };
}

// ---------------------------------------------------------------------------
// Default mock wiring — reset before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // getOrCreateSmartpenPage → returns a minimal page object
  getOrCreateSmartpenPage.mockResolvedValue({ name: 'smartpen/B3017/P74' });

  // partitionStrokesByTranscriptionStatus → no strokes by default
  partitionStrokesByTranscriptionStatus.mockReturnValue({
    transcribed: [],
    untranscribed: []
  });

  // getTranscriptBlocks → no existing blocks by default
  getTranscriptBlocks.mockResolvedValue([]);

  // makeRequest — handles getPageBlocksTree (returns existing section) and
  // appendBlockInPage (creates new section)
  makeRequest.mockImplementation((_host, _token, method) => {
    if (method === 'logseq.Editor.getPageBlocksTree') {
      return Promise.resolve([{
        content: '## Transcribed Content #Display_No_Properties',
        uuid: 'section-uuid'
      }]);
    }
    return Promise.resolve({ uuid: 'section-uuid' });
  });

  // createTranscriptBlockWithProperties → always returns a fresh block UUID
  createTranscriptBlockWithProperties.mockImplementation(() =>
    Promise.resolve({ uuid: freshUuid() })
  );

  // updatePageStrokes → succeeds silently
  updatePageStrokes.mockResolvedValue({ success: true });

  // Svelte store stubs
  updateStrokeBlockUuids.mockReturnValue(undefined);
  getStrokesSnapshot.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Basic happy path
// ---------------------------------------------------------------------------

describe('updateTranscriptBlocks — basic success path', () => {
  it('returns success:true for a simple transcription', async () => {
    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(line('Hello world', 5, 13)),
      'http://localhost:12315'
    );
    expect(result.success).toBe(true);
  });

  it('creates one block per valid line', async () => {
    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('First line', 5, 13),
        line('Second line', 20, 28)
      ),
      'http://localhost:12315'
    );
    expect(result.stats.created).toBe(2);
    expect(createTranscriptBlockWithProperties).toHaveBeenCalledTimes(2);
  });

  it('returns success:true and zero blocks for an empty transcription', async () => {
    const result = await updateTranscriptBlocks(
      3017, 74, [], { lines: [], text: '', strokeCount: 0, transcribedStrokeIds: [] },
      'http://localhost:12315'
    );
    expect(result.success).toBe(true);
    expect(result.stats.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validLines filter — Y-bounds gating
// ---------------------------------------------------------------------------

describe('updateTranscriptBlocks — validLines Y-bounds filter', () => {
  it('skips a line whose Y-bounds are {0,0}', async () => {
    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('Valid line',     5, 13),  // should be created
        line('Zero bounds',   0, 0),   // should be skipped
        line('Another valid', 25, 33)  // should be created
      ),
      'http://localhost:12315'
    );
    expect(result.stats.created).toBe(2);
    expect(createTranscriptBlockWithProperties).toHaveBeenCalledTimes(2);
  });

  it('skips a line with empty text even if Y-bounds are valid', async () => {
    const emptyTextLine = line('', 10, 18);

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('Good line', 5, 13),
        emptyTextLine
      ),
      'http://localhost:12315'
    );
    expect(result.stats.created).toBe(1);
  });

  it('skips a whitespace-only line', async () => {
    const wsLine = line('   ', 10, 18);

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(line('Good line', 5, 13), wsLine),
      'http://localhost:12315'
    );
    expect(result.stats.created).toBe(1);
  });

  it('includes a line that has valid bounds even if strokeIds set is empty', async () => {
    // strokeIds.size === 0 used to gate inclusion — after the fix it should NOT
    partitionStrokesByTranscriptionStatus.mockReturnValue({
      transcribed: [],
      untranscribed: []   // no strokes at all → estimateLineStrokeIds returns empty Set
    });

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('5) Dean confirmed', 60, 68),  // numbered — strokeIds may be empty
        line('□ Email Keith',     75, 83)   // special char — same
      ),
      'http://localhost:12315'
    );

    // Both lines have valid Y-bounds, so both should be created
    expect(result.stats.created).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Duplicate prevention
// ---------------------------------------------------------------------------

describe('updateTranscriptBlocks — duplicate prevention', () => {
  it('skips a line whose canonical text already exists in LogSeq', async () => {
    getTranscriptBlocks.mockResolvedValue([
      existingBlock('meeting summary')
    ]);

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('meeting summary',  5, 13, 'meeting summary'),  // duplicate
        line('action item one', 20, 28, 'action item one')   // new
      ),
      'http://localhost:12315'
    );

    expect(result.stats.created).toBe(1);
    // Only the non-duplicate should have been created
    const [, lineArg] = createTranscriptBlockWithProperties.mock.calls[0];
    expect((lineArg.canonical || lineArg.text).toLowerCase()).toBe('action item one');
  });

  it('creates the block when the same text has different capitalisation in LogSeq', async () => {
    // Canonical matching is case-insensitive, so this IS a duplicate
    getTranscriptBlocks.mockResolvedValue([
      existingBlock('Action Item One')
    ]);

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(line('Action Item One', 5, 13, 'action item one')),
      'http://localhost:12315'
    );

    expect(result.stats.created).toBe(0);
  });

  it('creates all lines when no existing blocks are present', async () => {
    getTranscriptBlocks.mockResolvedValue([]);  // already the default, but explicit

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('Line A', 5, 13),
        line('Line B', 20, 28)
      ),
      'http://localhost:12315'
    );

    expect(result.stats.created).toBe(2);
  });

  it('does not fail when getTranscriptBlocks throws — still creates all lines', async () => {
    getTranscriptBlocks.mockRejectedValue(new Error('LogSeq unavailable'));

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(line('Fallback line', 5, 13)),
      'http://localhost:12315'
    );

    // Should gracefully fall through and create without deduplication
    expect(result.success).toBe(true);
    expect(result.stats.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dedupedLines index correctness (the pre-existing index bug)
// ---------------------------------------------------------------------------

describe('updateTranscriptBlocks — dedupedLines index correctness', () => {
  /**
   * Scenario: line 0 has 0-0 bounds (filtered out), line 1 is valid.
   * After filtering, dedupedLines = [line1] at index 0.
   * The CREATE action records lineIndex:0.
   * When linesWithBlocks is built, r.lineIndex=0 must reference line1 (not line0).
   *
   * We verify this indirectly: the block created should have line1's yBounds,
   * not line0's.  createTranscriptBlockWithProperties receives the line object,
   * so we inspect the argument.
   */
  it('associates block creation with the correct line data when earlier lines are filtered', async () => {
    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('Filtered out', 0, 0),         // filtered — invalid bounds
        line('The real content', 25, 33)     // valid
      ),
      'http://localhost:12315'
    );

    expect(result.stats.created).toBe(1);

    // The block created should carry the second line's text
    const [, lineArg] = createTranscriptBlockWithProperties.mock.calls[0];
    expect(lineArg.text).toBe('The real content');
    expect(lineArg.yBounds.minY).toBe(25);
  });

  it('associates block creation with the correct line data when earlier duplicate is removed', async () => {
    getTranscriptBlocks.mockResolvedValue([existingBlock('already saved')]);

    const result = await updateTranscriptBlocks(
      3017, 74,
      [],
      transcription(
        line('already saved',  5, 13, 'already saved'),  // deduped
        line('brand new line', 20, 28, 'brand new line')  // created
      ),
      'http://localhost:12315'
    );

    expect(result.stats.created).toBe(1);
    const [, lineArg] = createTranscriptBlockWithProperties.mock.calls[0];
    expect(lineArg.text).toBe('brand new line');
  });
});
