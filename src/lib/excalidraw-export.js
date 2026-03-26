/**
 * Excalidraw Export - Convert pen strokes to Excalidraw freedraw elements.
 * Enables copying strokes to clipboard in Excalidraw-compatible format.
 */

const NCODE_TO_EXCALIDRAW_SCALE = 2.371;

/** Generate a random alphanumeric ID (Excalidraw style) */
function generateId(length = 21) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Convert a single pen stroke (with dotArray) to an Excalidraw freedraw element.
 * @param {Object} stroke - Stroke with dotArray: [{x, y, f, timestamp}]
 * @param {number} scale - Coordinate scale factor
 * @returns {Object} Excalidraw freedraw element
 */
function strokeToExcalidrawElement(stroke, scale = NCODE_TO_EXCALIDRAW_SCALE) {
  const dots = stroke.dotArray || [];
  if (dots.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const dot of dots) {
    if (dot.x < minX) minX = dot.x;
    if (dot.y < minY) minY = dot.y;
    if (dot.x > maxX) maxX = dot.x;
    if (dot.y > maxY) maxY = dot.y;
  }

  return {
    type: 'freedraw',
    id: generateId(),
    x: minX * scale,
    y: minY * scale,
    width: (maxX - minX) * scale,
    height: (maxY - minY) * scale,
    points: dots.map(dot => [
      (dot.x - minX) * scale,
      (dot.y - minY) * scale
    ]),
    pressures: dots.map(dot => Math.min(1, Math.max(0, (dot.f || 0.5) / 1.0))),
    simulatePressure: false,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    angle: 0,
    version: 2,
    versionNonce: Math.floor(Math.random() * 2147483647),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    seed: Math.floor(Math.random() * 2147483647),
    roundness: null,
    updated: Date.now(),
    locked: false
  };
}

/**
 * Convert multiple strokes to Excalidraw elements, normalized near origin.
 * @param {Array} strokes - Array of pen strokes with dotArray
 * @returns {Array} Array of Excalidraw freedraw elements
 */
export function strokesToExcalidrawElements(strokes) {
  if (!strokes || strokes.length === 0) return [];

  // Find global min to normalize
  let globalMinX = Infinity, globalMinY = Infinity;
  for (const stroke of strokes) {
    for (const dot of (stroke.dotArray || [])) {
      if (dot.x < globalMinX) globalMinX = dot.x;
      if (dot.y < globalMinY) globalMinY = dot.y;
    }
  }

  const elements = [];
  for (const stroke of strokes) {
    const el = strokeToExcalidrawElement(stroke);
    if (el) {
      // Offset to start near (100, 100) in Excalidraw space
      el.x = el.x - globalMinX * NCODE_TO_EXCALIDRAW_SCALE + 100;
      el.y = el.y - globalMinY * NCODE_TO_EXCALIDRAW_SCALE + 100;
      elements.push(el);
    }
  }
  return elements;
}

/**
 * Copy strokes to clipboard as Excalidraw clipboard JSON.
 * Can be pasted directly into any Excalidraw canvas.
 * @param {Array} strokes - Array of pen strokes with dotArray
 * @returns {Promise<void>}
 */
export async function copyStrokesAsExcalidraw(strokes) {
  const elements = strokesToExcalidrawElements(strokes);
  const clipboardData = {
    type: 'excalidraw/clipboard',
    elements,
    files: {}
  };
  await navigator.clipboard.writeText(JSON.stringify(clipboardData));
}

/**
 * Generate the {{renderer :smartpen-sketch}} macro string for selected strokes.
 * @param {string} pageName - LogSeq page name (e.g., "smartpen/B3017/P42")
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds - Ncode bounding box
 * @returns {string} The renderer macro string
 */
export function generateSketchMacro(pageName, bounds) {
  return `{{renderer :smartpen-sketch, ${pageName}, ${bounds.minX.toFixed(2)}, ${bounds.minY.toFixed(2)}, ${bounds.maxX.toFixed(2)}, ${bounds.maxY.toFixed(2)}}}`;
}
