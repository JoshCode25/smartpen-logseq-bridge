/**
 * Tests for stroke-filter.js — decorative stroke detection (single-stroke only).
 *
 * The algorithm detects three types of decorative strokes, all as INDIVIDUAL strokes:
 *   1. Underlines  — long, straight, horizontal strokes
 *   2. Single-stroke boxes — closed rectangular strokes with content inside
 *   3. Circles/ovals — closed curved strokes with content inside
 *
 * Multi-stroke grouping (the old 2-stroke H+V box) has been removed.
 * Vertical-line detection has been removed.
 *
 * All geometry is expressed in Ncode units (1 unit = 2.371 mm).
 * Helpers convert from mm → Ncode for readability.
 *
 * Coverage:
 *   - filterDecorativeStrokes: empty input, stats shape, text passthrough
 *   - Underline detection: thresholds, short/vertical rejections
 *   - Single-stroke box detection: rectangle geometry + content requirement
 *   - Circle detection: closed, large enough, contains content
 *   - detectDecorativeIndices: index correctness, agreement with filterDecorativeStrokes
 *   - Removal of vertical-line and multi-stroke group detection
 */

import { describe, it, expect } from 'vitest';
import { filterDecorativeStrokes, detectDecorativeIndices, config } from '../stroke-filter.js';

const { NCODE_TO_MM } = config;

// ---------------------------------------------------------------------------
// Coordinate helpers — all measurements in mm → Ncode
// ---------------------------------------------------------------------------

const mmToNcode = mm => mm / NCODE_TO_MM;

/**
 * Build a horizontal stroke of given width (mm).
 * A tiny y-wobble (0.1 mm) ensures bounds.height > 0 so the aspect-ratio
 * check can proceed — real handwriting is never perfectly flat.
 */
function makeHorizontalStroke(startXmm, yMm, widthMm, dotCount = 20, startTime = 1000) {
  const startX = mmToNcode(startXmm);
  const baseY  = mmToNcode(yMm);
  const wobble = mmToNcode(0.1);
  const endX   = mmToNcode(startXmm + widthMm);
  const dots   = Array.from({ length: dotCount }, (_, i) => ({
    x: startX + (endX - startX) * (i / (dotCount - 1)),
    y: baseY + (i % 2 === 0 ? wobble : -wobble),
    f: 512,
    timestamp: startTime + i
  }));
  return { pageInfo: {}, startTime, endTime: startTime + dotCount, dotArray: dots };
}

/** Build a closed approximately-circular stroke (polygon approximation). */
function makeCircleStroke(centreMm, diameterMm, dotCount = 60, startTime = 5000) {
  const [cx, cy] = centreMm.map(mmToNcode);
  const r = mmToNcode(diameterMm / 2);
  const dots = Array.from({ length: dotCount + 1 }, (_, i) => {
    const angle = (2 * Math.PI * i) / dotCount;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), f: 512, timestamp: startTime + i };
  });
  return { pageInfo: {}, startTime, endTime: startTime + dotCount, dotArray: dots };
}

/**
 * Build a closed single-stroke rectangle starting and ending at the MIDPOINT
 * of the top edge.  Drawing order: midTop → TR → BR → BL → TL → midTop.
 *
 * All 4 corners (TR, BR, BL, TL) land near 1/5, 2/5, 3/5, 4/5 of the stroke,
 * well inside StrokeAnalyzer's sliding corner-detection window (which cannot
 * see changes within `windowSize` dots of either end).
 * wMm × hMm box, top-left at (x0Mm, y0Mm).
 */
function makeRectStroke(x0Mm, y0Mm, wMm, hMm, dotsPerSide = 15, startTime = 8000) {
  const x0  = mmToNcode(x0Mm);
  const y0  = mmToNcode(y0Mm);
  const x1  = mmToNcode(x0Mm + wMm);
  const y1  = mmToNcode(y0Mm + hMm);
  const xMid = (x0 + x1) / 2;

  let ts = startTime;
  function seg(ax, ay, bx, by) {
    return Array.from({ length: dotsPerSide }, (_, i) => ({
      x: ax + (bx - ax) * (i / (dotsPerSide - 1)),
      y: ay + (by - ay) * (i / (dotsPerSide - 1)),
      f: 512,
      timestamp: ts++
    }));
  }

  // Start mid-top so all 4 corners sit well within the stroke body
  const dots = [
    ...seg(xMid, y0, x1,  y0),   // right half of top  (midTop → TR)
    ...seg(x1,   y0, x1,  y1),   // right edge          (TR → BR)
    ...seg(x1,   y1, x0,  y1),   // bottom edge         (BR → BL)
    ...seg(x0,   y1, x0,  y0),   // left edge           (BL → TL)
    ...seg(x0,   y0, xMid, y0),  // left half of top    (TL → midTop)
    { x: xMid, y: y0, f: 512, timestamp: ts }  // close
  ];

  return { pageInfo: {}, startTime, endTime: startTime + dots.length, dotArray: dots };
}

