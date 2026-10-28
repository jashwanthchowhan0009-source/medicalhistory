/* Health History — front-end app.
 * Login with email + password (Supabase Auth). Records are saved to the user's account
 * (Postgres, row-level security) and report files to private storage. Files go to /api/scan only while scanning.
 */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (iso) => {
    if (!iso) return 'Date unknown';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d)) return iso;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const setStatus = (el, msg, kind = '') => {
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = msg;
  };
  const spin = (t) => `<span class="spinner" aria-hidden="true"></span>${esc(t)}`;

  // ---------- Supabase ----------
  const CFG = window.HH_CONFIG || {};
  const configured = CFG.supabaseUrl && !CFG.supabaseUrl.startsWith('__') && window.supabase;
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;
  const BUCKET = 'hh-reports';
  let user = null;
  let session = null;

  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  }

  // ---------- Data layer ----------
  let entries = [];
  let profileData = {};
  let fullReport = null;

  function byDateDesc(a, b) {
    return (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '');
  }

  async function loadEntries() {
    const { data, error } = await sb.from('hh_records').select('id, data, created_at').order('created_at', { ascending: false });
    if (error) throw error;
    entries = (data || []).map((r) => ({ ...r.data, id: r.id, createdAt: r.data.createdAt || r.created_at })).sort(byDateDesc);
  }

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = head.match(/data:(.*?);/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Upload any not-yet-stored files, then save the record row.
  async function putEntry(e) {
    const files = [];
    for (const f of e.files || []) {
      if (!f.path && f.dataUrl) {
        const ext = f.mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        const path = `${user.id}/${e.id}/${f.id}.${ext}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, dataUrlToBlob(f.dataUrl), { contentType: f.mediaType, upsert: true });
        if (error) throw new Error('File upload failed: ' + error.message);
        files.push({ id: f.id, name: f.name, mediaType: f.mediaType, path });
      } else {
        files.push({ id: f.id, name: f.name, mediaType: f.mediaType, path: f.path });
      }
    }
    const { id, ...rest } = e;
    const data = { ...rest, files };
    const { error } = await sb.from('hh_records').upsert({ id, user_id: user.id, record_date: isoDate(e.date), data });
    if (error) throw new Error('Save failed: ' + error.message);
  }

  async function delEntry(id, { keepFiles = false } = {}) {
    const e = entries.find((x) => x.id === id);
    if (!keepFiles) {
      const paths = (e?.files || []).map((f) => f.path).filter(Boolean);
      if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    }
    const { error } = await sb.from('hh_records').delete().eq('id', id);
    if (error) throw error;
  }

  async function clearAll() {
    for (const e of entries) await delEntry(e.id);
  }

  async function fileAsDataURL(f) {
    if (f.dataUrl) return f.dataUrl;
    const { data, error } = await sb.storage.from(BUCKET).download(f.path);
    if (error) throw error;
    return blobToDataURL(data);
  }

  async function loadProfile() {
    const { data, error } = await sb.from('hh_profiles').select('data, full_report').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    profileData = data?.data || {};
    if (!profileData.name && user.user_metadata?.full_name) profileData.name = user.user_metadata.full_name;
    fullReport = data?.full_report || null;
  }
  async function saveProfile(patch) {
    const row = { user_id: user.id };
    if ('data' in patch) { profileData = patch.data; row.data = patch.data; }
    if ('full_report' in patch) { fullReport = patch.full_report; row.full_report = patch.full_report; }
    const { error } = await sb.from('hh_profiles').upsert(row);
    if (error) throw new Error('Save failed: ' + error.message);
  }

  // ---------- Routing ----------
  const VIEWS = ['home', 'history', 'profile'];
  function showView(view) {
    $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  }
  function route() {
    if (!user) { showView('auth'); return; }
    const name = (location.hash || '#home').slice(1).split('/')[0];
    const view = VIEWS.includes(name) ? name : 'home';
    showView(view);
    $$('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'history') renderHistory();
    if (view === 'profile') renderProfile();
    if (view === 'home') renderRecent();
    window.scrollTo(0, 0);
    const target = location.hash.split('/')[1];
    if (view === 'history' && target) {
      requestAnimationFrame(() => document.getElementById('rec-' + target)?.scrollIntoView({ block: 'start' }));
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- Auth ----------
  let authMode = 'login'; // login | signup | reset | newpass
  let recoveryMode = location.hash.includes('type=recovery');

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    $('#tabLogin').setAttribute('aria-selected', String(mode === 'login'));
    $('#tabSignup').setAttribute('aria-selected', String(signup));
    $('.tabs').hidden = mode === 'reset' || mode === 'newpass';
    $('#nameField').hidden = !signup;
    $('#pwHint').hidden = !(signup || mode === 'newpass');
    $('#passwordField').hidden = mode === 'reset';
    $('#au-email').closest('.field').hidden = mode === 'newpass';
    $('#forgotBtn').hidden = mode !== 'login';
    $('#au-password').setAttribute('autocomplete', signup || mode === 'newpass' ? 'new-password' : 'current-password');
    const t = {
      login: ['Welcome', 'Log in to Health History', 'Log in'],
      signup: ['New here', 'Create your account', 'Create account'],
      reset: ['Reset', 'Reset your password', 'Send reset link'],
      newpass: ['Reset', 'Choose a new password', 'Save new password'],
    }[mode];
    $('#authEyebrow').textContent = t[0];
    $('#authTitle').textContent = t[1];
    $('#authSubmit').textContent = t[2];
    setStatus($('#authStatus'), mode === 'reset' ? 'We’ll email you a link to set a new password. <button type="button" class="link-btn" id="backToLogin">Back to log in</button>' : '');
  }

  async function onAuthSubmit(ev) {
    ev.preventDefault();
    const status = $('#authStatus');
    const email = $('#au-email').value.trim();
    const password = $('#au-password').value;
    const name = $('#au-name').value.trim();
    const btn = $('#authSubmit');
    if (authMode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) return setStatus(status, 'Enter a valid email.', 'error');
    if ((authMode === 'signup' || authMode === 'newpass') && password.length < 8) return setStatus(status, 'Password must be at least 8 characters.', 'error');
    if (authMode === 'login' && !password) return setStatus(status, 'Enter your password.', 'error');
    btn.disabled = true;
    try {
      if (authMode === 'login') {
        setStatus(status, spin('Logging in…'));
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (authMode === 'signup') {
        setStatus(status, spin('Creating account…'));
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { full_name: name }, emailRedirectTo: location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMode('login');
          $('#au-email').value = email;
          setStatus(status, `Check <strong>${esc(email)}</strong> for a confirmation link, then log in here.`, 'ok');
        }
      } else if (authMode === 'reset') {
        setStatus(status, spin('Sending…'));
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
        if (error) throw error;
        setStatus(status, `If an account exists for <strong>${esc(email)}</strong>, a reset link is on its way.`, 'ok');
      } else if (authMode === 'newpass') {
        setStatus(status, spin('Saving…'));
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        recoveryMode = false;
        history.replaceState(null, '', location.pathname + '#home');
        setStatus(status, 'Password updated.', 'ok');
        await onSignedIn((await sb.auth.getSession()).data.session);
      }
    } catch (err) {
      const msg = /invalid login/i.test(err.message) ? 'Wrong email or password.' : err.message;
      setStatus(status, esc(msg), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function onSignedIn(s) {
    session = s;
    user = s?.user || null;
    if (!user) return;
    document.body.classList.remove('signed-out');
    try {
      await Promise.all([loadEntries(), loadProfile()]);
    } catch (err) {
      entries = [];
      console.error(err);
    }
    paintAvatar();
    if (!location.hash || location.hash.includes('access_token') || location.hash.includes('type=')) {
      history.replaceState(null, '', location.pathname + '#home');
    }
    route();
  }

  function onSignedOut() {
    user = null; session = null; entries = []; profileData = {}; fullReport = null;
    document.body.classList.add('signed-out');
    setAuthMode('login');
    showView('auth');
  }

  // ---------- Upload / pending ----------
  const MAX_FILES = 10;
  const MAX_SIDE = 1800;
  const MAX_PDF_BYTES = 3.5e6;
  let pending = [];

  function readAsDataURL(file) { return blobToDataURL(file); }
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
    for (const f of [...fileList]) {
      if (pending.length >= MAX_FILES) { setStatus(scanStatus, `Up to ${MAX_FILES} files per scan.`, 'error'); break; }
      try {
        if (f.type === 'application/pdf') {
          if (f.size > MAX_PDF_BYTES) { setStatus(scanStatus, `${esc(f.name)} is too large (max 3.5 MB PDF). Try photos of the pages instead.`, 'error'); continue; }
          pending.push({ id: uid(), name: f.name, mediaType: 'application/pdf', dataUrl: await readAsDataURL(f) });
        } else if (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)) {
          pending.push({ id: uid(), name: f.name, mediaType: 'image/jpeg', dataUrl: await compressImage(f) });
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
    $('#pending').hidden = pending.length === 0;
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }
  const toApiFile = async (f) => ({ name: f.name, mediaType: f.mediaType, data: (await fileAsDataURL(f)).split(',')[1] });

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
      files: [...new Set(idx)].map((i) => files[i]).filter(Boolean),
    };
  }

  // Each file belongs to exactly one record; leftovers go to the first.
  function assignFiles(list, files) {
    const used = new Set();
    for (const e of list) e.files = e.files.filter((f) => !used.has(f.id) && used.add(f.id));
    const orphans = files.filter((f) => !used.has(f.id));
    if (orphans.length) list[0].files.push(...orphans);
  }

  async function scanPending() {
    if (!pending.length) return;
    const btn = $('#scanBtn');
    const status = $('#scanStatus');
    const files = pending.slice();
    btn.disabled = true;
    setStatus(status, spin(`Reading ${files.length} file${files.length > 1 ? 's' : ''}… this takes ~20 seconds`));
    try {
      let list;
      try {
        const data = await api('/api/scan', { files: await Promise.all(files.map(toApiFile)) });
        list = (data.entries || []).map((e) => entryFromAI(e, files));
        if (!list.length) throw new Error('The AI could not find a health record in these files.');
        assignFiles(list, files);
      } catch (err) {
        // keep the files safe even if AI fails
        list = [{
          id: uid(), createdAt: new Date().toISOString(), scanned: false,
          date: new Date().toISOString().slice(0, 10), title: 'Uploaded — not scanned yet',
          files, error: err.message,
        }];
      }
      setStatus(status, spin('Saving to your account…'));
      for (const e of list) await putEntry(e);
      pending = [];
      renderPending();
      await loadEntries();
      if (list[0].scanned) {
        setStatus(status, `Saved ${list.length} record${list.length > 1 ? 's' : ''} to your history.`, 'ok');
        location.hash = '#history/' + list[0].id;
      } else {
        setStatus(status, `AI scan failed: ${esc(list[0].error)}. Your files are saved — use “Retry scan” in History.`, 'error');
      }
    } catch (err) {
      setStatus(status, esc(err.message), 'error');
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
      const data = await api('/api/scan', { files: await Promise.all(old.files.map(toApiFile)) });
      const list = (data.entries || []).map((e) => entryFromAI(e, old.files));
      if (!list.length) throw new Error('No health record found');
      assignFiles(list, old.files);
      for (const e of list) await putEntry(e); // files already have storage paths
      await delEntry(id, { keepFiles: true });
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
    const recent = entries.slice(0, 3);
    $('#recentWrap').hidden = !recent.length;
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
    const nFiles = (e.files || []).length;
    if (!e.scanned) {
      return `
      <article class="t-card unscanned">
        <p class="label-row"><span class="k">${esc(e.title)}</span></p>
        <p class="muted">${esc(e.error ? 'Last attempt: ' + e.error : 'These files are stored but haven’t been read by the AI.')}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-sm" type="button" data-retry="${e.id}">Retry scan</button>
          <button class="btn btn-outline btn-sm" type="button" data-sources="${e.id}">Sources (${nFiles})</button>
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
            Sources (${nFiles})
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
  async function openSources(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const dlg = $('#sourcesDialog');
    $('#sourcesTitle').textContent = `Sources · ${e.title}`;
    $('#sourcesBody').innerHTML = `<p class="muted">${spin('Loading files…')}</p>`;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    const files = e.files || [];
    const paths = files.map((f) => f.path).filter(Boolean);
    const urls = {};
    if (paths.length) {
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
      (data || []).forEach((d) => { if (d.signedUrl) urls[d.path] = d.signedUrl; });
    }
    $('#sourcesBody').innerHTML = files.map((f, i) => {
      const src = urls[f.path] || f.dataUrl;
      if (!src) return `<p class="muted">${i + 1}. ${esc(f.name)} — couldn’t load.</p>`;
      if (f.mediaType === 'application/pdf') {
        return `<figure class="source"><iframe src="${esc(src)}" title="${esc(f.name)}"></iframe><figcaption>${i + 1}. ${esc(f.name)} · <a href="${esc(src)}" target="_blank" rel="noopener">Open</a></figcaption></figure>`;
      }
      return `<figure class="source"><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Page ${i + 1}: ${esc(f.name)}"></a><figcaption>${i + 1}. ${esc(f.name)}</figcaption></figure>`;
    }).join('') || '<p class="muted">No files attached.</p>';
  }

  // ---------- Profile ----------
  function paintAvatar() {
    const name = (profileData.name || '').trim();
    const initial = (name || user?.email || 'H')[0].toUpperCase();
    $('#avatarInitial').textContent = initial;
    $('#profileInitial').textContent = initial;
    $('#profileName').textContent = name || 'Your profile';
    $('#profileEmail').textContent = user?.email || '';
  }

  function renderProfile() {
    const form = $('#profileForm');
    for (const el of form.elements) if (el.name) el.value = profileData[el.name] || '';
    paintAvatar();
    const scanned = entries.filter((e) => e.scanned);
    $('#statRecords').textContent = entries.length;
    $('#statDoctors').textContent = new Set(scanned.map((e) => e.doctor).filter(Boolean)).size;
    const dated = scanned.map((e) => e.date).filter(Boolean).sort();
    $('#statLast').textContent = dated.length ? fmtDate(dated[dated.length - 1]) : '—';
    renderFullReport(fullReport);
    $('#genReportBtn').textContent = fullReport ? 'Regenerate' : 'Generate with AI';
  }

  function list(items) {
    const arr = (items || []).filter(Boolean);
    return arr.length ? `<ul>${arr.map((i) => `<li>${esc(typeof i === 'string' ? i : [i.name, i.detail].filter(Boolean).join(' — '))}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
  }

  function renderFullReport(r) {
    const el = $('#fullReport');
    $('#printBtn').hidden = !r;
    if (!r) { el.innerHTML = ''; return; }
    const p = profileData;
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
      const r = await api('/api/summary', { profile: profileData, records });
      r.generatedAt = new Date().toISOString();
      r.basedOn = scanned.length;
      await saveProfile({ full_report: r });
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
    // auth
    $('#tabLogin').addEventListener('click', () => setAuthMode('login'));
    $('#tabSignup').addEventListener('click', () => setAuthMode('signup'));
    $('#forgotBtn').addEventListener('click', () => setAuthMode('reset'));
    $('#authStatus').addEventListener('click', (e) => { if (e.target.id === 'backToLogin') setAuthMode('login'); });
    $('#authForm').addEventListener('submit', onAuthSubmit);
    $('#logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); });

    // upload
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

    // history
    $('#searchInput').addEventListener('input', renderHistory);
    $('#timeline').addEventListener('click', async (e) => {
      const s = e.target.closest('[data-sources]');
      if (s) return openSources(s.dataset.sources);
      const r = e.target.closest('[data-retry]');
      if (r) return retryScan(r.dataset.retry, r);
      const d = e.target.closest('[data-delete]');
      if (d && confirm('Delete this record and its files from your account?')) {
        try { await delEntry(d.dataset.delete); await loadEntries(); renderHistory(); }
        catch (err) { alert('Delete failed: ' + err.message); }
      }
    });
    const dlg = $('#sourcesDialog');
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });

    // profile
    $('#profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = $('#profileStatus');
      try {
        await saveProfile({ data: Object.fromEntries(new FormData(e.target).entries()) });
        paintAvatar();
        setStatus(status, 'Saved.', 'ok');
      } catch (err) { setStatus(status, esc(err.message), 'error'); }
    });
    $('#genReportBtn').addEventListener('click', generateFullReport);
    $('#printBtn').addEventListener('click', () => {
      const panel = $('#fullReport').closest('.panel');
      panel.classList.add('print-me');
      window.print();
      panel.classList.remove('print-me');
    });
    $('#exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ app: 'health-history', version: 2, email: user.email, profile: profileData, fullReport, entries }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `health-history-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#wipeBtn').addEventListener('click', async () => {
      if (!confirm('Delete ALL your records and report files? This cannot be undone.')) return;
      try { await clearAll(); await loadEntries(); renderProfile(); }
      catch (err) { alert('Delete failed: ' + err.message); }
    });
  }

  // ---------- Boot ----------
  (async function init() {
    if (!sb) {
      document.body.classList.add('signed-out');
      showView('auth');
      $('#authForm').hidden = true;
      $('.tabs').hidden = true;
      setStatus($('#authStatus'), 'Setup pending: add your Supabase URL and key in config.js.', 'error');
      $('#authForm').after($('#authStatus'));
      return;
    }
    bind();
    document.body.classList.add('signed-out');
    setAuthMode('login');
    sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY' || (recoveryMode && event === 'SIGNED_IN')) {
        recoveryMode = true;
        document.body.classList.add('signed-out');
        showView('auth');
        setAuthMode('newpass');
        return;
      }
      if (event === 'SIGNED_OUT') onSignedOut();
      if (event === 'SIGNED_IN' && s?.user?.id !== user?.id) onSignedIn(s);
    });
    const { data } = await sb.auth.getSession();
    if (recoveryMode) { showView('auth'); setAuthMode('newpass'); }
    else if (data.session) await onSignedIn(data.session);
    else showView('auth');
  })();
})();
