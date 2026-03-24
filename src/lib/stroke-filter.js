/**
 * Stroke Preprocessing Filter
 * Removes decorative elements (underlines, single-stroke boxes, circles) before
 * MyScript transcription.
 *
 * This filter prevents decorative strokes from being misinterpreted as emojis by
 * MyScript's Text recognizer.  Only filters decorative elements that contain text
 * inside them (boxes, circles) or are clearly not text (underlines).
 *
 * All three detectors operate on INDIVIDUAL strokes only — no multi-stroke grouping.
 *
 * Detection types:
 *   1. Underlines  — long, straight, horizontal single strokes
 *   2. Single-stroke boxes — closed rectangular strokes with text inside
 *   3. Circles/ovals — closed curved strokes with text inside
 */

// ============================================================================
// TUNABLE PARAMETERS
// ============================================================================

// Single-stroke Box Detection
const BOX_MIN_DOTS = 20;              // minimum dots to attempt rectangle analysis
const BOX_MIN_SIZE = 5.0;             // mm - minimum box dimension
const BOX_MAX_SIZE = 50.0;            // mm - maximum box dimension
const BOX_ASPECT_MIN = 0.3;           // minimum width/height ratio (not too tall)
const BOX_ASPECT_MAX = 3.0;           // maximum width/height ratio (not too wide)
const BOX_MAX_CLOSURE_MM = 5.0;       // mm - max start/end distance (closed stroke)
const BOX_NEAR_EDGE_MM = 1.5;         // mm - "near a side" tolerance for perimeter check
const BOX_MIN_PERIM_FRACTION = 0.85;  // fraction of dots that must lie near the perimeter
const BOX_PATH_RATIO_MIN = 0.80;      // pathLength / 2(w+h) lower bound (circles ~0.78)
const BOX_PATH_RATIO_MAX = 1.40;      // pathLength / 2(w+h) upper bound (filters spirals)
const BOX_MIN_CONTENT = 2;            // minimum strokes inside to be decorative

// Underline Detection
const UNDERLINE_MIN_ASPECT = 50;      // width/height ratio (very horizontal)
const UNDERLINE_MIN_STRAIGHTNESS = 0.90;  // bbox_diagonal / path_length
const UNDERLINE_MIN_WIDTH = 15.0;     // mm - substantial length

// Circle Detection
const CIRCLE_MIN_DOTS = 30;           // dots for smooth curve
const CIRCLE_MIN_SIZE = 4.0;          // mm - larger than letters
const CIRCLE_MAX_ENDPOINT_DIST = 2.0; // mm - closed loop
const CIRCLE_ASPECT_MIN = 0.3;        // minimum width/height ratio
const CIRCLE_ASPECT_MAX = 3.0;        // maximum width/height ratio (allows ovals)
const CIRCLE_MIN_CONTENT = 1;         // minimum strokes inside

// Containment Check
const CONTAINMENT_MARGIN = 0.5;       // mm - tolerance for edge strokes

// Ncode to MM conversion (from pen SDK)
const NCODE_TO_MM = 2.371;            // 1 Ncode unit × 2.371 = 1mm

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate bounding box for a stroke in millimeters
 * @param {Object} stroke - Stroke with dotArray
 * @returns {Object|null} Bounds {minX, maxX, minY, maxY, width, height} or null
 */