/** Small text-like stroke at a given position (mm). */
function makeTextStroke(cxMm, cyMm, startTime = 3000) {
  const cx = mmToNcode(cxMm);
  const cy = mmToNcode(cyMm);
  const dots = [
    { x: cx,       y: cy,       f: 512, timestamp: startTime },
    { x: cx + 0.5, y: cy + 0.5, f: 512, timestamp: startTime + 1 },
    { x: cx + 1,   y: cy,       f: 512, timestamp: startTime + 2 }
  ];
  return { pageInfo: {}, startTime, endTime: startTime + 3, dotArray: dots };
}

// ---------------------------------------------------------------------------
// filterDecorativeStrokes — empty / passthrough
// ---------------------------------------------------------------------------

describe('filterDecorativeStrokes — empty / passthrough', () => {
  it('returns empty arrays and zero stats for null input', () => {
    const result = filterDecorativeStrokes(null);
    expect(result.textStrokes).toHaveLength(0);
    expect(result.decorativeStrokes).toHaveLength(0);
    expect(result.stats.total).toBe(0);
  });

  it('returns empty arrays and zero stats for empty array', () => {
    const result = filterDecorativeStrokes([]);
    expect(result.stats.boxes).toBe(0);
    expect(result.stats.underlines).toBe(0);
    expect(result.stats.circles).toBe(0);
  });

  it('passes through plain text strokes unchanged', () => {
    const strokes = [makeTextStroke(10, 20), makeTextStroke(15, 25), makeTextStroke(20, 30)];
    const result = filterDecorativeStrokes(strokes);
    expect(result.textStrokes).toHaveLength(3);
    expect(result.decorativeStrokes).toHaveLength(0);
    expect(result.stats.total).toBe(3);
    expect(result.stats.text).toBe(3);
    expect(result.stats.decorative).toBe(0);
  });

  it('result always has the expected stats shape', () => {
    const result = filterDecorativeStrokes([makeTextStroke(10, 10)]);
    expect(result.stats).toMatchObject({
      total: expect.any(Number),
      text: expect.any(Number),
      decorative: expect.any(Number),
      boxes: expect.any(Number),
      underlines: expect.any(Number),
      circles: expect.any(Number)
    });
  });
});

// ---------------------------------------------------------------------------
// Underline detection
// ---------------------------------------------------------------------------

describe('filterDecorativeStrokes — underline detection', () => {
  it('detects a long, straight, horizontal stroke as an underline', () => {
    const underline = makeHorizontalStroke(10, 50, 40, 30, 1000);
    const text1     = makeTextStroke(20, 48, 4000);
    const text2     = makeTextStroke(25, 48, 5000);

    const result = filterDecorativeStrokes([underline, text1, text2]);

    expect(result.stats.underlines).toBe(1);
    expect(result.decorativeStrokes).toHaveLength(1);
    expect(result.decorativeStrokes[0].type).toBe('underline');
  });

  it('does NOT flag a short horizontal stroke as an underline (below min width)', () => {
    // 5mm — below UNDERLINE_MIN_WIDTH=15mm
    const shortH = makeHorizontalStroke(10, 50, 5, 15, 1000);
    expect(filterDecorativeStrokes([shortH]).stats.underlines).toBe(0);
  });

  it('does NOT flag a vertical stroke as an underline', () => {
    // Vertical stroke: width ≈ 0, height >> 0 → aspect ratio ≈ 0 < 50
    const x = mmToNcode(10);
    const dots = Array.from({ length: 20 }, (_, i) => ({
      x, y: mmToNcode(10 + i * 1.5), f: 512, timestamp: 1000 + i
    }));
    const vertical = { pageInfo: {}, startTime: 1000, endTime: 1020, dotArray: dots };
    expect(filterDecorativeStrokes([vertical]).stats.underlines).toBe(0);
  });

  it('does NOT flag a stroke with too few dots', () => {
    // 5 dots — below the minimum of 10
    const sparse = makeHorizontalStroke(10, 50, 40, 5, 1000);
    expect(filterDecorativeStrokes([sparse]).stats.underlines).toBe(0);
  });

  it('excludes the underline from textStrokes', () => {
    const underline  = makeHorizontalStroke(10, 50, 40, 30, 1000);
    const textStroke = makeTextStroke(20, 48, 4000);
    const result = filterDecorativeStrokes([underline, textStroke]);
    expect(result.textStrokes).toHaveLength(1);
    expect(result.textStrokes[0]).toBe(textStroke);
  });
});

