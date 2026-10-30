// Full-screen in-app viewer for report attachments.
// Images open instantly (pinch / double-tap zoom, swipe between pages); PDFs are drawn page by page
// with pdf.js inside the app, so nothing has to be downloaded just to look at a report.
(function () {
  'use strict';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  let pdfReady = null;
  function loadPdf() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfReady) {
      pdfReady = new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = PDFJS;
        s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(window.pdfjsLib); };
        s.onerror = () => { pdfReady = null; rej(new Error('PDF viewer did not load')); };
        document.head.appendChild(s);
      });
    }
    return pdfReady;
  }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = {
    x: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    l: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    r: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  };

  let root, stage, items = [], idx = 0, opts = {}, zoom = 1, lastFocus = null, pdfTask = null;

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'mv'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Report viewer');
    root.innerHTML = `
      <div class="mv-bar">
        <button type="button" class="mv-btn" data-mv="close" aria-label="Close">${icon.x}</button>
        <div class="mv-title"><strong id="mvName"></strong><span id="mvCount"></span></div>
        <button type="button" class="mv-btn" data-mv="out" aria-label="Zoom out">${icon.minus}</button>
        <button type="button" class="mv-btn" data-mv="in" aria-label="Zoom in">${icon.plus}</button>
        <button type="button" class="mv-btn" data-mv="dl" aria-label="Download" id="mvDl">${icon.dl}</button>
      </div>
      <div class="mv-stage" id="mvStage" tabindex="-1"></div>
      <button type="button" class="mv-nav prev" data-mv="prev" aria-label="Previous page">${icon.l}</button>
      <button type="button" class="mv-nav next" data-mv="next" aria-label="Next page">${icon.r}</button>
      <div class="mv-dots" id="mvDots"></div>`;
    document.body.appendChild(root);
    stage = root.querySelector('#mvStage');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mv]'); if (!b) return;
      const a = b.dataset.mv;
      if (a === 'close') close();
      else if (a === 'prev') go(idx - 1);
      else if (a === 'next') go(idx + 1);
      else if (a === 'in') setZoom(zoom * 1.5);
      else if (a === 'out') setZoom(zoom / 1.5);
      else if (a === 'dl') download();
    });
    document.addEventListener('keydown', (e) => {
      if (root.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(idx - 1);
      else if (e.key === 'ArrowRight') go(idx + 1);
      else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.5);
      else if (e.key === '-') setZoom(zoom / 1.5);
    });
    gestures();
    addEventListener('popstate', () => { if (!root.hidden) close(true); });
  }

  // ── gestures: pinch to zoom, double-tap, swipe between pages ──
  function gestures() {
    const pts = new Map(); let startDist = 0, startZoom = 1, sx = 0, sy = 0, st = 0, lastTap = 0, moved = false;
    stage.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { sx = e.clientX; sy = e.clientY; st = Date.now(); moved = false; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; startDist = Math.hypot(a.x - b.x, a.y - b.y); startZoom = zoom; }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) moved = true;
      if (pts.size === 2 && startDist) { const [a, b] = [...pts.values()]; setZoom(startZoom * Math.hypot(a.x - b.x, a.y - b.y) / startDist, true); }
    });
    const up = (e) => {
      const wasPinch = pts.size === 2;
      pts.delete(e.pointerId);
      if (wasPinch) { startDist = 0; return; }
      if (pts.size) return;
      const dx = e.clientX - sx, dy = e.clientY - sy, dt = Date.now() - st;
      if (zoom <= 1.01 && dt < 500 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && items[idx]?.kind !== 'pdf') { go(idx + (dx < 0 ? 1 : -1)); return; }
      if (!moved && dt < 300) {
        const now = Date.now();
        if (now - lastTap < 300) { setZoom(zoom > 1.2 ? 1 : 2.5); lastTap = 0; } else lastTap = now;
      }
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
  }

  function setZoom(z, live) {
    const prev = zoom;
    zoom = Math.max(1, Math.min(5, z));
    const box = stage.querySelector('.mv-content'); if (!box) return;
    // keep the centre of the view steady while zooming
    const cx = (stage.scrollLeft + stage.clientWidth / 2) / prev, cy = (stage.scrollTop + stage.clientHeight / 2) / prev;
    box.style.width = (zoom * 100) + '%';
    stage.classList.toggle('zoomed', zoom > 1.01);
    stage.scrollLeft = cx * zoom - stage.clientWidth / 2;
    stage.scrollTop = cy * zoom - stage.clientHeight / 2;
  }

  async function show() {
    const it = items[idx];
    if (pdfTask) { try { pdfTask.destroy(); } catch {} pdfTask = null; }
    zoom = 1; stage.classList.remove('zoomed'); stage.scrollTop = 0; stage.scrollLeft = 0;
    root.querySelector('#mvName').textContent = it.name || opts.title || 'Attachment';
    root.querySelector('#mvCount').textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
    root.querySelector('.prev').hidden = idx === 0;
    root.querySelector('.next').hidden = idx >= items.length - 1;
    root.querySelector('#mvDl').hidden = !(opts.onDownload || it.url);
    root.querySelector('#mvDots').innerHTML = items.length > 1 && items.length <= 12 ? items.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('') : '';
    if (it.kind === 'pdf') {
      stage.innerHTML = `<div class="mv-content mv-pdf"><p class="mv-msg"><span class="spinner"></span>Opening PDF…</p></div>`;
      try {
        const lib = await loadPdf();
        const res = await fetch(it.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        if (items[idx] !== it) return;
        pdfTask = lib.getDocument({ data: buf });
        const doc = await pdfTask.promise;
        const box = stage.querySelector('.mv-pdf'); if (!box || items[idx] !== it) return;
        box.innerHTML = '';
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.min(stage.clientWidth, 1100);
        root.querySelector('#mvCount').textContent = `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}${items.length > 1 ? ` · file ${idx + 1}/${items.length}` : ''}`;
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const v1 = page.getViewport({ scale: 1 });
          const scale = (width / v1.width) * dpr * 1.6;                 // extra resolution for zooming in
          const vp = page.getViewport({ scale });
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
          c.setAttribute('aria-label', `Page ${p}`);
          box.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          if (items[idx] !== it) return;
        }
      } catch (err) {
        console.warn('[MedH viewer]', err);
        const box = stage.querySelector('.mv-pdf');
        if (box) box.innerHTML = `<p class="mv-msg">Couldn’t show this PDF here. <button type="button" class="btn btn-primary btn-sm" data-mv="dl">Download it</button></p>`;
      }
    } else {
      stage.innerHTML = `<div class="mv-content"><img src="${esc(it.url)}" alt="${esc(it.name || 'Report page')}" draggable="false"></div>`;
      // preload neighbours so swiping feels instant
      [idx - 1, idx + 1].forEach((j) => { const n = items[j]; if (n && n.kind !== 'pdf') { const im = new Image(); im.src = n.url; } });
    }
  }
  function go(i) { if (i < 0 || i >= items.length || i === idx) return; idx = i; show(); }

  async function download() {
    if (opts.onDownload) return opts.onDownload(items[idx]);
    const it = items[idx]; if (!it?.url) return;
    try {
      const r = await fetch(it.url); const b = await r.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = it.name || 'report';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch { window.open(it.url, '_blank', 'noopener'); }
  }

  function open(list, start = 0, o = {}) {
    build();
    items = (list || []).filter((x) => x && x.url);
    if (!items.length) { alert('No files to show.'); return; }
    opts = o; idx = Math.max(0, Math.min(start, items.length - 1));
    lastFocus = document.activeElement;
    root.hidden = false; document.documentElement.classList.add('mv-open');
    history.pushState({ mv: 1 }, '');                // phone Back button closes the viewer
    show();
    root.querySelector('[data-mv="close"]').focus();
  }
  function close(fromPop) {
    if (!root || root.hidden) return;
    if (pdfTask) { try { pdfTask.destroy(); } catch {} pdfTask = null; }
    root.hidden = true; stage.innerHTML = ''; document.documentElement.classList.remove('mv-open');
    if (!fromPop && history.state?.mv) history.back();
    lastFocus?.focus?.();
  }

  window.MHViewer = { open, close };
})();