function getStrokeBounds(stroke) {
  if (!stroke.dotArray || stroke.dotArray.length === 0) {
    return null;
  }

  const xs = stroke.dotArray.map(d => d.x * NCODE_TO_MM);
  const ys = stroke.dotArray.map(d => d.y * NCODE_TO_MM);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Check if one bounding box is spatially contained within another
 * @param {Object} innerBounds - Inner bounding box (mm)
 * @param {Object} outerBounds - Outer bounding box (mm)
 * @param {number} margin - Tolerance in mm (default: 0.5mm)
 * @returns {boolean} True if inner is inside outer
 */
function isInside(innerBounds, outerBounds, margin = CONTAINMENT_MARGIN) {
  return (
    innerBounds.minX >= outerBounds.minX - margin &&
    innerBounds.maxX <= outerBounds.maxX + margin &&
    innerBounds.minY >= outerBounds.minY - margin &&
    innerBounds.maxY <= outerBounds.maxY + margin
  );
}

/**
 * Calculate path length of a stroke in millimeters
 * @param {Object} stroke - Stroke with dotArray
 * @returns {number} Total path length in mm
 */
function getPathLength(stroke) {
  if (!stroke.dotArray || stroke.dotArray.length < 2) {
    return 0;
  }

  let length = 0;
  for (let i = 1; i < stroke.dotArray.length; i++) {
    const dx = (stroke.dotArray[i].x - stroke.dotArray[i - 1].x) * NCODE_TO_MM;
    const dy = (stroke.dotArray[i].y - stroke.dotArray[i - 1].y) * NCODE_TO_MM;
    length += Math.sqrt(dx * dx + dy * dy);
  }

  return length;
}

/**
 * Calculate straightness ratio (0-1, higher is straighter)
 * Computed as bbox_diagonal / path_length
 * @param {Object} bounds - Stroke bounding box (mm)
 * @param {number} pathLength - Stroke path length (mm)
 * @returns {number} Straightness ratio
 */
function getStraightness(bounds, pathLength) {
  if (pathLength === 0) return 0;

  const bboxDiagonal = Math.sqrt(
    bounds.width * bounds.width +
    bounds.height * bounds.height
  );

  return bboxDiagonal / pathLength;
}

/**
 * Count how many other strokes have their bounding box inside the given bounds
 * @param {Array} strokes - All strokes
 * @param {number} selfIndex - Index of the enclosing stroke (excluded from count)
 * @param {Object} bounds - Enclosing bounds in mm
 * @returns {number} Number of contained strokes
 */
function countContainedStrokes(strokes, selfIndex, bounds) {
  let count = 0;
  for (let j = 0; j < strokes.length; j++) {
    if (j === selfIndex) continue;
    const otherBounds = getStrokeBounds(strokes[j]);
    if (otherBounds && isInside(otherBounds, bounds)) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

/**
 * Detect standalone underlines
 * Criteria: single stroke that is very horizontal (aspect > 50), very straight
 * (straightness > 0.90), and at least 15mm wide.
 *
 * @param {Array} strokes - Array of stroke objects
 * @returns {number[]} Indices of underline strokes
 */
function detectUnderlines(strokes) {
  const underlineIndices = [];

  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (!stroke.dotArray || stroke.dotArray.length < 10) continue;

    const bounds = getStrokeBounds(stroke);
    if (!bounds || bounds.height < 0.01) continue;

    const aspectRatio = bounds.width / bounds.height;
    const pathLength = getPathLength(stroke);
    const straightness = getStraightness(bounds, pathLength);

    if (
      aspectRatio > UNDERLINE_MIN_ASPECT &&
      straightness > UNDERLINE_MIN_STRAIGHTNESS &&
      bounds.width > UNDERLINE_MIN_WIDTH
    ) {
      underlineIndices.push(i);
    }
  }

  return underlineIndices;
}

/**
 * Check if a stroke traces a rectangular perimeter.
 * Two geometric tests must both pass:
 *   1. Perimeter fraction — ≥ BOX_MIN_PERIM_FRACTION of dots must lie within
 *      BOX_NEAR_EDGE_MM of one of the four bounding-box edges.
 *   2. Path ratio — total path length / 2(w+h) must be in
 *      [BOX_PATH_RATIO_MIN, BOX_PATH_RATIO_MAX].
 *      A perfect rectangle scores 1.0; circles score ~0.785 (too low).
 *
 * @param {Object} stroke - Stroke with dotArray
 * @param {Object} bounds - Bounding box in mm (from getStrokeBounds)
 * @returns {boolean}
 */
function isRectangularStroke(stroke, bounds) {
  const nearNcode = BOX_NEAR_EDGE_MM / NCODE_TO_MM;
  const minX = bounds.minX / NCODE_TO_MM;
  const maxX = bounds.maxX / NCODE_TO_MM;
  const minY = bounds.minY / NCODE_TO_MM;
  const maxY = bounds.maxY / NCODE_TO_MM;

  let perimDots = 0;
  for (const dot of stroke.dotArray) {
    if (
      dot.x <= minX + nearNcode || dot.x >= maxX - nearNcode ||
      dot.y <= minY + nearNcode || dot.y >= maxY - nearNcode
    ) {
      perimDots++;
    }
  }

  const perimFraction = perimDots / stroke.dotArray.length;
  const pathMm = getPathLength(stroke);
  const rectPerimMm = 2 * (bounds.width + bounds.height);
  const pathRatio = pathMm / rectPerimMm;

  return (
    perimFraction >= BOX_MIN_PERIM_FRACTION &&
    pathRatio >= BOX_PATH_RATIO_MIN &&
    pathRatio <= BOX_PATH_RATIO_MAX
  );
}

/**
 * Detect single-stroke rectangular boxes with content inside.
 *
 * Criteria (all must pass):
 *   - ≥ BOX_MIN_DOTS dots
 *   - Bounds within BOX_MIN_SIZE..BOX_MAX_SIZE in both dimensions
 *   - Aspect ratio within BOX_ASPECT_MIN..BOX_ASPECT_MAX
 *   - Stroke is closed: start/end distance ≤ BOX_MAX_CLOSURE_MM
 *   - isRectangularStroke passes (perimeter fraction + path ratio)
 *   - At least BOX_MIN_CONTENT other strokes inside its bounds
 *
 * @param {Array} strokes - Array of stroke objects
 * @returns {number[]} Indices of single-stroke box strokes
 */
function detectSingleStrokeBoxes(strokes) {
  const boxIndices = [];

  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (!stroke.dotArray || stroke.dotArray.length < BOX_MIN_DOTS) continue;

    // Size check (mm)
    const bounds = getStrokeBounds(stroke);
    if (!bounds) continue;
    if (bounds.width < BOX_MIN_SIZE || bounds.width > BOX_MAX_SIZE) continue;
    if (bounds.height < BOX_MIN_SIZE || bounds.height > BOX_MAX_SIZE) continue;

    // Aspect ratio check
    const aspectRatio = bounds.width / bounds.height;
    if (aspectRatio < BOX_ASPECT_MIN || aspectRatio > BOX_ASPECT_MAX) continue;

    // Closure check (mm)
    const first = stroke.dotArray[0];
    const last = stroke.dotArray[stroke.dotArray.length - 1];
    const cdx = (last.x - first.x) * NCODE_TO_MM;
    const cdy = (last.y - first.y) * NCODE_TO_MM;
    if (Math.sqrt(cdx * cdx + cdy * cdy) > BOX_MAX_CLOSURE_MM) continue;

    // Rectangular shape check (perimeter fraction + path ratio)
    if (!isRectangularStroke(stroke, bounds)) continue;

    // Content check: must contain enough other strokes
    if (countContainedStrokes(strokes, i, bounds) >= BOX_MIN_CONTENT) {
      boxIndices.push(i);
    }
  }

  return boxIndices;
}

/**
 * Detect circles/ovals with content inside
 * Criteria: single closed stroke, large enough not to be a letter, reasonable
 * aspect ratio (allows ovals), and at least CIRCLE_MIN_CONTENT strokes inside.
 *
 * @param {Array} strokes - Array of stroke objects
 * @returns {number[]} Indices of circle/oval strokes
 */
function detectCircles(strokes) {
  const circleIndices = [];

  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (!stroke.dotArray || stroke.dotArray.length < CIRCLE_MIN_DOTS) continue;

    const bounds = getStrokeBounds(stroke);
    if (!bounds) continue;

    // Must be large enough to not be a letter
    if (bounds.width <= CIRCLE_MIN_SIZE || bounds.height <= CIRCLE_MIN_SIZE) continue;

    // Must be closed
    const firstDot = stroke.dotArray[0];
    const lastDot = stroke.dotArray[stroke.dotArray.length - 1];
    const dx = (lastDot.x - firstDot.x) * NCODE_TO_MM;
    const dy = (lastDot.y - firstDot.y) * NCODE_TO_MM;
    if (Math.sqrt(dx * dx + dy * dy) > CIRCLE_MAX_ENDPOINT_DIST) continue;

    // Aspect ratio (allow ovals but not too elongated)
    const aspectRatio = bounds.width / bounds.height;
    if (aspectRatio < CIRCLE_ASPECT_MIN || aspectRatio > CIRCLE_ASPECT_MAX) continue;

    // Must contain content
    if (countContainedStrokes(strokes, i, bounds) >= CIRCLE_MIN_CONTENT) {
      circleIndices.push(i);
    }
  }

  return circleIndices;
}