// ---------------------------------------------------------------------------
// Single-stroke box detection
// ---------------------------------------------------------------------------

describe('filterDecorativeStrokes — single-stroke box detection', () => {
  it('detects a closed rectangular stroke with content inside as a box', () => {
    // 20mm × 15mm box; content strokes placed near the centre
    const box  = makeRectStroke(10, 10, 20, 15, 15, 8000);
    const txt1 = makeTextStroke(18, 17, 20000);
    const txt2 = makeTextStroke(22, 17, 21000);

    const result = filterDecorativeStrokes([box, txt1, txt2]);

    expect(result.stats.boxes).toBe(1);
    expect(result.decorativeStrokes).toHaveLength(1);
    expect(result.decorativeStrokes[0].type).toBe('box');
  });

  it('does NOT detect a rectangular stroke with no content inside', () => {
    const box = makeRectStroke(10, 10, 20, 15, 15, 8000);
    // No strokes inside
    expect(filterDecorativeStrokes([box]).stats.boxes).toBe(0);
    // The box stroke itself should be passed through as text
    expect(filterDecorativeStrokes([box]).textStrokes).toHaveLength(1);
  });

  it('does NOT detect a rectangular stroke with only 1 content stroke (requires ≥2)', () => {
    const box  = makeRectStroke(10, 10, 20, 15, 15, 8000);
    const txt1 = makeTextStroke(18, 17, 20000);
    expect(filterDecorativeStrokes([box, txt1]).stats.boxes).toBe(0);
  });

  it('does NOT detect a box that is too small', () => {
    // 3mm × 3mm — below BOX_MIN_SIZE=5mm
    const tinyBox = makeRectStroke(10, 10, 3, 3, 15, 8000);
    const txt1 = makeTextStroke(11, 11, 20000);
    const txt2 = makeTextStroke(12, 12, 21000);
    expect(filterDecorativeStrokes([tinyBox, txt1, txt2]).stats.boxes).toBe(0);
  });

  it('excludes the box stroke from textStrokes', () => {
    const box  = makeRectStroke(10, 10, 20, 15, 15, 8000);
    const txt1 = makeTextStroke(18, 17, 20000);
    const txt2 = makeTextStroke(22, 17, 21000);
    const result = filterDecorativeStrokes([box, txt1, txt2]);
    expect(result.textStrokes).toHaveLength(2);
    expect(result.textStrokes).toContain(txt1);
    expect(result.textStrokes).toContain(txt2);
  });

  it('does NOT treat a 2-stroke H+V pair as a box (multi-stroke grouping removed)', () => {
    // Old algorithm would have combined these; new algorithm must NOT
    const hStroke = makeHorizontalStroke(10, 10, 20, 20, 1000);
    const vDots   = Array.from({ length: 20 }, (_, i) => ({
      x: mmToNcode(10), y: mmToNcode(10 + i * 1), f: 512, timestamp: 1500 + i
    }));
    const vStroke = { pageInfo: {}, startTime: 1500, endTime: 1520, dotArray: vDots };
    const txt1 = makeTextStroke(15, 15, 5000);
    const txt2 = makeTextStroke(16, 16, 6000);

    const result = filterDecorativeStrokes([hStroke, vStroke, txt1, txt2]);
    // Neither the horizontal nor the vertical stroke is a closed rectangle on its own
    expect(result.stats.boxes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Circle detection
// ---------------------------------------------------------------------------

describe('filterDecorativeStrokes — circle detection', () => {
  it('detects a closed circle that contains content strokes', () => {
    const circle = makeCircleStroke([50, 50], 20, 60, 10000);
    const inside1 = makeTextStroke(48, 49, 20000);
    const inside2 = makeTextStroke(51, 51, 21000);

    const result = filterDecorativeStrokes([circle, inside1, inside2]);
    expect(result.stats.circles).toBe(1);
    expect(result.decorativeStrokes[0].type).toBe('circle');
  });

  it('does NOT detect a circle with no content inside', () => {
    const circle = makeCircleStroke([50, 50], 20, 60, 10000);
    const result = filterDecorativeStrokes([circle]);
    expect(result.stats.circles).toBe(0);
    expect(result.textStrokes).toHaveLength(1);
  });

  it('does NOT detect a very small circle (below CIRCLE_MIN_SIZE)', () => {
    // 2mm — below CIRCLE_MIN_SIZE=4mm
    const tiny   = makeCircleStroke([50, 50], 2, 60, 10000);
    const inside = makeTextStroke(50, 50, 20000);
    expect(filterDecorativeStrokes([tiny, inside]).stats.circles).toBe(0);
  });

  it('does NOT detect an open curve as a circle', () => {
    const cx = mmToNcode(50), cy = mmToNcode(50), r = mmToNcode(10);
    // 270° arc — not closed
    const dots = Array.from({ length: 60 }, (_, i) => {
      const angle = (1.5 * Math.PI * i) / 59;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), f: 512, timestamp: 10000 + i };
    });
    const openCurve = { pageInfo: {}, startTime: 10000, endTime: 10060, dotArray: dots };
    const inside = makeTextStroke(50, 50, 20000);
    expect(filterDecorativeStrokes([openCurve, inside]).stats.circles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectDecorativeIndices
// ---------------------------------------------------------------------------

describe('detectDecorativeIndices', () => {
  it('returns empty indices and zero stats for null/empty input', () => {
    expect(detectDecorativeIndices(null)).toEqual({
      indices: [],
      stats: { boxes: 0, underlines: 0, circles: 0 }
    });
    expect(detectDecorativeIndices([])).toEqual({
      indices: [],
      stats: { boxes: 0, underlines: 0, circles: 0 }
    });
  });

  it('identifies the correct index for a detected underline', () => {
    const text     = makeTextStroke(20, 20, 4000);
    const underline = makeHorizontalStroke(10, 50, 40, 30, 1000);

    const result = detectDecorativeIndices([text, underline]);
    // underline is at index 1
    expect(result.indices).toContain(1);
    expect(result.stats.underlines).toBe(1);
  });

  it('stats object always has boxes, underlines, and circles', () => {
    const result = detectDecorativeIndices([makeTextStroke(10, 10)]);
    expect(result.stats).toMatchObject({
      boxes:      expect.any(Number),
      underlines: expect.any(Number),
      circles:    expect.any(Number)
    });
  });

  it('agrees with filterDecorativeStrokes on which indices are decorative', () => {
    const underline = makeHorizontalStroke(10, 50, 40, 30, 1000);
    const text1     = makeTextStroke(20, 20, 4000);

    const filterResult = filterDecorativeStrokes([underline, text1]);
    const indexResult  = detectDecorativeIndices([underline, text1]);

    const decorativeFromFilter = filterResult.decorativeStrokes.map(d => d.index);
    decorativeFromFilter.forEach(idx => expect(indexResult.indices).toContain(idx));
  });

  it('returns no indices when all strokes are plain text', () => {
    const strokes = [makeTextStroke(10, 20), makeTextStroke(15, 25)];
    expect(detectDecorativeIndices(strokes).indices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: vertical line is NOT flagged
// ---------------------------------------------------------------------------

describe('regression — vertical lines are not flagged', () => {
  it('a tall, narrow vertical stroke is not classified as decorative', () => {
    const x = mmToNcode(10);
    const dots = Array.from({ length: 20 }, (_, i) => ({
      x, y: mmToNcode(10 + i * 2), f: 512, timestamp: 1000 + i
    }));
    const vertical = { pageInfo: {}, startTime: 1000, endTime: 1020, dotArray: dots };
    const result = filterDecorativeStrokes([vertical]);
    expect(result.decorativeStrokes).toHaveLength(0);
    expect(result.textStrokes).toHaveLength(1);
  });
});
