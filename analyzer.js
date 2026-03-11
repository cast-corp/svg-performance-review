/**
 * SVG Performance Analyzer
 * Static analysis + runtime render measurement for SVG sources.
 */

const SVGAnalyzer = (() => {

  function parseSVG(source) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(source, 'image/svg+xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      throw new Error('Invalid SVG: ' + errorNode.textContent.slice(0, 200));
    }
    return doc.documentElement;
  }

  function getViewport(svgEl) {
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const [, , w, h] = vb.split(/[\s,]+/).map(Number);
      return { width: w, height: h };
    }
    return {
      width: parseFloat(svgEl.getAttribute('width')) || 300,
      height: parseFloat(svgEl.getAttribute('height')) || 150,
    };
  }

  function collectElements(svgEl) {
    const all = svgEl.querySelectorAll('*');
    const tagCounts = {};
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    return { total: all.length, tagCounts };
  }

  function analyzeFilters(svgEl, viewport) {
    const filters = svgEl.querySelectorAll('filter');
    const results = [];
    let totalFilterArea = 0;

    for (const filter of filters) {
      const id = filter.getAttribute('id') || '(unnamed)';
      const units = filter.getAttribute('filterUnits') || 'objectBoundingBox';

      let region = null;
      if (units === 'userSpaceOnUse') {
        const x = parseFloat(filter.getAttribute('x')) || 0;
        const y = parseFloat(filter.getAttribute('y')) || 0;
        const w = parseFloat(filter.getAttribute('width')) || 0;
        const h = parseFloat(filter.getAttribute('height')) || 0;
        region = { x, y, width: w, height: h, area: w * h };
        totalFilterArea += region.area;
      }

      const primitives = filter.querySelectorAll('*');
      const primitiveList = [];
      const issues = [];

      for (const p of primitives) {
        const tag = p.tagName.toLowerCase();
        primitiveList.push(tag);

        if (tag === 'feturbulence') {
          const octaves = parseInt(p.getAttribute('numOctaves')) || 1;
          const freq = p.getAttribute('baseFrequency') || '0';
          issues.push({
            severity: octaves >= 3 ? 'high' : octaves >= 2 ? 'medium' : 'low',
            message: `feTurbulence: numOctaves=${octaves}, baseFrequency=${freq}` +
              (region ? `, computed over ${formatNum(region.area)}px²` : ''),
          });
        }

        if (tag === 'femorphology') {
          const radius = parseFloat(p.getAttribute('radius')) || 0;
          const operator = p.getAttribute('operator') || 'erode';
          const severity = radius > 20 ? 'high' : radius > 5 ? 'medium' : 'low';
          const pixelOps = region ? Math.round(region.area * radius * 2) : null;
          issues.push({
            severity,
            message: `feMorphology: operator=${operator}, radius=${radius}` +
              (pixelOps ? ` → ~${formatNum(pixelOps)} pixel ops` : ''),
          });
        }

        if (tag === 'fegaussianblur') {
          const dev = p.getAttribute('stdDeviation') || '0';
          const vals = dev.split(/[\s,]+/).map(Number);
          const maxDev = Math.max(...vals);
          if (maxDev > 40 && region && region.area > 500000) {
            issues.push({
              severity: 'medium',
              message: `feGaussianBlur: stdDeviation=${dev} on large region (${formatNum(region.area)}px²)`,
            });
          }
        }
      }

      results.push({
        id,
        region,
        primitiveCount: primitives.length,
        primitives: primitiveList,
        issues,
      });
    }

    const viewportArea = viewport.width * viewport.height;
    return { filters: results, totalFilterArea, viewportArea };
  }

  function analyzeComplexity(svgEl) {
    const gradients = svgEl.querySelectorAll('linearGradient, radialGradient');
    const clipPaths = svgEl.querySelectorAll('clipPath');
    const masks = svgEl.querySelectorAll('mask');
    const patterns = svgEl.querySelectorAll('pattern');
    const uses = svgEl.querySelectorAll('use');
    const texts = svgEl.querySelectorAll('text');
    const images = svgEl.querySelectorAll('image');
    const groups = svgEl.querySelectorAll('g');
    const paths = svgEl.querySelectorAll('path');

    const filteredEls = svgEl.querySelectorAll('[filter]');
    const clippedEls = svgEl.querySelectorAll('[clip-path]');
    const maskedEls = svgEl.querySelectorAll('[mask]');

    return {
      gradients: gradients.length,
      clipPaths: clipPaths.length,
      masks: masks.length,
      patterns: patterns.length,
      uses: uses.length,
      texts: texts.length,
      images: images.length,
      groups: groups.length,
      paths: paths.length,
      filteredElements: filteredEls.length,
      clippedElements: clippedEls.length,
      maskedElements: maskedEls.length,
    };
  }

  function analyzeDeepComplexity(svgEl, viewport) {
    // --- Path complexity ---
    const paths = svgEl.querySelectorAll('path');
    let totalPathDataLen = 0;
    let totalPathCommands = 0;
    let curveCommands = 0;
    for (const p of paths) {
      const d = p.getAttribute('d') || '';
      totalPathDataLen += d.length;
      const cmds = d.match(/[a-zA-Z]/g);
      if (cmds) {
        totalPathCommands += cmds.length;
        for (const c of cmds) {
          if ('cCsSqQtTaA'.includes(c)) curveCommands++;
        }
      }
    }

    // --- Nesting depth ---
    let maxDepth = 0;
    function walkDepth(el, depth) {
      if (depth > maxDepth) maxDepth = depth;
      for (const child of el.children) walkDepth(child, depth + 1);
    }
    walkDepth(svgEl, 0);

    // --- Opacity layers ---
    let opacityLayers = 0;
    const allEls = svgEl.querySelectorAll('*');
    for (const el of allEls) {
      const op = el.getAttribute('opacity');
      const fillOp = el.getAttribute('fill-opacity');
      const strokeOp = el.getAttribute('stroke-opacity');
      if ((op && parseFloat(op) < 1 && parseFloat(op) > 0) ||
          (fillOp && parseFloat(fillOp) < 1 && parseFloat(fillOp) > 0) ||
          (strokeOp && parseFloat(strokeOp) < 1 && parseFloat(strokeOp) > 0)) {
        opacityLayers++;
      }
    }

    // --- Transforms ---
    const transformEls = svgEl.querySelectorAll('[transform]');

    // --- Gradient stops ---
    let totalGradientStops = 0;
    const gradients = svgEl.querySelectorAll('linearGradient, radialGradient');
    for (const g of gradients) {
      totalGradientStops += g.querySelectorAll('stop').length;
    }

    // --- Paint server references (url() in fill/stroke) ---
    let paintServerRefs = 0;
    for (const el of allEls) {
      const fill = el.getAttribute('fill') || '';
      const stroke = el.getAttribute('stroke') || '';
      if (fill.includes('url(')) paintServerRefs++;
      if (stroke.includes('url(')) paintServerRefs++;
    }

    // --- Stroke complexity ---
    let dashedStrokes = 0;
    let thickStrokes = 0;
    for (const el of allEls) {
      if (el.getAttribute('stroke-dasharray')) dashedStrokes++;
      const sw = parseFloat(el.getAttribute('stroke-width'));
      if (sw > 10) thickStrokes++;
    }

    // --- shape-rendering hints ---
    let crispEdgesCount = 0;
    for (const el of allEls) {
      if (el.getAttribute('shape-rendering') === 'crispEdges') crispEdgesCount++;
    }

    // --- Estimated filter memory (4 bytes/pixel per intermediate buffer) ---
    const filters = svgEl.querySelectorAll('filter');
    let estFilterMemoryBytes = 0;
    for (const filter of filters) {
      const units = filter.getAttribute('filterUnits') || 'objectBoundingBox';
      let area = viewport.width * viewport.height;
      if (units === 'userSpaceOnUse') {
        const w = parseFloat(filter.getAttribute('width')) || 0;
        const h = parseFloat(filter.getAttribute('height')) || 0;
        area = w * h;
      }
      const buffers = filter.querySelectorAll('*').length + 1;
      estFilterMemoryBytes += area * 4 * Math.min(buffers, 6);
    }

    // --- Defs utilization ---
    const defsEls = svgEl.querySelectorAll('defs > *');
    let usedDefs = 0;
    let unusedDefIds = [];
    for (const el of defsEls) {
      const id = el.getAttribute('id');
      if (!id) continue;
      const ref = svgEl.querySelector(`[filter*="${id}"], [fill*="${id}"], [stroke*="${id}"], [clip-path*="${id}"], [mask*="${id}"], [href*="#${id}"], [xlink\\:href*="#${id}"]`);
      if (ref) {
        usedDefs++;
      } else {
        unusedDefIds.push(id);
      }
    }

    return {
      pathDataLength: totalPathDataLen,
      pathCommands: totalPathCommands,
      curveCommands,
      straightCommands: totalPathCommands - curveCommands,
      maxNestingDepth: maxDepth,
      opacityLayers,
      transforms: transformEls.length,
      gradientStops: totalGradientStops,
      paintServerRefs,
      dashedStrokes,
      thickStrokes,
      crispEdgesCount,
      estFilterMemoryMB: +(estFilterMemoryBytes / (1024 * 1024)).toFixed(1),
      defsTotal: defsEls.length,
      defsUsed: usedDefs,
      unusedDefIds,
    };
  }

  function detectWarnings(svgEl, viewport, filterAnalysis, complexity, elementStats, deep) {
    const warnings = [];
    const vArea = viewport.width * viewport.height;

    if (filterAnalysis.totalFilterArea > vArea * 3) {
      warnings.push({
        severity: 'high',
        category: 'Filter Regions',
        message: `Total filter region area (${formatNum(filterAnalysis.totalFilterArea)}px²) is ${(filterAnalysis.totalFilterArea / vArea).toFixed(1)}× larger than the viewport (${formatNum(vArea)}px²). This forces off-screen rasterization.`,
      });
    }

    for (const f of filterAnalysis.filters) {
      for (const issue of f.issues) {
        warnings.push({
          severity: issue.severity,
          category: `Filter: ${f.id}`,
          message: issue.message,
        });
      }
      if (f.region && f.region.area > vArea * 2) {
        warnings.push({
          severity: 'high',
          category: `Filter: ${f.id}`,
          message: `Filter region ${f.region.width.toFixed(0)}×${f.region.height.toFixed(0)} (${formatNum(f.region.area)}px²) is ${(f.region.area / vArea).toFixed(1)}× the viewport. Constrain x/y/width/height.`,
        });
      }
    }

    const oversizedEllipses = svgEl.querySelectorAll('ellipse, circle');
    for (const el of oversizedEllipses) {
      const rx = parseFloat(el.getAttribute('rx') || el.getAttribute('r')) || 0;
      const ry = parseFloat(el.getAttribute('ry') || el.getAttribute('r')) || 0;
      if (rx > viewport.width * 1.5 || ry > viewport.height * 1.5) {
        const parentFilter = el.closest('[filter]');
        if (parentFilter) {
          const filterId = parentFilter.getAttribute('filter');
          warnings.push({
            severity: 'high',
            category: 'Oversized Shape',
            message: `Ellipse/circle (rx=${rx}, ry=${ry}) is much larger than viewport and has a filter (${filterId}). This forces massive off-screen computation.`,
          });
        }
      }
    }

    if (elementStats.total > 1000) {
      warnings.push({
        severity: 'medium',
        category: 'DOM Size',
        message: `SVG has ${elementStats.total} elements. Large DOMs slow down parsing and layout.`,
      });
    }

    if (complexity.uses > 20) {
      warnings.push({
        severity: 'medium',
        category: 'Use Elements',
        message: `${complexity.uses} <use> elements. Excessive cloning can hurt performance.`,
      });
    }

    if (complexity.filteredElements > 5) {
      warnings.push({
        severity: 'medium',
        category: 'Filtered Elements',
        message: `${complexity.filteredElements} elements have filters applied. Each filter is a separate rasterization pass.`,
      });
    }

    if (deep.maxNestingDepth > 15) {
      warnings.push({
        severity: 'medium',
        category: 'Nesting Depth',
        message: `Max nesting depth is ${deep.maxNestingDepth}. Deep nesting slows layout and style recalculation.`,
      });
    }

    if (deep.opacityLayers > 10) {
      warnings.push({
        severity: 'medium',
        category: 'Opacity Layers',
        message: `${deep.opacityLayers} elements with partial opacity. Each creates a separate compositing layer.`,
      });
    }

    if (deep.pathCommands > 5000) {
      warnings.push({
        severity: 'medium',
        category: 'Path Complexity',
        message: `${formatNum(deep.pathCommands)} path commands (${formatNum(deep.curveCommands)} curves). High path complexity increases tessellation and rasterization cost.`,
      });
    }

    if (deep.pathDataLength > 50000) {
      warnings.push({
        severity: 'medium',
        category: 'Path Data Size',
        message: `${formatNum(deep.pathDataLength)} chars of path data. Large paths slow down parsing.`,
      });
    }

    if (deep.estFilterMemoryMB > 50) {
      warnings.push({
        severity: 'high',
        category: 'Filter Memory',
        message: `Estimated filter buffer memory: ~${deep.estFilterMemoryMB} MB. Can cause memory pressure and crashes on mobile.`,
      });
    } else if (deep.estFilterMemoryMB > 10) {
      warnings.push({
        severity: 'medium',
        category: 'Filter Memory',
        message: `Estimated filter buffer memory: ~${deep.estFilterMemoryMB} MB.`,
      });
    }

    if (deep.thickStrokes > 5) {
      warnings.push({
        severity: 'low',
        category: 'Thick Strokes',
        message: `${deep.thickStrokes} elements with stroke-width > 10. Thick strokes on complex paths are expensive to rasterize.`,
      });
    }

    if (deep.unusedDefIds.length > 5) {
      warnings.push({
        severity: 'low',
        category: 'Unused Defs',
        message: `${deep.unusedDefIds.length} unused definitions in <defs>. Removing them reduces file size and parse time.`,
      });
    }

    if (complexity.masks > 3) {
      warnings.push({
        severity: 'medium',
        category: 'Masks',
        message: `${complexity.masks} <mask> elements. Masks require separate off-screen rendering passes.`,
      });
    }

    if (deep.paintServerRefs > 20) {
      warnings.push({
        severity: 'low',
        category: 'Paint Servers',
        message: `${deep.paintServerRefs} url() references in fill/stroke. Each requires a lookup and may prevent batching.`,
      });
    }

    if (warnings.length === 0) {
      warnings.push({
        severity: 'ok',
        category: 'All Clear',
        message: 'No obvious performance issues detected.',
      });
    }

    warnings.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2, ok: 3 };
      return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
    });

    return warnings;
  }

  /**
   * Measure real render time by inserting SVG directly into a visible
   * container in the page DOM. Single-pass only — no repaint cycle,
   * because a second heavy block crashes Safari.
   *
   * The render time equals repaint cost (same filters must re-rasterize
   * on every tab switch), so we report it as both.
   */
  /**
   * Run a tight math loop for `durationMs` and return ops completed.
   * Used as a CPU throughput probe — comparing before vs after render
   * reveals how much CPU capacity the render consumed.
   */
  function cpuBenchmark(durationMs) {
    let ops = 0;
    const end = performance.now() + durationMs;
    let x = 1.0001;
    while (performance.now() < end) {
      x = Math.sin(x) * Math.cos(x) + Math.sqrt(Math.abs(x));
      x = Math.atan2(x, 0.5) + Math.log(Math.abs(x) + 1);
      ops++;
    }
    return ops;
  }

  /**
   * Measure GPU compositing cost by timing canvas drawImage of the SVG.
   */
  function measureCompositingCost(container, viewport) {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return { compositingTimeMs: 0 };

    const w = viewport.width;
    const h = viewport.height;
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgEl);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        const t0 = performance.now();
        ctx.drawImage(img, 0, 0, w, h);
        const t1 = performance.now();

        URL.revokeObjectURL(url);
        resolve({ compositingTimeMs: +(t1 - t0).toFixed(2) });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ compositingTimeMs: 0 });
      };
      img.width = w;
      img.height = h;
      img.src = url;
    });
  }

  async function measureRenderTime(container, source, viewport) {
    container.innerHTML = '';

    const longTasks = [];
    let longTaskObserver = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ duration: entry.duration, startTime: entry.startTime });
          }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
      } catch (e) { /* longtask not supported */ }
    }

    const heartbeatLog = [];
    let heartbeatRunning = true;
    const HEARTBEAT_INTERVAL = 50;

    function heartbeat() {
      if (!heartbeatRunning) return;
      heartbeatLog.push(performance.now());
      setTimeout(heartbeat, HEARTBEAT_INTERVAL);
    }

    const frameTimestamps = [];
    let frameCounting = true;
    function countFrames(ts) {
      if (!frameCounting) return;
      frameTimestamps.push(ts);
      requestAnimationFrame(countFrames);
    }

    // --- CPU baseline benchmark (10ms probe) ---
    const PROBE_MS = 10;
    const cpuBaseline = cpuBenchmark(PROBE_MS);

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    heartbeat();
    requestAnimationFrame(countFrames);

    // --- Capture memory before (Chrome only) ---
    const memBefore = performance.memory ? performance.memory.usedJSHeapSize : null;

    const t0 = performance.now();
    container.innerHTML = source;
    container.getBoundingClientRect();
    container.offsetHeight;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t1 = performance.now();

    heartbeatRunning = false;
    frameCounting = false;
    if (longTaskObserver) longTaskObserver.disconnect();

    const memAfter = performance.memory ? performance.memory.usedJSHeapSize : null;

    const renderTime = t1 - t0;

    // --- CPU post-render benchmark ---
    const cpuAfterRender = cpuBenchmark(PROBE_MS);

    // --- GPU compositing probe ---
    const gpuResult = await measureCompositingCost(container, viewport);

    // --- Analyze heartbeat for blocking ---
    let maxGap = 0;
    let totalBlocked = 0;
    for (let i = 1; i < heartbeatLog.length; i++) {
      const gap = heartbeatLog[i] - heartbeatLog[i - 1];
      const overshoot = gap - HEARTBEAT_INTERVAL - 10;
      if (overshoot > 0) {
        totalBlocked += overshoot;
        if (gap > maxGap) maxGap = gap;
      }
    }

    // --- Frame budget analysis ---
    let droppedFrames = 0;
    let framesOver16 = 0;
    let framesOver50 = 0;
    let framesOver100 = 0;
    for (let i = 1; i < frameTimestamps.length; i++) {
      const delta = frameTimestamps[i] - frameTimestamps[i - 1];
      if (delta > 16.67) framesOver16++;
      if (delta > 50) { framesOver50++; droppedFrames += Math.floor(delta / 16.67) - 1; }
      if (delta > 100) framesOver100++;
    }

    const totalLongTaskTime = longTasks.reduce((s, t) => s + t.duration, 0);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // --- CPU estimates ---
    const cpuOpsPerMs = cpuBaseline / PROBE_MS;
    const estCpuTimeMs = renderTime;
    const cpuSaturation = Math.min(100, (1 - (cpuAfterRender / cpuBaseline)) * 100);

    // Rough cycle estimate: assume ~3GHz single-core equivalent for the main thread
    const EST_CLOCK_HZ = 3_000_000_000;
    const estCpuCycles = (estCpuTimeMs / 1000) * EST_CLOCK_HZ;

    return {
      renderTime: +renderTime.toFixed(2),
      mainThreadBlocked: +totalBlocked.toFixed(2),
      maxBlockingGap: +maxGap.toFixed(2),
      longTaskCount: longTasks.length,
      longTaskTotalMs: +totalLongTaskTime.toFixed(2),
      longestTask: longTasks.length ? +Math.max(...longTasks.map(t => t.duration)).toFixed(2) : 0,
      droppedFrames,
      framesRecorded: frameTimestamps.length,
      framesOver16,
      framesOver50,
      framesOver100,
      heartbeats: heartbeatLog.length,
      browser: isSafari ? 'Safari' : 'Other',
      cpu: {
        baselineOpsPerMs: Math.round(cpuOpsPerMs),
        afterOpsPerMs: Math.round(cpuAfterRender / PROBE_MS),
        saturationPct: +Math.max(0, cpuSaturation).toFixed(1),
        estCpuTimeMs: +estCpuTimeMs.toFixed(2),
        estCycles: estCpuCycles,
        estCyclesFormatted: formatCycles(estCpuCycles),
      },
      gpu: {
        compositingTimeMs: gpuResult.compositingTimeMs,
      },
      memory: {
        heapBefore: memBefore,
        heapAfter: memAfter,
        heapDelta: memBefore != null ? memAfter - memBefore : null,
      },
    };
  }

  function formatCycles(cycles) {
    if (cycles >= 1e12) return (cycles / 1e12).toFixed(2) + 'T';
    if (cycles >= 1e9) return (cycles / 1e9).toFixed(2) + 'G';
    if (cycles >= 1e6) return (cycles / 1e6).toFixed(2) + 'M';
    if (cycles >= 1e3) return (cycles / 1e3).toFixed(2) + 'K';
    return cycles.toFixed(0);
  }

  /**
   * Static analysis pipeline (no rendering).
   */
  function analyzeStatic(source) {
    const svgEl = parseSVG(source);
    const viewport = getViewport(svgEl);
    const elementStats = collectElements(svgEl);
    const filterAnalysis = analyzeFilters(svgEl, viewport);
    const complexity = analyzeComplexity(svgEl);
    const deep = analyzeDeepComplexity(svgEl, viewport);
    const warnings = detectWarnings(svgEl, viewport, filterAnalysis, complexity, elementStats, deep);

    return {
      viewport,
      elementStats,
      filterAnalysis,
      complexity,
      deep,
      warnings,
      sourceSize: new Blob([source]).size,
    };
  }

  function formatNum(n) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /**
   * Replace the live SVG in a container with a static PNG snapshot.
   * This eliminates ongoing compositing/repaint cost from filters.
   */
  function rasterizePreview(container, viewport) {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return Promise.resolve();

    const w = viewport.width;
    const h = viewport.height;
    const dpr = window.devicePixelRatio || 1;

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgEl);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);

        const pngImg = document.createElement('img');
        pngImg.src = canvas.toDataURL('image/png');
        pngImg.style.cssText = `width:${w}px;height:${h}px;max-width:100%;height:auto;display:block;`;
        container.innerHTML = '';
        container.appendChild(pngImg);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      img.width = w;
      img.height = h;
      img.src = url;
    });
  }

  return { analyzeStatic, measureRenderTime, rasterizePreview, formatNum };

})();
