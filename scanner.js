/* Medical History — in-browser document scanner.
 * Photo → find page edges → user adjusts 4 corners → perspective-flatten → optional tone clean-up.
 * Only geometry (crop / straighten / rotate) and whole-page brightness/contrast are changed:
 * no pixels are invented, nothing is removed or added. "Original" mode keeps colours untouched
 * (use it for X-rays and scan films).
 */
(() => {
  'use strict';

  const OUT_MAX = 2400;      // longest side of the flattened page
  const WORK_MAX = 4000;     // cap on the source image kept in memory
  const $ = (s, el = document) => el.querySelector(s);

  // ---------- image helpers ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open this photo. Try a JPG or PNG.')); };
      img.src = url;
    });
  }
  function toCanvas(img, max) {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const k = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function rotate90(src) {
    const c = document.createElement('canvas');
    c.width = src.height; c.height = src.width;
    const g = c.getContext('2d');
    g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0);
    return c;
  }

  // ---------- page edge detection (bright paper on darker background) ----------
  function detectCorners(src) {
    const k = 360 / Math.max(src.width, src.height);
    const w = Math.max(8, Math.round(src.width * k)), h = Math.max(8, Math.round(src.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      gray[j] = v; hist[v]++;
    }
    // Otsu threshold
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128; const total = w * h;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = t; }
    }
    // largest bright connected region
    const seen = new Uint8Array(w * h);
    let bestPts = null, bestN = 0;
    const stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || gray[s] <= thr) continue;
      let sp = 0, n = 0; stack[sp++] = s; seen[s] = 1;
      let tl = s, br = s, tr = s, bl = s;
      const score = (p, f) => f(p % w, (p / w) | 0);
      while (sp) {
        const p = stack[--sp]; n++;
        const x = p % w, y = (p / w) | 0;
        if (x + y < score(tl, (a, b) => a + b)) tl = p;
        if (x + y > score(br, (a, b) => a + b)) br = p;
        if (x - y > score(tr, (a, b) => a - b)) tr = p;
        if (x - y < score(bl, (a, b) => a - b)) bl = p;
        const nb = [p - 1, p + 1, p - w, p + w];
        for (let q = 0; q < 4; q++) {
          const v = nb[q];
          if (v < 0 || v >= w * h || seen[v] || gray[v] <= thr) continue;
          if ((q === 0 && x === 0) || (q === 1 && x === w - 1)) continue;
          seen[v] = 1; stack[sp++] = v;
        }
      }
      if (n > bestN) { bestN = n; bestPts = [tl, tr, br, bl]; }
    }
    const inv = 1 / k;
    if (!bestPts || bestN < total * 0.15) return defaultCorners(src);
    return bestPts.map((p) => ({ x: (p % w) * inv, y: ((p / w) | 0) * inv }));
  }
  function defaultCorners(src) {
    const mx = src.width * 0.04, my = src.height * 0.04;
    return [{ x: mx, y: my }, { x: src.width - mx, y: my }, { x: src.width - mx, y: src.height - my }, { x: mx, y: src.height - my }];
  }
  const fullCorners = (src) => [{ x: 0, y: 0 }, { x: src.width, y: 0 }, { x: src.width, y: src.height }, { x: 0, y: src.height }];

  // ---------- perspective flatten ----------
  // homography H mapping destination (u,v) → source (x,y)
  function homography(dst, srcQ) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = dst[i], { x, y } = srcQ[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    // gaussian elimination
    for (let c = 0; c < 8; c++) {
      let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [...h, 1];
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function flatten(src, q) {
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, OUT_MAX / Math.max(W, H));
    W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));
    const h = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], q);
    const sw = src.width, sh = src.height;
    const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const og = out.getContext('2d');
    const od = og.createImageData(W, H);
    const o = od.data;
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const den = h[6] * u + h[7] * v + 1;
        let x = (h[0] * u + h[1] * v + h[2]) / den;
        let y = (h[3] * u + h[4] * v + h[5]) / den;
        if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
        if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const oi = (v * W + u) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const a = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
          const c2 = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
          o[oi + ch] = a + (c2 - a) * fy;
        }
        o[oi + 3] = 255;
      }
    }
    og.putImageData(od, 0, 0);
    return out;
  }

  // ---------- tone (whole page only — never local edits) ----------
  function applyTone(canvas, mode) {
    if (mode === 'original') return canvas;
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d'); g.drawImage(canvas, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height); const d = im.data;
    const n = d.length / 4;
    const pct = (hist, p) => { let acc = 0; const target = n * p; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
    if (mode === 'bw') {
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
      const lo = pct(hist, 0.02), hi = Math.max(lo + 1, pct(hist, 0.92));
      for (let i = 0; i < d.length; i += 4) { const y = Math.max(0, Math.min(255, (d[i] - lo) * 255 / (hi - lo))); d[i] = d[i + 1] = d[i + 2] = y; }
    } else { // clean: per-channel levels → white paper, dark ink, true colours kept
      const hs = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let i = 0; i < d.length; i += 4) { hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; }
      const lo = hs.map((h) => pct(h, 0.01)), hi = hs.map((h, k) => Math.max(lo[k] + 1, pct(h, 0.95)));
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - lo[k]) * 255 / (hi[k] - lo[k])));
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  // ---------- UI ----------
  let state = null;   // { src, corners, mode, pages, side, onDone }
  const dlg = () => $('#scanDialog');

  function show(step) {
    dlg().querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== step; });
    const n = state.pages.length;
    $('#scanCount').textContent = n ? `${n} page${n > 1 ? 's' : ''} scanned` : '';
  }

  function sideLabel() {
    const pageNo = state.pages.filter((p) => p.side !== 'back').length + (state.side === 'back' ? 0 : 1);
    return state.side === 'back' ? `Page ${pageNo} · Back side` : `Page ${pageNo} · Front side`;
  }

  function capture(side) {
    state.side = side;
    $('#scanSide').textContent = sideLabel();
    $('#scanCaptureTitle').textContent = side === 'back' ? 'Now the back side' : (state.pages.length ? 'Next page' : 'Scan a document');
    show('capture');
  }

  async function onPhoto(file) {
    try {
      $('#scanBusy').hidden = false;
      const img = await loadImage(file);
      state.src = toCanvas(img, WORK_MAX);
      state.corners = detectCorners(state.src);
      $('#scanBusy').hidden = true;
      show('adjust');
      drawAdjust();
    } catch (err) {
      $('#scanBusy').hidden = true;
      alert(err.message);
    }
  }

  // corner editor
  let view = { k: 1 };
  function drawAdjust() {
    const cv = $('#scanCanvas');
    const stage = $('#scanStage');
    const cs = getComputedStyle(stage);
    const maxW = Math.max(200, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const maxH = Math.min(window.innerHeight * 0.55, 640);
    const k = Math.min(maxW / state.src.width, maxH / state.src.height);
    view.k = k;
    cv.width = Math.round(state.src.width * k); cv.height = Math.round(state.src.height * k);
    cv.getContext('2d').drawImage(state.src, 0, 0, cv.width, cv.height);
    const svg = $('#scanOverlay');
    svg.setAttribute('viewBox', `0 0 ${cv.width} ${cv.height}`);
    svg.style.width = cv.width + 'px'; svg.style.height = cv.height + 'px';
    placeHandles();
  }
  function placeHandles() {
    const pts = state.corners.map((p) => `${p.x * view.k},${p.y * view.k}`).join(' ');
    $('#scanPoly').setAttribute('points', pts);
    $('#scanShade').setAttribute('d', `M0 0H${$('#scanCanvas').width}V${$('#scanCanvas').height}H0Z M${pts.split(' ').join(' L')} Z`);
    document.querySelectorAll('.scan-h').forEach((h, i) => {
      h.style.left = state.corners[i].x * view.k + 'px';
      h.style.top = state.corners[i].y * view.k + 'px';
    });
  }
  function bindHandles() {
    document.querySelectorAll('.scan-h').forEach((h, i) => {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag');
        const rect = $('#scanCanvas').getBoundingClientRect();
        const move = (ev) => {
          const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left)) / view.k;
          const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top)) / view.k;
          state.corners[i] = { x, y }; placeHandles();
        };
        const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
      h.addEventListener('keydown', (e) => {
        const step = 6 / view.k, c = state.corners[i];
        const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!m) return; e.preventDefault();
        state.corners[i] = { x: Math.max(0, Math.min(state.src.width, c.x + m[0])), y: Math.max(0, Math.min(state.src.height, c.y + m[1])) };
        placeHandles();
      });
    });
  }

  function makeResult() {
    $('#scanBusy').hidden = false;
    requestAnimationFrame(() => setTimeout(() => {
      state.flat = flatten(state.src, state.corners);
      renderResult();
      $('#scanBusy').hidden = true;
      show('result');
    }, 20));
  }
  function renderResult() {
    state.out = applyTone(state.flat, state.mode);
    const cv = $('#scanResult');
    cv.width = state.out.width; cv.height = state.out.height;
    cv.getContext('2d').drawImage(state.out, 0, 0);
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    $('#scanModeHint').textContent = state.mode === 'original'
      ? 'Original colours — best for X-rays, scan films and photos.'
      : state.mode === 'bw' ? 'Black & white — sharp text for printed reports.' : 'Clean — white paper, dark text, true colours.';
  }

  function keepPage() {
    const n = state.pages.filter((p) => p.side !== 'back').length + (state.side === 'back' ? 0 : 1);
    state.pages.push({
      dataUrl: state.out.toDataURL('image/jpeg', 0.9),
      side: state.side, page: n, mode: state.mode,
      name: `Scan ${state.docLabel} – page ${n}${state.side === 'back' ? ' (back)' : ' (front)'}.jpg`,
    });
    state.src = state.flat = state.out = null;
    if (state.side === 'front') show('back'); else show('more');
  }

  function finish() {
    const pages = state.pages;
    const done = state.onDone;
    dlg().close();
    if (pages.length) done(pages, state.docId);
  }

  function bind() {
    const d = dlg();
    $('#scanCam').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); });
    $('#scanPick').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); });
    bindHandles();
    $('#scanRotate').addEventListener('click', () => { state.src = rotate90(state.src); state.corners = detectCorners(state.src); drawAdjust(); });
    $('#scanAuto').addEventListener('click', () => { state.corners = detectCorners(state.src); placeHandles(); });
    $('#scanFull').addEventListener('click', () => { state.corners = fullCorners(state.src); placeHandles(); });
    $('#scanRetake').addEventListener('click', () => capture(state.side));
    $('#scanNext').addEventListener('click', makeResult);
    $('#scanBackAdjust').addEventListener('click', () => { show('adjust'); drawAdjust(); });
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; renderResult(); }));
    $('#scanKeep').addEventListener('click', keepPage);
    $('#scanAddBack').addEventListener('click', () => capture('back'));
    $('#scanNoBack').addEventListener('click', () => show('more'));
    $('#scanAddPage').addEventListener('click', () => capture('front'));
    $('#scanDone').addEventListener('click', finish);
    d.addEventListener('click', (e) => { if (e.target.closest('[data-scan-close]')) { if (!state.pages.length || confirm('Discard the scanned pages?')) d.close(); } });
    d.addEventListener('cancel', (e) => { if (state.pages.length && !confirm('Discard the scanned pages?')) e.preventDefault(); });
    window.addEventListener('resize', () => { if (!d.open || $('[data-step="adjust"]').hidden) return; drawAdjust(); });
  }

  let bound = false;
  let docCounter = 0;
  window.MHScanner = {
    open({ onDone }) {
      if (!bound) { bind(); bound = true; }
      docCounter++;
      state = { pages: [], side: 'front', mode: 'clean', onDone, docId: 'doc-' + Date.now().toString(36), docLabel: String.fromCharCode(64 + ((docCounter - 1) % 26) + 1) };
      const d = dlg();
      d.showModal ? d.showModal() : d.setAttribute('open', '');
      capture('front');
    },
  };

  // ---------- PDF export ----------
  // pages: [{ dataUrl, name }] (JPEG/PNG). Builds an A4-width PDF, one page per image, at full quality.
  window.MHPdf = {
    async build(pages, title) {
      const { jsPDF } = window.jspdf || {};
      if (!jsPDF) throw new Error('PDF tool did not load. Check your connection and try again.');
      let pdf = null;
      for (const p of pages) {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read a page')); i.src = p.dataUrl; });
        const w = 210, h = (img.naturalHeight / img.naturalWidth) * 210; // mm, A4 width
        const orient = h >= w ? 'p' : 'l';
        if (!pdf) pdf = new jsPDF({ orientation: orient, unit: 'mm', format: [w, h], compress: true });
        else pdf.addPage([w, h], orient);
        const fmt = /^data:image\/png/.test(p.dataUrl) ? 'PNG' : 'JPEG';
        pdf.addImage(p.dataUrl, fmt, 0, 0, w, h, undefined, 'FAST');
      }
      if (!pdf) throw new Error('No pages to put in the PDF.');
      pdf.setProperties({ title: title || 'Medical History scan', creator: 'Medical History' });
      return pdf;
    },
  };
})();
