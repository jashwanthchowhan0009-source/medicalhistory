/* Health History — front-end app.
 * Records live on the user's device (IndexedDB). Files are sent to /api/scan only while scanning.
 */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (iso) => {
    if (!iso) return 'Date unknown';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d)) return iso;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };
  const setStatus = (el, msg, kind = '') => {
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = msg;
  };
  const spin = (t) => `<span class="spinner" aria-hidden="true"></span>${esc(t)}`;

  // ---------- Storage (IndexedDB) ----------
  const DB_NAME = 'health-history';
  const STORE = 'entries';
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const getAll = () => tx('readonly', (s) => s.getAll());
  const putEntry = (e) => tx('readwrite', (s) => s.put(e));
  const delEntry = (id) => tx('readwrite', (s) => s.delete(id));
  const clearAll = () => tx('readwrite', (s) => s.clear());

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let entries = [];
  async function loadEntries() {
    entries = (await getAll()).sort(byDateDesc);
  }
  function byDateDesc(a, b) {
    const da = a.date || a.createdAt || '';
    const dbb = b.date || b.createdAt || '';
    return dbb.localeCompare(da);
  }

  // ---------- Routing ----------
  const VIEWS = ['home', 'history', 'profile'];
  function route() {
    const name = (location.hash || '#home').slice(1).split('/')[0];
    const view = VIEWS.includes(name) ? name : 'home';
    $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
    $$('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'history') renderHistory();
    if (view === 'profile') renderProfile();
    if (view === 'home') renderRecent();
    window.scrollTo(0, 0);
    // scroll to a specific record: #history/<id>
    const target = location.hash.split('/')[1];
    if (view === 'history' && target) {
      requestAnimationFrame(() => document.getElementById('rec-' + target)?.scrollIntoView({ block: 'start' }));
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- Upload / pending ----------
  const MAX_FILES = 10;
  const MAX_SIDE = 1800;          // px, longest edge after compression
  const MAX_PDF_BYTES = 3.5e6;    // keep request under serverless body limits
  let pending = [];               // { id, name, mediaType, dataUrl }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open image'));
      img.src = src;
    });
  }
  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addFiles(fileList) {
    const scanStatus = $('#scanStatus');
    const files = [...fileList];
    for (const f of files) {
      if (pending.length >= MAX_FILES) { setStatus(scanStatus, `Up to ${MAX_FILES} files per scan.`, 'error'); break; }
      try {
        if (f.type === 'application/pdf') {
          if (f.size > MAX_PDF_BYTES) { setStatus(scanStatus, `${esc(f.name)} is too large (max 3.5 MB PDF). Try photos of the pages instead.`, 'error'); continue; }
          pending.push({ id: uid(), name: f.name, mediaType: 'application/pdf', dataUrl: await readAsDataURL(f) });
        } else if (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)) {
          const dataUrl = await compressImage(f);
          pending.push({ id: uid(), name: f.name, mediaType: 'image/jpeg', dataUrl });
        } else {
          setStatus(scanStatus, `${esc(f.name)}: only images and PDFs are supported.`, 'error');
        }
      } catch {
        setStatus(scanStatus, `Couldn’t read ${esc(f.name)}. If it’s HEIC, try exporting as JPG.`, 'error');
      }
    }
    renderPending();
  }

  function renderPending() {
    const wrap = $('#pending');
    wrap.hidden = pending.length === 0;
    $('#pendingCount').textContent = pending.length;
    $('#pendingList').innerHTML = pending.map((p) => `
      <li class="thumb">
        ${p.mediaType === 'application/pdf'
          ? `<div class="pdf">PDF<small>${esc(p.name)}</small></div>`
          : `<img src="${p.dataUrl}" alt="${esc(p.name)}">`}
        <button class="remove" type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </li>`).join('');
  }

  // ---------- AI calls ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }
  const toApiFile = (f) => ({ name: f.name, mediaType: f.mediaType, data: f.dataUrl.split(',')[1] });

  function entryFromAI(ai, files) {
    const idx = Array.isArray(ai.sourceIndexes) && ai.sourceIndexes.length ? ai.sourceIndexes : files.map((_, i) => i);
    return {
      id: uid(),
      createdAt: new Date().toISOString(),
      scanned: true,
      date: ai.date || '',
      title: ai.title || 'Health record',
      documentType: ai.documentType || '',
      madeBy: ai.madeBy || '',
      reportSays: ai.reportSays || '',
      findings: Array.isArray(ai.findings) ? ai.findings : [],
      doctor: ai.doctor || '',
      hospital: ai.hospital || '',
      diagnosis: ai.diagnosis || '',
      suggestions: ai.suggestions || '',
      medicines: Array.isArray(ai.medicines) ? ai.medicines : [],
      billAmount: ai.billAmount || '',
      tldr: ai.tldr || '',
      files: idx.map((i) => files[i]).filter(Boolean),
    };
  }

  async function scanPending() {
    if (!pending.length) return;
    const btn = $('#scanBtn');
    const status = $('#scanStatus');
    const files = pending.slice();
    btn.disabled = true;
    setStatus(status, spin(`Reading ${files.length} file${files.length > 1 ? 's' : ''}… this takes ~20 seconds`));
    try {
      const data = await api('/api/scan', { files: files.map(toApiFile) });
      const list = (data.entries || []).map((e) => entryFromAI(e, files));
      if (!list.length) throw new Error('The AI could not find a health record in these files.');
      // make sure every file is kept somewhere
      const used = new Set(list.flatMap((e) => e.files.map((f) => f.id)));
      const orphans = files.filter((f) => !used.has(f.id));
      if (orphans.length) list[0].files.push(...orphans);
      for (const e of list) await putEntry(e);
      pending = [];
      renderPending();
      await loadEntries();
      setStatus(status, `Saved ${list.length} record${list.length > 1 ? 's' : ''} to your history.`, 'ok');
      location.hash = '#history/' + list[0].id;
    } catch (err) {
      // keep the files safe even if AI fails
      const e = {
        id: uid(), createdAt: new Date().toISOString(), scanned: false,
        date: new Date().toISOString().slice(0, 10), title: 'Uploaded — not scanned yet',
        files, error: err.message,
      };
      await putEntry(e);
      pending = [];
      renderPending();
      await loadEntries();
      setStatus(status, `AI scan failed: ${esc(err.message)}. Your files are saved — use “Retry scan” in History.`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function retryScan(id, btn) {
    const old = entries.find((e) => e.id === id);
    if (!old) return;
    btn.disabled = true;
    btn.innerHTML = spin('Scanning…');
    try {
      const data = await api('/api/scan', { files: old.files.map(toApiFile) });
      const list = (data.entries || []).map((e) => entryFromAI(e, old.files));
      if (!list.length) throw new Error('No health record found');
      for (const e of list) await putEntry(e);
      await delEntry(id);
      await loadEntries();
      renderHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry scan';
      alert('Scan failed: ' + err.message);
    }
  }

  // ---------- Home: recent ----------
  function renderRecent() {
    const wrap = $('#recentWrap');
    const recent = entries.slice(0, 3);
    wrap.hidden = !recent.length;
    $('#recentList').innerHTML = recent.map((e) => `
      <li><a href="#history/${e.id}"><span>${esc(e.title)}${e.madeBy ? ` <span class="muted">· ${esc(e.madeBy)}</span>` : ''}</span><span class="r-date">${esc(fmtDate(e.date))}</span></a></li>`).join('');
  }

  // ---------- History ----------
  function matches(e, q) {
    if (!q) return true;
    const hay = [e.title, e.madeBy, e.reportSays, e.doctor, e.hospital, e.diagnosis, e.suggestions, e.tldr, e.documentType,
      ...(e.medicines || []).map((m) => m.name), ...(e.findings || []).map((f) => f.name)].join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function flagClass(flag) {
    const f = String(flag || '').toLowerCase();
    if (f.startsWith('h')) return 'flag-high';
    if (f.startsWith('l')) return 'flag-low';
    return '';
  }

  function cardHTML(e) {
    if (!e.scanned) {
      return `
      <article class="t-card unscanned">
        <p class="label-row"><span class="k">${esc(e.title)}</span></p>
        <p class="muted">${esc(e.error ? 'Last attempt: ' + e.error : 'These files are stored but haven’t been read by the AI.')}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-sm" type="button" data-retry="${e.id}">Retry scan</button>
          <button class="btn btn-outline btn-sm" type="button" data-sources="${e.id}">Sources (${e.files.length})</button>
          <span class="spacer"></span>
          <button class="link-btn" type="button" data-delete="${e.id}">Delete</button>
        </div>
      </article>`;
    }
    const findings = (e.findings || []).filter((f) => f && f.name);
    const meds = (e.medicines || []).filter((m) => m && m.name);
    const hasDoctor = e.doctor || e.hospital || e.suggestions || meds.length || e.diagnosis;
    return `
      <article class="t-card">
        ${e.tldr ? `<div class="tldr"><span class="tldr-k">TL;DR</span><p>${esc(e.tldr)}</p></div>` : ''}

        <p class="label-row">
          <span class="k">${esc(e.title)}</span>
          ${e.madeBy ? `<span class="sep">|</span><span class="v">Made by ${esc(e.madeBy)}</span>` : ''}
          ${e.documentType ? `<span class="tag">${esc(e.documentType)}</span>` : ''}
        </p>
        ${(e.reportSays || findings.length) ? `
        <div class="block">
          <p class="block-title">What the report says</p>
          ${e.reportSays ? `<p>${esc(e.reportSays)}</p>` : ''}
          ${findings.length ? `
          <div class="findings-wrap"><table class="findings">
            <thead><tr><th scope="col">Test</th><th scope="col">Result</th><th scope="col">Normal range</th></tr></thead>
            <tbody>${findings.map((f) => `
              <tr><td>${esc(f.name)}</td>
              <td class="${flagClass(f.flag)}">${esc(f.value)} ${esc(f.unit || '')}${flagClass(f.flag) ? ` (${esc(f.flag)})` : ''}</td>
              <td>${esc(f.range || '—')}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
        </div>` : ''}

        ${hasDoctor ? `
        <p class="label-row">
          <span class="k">Consulted doctor</span>
          ${e.doctor ? `<span class="sep">|</span><span class="v">${esc(e.doctor)}</span>` : ''}
          ${e.hospital ? `<span class="sep">|</span><span class="v">${esc(e.hospital)}</span>` : ''}
        </p>
        <div class="block">
          <p class="block-title">What the doctor suggested</p>
          ${e.diagnosis ? `<p><strong>Diagnosis:</strong> ${esc(e.diagnosis)}</p>` : ''}
          ${e.suggestions ? `<p>${esc(e.suggestions)}</p>` : (!meds.length && !e.diagnosis ? '<p class="muted">No advice written on this document.</p>' : '')}
          ${meds.length ? `
          <p class="block-title" style="margin-top:10px">Tablets / medicines given</p>
          <ul class="meds">${meds.map((m) => `
            <li><span class="pill" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="8" width="18" height="8" rx="4"/><path d="M12 8v8"/></svg></span>
            <div><strong>${esc(m.name)}</strong><span>${esc([m.dose, m.frequency, m.duration].filter(Boolean).join(' · '))}</span></div></li>`).join('')}
          </ul>` : ''}
        </div>` : ''}

        ${e.billAmount ? `<p class="muted">Bill amount: <strong style="color:var(--ink)">${esc(e.billAmount)}</strong></p>` : ''}

        <div class="card-actions">
          <button class="btn btn-outline btn-sm" type="button" data-sources="${e.id}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/></svg>
            Sources (${(e.files || []).length})
          </button>
          <span class="spacer"></span>
          <button class="link-btn" type="button" data-delete="${e.id}">Delete</button>
        </div>
      </article>`;
  }

  function renderHistory() {
    const q = $('#searchInput').value.trim();
    const list = entries.filter((e) => matches(e, q));
    $('#historyEmpty').hidden = entries.length > 0;
    if (entries.length && !list.length) {
      $('#timeline').innerHTML = `<li class="muted">No records match “${esc(q)}”.</li>`;
      return;
    }
    $('#timeline').innerHTML = list.map((e) => `
      <li class="t-item" id="rec-${e.id}">
        <span class="t-dot" aria-hidden="true"></span>
        <div class="t-date">${esc(fmtDate(e.date))}${e.hospital ? `<small>${esc(e.hospital)}</small>` : ''}</div>
        ${cardHTML(e)}
      </li>`).join('');
  }

  // ---------- Sources dialog ----------
  function openSources(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const dlg = $('#sourcesDialog');
    $('#sourcesTitle').textContent = `Sources · ${e.title}`;
    $('#sourcesBody').innerHTML = (e.files || []).map((f, i) => {
      if (f.mediaType === 'application/pdf') {
        return `<figure class="source"><iframe src="${f.dataUrl}" title="${esc(f.name)}"></iframe><figcaption>${i + 1}. ${esc(f.name)}</figcaption></figure>`;
      }
      return `<figure class="source"><a href="${f.dataUrl}" target="_blank" rel="noopener"><img src="${f.dataUrl}" alt="Page ${i + 1}: ${esc(f.name)}"></a><figcaption>${i + 1}. ${esc(f.name)}</figcaption></figure>`;
    }).join('') || '<p class="muted">No files attached.</p>';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  // ---------- Profile ----------
  const PROFILE_KEY = 'hh-profile';
  const REPORT_KEY = 'hh-full-report';
  function profile() { return store.get(PROFILE_KEY, {}); }

  function paintAvatar() {
    const name = (profile().name || '').trim();
    const initial = name ? name[0].toUpperCase() : 'H';
    $('#avatarInitial').textContent = initial;
    $('#profileInitial').textContent = initial;
    $('#profileName').textContent = name || 'Your profile';
  }

  function renderProfile() {
    const p = profile();
    const form = $('#profileForm');
    for (const el of form.elements) if (el.name) el.value = p[el.name] || '';
    paintAvatar();
    const scanned = entries.filter((e) => e.scanned);
    $('#statRecords').textContent = entries.length;
    $('#statDoctors').textContent = new Set(scanned.map((e) => e.doctor).filter(Boolean)).size;
    const dated = scanned.map((e) => e.date).filter(Boolean).sort();
    $('#statLast').textContent = dated.length ? fmtDate(dated[dated.length - 1]) : '—';
    renderFullReport(store.get(REPORT_KEY, null));
  }

  function list(items) {
    const arr = (items || []).filter(Boolean);
    return arr.length ? `<ul>${arr.map((i) => `<li>${esc(typeof i === 'string' ? i : [i.name, i.detail].filter(Boolean).join(' — '))}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
  }

  function renderFullReport(r) {
    const el = $('#fullReport');
    $('#printBtn').hidden = !r;
    if (!r) { el.innerHTML = ''; return; }
    const p = profile();
    el.innerHTML = `
      <p><strong>${esc(p.name || 'Patient')}</strong>${p.dob ? ` · DOB ${esc(fmtDate(p.dob))}` : ''}${p.sex ? ` · ${esc(p.sex)}` : ''}${p.blood ? ` · Blood group ${esc(p.blood)}` : ''}</p>
      <h3>Overview</h3><p>${esc(r.overview)}</p>
      <h3>Conditions &amp; diagnoses</h3>${list(r.conditions)}
      <h3>Current / recent medicines</h3>${list(r.medicines)}
      <h3>Allergies</h3>${list(r.allergies)}
      <h3>Key test results over time</h3>${list(r.keyResults)}
      <h3>Doctors &amp; hospitals</h3>${list(r.careTeam)}
      <h3>Things to watch</h3>${list(r.watchouts)}
      <p class="generated">Generated ${esc(fmtDate((r.generatedAt || '').slice(0, 10)))} from ${esc(r.basedOn)} record(s). Not medical advice.</p>`;
  }

  async function generateFullReport() {
    const btn = $('#genReportBtn');
    const status = $('#genStatus');
    const scanned = entries.filter((e) => e.scanned);
    if (!scanned.length) { setStatus(status, 'Add and scan at least one report first.', 'error'); return; }
    btn.disabled = true;
    setStatus(status, spin('Building your complete health report…'));
    try {
      const records = scanned.map(({ files, id, createdAt, scanned: _s, error, ...rest }) => rest);
      const r = await api('/api/summary', { profile: profile(), records });
      r.generatedAt = new Date().toISOString();
      r.basedOn = scanned.length;
      store.set(REPORT_KEY, r);
      renderFullReport(r);
      setStatus(status, 'Done.', 'ok');
      btn.textContent = 'Regenerate';
    } catch (err) {
      setStatus(status, 'Could not generate: ' + esc(err.message), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Events ----------
  function bind() {
    $('#cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('#galleryInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    $('#pendingList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      pending = pending.filter((p) => p.id !== b.dataset.remove);
      renderPending();
    });
    $('#clearPending').addEventListener('click', () => { pending = []; renderPending(); setStatus($('#scanStatus'), ''); });
    $('#scanBtn').addEventListener('click', scanPending);

    $('#searchInput').addEventListener('input', renderHistory);
    $('#timeline').addEventListener('click', async (e) => {
      const s = e.target.closest('[data-sources]');
      if (s) return openSources(s.dataset.sources);
      const r = e.target.closest('[data-retry]');
      if (r) return retryScan(r.dataset.retry, r);
      const d = e.target.closest('[data-delete]');
      if (d && confirm('Delete this record and its files from this device?')) {
        await delEntry(d.dataset.delete);
        await loadEntries();
        renderHistory();
      }
    });

    const dlg = $('#sourcesDialog');
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });

    $('#profileForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      store.set(PROFILE_KEY, data);
      paintAvatar();
      setStatus($('#profileStatus'), 'Saved.', 'ok');
    });
    $('#genReportBtn').addEventListener('click', generateFullReport);
    $('#printBtn').addEventListener('click', () => {
      const panel = $('#fullReport').closest('.panel');
      panel.classList.add('print-me');
      window.print();
      panel.classList.remove('print-me');
    });

    $('#exportBtn').addEventListener('click', async () => {
      const blob = new Blob([JSON.stringify({ app: 'health-history', version: 1, profile: profile(), entries: await getAll() })], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `health-history-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#importInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (data.app !== 'health-history' || !Array.isArray(data.entries)) throw new Error('Not a Health History backup');
        for (const en of data.entries) if (en && en.id) await putEntry(en);
        if (data.profile) store.set(PROFILE_KEY, data.profile);
        await loadEntries();
        renderProfile();
        alert(`Imported ${data.entries.length} record(s).`);
      } catch (err) { alert('Import failed: ' + err.message); }
    });
    $('#wipeBtn').addEventListener('click', async () => {
      if (!confirm('Delete ALL records, files and profile from this device? This cannot be undone.')) return;
      await clearAll();
      store.del(PROFILE_KEY); store.del(REPORT_KEY);
      await loadEntries();
      renderProfile();
    });
  }

  // ---------- Boot ----------
  (async function init() {
    bind();
    paintAvatar();
    try { await loadEntries(); } catch { entries = []; }
    route();
  })();
})();