// ============================================================================
// MAIN FILTERING FUNCTION
// ============================================================================

/**
 * Filter decorative strokes from a stroke array
 * Separates text strokes from decorative elements (underlines, boxes, circles).
 * All detection operates on individual strokes — no multi-stroke grouping.
 *
 * @param {Array} strokes - Array of stroke objects
 * @returns {Object} {textStrokes, decorativeStrokes, stats}
 */
export function filterDecorativeStrokes(strokes) {
  if (!strokes || strokes.length === 0) {
    return {
      textStrokes: [],
      decorativeStrokes: [],
      stats: {
        total: 0,
        text: 0,
        decorative: 0,
        boxes: 0,
        underlines: 0,
        circles: 0
      }
    };
  }

  const underlineIndices = detectUnderlines(strokes);
  const boxIndices = detectSingleStrokeBoxes(strokes);
  const circleIndices = detectCircles(strokes);

  const decorativeIndices = new Set([
    ...underlineIndices,
    ...boxIndices,
    ...circleIndices
  ]);

  const textStrokes = [];
  const decorativeStrokes = [];

  strokes.forEach((stroke, index) => {
    if (decorativeIndices.has(index)) {
      let type;
      if (underlineIndices.includes(index)) type = 'underline';
      else if (boxIndices.includes(index)) type = 'box';
      else type = 'circle';

      decorativeStrokes.push({ stroke, index, type });
    } else {
      textStrokes.push(stroke);
    }
  });

  return {
    textStrokes,
    decorativeStrokes,
    stats: {
      total: strokes.length,
      text: textStrokes.length,
      decorative: decorativeStrokes.length,
      boxes: boxIndices.length,
      underlines: underlineIndices.length,
      circles: circleIndices.length
    }
  };
}

