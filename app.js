/**
 * SVG Perf Review — UI Controller
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const input = $('#svg-input');
  const btnAnalyze = $('#btn-analyze');
  const btnClear = $('#btn-clear');
  const charCount = $('#char-count');
  const resultsSection = $('#results-section');

  // ── Sample SVG banner ──────────────────────────────────────────
  let sampleSource = null;

  async function loadSampleSource() {
    if (sampleSource !== null) return sampleSource;
    try {
      const r = await fetch('sample.svg');
      sampleSource = await r.text();
    } catch (_) {
      sampleSource = '';
    }
    return sampleSource;
  }

  $('#btn-load-sample').addEventListener('click', async () => {
    const src = await loadSampleSource();
    if (!src) return;
    input.value = src;
    charCount.textContent = `${SVGAnalyzer.formatNum(src.length)} chars`;
    btnAnalyze.disabled = false;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
  });

  // ── End Sample ─────────────────────────────────────────────────

  input.addEventListener('input', () => {
    const len = input.value.length;
    charCount.textContent = len ? `${SVGAnalyzer.formatNum(len)} chars` : '';
    btnAnalyze.disabled = !len;
  });

  btnClear.addEventListener('click', () => {
    input.value = '';
    charCount.textContent = '';
    btnAnalyze.disabled = true;
    resultsSection.classList.add('hidden');
    $('#svg-preview').innerHTML = '';
    $('#preview-dimensions').textContent = '';
    $('#impact-results').innerHTML = '';
    $('#hardware-results').innerHTML = '';
    $('#complexity-results').innerHTML = '';
    $('#memory-results').innerHTML = '';
  });

  btnAnalyze.addEventListener('click', runAnalysis);

  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && input.value.trim()) {
      runAnalysis();
    }
  });

  async function runAnalysis() {
    const source = input.value.trim();
    if (!source) return;

    btnAnalyze.disabled = true;
    btnAnalyze.textContent = 'Analyzing…';
    resultsSection.classList.remove('hidden');

    $('#timing-results').innerHTML = '<div class="loading">Rendering SVG…</div>';
    $('#impact-results').innerHTML = '<div class="loading">Measuring page impact…</div>';
    $('#hardware-results').innerHTML = '<div class="loading">Benchmarking hardware…</div>';
    $('#stats-results').innerHTML = '';
    $('#complexity-results').innerHTML = '';
    $('#filter-results').innerHTML = '';
    $('#memory-results').innerHTML = '';
    $('#warnings-results').innerHTML = '';

    try {
      const staticResult = SVGAnalyzer.analyzeStatic(source);
      const vp = staticResult.viewport;
      $('#preview-dimensions').textContent = `${vp.width}×${vp.height}`;

      await new Promise(r => requestAnimationFrame(r));

      const preview = $('#svg-preview');
      const timing = await SVGAnalyzer.measureRenderTime(preview, source, vp);

      await SVGAnalyzer.rasterizePreview(preview, vp);

      renderTiming(timing, staticResult.sourceSize);
      renderPageImpact(timing);
      renderHardware(timing);
      renderStats(staticResult.elementStats, staticResult.complexity, vp);
      renderComplexity(staticResult.deep);
      renderFilters(staticResult.filterAnalysis, vp);
      renderMemory(staticResult.deep, staticResult.sourceSize, staticResult.filterAnalysis, vp);
      renderWarnings(staticResult.warnings);
    } catch (err) {
      $('#timing-results').innerHTML = `<div class="error">${esc(err.message)}</div>`;
    } finally {
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = 'Analyze';
    }
  }

  function renderTiming(timing, sourceSize) {
    const ms = timing.renderTime;
    const ratingClass = ms < 100 ? 'good' : ms < 500 ? 'warn' : 'bad';
    const ratingLabel = ms < 100 ? 'Fast' : ms < 500 ? 'Moderate' : 'Slow';
    const isSafari = timing.browser === 'Safari';

    $('#timing-results').innerHTML = `
      <div class="metric-hero ${ratingClass}">
        <span class="metric-value">${fmtMsHero(ms)}<small>${fmtMsUnit(ms)}</small></span>
        <span class="metric-label">render time${isSafari ? ' (Safari)' : ''}</span>
      </div>
      <div class="metric-badge ${ratingClass}">${ratingLabel}</div>
      <table class="metric-table">
        <tr><td>Render time</td><td>${fmtMs(ms)}</td></tr>
        <tr><td>Est. repaint cost</td><td>~${fmtMs(ms)}</td></tr>
        <tr><td>Source size</td><td>${formatBytes(sourceSize)}</td></tr>
        <tr><td>Browser</td><td>${timing.browser}</td></tr>
      </table>
      ${isSafari && ms > 500 ? `<p class="metric-warn">Safari renders SVG filters on the main thread. This SVG will freeze the page for ~${fmtMs(ms)} on every tab switch, scroll repaint, or resize.</p>` : ''}
      <p class="metric-note">Wall-clock time from SVG insertion to paint. Repaint cost is the same — filters must re-rasterize on every visibility change (tab switch etc).</p>
    `;
  }

  function fmtMsHero(ms) {
    return ms < 1000 ? ms.toFixed(1) : (ms / 1000).toFixed(2);
  }

  function fmtMsUnit(ms) {
    return ms < 1000 ? 'ms' : 's';
  }

  function renderPageImpact(timing) {
    const blocked = timing.mainThreadBlocked;
    const render = timing.renderTime;
    const impactMs = Math.max(blocked, render);
    const impactClass = impactMs < 50 ? 'good' : impactMs < 500 ? 'warn' : 'bad';
    const impactLabel = impactMs < 50 ? 'Minimal' : impactMs < 500 ? 'Noticeable' : 'Page Freeze';
    const isSafari = timing.browser === 'Safari';

    let safariNote = '';
    if (isSafari && render > 2000) {
      safariNote = `<p class="metric-warn">Safari may crash/reload the page if multiple heavy SVGs are on screen or if this SVG triggers multiple repaints (tab switch, scroll, resize).</p>`;
    } else if (isSafari && render > 500) {
      safariNote = `<p class="metric-warn">Safari will freeze the UI during filter rasterization. Users will experience an unresponsive page.</p>`;
    }

    $('#impact-results').innerHTML = `
      <div class="metric-hero ${impactClass}">
        <span class="metric-value">${fmtMsHero(impactMs)}<small>${fmtMsUnit(impactMs)}</small></span>
        <span class="metric-label">page blocked</span>
      </div>
      <div class="metric-badge ${impactClass}">${impactLabel}</div>
      <table class="metric-table">
        <tr><td>Main thread blocked</td><td>${fmtMs(blocked)}</td></tr>
        <tr><td>Longest blocking gap</td><td>${fmtMs(timing.maxBlockingGap)}</td></tr>
        <tr><td>Long tasks (>50ms)</td><td>${timing.longTaskCount}</td></tr>
        <tr><td>Long task total time</td><td>${fmtMs(timing.longTaskTotalMs)}</td></tr>
        <tr><td>Longest single task</td><td>${fmtMs(timing.longestTask)}</td></tr>
        <tr><td>Dropped frames</td><td>${timing.droppedFrames}</td></tr>
      </table>
      ${safariNote}
      <p class="metric-note">Blocked time from 50ms heartbeat gaps during render. Every tab switch or repaint repeats this cost.</p>
    `;
  }

  function renderHardware(timing) {
    const cpu = timing.cpu;
    const gpu = timing.gpu;
    const mem = timing.memory;
    const isSafari = timing.browser === 'Safari';
    const framesTotal = timing.framesRecorded > 1 ? timing.framesRecorded - 1 : 0;

    const cpuClass = cpu.estCpuTimeMs > 2000 ? 'bad' : cpu.estCpuTimeMs > 200 ? 'warn' : 'good';

    let memRow = '';
    if (mem.heapDelta != null) {
      const deltaMB = (mem.heapDelta / (1024 * 1024)).toFixed(1);
      memRow = `
        <tr><td>JS heap before</td><td>${(mem.heapBefore / (1024 * 1024)).toFixed(1)} MB</td></tr>
        <tr><td>JS heap after</td><td>${(mem.heapAfter / (1024 * 1024)).toFixed(1)} MB</td></tr>
        <tr><td>Heap delta</td><td>${deltaMB >= 0 ? '+' : ''}${deltaMB} MB</td></tr>
      `;
    }

    $('#hardware-results').innerHTML = `
      <div class="hw-grid">
        <div class="hw-section">
          <h3>CPU</h3>
          <div class="metric-hero ${cpuClass}" style="padding:0.5rem 0">
            <span class="metric-value" style="font-size:2rem">${cpu.estCyclesFormatted}</span>
            <span class="metric-label">estimated cycles (@ ~3GHz)</span>
          </div>
          <table class="metric-table">
            <tr><td>CPU time (main thread)</td><td>${fmtMs(cpu.estCpuTimeMs)}</td></tr>
            <tr><td>Baseline throughput</td><td>${SVGAnalyzer.formatNum(cpu.baselineOpsPerMs)} ops/ms</td></tr>
            <tr><td>Post-render throughput</td><td>${SVGAnalyzer.formatNum(cpu.afterOpsPerMs)} ops/ms</td></tr>
            <tr><td>CPU saturation</td><td>${cpu.saturationPct}%</td></tr>
            ${isSafari ? `<tr><td>Rendering engine</td><td>WebKit (CPU-bound filters)</td></tr>` : `<tr><td>Rendering engine</td><td>Blink/Skia (GPU-accelerated)</td></tr>`}
          </table>
          ${isSafari && cpu.estCpuTimeMs > 1000 ? `<p class="metric-warn">Safari computes feTurbulence, feMorphology, and feGaussianBlur entirely on the CPU main thread. This SVG consumed ~${cpu.estCyclesFormatted} cycles — equivalent to ${(cpu.estCpuTimeMs / 1000).toFixed(1)}s of single-core CPU time.</p>` : ''}
        </div>
        <div class="hw-section">
          <h3>GPU / Compositing</h3>
          <table class="metric-table">
            <tr><td>Canvas drawImage time</td><td>${fmtMs(gpu.compositingTimeMs)}</td></tr>
            <tr><td>GPU cost assessment</td><td>${gpu.compositingTimeMs < 5 ? 'Minimal' : gpu.compositingTimeMs < 50 ? 'Moderate' : 'Heavy'}</td></tr>
          </table>
          <p class="metric-note">Canvas drawImage of the rendered SVG. Low values mean the GPU handled compositing quickly; high values indicate the SVG is too complex for efficient GPU compositing.</p>
        </div>
        <div class="hw-section">
          <h3>Frame Budget</h3>
          <table class="metric-table">
            <tr><td>Frames recorded</td><td>${timing.framesRecorded}</td></tr>
            <tr><td>Dropped frames</td><td>${timing.droppedFrames}</td></tr>
            <tr><td>Frames > 16.67ms</td><td>${timing.framesOver16}${framesTotal ? ` / ${framesTotal}` : ''}</td></tr>
            <tr><td>Frames > 50ms</td><td>${timing.framesOver50}</td></tr>
            <tr><td>Frames > 100ms</td><td>${timing.framesOver100}</td></tr>
          </table>
        </div>
        ${mem.heapDelta != null ? `
        <div class="hw-section">
          <h3>Memory (JS Heap)</h3>
          <table class="metric-table">${memRow}</table>
        </div>
        ` : ''}
      </div>
    `;
  }

  function fmtMs(ms) {
    if (ms < 1000) return ms.toFixed(1) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function renderStats(elementStats, complexity, viewport) {
    const topTags = Object.entries(elementStats.tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    let html = `
      <table class="metric-table">
        <tr><td>Viewport</td><td>${viewport.width} × ${viewport.height}</td></tr>
        <tr><td>Total elements</td><td>${elementStats.total}</td></tr>
        <tr><td>Groups &lt;g&gt;</td><td>${complexity.groups}</td></tr>
        <tr><td>Paths</td><td>${complexity.paths}</td></tr>
        <tr><td>Text elements</td><td>${complexity.texts}</td></tr>
        <tr><td>Images</td><td>${complexity.images}</td></tr>
        <tr><td>&lt;use&gt; clones</td><td>${complexity.uses}</td></tr>
        <tr><td>Gradients</td><td>${complexity.gradients}</td></tr>
        <tr><td>Clip paths</td><td>${complexity.clipPaths}</td></tr>
        <tr><td>Masks</td><td>${complexity.masks}</td></tr>
        <tr><td>Patterns</td><td>${complexity.patterns}</td></tr>
        <tr><td>Elements with filter</td><td>${complexity.filteredElements}</td></tr>
        <tr><td>Elements with clip-path</td><td>${complexity.clippedElements}</td></tr>
        <tr><td>Elements with mask</td><td>${complexity.maskedElements}</td></tr>
      </table>
      <h3>Top element types</h3>
      <div class="tag-list">
        ${topTags.map(([tag, count]) =>
          `<span class="tag-chip">&lt;${tag}&gt; <strong>${count}</strong></span>`
        ).join('')}
      </div>
    `;
    $('#stats-results').innerHTML = html;
  }

  function renderComplexity(deep) {
    const scoreClass = deep.maxNestingDepth > 15 || deep.curveCommands > 3000 ? 'bad'
      : deep.maxNestingDepth > 8 || deep.curveCommands > 1000 ? 'warn' : 'good';

    $('#complexity-results').innerHTML = `
      <table class="metric-table">
        <tr><td>Max nesting depth</td><td>${deep.maxNestingDepth}</td></tr>
        <tr><td>Transforms</td><td>${deep.transforms}</td></tr>
        <tr><td>Opacity layers</td><td>${deep.opacityLayers}</td></tr>
        <tr><td>Paint server refs (url())</td><td>${deep.paintServerRefs}</td></tr>
        <tr><td>Dashed strokes</td><td>${deep.dashedStrokes}</td></tr>
        <tr><td>Thick strokes (>10)</td><td>${deep.thickStrokes}</td></tr>
        <tr><td>crispEdges elements</td><td>${deep.crispEdgesCount}</td></tr>
      </table>
      <h3>Path Complexity</h3>
      <table class="metric-table">
        <tr><td>Path data size</td><td>${SVGAnalyzer.formatNum(deep.pathDataLength)} chars</td></tr>
        <tr><td>Total path commands</td><td>${SVGAnalyzer.formatNum(deep.pathCommands)}</td></tr>
        <tr><td>Curve commands</td><td>${SVGAnalyzer.formatNum(deep.curveCommands)} <span class="meta">(C/S/Q/T/A)</span></td></tr>
        <tr><td>Straight commands</td><td>${SVGAnalyzer.formatNum(deep.straightCommands)} <span class="meta">(M/L/H/V/Z)</span></td></tr>
      </table>
      <h3>Gradients</h3>
      <table class="metric-table">
        <tr><td>Gradient stops</td><td>${deep.gradientStops}</td></tr>
      </table>
    `;
  }

  function renderMemory(deep, sourceSize, filterAnalysis, viewport) {
    const vArea = viewport.width * viewport.height;
    const dpr = window.devicePixelRatio || 1;
    const framebufferMB = (vArea * dpr * dpr * 4) / (1024 * 1024);

    $('#memory-results').innerHTML = `
      <table class="metric-table">
        <tr><td>Source size</td><td>${formatBytes(sourceSize)}</td></tr>
        <tr><td>Parsed DOM estimate</td><td>~${formatBytes(sourceSize * 3)}</td></tr>
        <tr><td>Framebuffer (@${dpr}x)</td><td>${framebufferMB.toFixed(1)} MB</td></tr>
        <tr><td>Filter buffers (est.)</td><td>${deep.estFilterMemoryMB} MB</td></tr>
        <tr><td>Total est. memory</td><td>${(framebufferMB + deep.estFilterMemoryMB + (sourceSize * 3 / 1024 / 1024)).toFixed(1)} MB</td></tr>
      </table>
      <h3>Defs Utilization</h3>
      <table class="metric-table">
        <tr><td>Total defs</td><td>${deep.defsTotal}</td></tr>
        <tr><td>Used defs</td><td>${deep.defsUsed}</td></tr>
        <tr><td>Unused defs</td><td>${deep.unusedDefIds.length}</td></tr>
      </table>
      ${deep.unusedDefIds.length > 0 ? `
        <details class="filter-detail" style="margin-top:0.5rem">
          <summary><span class="meta">${deep.unusedDefIds.length} unused def IDs</span></summary>
          <div class="filter-primitives">
            ${deep.unusedDefIds.map(id => `<span class="prim-chip">${esc(id)}</span>`).join('')}
          </div>
        </details>
      ` : ''}
    `;
  }

  function renderFilters(filterAnalysis, viewport) {
    const vArea = viewport.width * viewport.height;
    if (filterAnalysis.filters.length === 0) {
      $('#filter-results').innerHTML = '<p class="empty-state">No SVG filters found.</p>';
      return;
    }

    let html = `
      <table class="metric-table">
        <tr><td>Total filters</td><td>${filterAnalysis.filters.length}</td></tr>
        <tr><td>Viewport area</td><td>${SVGAnalyzer.formatNum(vArea)} px²</td></tr>
        <tr><td>Total filter area</td><td>${SVGAnalyzer.formatNum(filterAnalysis.totalFilterArea)} px²</td></tr>
        <tr><td>Filter/Viewport ratio</td><td>${(filterAnalysis.totalFilterArea / vArea).toFixed(1)}×</td></tr>
      </table>
      <h3>Individual Filters</h3>
    `;

    for (const f of filterAnalysis.filters) {
      const regionStr = f.region
        ? `${f.region.width.toFixed(0)}×${f.region.height.toFixed(0)} (${SVGAnalyzer.formatNum(f.region.area)}px²)`
        : 'objectBoundingBox';
      const ratioStr = f.region ? `${(f.region.area / vArea).toFixed(1)}× viewport` : '';
      const hasIssues = f.issues.length > 0;

      html += `
        <details class="filter-detail ${hasIssues ? 'has-issues' : ''}" ${hasIssues ? 'open' : ''}>
          <summary>
            <code>${esc(f.id)}</code>
            <span class="meta">${f.primitiveCount} primitives · ${regionStr}</span>
            ${ratioStr ? `<span class="meta ratio">${ratioStr}</span>` : ''}
          </summary>
          <div class="filter-primitives">
            ${f.primitives.map(p => `<span class="prim-chip">${p}</span>`).join('')}
          </div>
          ${f.issues.length ? `
            <ul class="issue-list">
              ${f.issues.map(i => `<li class="severity-${i.severity}">${esc(i.message)}</li>`).join('')}
            </ul>
          ` : ''}
        </details>
      `;
    }

    $('#filter-results').innerHTML = html;
  }

  function renderWarnings(warnings) {
    if (!warnings.length) {
      $('#warnings-results').innerHTML = '<p class="empty-state">No issues found.</p>';
      return;
    }

    const html = warnings.map(w => `
      <div class="warning-item severity-${w.severity}">
        <span class="severity-badge">${w.severity.toUpperCase()}</span>
        <div>
          <strong>${esc(w.category)}</strong>
          <p>${esc(w.message)}</p>
        </div>
      </div>
    `).join('');

    $('#warnings-results').innerHTML = html;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

})();
