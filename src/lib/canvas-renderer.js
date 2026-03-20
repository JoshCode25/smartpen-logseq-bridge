/**
 * Canvas Renderer (Svelte-adapted)
 * Handles drawing strokes to canvas and exporting SVG
 * Zoom and pan are managed externally by Svelte stores
 */

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = []; // Array of stroke paths for SVG export
    this.currentStroke = null;
    this.scale = 2.371; // Ncode to mm conversion
    
    // Per-page scale factors (non-destructive display scaling)
    this.pageScales = {}; // Map of pageKey -> scale factor
    this.tempPageScales = {}; // Temporary scales during drag preview
    
    // Zoom and pan state
    this.zoom = 1;
    this.minZoom = 0.25;
    this.maxZoom = 10;
    this.panX = 0;
    this.panY = 0;
    
    // Bounds tracking for SVG export
    this.bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    
    // Page-based layout
    this.pageOffsets = new Map(); // Map of "B{book}/P{page}" -> {offsetX, offsetY, bounds}
    this.pageSpacing = 20; // mm between pages (horizontal and vertical)
    this.pageColumns = 5; // pages per row before wrapping
    
    this.viewWidth = 0;
    this.viewHeight = 0;
    
    // Page visualization settings
    this.showPageBackgrounds = true; // Toggle for page borders
    // Corner handle visualization
    this.showCornerHandles = true; // Toggle for corner resize handles
    this.cornerHandles = new Map(); // Map of pageKey -> array of handle objects
    this.handleSize = 8; // Size of corner handles in pixels
    
    this.pageColors = [ // Colors for different books (10 distinct colors)
      'rgba(233, 69, 96, 0.8)',   // Red
      'rgba(75, 192, 192, 0.8)',  // Teal
      'rgba(255, 205, 86, 0.8)',  // Yellow
      'rgba(153, 102, 255, 0.8)', // Purple
      'rgba(255, 159, 64, 0.8)',  // Orange
      'rgba(54, 162, 235, 0.8)',  // Blue
      'rgba(255, 99, 132, 0.8)',  // Pink
      'rgba(76, 175, 80, 0.8)',   // Green
      'rgba(121, 85, 72, 0.8)',   // Brown
      'rgba(158, 158, 158, 0.8)', // Gray
    ];
    this.visiblePageKeys = null; // Set of visible page keys (for filtering borders)
    
    this.resize();
    this.clear();
  }
  
  /**
   * Set zoom level, optionally centered on a specific point
   * @param {number} level - Zoom level
   * @param {Object} centerPoint - Optional {x, y} in screen coordinates to zoom toward
   * @returns {boolean} - Whether zoom changed
   */
  setZoom(level, centerPoint = null) {
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, level));
    if (newZoom !== this.zoom) {
      const zoomRatio = newZoom / this.zoom;
      
      // If no center point provided, zoom toward viewport center
      const centerX = centerPoint ? centerPoint.x : this.viewWidth / 2;
      const centerY = centerPoint ? centerPoint.y : this.viewHeight / 2;
      
      // Adjust pan to keep the center point fixed in world space
      // The point under the cursor should stay at the same screen position
      this.panX = centerX - (centerX - this.panX) * zoomRatio;
      this.panY = centerY - (centerY - this.panY) * zoomRatio;
      
      this.zoom = newZoom;
      return true;
    }
    return false;
  }
  
  /**
   * Zoom in by a fixed factor
   */
  zoomIn() {
    this.setZoom(this.zoom * 1.25);
  }
  
  /**
   * Zoom out by a fixed factor
   */
  zoomOut() {
    this.setZoom(this.zoom / 1.25);
  }
  
  /**
   * Reset zoom and pan to defaults
   * Note: Does not redraw - caller should trigger re-render
   */
  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    // Don't call redraw - let the component handle it
  }
  
  /**
   * Pan the view by delta amounts
   * Note: Does not redraw - caller should trigger re-render
   * @param {number} deltaX - Horizontal pan amount
   * @param {number} deltaY - Vertical pan amount
   */
  pan(deltaX, deltaY) {
    this.panX += deltaX;
    this.panY += deltaY;
    // Don't call redraw - let the component handle it
  }
  
  /**
   * Get current pan position
   */
  getPan() {
    return { x: this.panX, y: this.panY };
  }
  
  /**
   * Fit all content in view and center on strokes
   * Note: Does not redraw - caller should trigger re-render
   * @returns {number|undefined} - New zoom level if changed
   */
  fitToContent() {
    if (this.bounds.minX === Infinity) {
      this.resetView();
      return;
    }
    
    const contentWidth = (this.bounds.maxX - this.bounds.minX) * this.scale;
    const contentHeight = (this.bounds.maxY - this.bounds.minY) * this.scale;
    
    const padding = 40;
    const availWidth = this.viewWidth - padding * 2;
    const availHeight = this.viewHeight - padding * 2;
    
    if (contentWidth <= 0 || contentHeight <= 0) {
      this.resetView();
      return;
    }
    
    const scaleX = availWidth / contentWidth;
    const scaleY = availHeight / contentHeight;
    this.zoom = Math.min(scaleX, scaleY, this.maxZoom);
    
    // Center the content in the viewport
    // The content's top-left in screen space would be at (0,0) after ncodeToScreen subtracts bounds.min
    // We need to offset so content is centered
    const scaledContentWidth = contentWidth * this.zoom;
    const scaledContentHeight = contentHeight * this.zoom;
    
    this.panX = (this.viewWidth - scaledContentWidth) / 2;
    this.panY = (this.viewHeight - scaledContentHeight) / 2;
    
    // Don't call redraw - let the component handle it
    
    return this.zoom;
  }
  
  /**
   * Set a comfortable view for live writing: 3× zoom with the top of the current
   * writing area positioned near the top of the viewport (with padding).
   * Call this when the first live stroke arrives and then keep the view stable.
   * Does NOT redraw — the caller should trigger a re-render.
   * @returns {number} New zoom level
   */
  setLiveWritingView() {
    const LIVE_ZOOM = 3;
    const TOP_PADDING = 50; // px from top of canvas to top of writing content
    const LEFT_PADDING = 20; // px from left edge to left of writing content

    this.zoom = LIVE_ZOOM;

    // If we have real bounds, position so the content's top-left is in view.
    // ncodeToScreen: screenX = (dot.x - bounds.minX) * scale * zoom + panX
    // We want the top of the content at y = TOP_PADDING, so:
    //   panY = TOP_PADDING  (since minY maps to y=0 in world space after ncodeToScreen)
    // Similarly for X:
    //   panX = LEFT_PADDING
    this.panX = LEFT_PADDING;
    this.panY = TOP_PADDING;

    return this.zoom;
  }

  /**
   * Resize canvas to fit container
   */
  resize() {
    const container = this.canvas.parentElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    
    // Use device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    
    this.ctx.scale(dpr, dpr);
    
    this.viewWidth = rect.width;
    this.viewHeight = rect.height;
    
    this.redraw();
  }
  
  /**
   * Clear canvas and optionally reset state
   * @param {boolean} resetBounds - Whether to reset bounds tracking (default: true)
   */
  clear(resetBounds = true) {
    this.ctx.fillStyle = 'white';
    this.ctx.fillRect(0, 0, this.viewWidth || this.canvas.width, this.viewHeight || this.canvas.height);
    this.strokes = [];
    this.currentStroke = null;
    
    if (resetBounds) {
      this.bounds = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
      };
      // Do NOT reset zoom/pan here — view state is managed by the component
      // (fitToContent or setLiveWritingView). Resetting it here caused the
      // view to snap back to zoom=1 after every stroke completion.
    }
  }
  
  /**
   * Calculate bounds and page offsets from an array of strokes
   * Groups strokes by page and positions them horizontally
   * @param {Array} strokes - Array of stroke objects
   */
  calculateBounds(strokes) {
    // Reset
    this.bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    this.pageOffsets.clear();
    
    if (strokes.length === 0) return;
    
    // Group strokes by page (using full key to match pages store)
    const pageGroups = new Map();
    strokes.forEach(stroke => {
      const pageInfo = stroke.pageInfo;
      
      // Handle strokes without pageInfo or with incomplete pageInfo
      if (!pageInfo || pageInfo.book === undefined || pageInfo.page === undefined) {
        console.warn('Stroke missing valid pageInfo:', stroke);
        // Use a default page for strokes without pageInfo
        const fallbackKey = 'S0/O0/B0/P0';
        if (!pageGroups.has(fallbackKey)) {
          pageGroups.set(fallbackKey, []);
        }
        pageGroups.get(fallbackKey).push(stroke);
        return;
      }
      
      // Use full key format to match pages store: S{section}/O{owner}/B{book}/P{page}
      const pageKey = `S${pageInfo.section || 0}/O${pageInfo.owner || 0}/B${pageInfo.book}/P${pageInfo.page}`;
      if (!pageGroups.has(pageKey)) {
        pageGroups.set(pageKey, []);
      }
      pageGroups.get(pageKey).push(stroke);
    });
    
    // Calculate bounds for each page and assign horizontal offsets
    // Sort pages by book then page number for consistent left-to-right layout
    const sortedPageEntries = Array.from(pageGroups.entries()).sort((a, b) => {
      const keyA = a[0];
      const keyB = b[0];
      
      // Extract book and page numbers from keys (format: S#/O#/B#/P#)
      const matchA = keyA.match(/B(\d+)\/P(\d+)/);
      const matchB = keyB.match(/B(\d+)\/P(\d+)/);
      
      if (!matchA || !matchB) return 0;
      
      const bookA = parseInt(matchA[1]);
      const pageA = parseInt(matchA[2]);
      const bookB = parseInt(matchB[1]);
      const pageB = parseInt(matchB[2]);
      
      // Sort by book first, then by page
      if (bookA !== bookB) {
        return bookA - bookB;
      }
      return pageA - pageB;
    });
    
    // First pass: compute per-page bounds, width, and height
    const pageBoundsArray = sortedPageEntries.map(([pageKey, pageStrokes]) => {
      let pageMinX = Infinity, pageMinY = Infinity;
      let pageMaxX = -Infinity, pageMaxY = -Infinity;

      pageStrokes.forEach(stroke => {
        const dots = stroke.dotArray || stroke.dots || [];
        dots.forEach(dot => {
          pageMinX = Math.min(pageMinX, dot.x);
          pageMinY = Math.min(pageMinY, dot.y);
          pageMaxX = Math.max(pageMaxX, dot.x);
          pageMaxY = Math.max(pageMaxY, dot.y);
        });
      });

      return {
        pageKey,
        bounds: { minX: pageMinX, minY: pageMinY, maxX: pageMaxX, maxY: pageMaxY },
        width: pageMaxX - pageMinX,
        height: pageMaxY - pageMinY
      };
    });

    // Compute the max height for each row (needed to space rows apart)
    const columns = this.pageColumns;
    const rowCount = Math.ceil(pageBoundsArray.length / columns);
    const rowMaxHeights = new Array(rowCount).fill(0);
    pageBoundsArray.forEach((page, index) => {
      const row = Math.floor(index / columns);
      rowMaxHeights[row] = Math.max(rowMaxHeights[row], page.height);
    });

    // Compute cumulative Y start position for each row
    const rowStartY = new Array(rowCount).fill(0);
    for (let r = 1; r < rowCount; r++) {
      rowStartY[r] = rowStartY[r - 1] + rowMaxHeights[r - 1] + this.pageSpacing;
    }

    // Second pass: assign offsets and update global bounds
    // offsetX positions the page's left edge in world space (world_x = dot.x - bounds.minX + offsetX)
    // offsetY positions the page's top edge in world space (world_y = dot.y - bounds.minY + offsetY)
    let currentRowX = 0;
    pageBoundsArray.forEach((page, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);

      if (col === 0) currentRowX = 0;

      const offsetX = currentRowX;
      const offsetY = rowStartY[row];

      this.pageOffsets.set(page.pageKey, {
        offsetX,
        offsetY,
        bounds: page.bounds
      });

      this.bounds.minX = Math.min(this.bounds.minX, offsetX);
      this.bounds.minY = Math.min(this.bounds.minY, offsetY);
      this.bounds.maxX = Math.max(this.bounds.maxX, offsetX + page.width);
      this.bounds.maxY = Math.max(this.bounds.maxY, offsetY + page.height);

      currentRowX += page.width + this.pageSpacing;
    });

    // Normalise so the top-left of all content is at world (0, 0)
    this.bounds.minX = 0;
    this.bounds.minY = 0;
    
    console.log('Page offsets calculated:', Array.from(this.pageOffsets.keys()));
  }
  
  /**
   * Clear canvas without resetting zoom/pan/bounds (for redraws)
   */
  clearForRedraw() {
    this.ctx.fillStyle = 'white';
    this.ctx.fillRect(0, 0, this.viewWidth || this.canvas.width, this.viewHeight || this.canvas.height);
  }
  
  /**
   * Add a dot from the pen (real-time drawing)
   * @param {Object} dot - Dot object with x, y, f, dotType, pageInfo
   */
  addDot(dot) {
    // Update bounds (in Ncode coordinates)
    this.bounds.minX = Math.min(this.bounds.minX, dot.x);
    this.bounds.minY = Math.min(this.bounds.minY, dot.y);
    this.bounds.maxX = Math.max(this.bounds.maxX, dot.x);
    this.bounds.maxY = Math.max(this.bounds.maxY, dot.y);
    
    // Convert ncode coordinates to screen coordinates WITH pageInfo
    const screenDot = this.ncodeToScreen(dot, dot.pageInfo);
    
    switch (dot.dotType) {
      case 0: // Pen Down
        this.ctx.beginPath();
        this.ctx.moveTo(screenDot.x, screenDot.y);
        this.currentStroke = {
          dots: [{ x: dot.x, y: dot.y, f: dot.f }],
          color: '#000000',
          width: 2
        };
        break;
        
      case 1: // Pen Move
        if (this.currentStroke) {
          this.ctx.lineTo(screenDot.x, screenDot.y);
          this.ctx.strokeStyle = '#000000';
          this.ctx.lineWidth = Math.max(0.5, (dot.f / 500) * 2 * this.zoom);
          this.ctx.lineCap = 'round';
          this.ctx.lineJoin = 'round';
          this.ctx.stroke();
          
          this.ctx.beginPath();
          this.ctx.moveTo(screenDot.x, screenDot.y);
          
          this.currentStroke.dots.push({ x: dot.x, y: dot.y, f: dot.f });
        }
        break;
        
      case 2: // Pen Up
        if (this.currentStroke) {
          this.currentStroke.dots.push({ x: dot.x, y: dot.y, f: dot.f });
          this.strokes.push(this.currentStroke);
          this.currentStroke = null;
        }
        this.ctx.closePath();
        break;
        
      case 3: // Hover
        // Optionally show hover cursor
        break;
    }
  }
  
  /**
   * Convert ncode coordinates to screen coordinates with zoom, pan, page offset, and page scale
   * @param {Object} dot - Dot with x, y coordinates
   * @param {Object} pageInfo - Page information (section, owner, book, page) to determine offset
   */
  ncodeToScreen(dot, pageInfo = null) {
    let x, y;
    
    // Get page offset if available
    let offsetX = 0;
    let offsetY = 0;
    let pageBounds = null;
    let pageKey = null;
    
    if (pageInfo && this.pageOffsets.size > 0) {
      // Use full key format to match pages store
      pageKey = `S${pageInfo.section || 0}/O${pageInfo.owner || 0}/B${pageInfo.book}/P${pageInfo.page}`;
      const pageOffset = this.pageOffsets.get(pageKey);
      
      if (pageOffset) {
        offsetX = pageOffset.offsetX;
        offsetY = pageOffset.offsetY;
        pageBounds = pageOffset.bounds;
      }
    }
    
    // Get per-page scale factor (default: 1.0)
    const pageScale = pageKey ? this.getEffectiveScale(pageKey) : 1.0;
    
    // Use simple scaling if:
    // 1. No bounds calculated yet (first strokes), OR
    // 2. Page offset not found (real-time strokes on new page)
    if (this.bounds.minX === Infinity || (pageInfo && !pageBounds)) {
      x = dot.x * this.scale * pageScale;
      y = dot.y * this.scale * pageScale;
    } else {
      // Transform relative to page bounds (or global bounds if no page offset)
      const bounds = pageBounds || this.bounds;
      x = (dot.x - bounds.minX + offsetX) * this.scale * pageScale;
      y = (dot.y - bounds.minY + offsetY) * this.scale * pageScale;
    }
    
    return {
      x: x * this.zoom + this.panX,
      y: y * this.zoom + this.panY,
      pressure: dot.f
    };
  }
  
  /**
   * Convert ncode to screen without page offset lookup
   * Used for pasted strokes that aren't attached to a page
   * @param {Object} dot - Dot with x, y, f coordinates
   * @returns {Object} Screen coordinates {x, y, pressure}
   */
  ncodeToScreenDirect(dot) {
    const x = dot.x * this.scale * this.zoom + this.panX;
    const y = dot.y * this.scale * this.zoom + this.panY;
    return { x, y, pressure: dot.f };
  }
  
  /**
   * Draw a stroke from store data
   * @param {Object} stroke - Stroke object with dotArray and pageInfo
   * @param {boolean} highlighted - Whether to highlight this stroke
   * @param {boolean} filtered - Whether this is a filtered decorative stroke
   * @param {boolean} deleted - Whether this stroke is marked for deletion
   */
  drawStroke(stroke, highlighted = false, filtered = false, deleted = false) {
    const dots = stroke.dotArray || stroke.dots || [];
    if (dots.length < 2) return;
    
    const pageInfo = stroke.pageInfo;
    
    // Determine color and style based on state
    let color, baseWidth, opacity;
    
    if (deleted) {
      // Deleted strokes: gray with reduced opacity and dashed
      color = '#888888';
      baseWidth = 2;
      opacity = 0.4;
      this.ctx.setLineDash([3, 3]); // Dashed to indicate deletion
    } else if (filtered) {
      // Filtered decorative strokes are ALWAYS dashed
      // Color depends on selection state
      color = highlighted ? '#e94560' : '#000000'; // Red if selected, black if not
      baseWidth = highlighted ? 3 : 2;
      opacity = 1;
      this.ctx.setLineDash([5, 5]); // Always dashed for filtered strokes
    } else {
      // Normal text strokes are always solid
      color = highlighted ? '#e94560' : '#000000'; // Red if selected, black if not
      baseWidth = highlighted ? 3 : 2;
      opacity = 1;
      this.ctx.setLineDash([]); // Solid line
    }
    
    this.ctx.strokeStyle = color;
    this.ctx.globalAlpha = opacity;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    this.ctx.beginPath();
    const firstDot = dots[0];
    const firstScreen = this.ncodeToScreen(firstDot, pageInfo);
    this.ctx.moveTo(firstScreen.x, firstScreen.y);
    
    for (let i = 1; i < dots.length; i++) {
      const dot = dots[i];
      const screenDot = this.ncodeToScreen(dot, pageInfo);
      this.ctx.lineWidth = Math.max(0.5, ((dot.f || 500) / 500) * baseWidth * this.zoom);
      this.ctx.lineTo(screenDot.x, screenDot.y);
    }
    
    this.ctx.stroke();
    this.ctx.setLineDash([]); // Reset to solid for next stroke
  }
  
  /**
   * Draw a pasted stroke with offset applied
   * Visual distinction: green selection color when selected
   * @param {Object} stroke - Pasted stroke object with dotArray and _offset
   * @param {boolean} highlighted - Whether to highlight this stroke
   */
  drawPastedStroke(stroke, highlighted = false) {
    const dots = stroke.dotArray || [];
    if (dots.length < 2) return;
    
    const offset = stroke._offset || { x: 0, y: 0 };
    
    // Apply offset to coordinates during rendering
    const color = highlighted ? '#4ade80' : '#555555';  // Green when selected, dark gray otherwise
    const baseWidth = highlighted ? 3 : 2;
    
    this.ctx.strokeStyle = color;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.setLineDash([]);  // Solid line
    this.ctx.globalAlpha = 1;
    
    this.ctx.beginPath();
    
    // Transform first dot with offset
    const firstDot = { 
      x: dots[0].x + offset.x, 
      y: dots[0].y + offset.y,
      f: dots[0].f 
    };
    const firstScreen = this.ncodeToScreenDirect(firstDot);
    this.ctx.moveTo(firstScreen.x, firstScreen.y);
    
    for (let i = 1; i < dots.length; i++) {
      const dot = {
        x: dots[i].x + offset.x,
        y: dots[i].y + offset.y,
        f: dots[i].f
      };
      const screenDot = this.ncodeToScreenDirect(dot);
      this.ctx.lineWidth = Math.max(0.5, ((dot.f || 500) / 500) * baseWidth * this.zoom);
      this.ctx.lineTo(screenDot.x, screenDot.y);
    }
    
    this.ctx.stroke();
  }
  
  /**
   * Hit test to find pasted stroke at coordinates
   * Tests in reverse order so top strokes are selected first
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @param {Array} pastedStrokes - Array of pasted strokes to test
   * @returns {number} Index of hit stroke, or -1 if none
   */
  hitTestPasted(screenX, screenY, pastedStrokes) {
    const hitRadius = 10 / this.zoom;
    
    // Test in reverse order (top strokes first)
    for (let i = pastedStrokes.length - 1; i >= 0; i--) {
      const stroke = pastedStrokes[i];
      const dots = stroke.dotArray || [];
      const offset = stroke._offset || { x: 0, y: 0 };
      
      for (const dot of dots) {
        const screenDot = this.ncodeToScreenDirect({
          x: dot.x + offset.x,
          y: dot.y + offset.y,
          f: dot.f
        });
        
        const dx = screenDot.x - screenX;
        const dy = screenDot.y - screenY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance <= hitRadius) {
          return i;
        }
      }
    }
    
    return -1;
  }
  
  /**
   * Get bounding box for a pasted stroke in screen coordinates
   * @param {Object} stroke - Pasted stroke object with _offset
   * @returns {Object} Bounds object with left, top, right, bottom
   */
  getPastedStrokeBounds(stroke) {
    const dots = stroke.dotArray || [];
    if (dots.length === 0) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }
    
    const offset = stroke._offset || { x: 0, y: 0 };
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    dots.forEach(dot => {
      const screen = this.ncodeToScreenDirect({
        x: dot.x + offset.x,
        y: dot.y + offset.y,
        f: dot.f
      });
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
    });
    
    return { 
      left: minX, 
      top: minY, 
      right: maxX, 
      bottom: maxY 
    };
  }
  
  /**
   * Check if pasted stroke bounding box intersects with rectangle
   * @param {Object} stroke - Pasted stroke object
   * @param {Object} rect - Rectangle with left, top, right, bottom
   * @returns {boolean} True if intersects
   */
  pastedStrokeIntersectsBox(stroke, rect) {
    const bounds = this.getPastedStrokeBounds(stroke);
    
    return !(bounds.right < rect.left || 
             bounds.left > rect.right ||
             bounds.bottom < rect.top ||
             bounds.top > rect.bottom);
  }
  
  /**
   * Find all pasted stroke indices that intersect with a rectangle
   * @param {Array} pastedStrokes - Array of pasted stroke objects
   * @param {Object} rect - Rectangle with left, top, right, bottom
   * @returns {number[]} Array of intersecting stroke indices
   */
  findPastedStrokesInRect(pastedStrokes, rect) {
    return pastedStrokes
      .map((stroke, index) => ({ stroke, index }))
      .filter(({ stroke }) => this.pastedStrokeIntersectsBox(stroke, rect))
      .map(({ index }) => index);
  }
  
  /**
   * Highlight strokes by indices (from selection store)
   * @param {Set} indices - Set of selected stroke indices
   */
  highlightStrokes(indices) {
    // This method is called reactively by Svelte when selection changes
    // The actual highlighting is done during redraw via drawStroke's highlighted param
  }
  
  /**
   * Get bounding box for a stroke in screen coordinates
   * @param {Object} stroke - Stroke object with pageInfo
   * @returns {Object} Bounds object with left, top, right, bottom
   */
  getStrokeBounds(stroke) {
    const dots = stroke.dotArray || stroke.dots || [];
    if (dots.length === 0) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }
    
    const pageInfo = stroke.pageInfo;
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    dots.forEach(dot => {
      const screen = this.ncodeToScreen(dot, pageInfo);
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
    });
    
    return { 
      left: minX, 
      top: minY, 
      right: maxX, 
      bottom: maxY 
    };
  }
  
  /**
   * Check if stroke bounding box intersects with rectangle
   * @param {Object} stroke - Stroke object
   * @param {Object} rect - Rectangle with left, top, right, bottom
   * @returns {boolean} True if intersects
   */
  strokeIntersectsBox(stroke, rect) {
    const bounds = this.getStrokeBounds(stroke);
    
    return !(bounds.right < rect.left || 
             bounds.left > rect.right ||
             bounds.bottom < rect.top ||
             bounds.top > rect.bottom);
  }
  
  /**
   * Find all stroke indices that intersect with a rectangle
   * @param {Array} strokes - Array of stroke objects
   * @param {Object} rect - Rectangle with left, top, right, bottom
   * @returns {number[]} Array of intersecting stroke indices
   */
  findStrokesInRect(strokes, rect) {
    return strokes
      .map((stroke, index) => ({ stroke, index }))
      .filter(({ stroke }) => this.strokeIntersectsBox(stroke, rect))
      .map(({ index }) => index);
  }
  
  /**
   * Hit test to find stroke at coordinates
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @param {Array} strokes - Array of strokes to test against
   * @returns {number} Index of hit stroke, or -1 if none
   */
  hitTest(x, y, strokes) {
    const hitRadius = 10 / this.zoom; // Adjust for zoom level
    
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      const dots = stroke.dotArray || stroke.dots || [];
      const pageInfo = stroke.pageInfo;
      
      for (const dot of dots) {
        const screenDot = this.ncodeToScreen(dot, pageInfo);
        const dx = screenDot.x - x;
        const dy = screenDot.y - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance <= hitRadius) {
          return i;
        }
      }
    }
    
    return -1;
  }
  
  /**
   * Set which page keys should be visible (for filtering borders)
   * @param {Set|null} pageKeys - Set of visible page keys, or null for all
   */
  setVisiblePageKeys(pageKeys) {
    this.visiblePageKeys = pageKeys;
  }
  
  /**
   * Set page scale factors from store
   * @param {Object} scales - Map of pageKey -> scale factor
   */
  setPageScales(scales) {
    this.pageScales = scales || {};
  }
  
  /**
   * Set temporary page scale (for drag preview)
   * @param {string} pageKey - Page identifier
   * @param {number} scale - Temporary scale factor
   */
  setTempPageScale(pageKey, scale) {
    this.tempPageScales[pageKey] = scale;
  }
  
  /**
   * Clear all temporary page scales
   */
  clearTempPageScale() {
    this.tempPageScales = {};
  }
  
  /**
   * Get effective scale for a page (temp overrides permanent)
   * @param {string} pageKey - Page identifier
   * @returns {number} Scale factor (default: 1.0)
   */
  getEffectiveScale(pageKey) {
    return this.tempPageScales[pageKey] || this.pageScales[pageKey] || 1.0;
  }
  
  /**
   * Get color index for a book ID (consistent across pages)
   * @param {string} bookId - Book ID (e.g., "123")
   * @returns {number} Color index
   */
  getBookColorIndex(bookId) {
    // Simple hash of book ID to get consistent color
    let hash = 0;
    const str = String(bookId);
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash) % this.pageColors.length;
  }
  
  /**
   * Set pending changes map (for showing unsaved indicators)
   * @param {Map} changes - Map of pageKey -> change info
   */
  setPendingChanges(changes) {
    this.pendingChanges = changes;
  }
  
  /**
   * Draw page borders and labels (above the border)
   * Only draws borders for pages that are currently visible
   */
  drawPageBorders() {
    if (!this.showPageBackgrounds || this.pageOffsets.size === 0) return;
    
    this.pageOffsets.forEach((offset, pageKey) => {
      // Skip if page is not visible (filtered out)
      if (this.visiblePageKeys && !this.visiblePageKeys.has(pageKey)) {
        return;
      }
      const { offsetX, offsetY, bounds } = offset;
      
      // Get per-page scale factor
      const pageScale = this.getEffectiveScale(pageKey);
      
      // Calculate screen coordinates for page bounds (with per-page scale)
      const left = offsetX * this.scale * pageScale * this.zoom + this.panX;
      const top = offsetY * this.scale * pageScale * this.zoom + this.panY;
      const width = (bounds.maxX - bounds.minX) * this.scale * pageScale * this.zoom;
      const height = (bounds.maxY - bounds.minY) * this.scale * pageScale * this.zoom;
      
      // Extract book ID from pageKey (format: S#/O#/B#/P#)
      const bookMatch = pageKey.match(/B(\d+)/);
      const bookId = bookMatch ? bookMatch[1] : '0';
      
      // Get color based on book ID (consistent across all pages in the book)
      const colorIndex = this.getBookColorIndex(bookId);
      const baseColor = this.pageColors[colorIndex];
      
      // Parse RGB from rgba string
      const match = baseColor.match(/rgba\(([^,]+),([^,]+),([^,]+),/);
      let borderColor = 'rgba(200, 200, 200, 0.5)'; // Default gray
      if (match) {
        const r = match[1].trim();
        const g = match[2].trim();
        const b = match[3].trim();
        // Use color at full opacity for border
        borderColor = `rgba(${r},${g},${b},0.8)`;
      }
      
      // Draw border (no fill)
      this.ctx.strokeStyle = borderColor;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(left, top, width, height);
      
      // Draw page label ABOVE the border
      const fontSize = Math.max(11, 13 * this.zoom);
      this.ctx.font = `600 ${fontSize}px 'Segoe UI', sans-serif`;
      this.ctx.fillStyle = borderColor; // Match border color
      
      // Extract book and page from pageKey (format: S#/O#/B#/P#)
      const parts = pageKey.match(/B(\d+)\/P(\d+)/);
      if (parts) {
        const book = parts[1];
        const page = parts[2];
        let label = `B${book} / P${page}`;
        
        // Check if this page has pending changes (unsaved strokes)
        const hasUnsavedChanges = this.pendingChanges && this.pendingChanges.has(`B${book}/P${page}`);
        const pageChanges = hasUnsavedChanges ? this.pendingChanges.get(`B${book}/P${page}`) : null;
        const hasAdditions = pageChanges && pageChanges.additions && pageChanges.additions.length > 0;
        
        // Add asterisks if there are unsaved additions
        if (hasAdditions) {
          label = `* ${label} *`;
        }
        
        // Add scale percentage if not 1.0
        if (pageScale !== 1.0) {
          const scalePercent = Math.round(pageScale * 100);
          label += ` (${scalePercent}%)`;
        }
        
        // Position label above the top border with some padding
        const labelY = top - 6;
        this.ctx.fillText(label, left + 4, labelY);
      }
      
    });
    
    // Draw corner handles if enabled
    if (this.showCornerHandles) {
      this.drawCornerHandles();
    }
  }
  
  /**
   * Draw corner handles for all visible pages
   * Only shows bottom-right corner (top-left is anchor)
   */
  drawCornerHandles() {
    // Clear previous handle data
    this.cornerHandles.clear();
    
    this.pageOffsets.forEach((offset, pageKey) => {
      // Skip if page is not visible (filtered out)
      if (this.visiblePageKeys && !this.visiblePageKeys.has(pageKey)) {
        return;
      }
      
      const bounds = this.getPageBoundsScreen(pageKey);
      if (!bounds) return;
      
      const { left, top, width, height } = bounds;
      
      // Extract book ID for color matching
      const bookMatch = pageKey.match(/B(\d+)/);
      const bookId = bookMatch ? bookMatch[1] : '0';
      const colorIndex = this.getBookColorIndex(bookId);
      const baseColor = this.pageColors[colorIndex];
      
      // Parse RGB from base color for handle
      const match = baseColor.match(/rgba\(([^,]+),([^,]+),([^,]+),/);
      let handleColor = 'rgba(233, 69, 96, 0.9)'; // Default red
      if (match) {
        const r = match[1].trim();
        const g = match[2].trim();
        const b = match[3].trim();
        handleColor = `rgba(${r},${g},${b},0.9)`;
      }
      
      // Only bottom-right corner (SE) - top-left is anchor
      const corner = {
        x: left + width,
        y: top + height,
        corner: 'se',
        cursor: 'nwse-resize'
      };
      
      // Draw corner handle
      const handleRadius = this.handleSize / 2;
      this.ctx.fillStyle = handleColor;
      this.ctx.strokeStyle = 'white';
      this.ctx.lineWidth = 2;
      
      this.ctx.beginPath();
      this.ctx.arc(corner.x, corner.y, handleRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      
      // Store handle data for hit testing
      this.cornerHandles.set(pageKey, [{
        x: corner.x,
        y: corner.y,
        corner: corner.corner,
        cursor: corner.cursor,
        radius: handleRadius + 2 // Slightly larger hit area
      }]);
    });
  }
  
  /**
   * Hit test to find corner handle at coordinates
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @returns {Object|null} {pageKey, corner, handle, cursor} if hit, null otherwise
   */
  hitTestCorner(x, y) {
    if (!this.cornerHandles || this.cornerHandles.size === 0) return null;
    
    // Check in reverse order (top pages first)
    const entries = Array.from(this.cornerHandles.entries());
    for (let i = entries.length - 1; i >= 0; i--) {
      const [pageKey, handles] = entries[i];
      
      for (const handle of handles) {
        const dx = x - handle.x;
        const dy = y - handle.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance <= handle.radius) {
          return {
            pageKey,
            corner: handle.corner,
            handle,
            cursor: handle.cursor
          };
        }
      }
    }
    
    return null;
  }
  
  /**
   * Find page at screen coordinates (for hover tooltip)
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @returns {string|null} Page key or null
   */
  getPageAtPosition(x, y) {
    if (this.pageOffsets.size === 0) return null;
    
    for (const [pageKey, offset] of this.pageOffsets) {
      const { offsetX, offsetY, bounds } = offset;
      
      const left = offsetX * this.scale * this.zoom + this.panX;
      const top = offsetY * this.scale * this.zoom + this.panY;
      const width = (bounds.maxX - bounds.minX) * this.scale * this.zoom;
      const height = (bounds.maxY - bounds.minY) * this.scale * this.zoom;
      
      if (x >= left && x <= left + width && y >= top && y <= top + height) {
        return pageKey;
      }
    }
    
    return null;
  }
  
  /**
   * Check if click is on a page header/label area (draggable region)
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @returns {string|null} Page key if clicking on header, null otherwise
   */
  hitTestPageHeader(x, y) {
    if (this.pageOffsets.size === 0) return null;
    
    for (const [pageKey, offset] of this.pageOffsets) {
      const { offsetX, offsetY, bounds } = offset;
      const pageScale = this.getEffectiveScale(pageKey);
      
      const left = offsetX * this.scale * pageScale * this.zoom + this.panX;
      const top = offsetY * this.scale * pageScale * this.zoom + this.panY;
      const width = (bounds.maxX - bounds.minX) * this.scale * pageScale * this.zoom;
      
      // Draggable region is ONLY the label area above the border
      // Label is drawn at top - 6, so check from top - 28 to top + 2
      // This gives ~30px height for the label only, not extending into strokes
      if (x >= left && x <= left + width && y >= top - 28 && y <= top + 2) {
        return pageKey;
      }
    }
    
    return null;
  }
  
  /**
   * Apply custom positions from store to page offsets
   * @param {Object} customPositions - Map of pageKey -> {x, y} positions
   */
  applyCustomPositions(customPositions) {
    if (!customPositions || Object.keys(customPositions).length === 0) return;
    
    this.pageOffsets.forEach((offset, pageKey) => {
      const customPos = customPositions[pageKey];
      if (customPos) {
        // Apply custom offset (these are in Ncode space, already accounted for in calculation)
        offset.offsetX = customPos.x;
        offset.offsetY = customPos.y;
      }
    });
    
    // Recalculate global bounds based on custom positions
    this.bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    
    this.pageOffsets.forEach((offset) => {
      const { offsetX, offsetY, bounds } = offset;
      const pageWidth = bounds.maxX - bounds.minX;
      const pageHeight = bounds.maxY - bounds.minY;
      
      this.bounds.minX = Math.min(this.bounds.minX, offsetX);
      this.bounds.minY = Math.min(this.bounds.minY, offsetY);
      this.bounds.maxX = Math.max(this.bounds.maxX, offsetX + pageWidth);
      this.bounds.maxY = Math.max(this.bounds.maxY, offsetY + pageHeight);
    });
  }
  
  /**
   * Get page bounds in screen coordinates (accounting for per-page scale)
   * @param {string} pageKey - Page identifier
   * @returns {Object|null} Object with {left, top, right, bottom, width, height}
   */
  getPageBoundsScreen(pageKey) {
    const offset = this.pageOffsets.get(pageKey);
    if (!offset) return null;
    
    const pageScale = this.getEffectiveScale(pageKey);
    const { offsetX, offsetY, bounds } = offset;
    const left = offsetX * this.scale * pageScale * this.zoom + this.panX;
    const top = offsetY * this.scale * pageScale * this.zoom + this.panY;
    const width = (bounds.maxX - bounds.minX) * this.scale * pageScale * this.zoom;
    const height = (bounds.maxY - bounds.minY) * this.scale * pageScale * this.zoom;
    
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height
    };
  }
  
  /**
   * Draw transcribed text within a page's boundaries
   * @param {string} pageKey - Page identifier
   * @param {string} text - Transcribed text to render
   */
  drawPageText(pageKey, text) {
    const pageBounds = this.getPageBoundsScreen(pageKey);
    if (!pageBounds) return;
    
    const { left, top, width, height } = pageBounds;
    
    // Start with default sizing
    let fontSize = Math.max(3, 4 * this.zoom);
    let lineHeight = 5 * this.zoom;
    let padding = 4 * this.zoom;
    
    // Helper function to calculate wrapped lines
    const calculateWrappedLines = (text, fontSize, maxWidth) => {
      this.ctx.font = `${fontSize}px 'Courier New', monospace`;
      const lines = text.split('\n');
      const wrappedLines = [];
      
      lines.forEach(line => {
        if (line.trim() === '') {
          wrappedLines.push('');
          return;
        }
        
        const metrics = this.ctx.measureText(line);
        
        if (metrics.width <= maxWidth) {
          wrappedLines.push(line);
        } else {
          // Wrap line by words
          const words = line.split(' ');
          let currentLine = '';
          
          words.forEach(word => {
            const testLine = currentLine + (currentLine ? ' ' : '') + word;
            const testMetrics = this.ctx.measureText(testLine);
            
            if (testMetrics.width <= maxWidth) {
              currentLine = testLine;
            } else {
              if (currentLine) wrappedLines.push(currentLine);
              currentLine = word;
            }
          });
          
          if (currentLine) wrappedLines.push(currentLine);
        }
      });
      
      return wrappedLines;
    };
    
    // Calculate if text fits with current sizing
    const maxWidth = width - (padding * 2);
    let wrappedLines = calculateWrappedLines(text, fontSize, maxWidth);
    let requiredHeight = wrappedLines.length * lineHeight + (padding * 2);
    
    // If text doesn't fit, scale down until it does (or hit minimum)
    const minFontSize = Math.max(2, 2 * this.zoom);
    while (requiredHeight > height && fontSize > minFontSize) {
      // Scale down by 0.5px
      fontSize = Math.max(minFontSize, fontSize - 0.5);
      lineHeight = fontSize * 1.25; // Maintain proportional line height
      padding = fontSize; // Adjust padding proportionally
      
      // Recalculate
      const newMaxWidth = width - (padding * 2);
      wrappedLines = calculateWrappedLines(text, fontSize, newMaxWidth);
      requiredHeight = wrappedLines.length * lineHeight + (padding * 2);
    }
    
    // Set final text styling
    this.ctx.font = `${fontSize}px 'Courier New', monospace`;
    this.ctx.fillStyle = '#000000';
    this.ctx.textBaseline = 'top';
    
    // Draw wrapped lines
    let y = top + padding;
    const maxY = top + height - padding;
    
    for (const line of wrappedLines) {
      if (y + lineHeight > maxY) {
        // Draw ellipsis if text still doesn't fit (shouldn't happen often now)
        this.ctx.fillText('...', left + padding, y);
        break;
      }
      
      this.ctx.fillText(line, left + padding, y);
      y += lineHeight;
    }
  }
  
  /**
   * Redraw all strokes (called after clear or zoom change)
   */
  redraw() {
    this.clearForRedraw();
    
    // Draw page borders first
    this.drawPageBorders();
    
    // Draw grid for reference at high zoom levels
    if (this.zoom >= 2) {
      this.drawGrid();
    }
    
    // Internal strokes array is used for real-time drawing
    // Store strokes are drawn via drawStroke() from the component
    this.strokes.forEach(stroke => {
      this.drawStrokeInternal(stroke, '#000000', Math.max(1, 2 * this.zoom));
    });
  }
  
  /**
   * Draw internal stroke (different from store strokes)
   */
  drawStrokeInternal(stroke, color = '#000000', baseWidth = 2) {
    if (!stroke.dots || stroke.dots.length < 2) return;
    
    this.ctx.strokeStyle = color;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    this.ctx.beginPath();
    const firstDot = stroke.dots[0];
    const firstScreen = this.ncodeToScreen(firstDot);
    this.ctx.moveTo(firstScreen.x, firstScreen.y);
    
    for (let i = 1; i < stroke.dots.length; i++) {
      const dot = stroke.dots[i];
      const screenDot = this.ncodeToScreen(dot);
      this.ctx.lineWidth = Math.max(0.5, (dot.f / 500) * baseWidth);
      this.ctx.lineTo(screenDot.x, screenDot.y);
    }
    
    this.ctx.stroke();
  }
  
  /**
   * Draw reference grid
   */
  drawGrid() {
    const gridSize = 10 * this.scale * this.zoom;
    
    this.ctx.strokeStyle = '#f0f0f0';
    this.ctx.lineWidth = 1;
    
    const startX = this.panX % gridSize;
    for (let x = startX; x < this.viewWidth; x += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.viewHeight);
      this.ctx.stroke();
    }
    
    const startY = this.panY % gridSize;
    for (let y = startY; y < this.viewHeight; y += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.viewWidth, y);
      this.ctx.stroke();
    }
  }
  
  /**
   * Export strokes as SVG
   * @param {Array} strokes - Strokes to export (from store)
   * @param {number} strokeWidth - SVG stroke width (default 0.5)
   */
  exportSVG(strokes = [], strokeWidth = 0.5) {
    const allStrokes = strokes.length > 0 ? strokes : this.strokes;

    if (allStrokes.length === 0) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
    }

    // Calculate bounds from provided strokes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    allStrokes.forEach(stroke => {
      const dots = stroke.dotArray || stroke.dots || [];
      dots.forEach(dot => {
        minX = Math.min(minX, dot.x);
        minY = Math.min(minY, dot.y);
        maxX = Math.max(maxX, dot.x);
        maxY = Math.max(maxY, dot.y);
      });
    });

    const padding = 10;
    const width = (maxX - minX) * this.scale + padding * 2;
    const height = (maxY - minY) * this.scale + padding * 2;

    let paths = '';

    allStrokes.forEach((stroke, index) => {
      const dots = stroke.dotArray || stroke.dots || [];
      if (dots.length < 2) return;

      let d = dots.map((dot, i) => {
        const x = (dot.x - minX) * this.scale + padding;
        const y = (dot.y - minY) * this.scale + padding;
        return i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : `L ${x.toFixed(2)} ${y.toFixed(2)}`;
      }).join(' ');

      paths += `  <path
    d="${d}"
    stroke="black"
    stroke-width="${strokeWidth}"
    fill="none"
    stroke-linecap="round"
    stroke-linejoin="round"
    data-stroke-index="${index}"
    data-dot-count="${dots.length}"
  />\n`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}"
  width="${width.toFixed(2)}mm"
  height="${height.toFixed(2)}mm"
  data-source="neosmartpen"
  data-stroke-count="${allStrokes.length}"
>
${paths}</svg>`;
  }
  
  /**
   * Get current zoom level
   */
  getZoom() {
    return this.zoom;
  }
}