/**
 * Detect decorative strokes and return their indices
 * Useful for user-controlled deselection rather than automatic filtering.
 * All detection operates on individual strokes — no multi-stroke grouping.
 *
 * @param {Array} strokes - Array of stroke objects
 * @returns {Object} {indices: number[], stats: {boxes, underlines, circles}}
 */
export function detectDecorativeIndices(strokes) {
  if (!strokes || strokes.length === 0) {
    return {
      indices: [],
      stats: { boxes: 0, underlines: 0, circles: 0 }
    };
  }

  const underlineIndices = detectUnderlines(strokes);
  const boxIndices = detectSingleStrokeBoxes(strokes);
  const circleIndices = detectCircles(strokes);

  return {
    indices: [...underlineIndices, ...boxIndices, ...circleIndices],
    stats: {
      boxes: boxIndices.length,
      underlines: underlineIndices.length,
      circles: circleIndices.length
    }
  };
}

/**
 * Export configuration constants for external access/tuning
 */
export const config = {
  BOX_MIN_DOTS,
  BOX_MIN_SIZE,
  BOX_MAX_SIZE,
  BOX_ASPECT_MIN,
  BOX_ASPECT_MAX,
  BOX_MAX_CLOSURE_MM,
  BOX_NEAR_EDGE_MM,
  BOX_MIN_PERIM_FRACTION,
  BOX_PATH_RATIO_MIN,
  BOX_PATH_RATIO_MAX,
  BOX_MIN_CONTENT,
  UNDERLINE_MIN_ASPECT,
  UNDERLINE_MIN_STRAIGHTNESS,
  UNDERLINE_MIN_WIDTH,
  CIRCLE_MIN_DOTS,
  CIRCLE_MIN_SIZE,
  CIRCLE_MAX_ENDPOINT_DIST,
  CIRCLE_ASPECT_MIN,
  CIRCLE_ASPECT_MAX,
  CIRCLE_MIN_CONTENT,
  CONTAINMENT_MARGIN,
  NCODE_TO_MM
};
