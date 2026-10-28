/* Medical History — front-end app.
 * One login (email + password) → up to 6 patients → each patient's own timeline of records.
 * Data lives in Supabase (Postgres + private storage) behind row-level security.
 * Files are sent to /api/scan only while scanning.
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
  const ageOf = (dob) => {
    if (!dob) return '';
    const d = new Date(dob + 'T00:00:00'); if (isNaN(d)) return '';
    const n = new Date(); let a = n.getFullYear() - d.getFullYear();
    if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
    return a >= 0 ? a : '';
  };
  const setStatus = (el, msg, kind = '') => { el.className = el.className.replace(/\b(error|ok)\b/g, '').trim(); if (kind) el.classList.add(kind); el.innerHTML = msg; };
  const spin = (t) => `<span class="spinner" aria-hidden="true"></span>${esc(t)}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- Aadhaar (Verhoeff checksum) ----------
  const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function validAadhaar(raw) {
    const n = String(raw || '').replace(/\D/g, '');
    if (!/^[2-9]\d{11}$/.test(n)) return false;
    let c = 0;
    n.split('').reverse().forEach((d, i) => { c = VD[c][VP[i % 8][+d]]; });
    return c === 0;
  }
  const fmtAadhaarInput = (v) => v.replace(/\D/g, '').slice(0, 12).replace(/(\d{4})(?=\d)/g, '$1 ');
  const maskAadhaar = (last4) => (last4 ? `XXXX XXXX ${last4}` : '—');

  // ---------- Theme ----------
  const THEME_KEY = 'mh-theme';
  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintThemeBtn() {
    const dark = effectiveTheme() === 'dark';
    $('#themeBtn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#0E1310' : '#00930A');
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set(THEME_KEY, next);
    paintThemeBtn();
  }

  // ---------- Supabase ----------
  const CFG = window.HH_CONFIG || {};
  const sb = CFG.supabaseUrl && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;
  const BUCKET = 'hh-reports';
  const MAX_PATIENTS = 6;
  let user = null;

  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  }

  // ---------- State ----------
  let patients = [];       // [{ id, data, aadhaar_last4, full_report }]
  let activeId = null;
  let entries = [];        // records of the active patient
  const ACTIVE_KEY = 'mh-active-patient';
  const active = () => patients.find((p) => p.id === activeId) || null;
  const pname = (p) => (p?.data?.name || 'Patient');

  // ---------- Data layer ----------
  async function loadPatients() {
    const { data, error } = await sb.from('hh_patients').select('id, data, aadhaar_last4, full_report, created_at').order('created_at');
    if (error) throw error;
    patients = data || [];
    const saved = store.get(ACTIVE_KEY);
    activeId = patients.some((p) => p.id === saved) ? saved : patients[0]?.id || null;
  }

  async function savePatient(id, data, aadhaarLast4) {
    if (id) {
      const row = { data };
      if (aadhaarLast4) row.aadhaar_last4 = aadhaarLast4;
      const { error } = await sb.from('hh_patients').update(row).eq('id', id);
      if (error) throw error;
      return id;
    }
    const newId = uid();
    const { error } = await sb.from('hh_patients').insert({ id: newId, user_id: user.id, data, aadhaar_last4: aadhaarLast4 });
    if (error) throw error;
    return newId;
  }

  async function deletePatient(id) {
    const { data: recs } = await sb.from('hh_records').select('data').eq('patient_id', id);
    const paths = (recs || []).flatMap((r) => (r.data.files || []).map((f) => f.path)).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    const { error } = await sb.from('hh_patients').delete().eq('id', id);
    if (error) throw error;
  }

  function byDateDesc(a, b) { return (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''); }

  async function loadEntries() {
    entries = [];
    if (!activeId) return;
    const { data, error } = await sb.from('hh_records').select('id, data, created_at').eq('patient_id', activeId);
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

  async function putEntry(e, patientId) {
    const files = [];
    for (const f of e.files || []) {
      if (!f.path && f.dataUrl) {
        const ext = f.mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        const path = `${user.id}/${patientId}/${e.id}/${f.id}.${ext}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, dataUrlToBlob(f.dataUrl), { contentType: f.mediaType, upsert: true });
        if (error) throw new Error('File upload failed: ' + error.message);
        files.push({ id: f.id, name: f.name, mediaType: f.mediaType, path });
      } else {
        files.push({ id: f.id, name: f.name, mediaType: f.mediaType, path: f.path });
      }
    }
    const { id, ...rest } = e;
    const { error } = await sb.from('hh_records').upsert({ id, user_id: user.id, patient_id: patientId, record_date: isoDate(e.date), data: { ...rest, files } });
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

  async function fileAsDataURL(f) {
    if (f.dataUrl) return f.dataUrl;
    const { data, error } = await sb.storage.from(BUCKET).download(f.path);
    if (error) throw error;
    return blobToDataURL(data);
  }

  async function setActive(id) {
    activeId = id;
    store.set(ACTIVE_KEY, id);
    paintPatientSwitch();
    try { await loadEntries(); } catch (err) { console.error(err); }
  }

  // ---------- Routing ----------
  const VIEWS = ['home', 'history', 'profile', 'patient'];
  function showView(view) { $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view)); }

  function route() {
    if (!user) { showView('auth'); return; }
    const [name, arg] = (location.hash || '#home').slice(1).split('/');
    // A patient (with Aadhaar) is required before anything else.
    if (!patients.length) {
      document.body.classList.add('onboarding');
      openPatientForm(null, true);
      return;
    }
    document.body.classList.remove('onboarding');
    const view = VIEWS.includes(name) ? name : 'home';
    if (view === 'patient') { openPatientForm(arg === 'new' ? null : arg, false); return; }
    showView(view);
    $$('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'history') renderHistory();
    if (view === 'profile') renderProfile();
    if (view === 'home') renderHome();
    window.scrollTo(0, 0);
    if (view === 'history' && arg) requestAnimationFrame(() => document.getElementById('rec-' + arg)?.scrollIntoView({ block: 'start' }));
  }
  window.addEventListener('hashchange', route);

  // ---------- Auth ----------
  let authMode = 'login';
  let recoveryMode = location.hash.includes('type=recovery');

  function setAuthMode(mode) {
    authMode = mode;
    $('#tabLogin').setAttribute('aria-selected', String(mode === 'login'));
    $('#tabSignup').setAttribute('aria-selected', String(mode === 'signup'));
    $('.tabs').hidden = mode === 'reset' || mode === 'newpass';
    $('#pwHint').hidden = !(mode === 'signup' || mode === 'newpass');
    $('#passwordField').hidden = mode === 'reset';
    $('#au-email').closest('.field').hidden = mode === 'newpass';
    $('#forgotBtn').hidden = mode !== 'login';
    $('#au-password').setAttribute('autocomplete', mode === 'signup' || mode === 'newpass' ? 'new-password' : 'current-password');
    const t = {
      login: ['Welcome', 'Log in to Medical History', 'Log in'],
      signup: ['New here', 'Create your account', 'Create account'],
      reset: ['Reset', 'Reset your password', 'Send reset link'],
      newpass: ['Reset', 'Choose a new password', 'Save new password'],
    }[mode];
    $('#authEyebrow').textContent = t[0];
    $('#authTitle').textContent = t[1];
    $('#authSubmit').textContent = t[2];
    $('#authSub').textContent = mode === 'signup'
      ? 'One email for the whole family. Next you’ll add the first patient (Aadhaar required).'
      : 'One account for your whole family’s reports — on any device.';
    setStatus($('#authStatus'), mode === 'reset' ? 'We’ll email you a link to set a new password. <button type="button" class="link-btn" id="backToLogin">Back to log in</button>' : '');
  }

  async function onAuthSubmit(ev) {
    ev.preventDefault();
    const status = $('#authStatus');
    const email = $('#au-email').value.trim();
    const password = $('#au-password').value;
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
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
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
    user = s?.user || null;
    if (!user) return;
    document.body.classList.remove('signed-out');
    $('#avatarInitial').textContent = (user.email || 'M')[0].toUpperCase();
    try {
      await loadPatients();
      await loadEntries();
    } catch (err) { console.error(err); }
    paintPatientSwitch();
    if (!location.hash || /access_token|type=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#home');
    route();
  }

  function onSignedOut() {
    user = null; patients = []; entries = []; activeId = null;
    document.body.classList.add('signed-out');
    document.body.classList.remove('onboarding');
    setAuthMode('login');
    showView('auth');
  }

  // ---------- Patient switcher ----------
  function paintPatientSwitch() {
    const sel = $('#patientSelect');
    sel.innerHTML = patients.map((p) => `<option value="${p.id}">${esc(pname(p))}${p.data?.relation && p.data.relation !== 'Self' ? ` (${esc(p.data.relation)})` : ''}</option>`).join('')
      + (patients.length < MAX_PATIENTS ? '<option value="__add">+ Add patient</option>' : '');
    if (activeId) sel.value = activeId;
    $$('#homePatient, #historyPatient').forEach((el) => { el.textContent = pname(active()); });
  }

  // ---------- Patient form ----------
  let editingId = null;
  const PATIENT_FIELDS = ['name', 'relation', 'dob', 'sex', 'blood', 'phone', 'emergency', 'abha', 'cardType', 'cardNumber', 'insurer', 'height', 'weight', 'allergies', 'conditions'];

  function openPatientForm(id, onboarding) {
    const p = id ? patients.find((x) => x.id === id) : null;
    if (id && !p) { location.hash = '#profile'; return; }
    if (!p && !onboarding && patients.length >= MAX_PATIENTS) { alert(`One account can hold up to ${MAX_PATIENTS} patients.`); location.hash = '#profile'; return; }
    editingId = p?.id || null;
    showView('patient');
    window.scrollTo(0, 0);
    const f = $('#patientForm');
    f.reset();
    for (const k of PATIENT_FIELDS) if (f.elements[k] && p?.data?.[k] != null) f.elements[k].value = p.data[k];
    f.elements.relation.value = p?.data?.relation || (onboarding || !patients.some((x) => x.data?.relation === 'Self') ? 'Self' : 'Spouse');
    $('#pt-aadhaar').value = '';
    $('#pt-aadhaar').placeholder = p ? maskAadhaar(p.aadhaar_last4) + ' — leave blank to keep' : '1234 5678 9012';
    $('#pt-aadhaar').removeAttribute('aria-invalid');
    $('#aadhaarHint').className = 'hint';
    $('#aadhaarHint').textContent = '12 digits. For your privacy only the last 4 digits are stored.';
    $('#pt-consent').checked = !!p;
    $('#pEyebrow').textContent = onboarding ? 'Step 2 of 2' : p ? 'Edit patient' : 'New patient';
    $('#pTitle').textContent = onboarding ? 'Add the first patient' : p ? pname(p) : 'Add a patient';
    $('#pLead').textContent = onboarding
      ? 'Usually that’s you. You can add up to 5 more family members later. Aadhaar is required to create a Medical History account.'
      : `One account can hold up to ${MAX_PATIENTS} patients. Aadhaar is required for every patient.`;
    $('#patientCancel').hidden = onboarding;
    $('#patientDelete').hidden = !p;
    setStatus($('#patientStatus'), '');
  }

  async function onPatientSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const status = $('#patientStatus');
    const data = {};
    for (const k of PATIENT_FIELDS) data[k] = (f.elements[k]?.value || '').trim();
    const aadhaarRaw = $('#pt-aadhaar').value.replace(/\D/g, '');
    const isNew = !editingId;

    if (!data.name) return setStatus(status, 'Enter the full name.', 'error');
    if (!data.dob) return setStatus(status, 'Enter the date of birth.', 'error');
    if (!data.sex) return setStatus(status, 'Select sex.', 'error');
    if (isNew || aadhaarRaw) {
      if (!validAadhaar(aadhaarRaw)) {
        $('#pt-aadhaar').setAttribute('aria-invalid', 'true');
        $('#aadhaarHint').className = 'hint error';
        $('#aadhaarHint').textContent = 'That isn’t a valid Aadhaar number. Check the 12 digits on the card.';
        $('#pt-aadhaar').focus();
        return setStatus(status, 'Aadhaar number is required.', 'error');
      }
    }
    if (data.abha && data.abha.replace(/\D/g, '').length !== 14) return setStatus(status, 'ABHA number should be 14 digits.', 'error');
    if (!$('#pt-consent').checked) return setStatus(status, 'Please confirm you have permission to store these records.', 'error');

    const btn = $('#patientSave');
    btn.disabled = true;
    setStatus(status, spin('Saving…'));
    try {
      const id = await savePatient(editingId, data, aadhaarRaw ? aadhaarRaw.slice(-4) : null);
      await loadPatients();
      if (isNew) await setActive(id); else paintPatientSwitch();
      location.hash = isNew && patients.length === 1 ? '#home' : '#profile';
      route();
    } catch (err) {
      setStatus(status, esc(/up to 6/.test(err.message) ? `One account can hold up to ${MAX_PATIENTS} patients.` : err.message), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function onPatientDelete() {
    const p = patients.find((x) => x.id === editingId);
    if (!p) return;
    if (!confirm(`Delete ${pname(p)} and ALL of their records and files? This cannot be undone.`)) return;
    try {
      await deletePatient(p.id);
      await loadPatients();
      await setActive(activeId);
      location.hash = '#profile';
      route();
    } catch (err) { setStatus($('#patientStatus'), esc(err.message), 'error'); }
  }

  // ---------- Upload / pending ----------
  const MAX_FILES = 10;
  const MAX_SIDE = 1800;
  const MAX_PDF_BYTES = 3.5e6;
  let pending = [];

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
    } finally { URL.revokeObjectURL(url); }
  }

  async function addFiles(fileList) {
    const scanStatus = $('#scanStatus');
    for (const f of [...fileList]) {
      if (pending.length >= MAX_FILES) { setStatus(scanStatus, `Up to ${MAX_FILES} files per scan.`, 'error'); break; }
      try {
        if (f.type === 'application/pdf') {
          if (f.size > MAX_PDF_BYTES) { setStatus(scanStatus, `${esc(f.name)} is too large (max 3.5 MB PDF). Try photos of the pages instead.`, 'error'); continue; }
          pending.push({ id: uid(), name: f.name, mediaType: 'application/pdf', dataUrl: await blobToDataURL(f) });
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
        ${p.mediaType === 'application/pdf' ? `<div class="pdf">PDF<small>${esc(p.name)}</small></div>` : `<img src="${p.dataUrl}" alt="${esc(p.name)}">`}
        <button class="remove" type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </li>`).join('');
  }

  // ---------- AI ----------
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
      id: uid(), createdAt: new Date().toISOString(), scanned: true,
      date: ai.date || '', title: ai.title || 'Health record', documentType: ai.documentType || '',
      madeBy: ai.madeBy || '', reportSays: ai.reportSays || '',
      findings: Array.isArray(ai.findings) ? ai.findings : [],
      doctor: ai.doctor || '', hospital: ai.hospital || '', diagnosis: ai.diagnosis || '', suggestions: ai.suggestions || '',
      medicines: Array.isArray(ai.medicines) ? ai.medicines : [],
      billAmount: ai.billAmount || '', tldr: ai.tldr || '',
      files: [...new Set(idx)].map((i) => files[i]).filter(Boolean),
    };
  }
  function assignFiles(list, files) {
    const used = new Set();
    for (const e of list) e.files = e.files.filter((f) => !used.has(f.id) && used.add(f.id));
    const orphans = files.filter((f) => !used.has(f.id));
    if (orphans.length) list[0].files.push(...orphans);
  }

  async function scanPending() {
    if (!pending.length || !activeId) return;
    const btn = $('#scanBtn');
    const status = $('#scanStatus');
    const files = pending.slice();
    const patientId = activeId;
    btn.disabled = true;
    setStatus(status, spin(`Reading ${files.length} file${files.length > 1 ? 's' : ''} for ${pname(active())}… ~20 seconds`));
    try {
      let list;
      try {
        const data = await api('/api/scan', { files: await Promise.all(files.map(toApiFile)) });
        list = (data.entries || []).map((e) => entryFromAI(e, files));
        if (!list.length) throw new Error('The AI could not find a health record in these files.');
        assignFiles(list, files);
      } catch (err) {
        list = [{ id: uid(), createdAt: new Date().toISOString(), scanned: false, date: new Date().toISOString().slice(0, 10), title: 'Uploaded — not scanned yet', files, error: err.message }];
      }
      setStatus(status, spin('Saving to your account…'));
      for (const e of list) await putEntry(e, patientId);
      pending = [];
      renderPending();
      await loadEntries();
      if (list[0].scanned) {
        setStatus(status, `Saved ${list.length} record${list.length > 1 ? 's' : ''} to ${esc(pname(active()))}’s history.`, 'ok');
        location.hash = '#history/' + list[0].id;
      } else {
        setStatus(status, `AI scan failed: ${esc(list[0].error)}. Your files are saved — use “Retry scan” in History.`, 'error');
      }
    } catch (err) {
      setStatus(status, esc(err.message), 'error');
    } finally { btn.disabled = false; }
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
      for (const e of list) await putEntry(e, activeId);
      await delEntry(id, { keepFiles: true });
      await loadEntries();
      renderHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry scan';
      alert('Scan failed: ' + err.message);
    }
  }

  // ---------- Home ----------
  function renderHome() {
    paintPatientSwitch();
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
    paintPatientSwitch();
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
  function renderProfile() {
    paintPatientSwitch();
    $('#profileInitial').textContent = (user.email || 'M')[0].toUpperCase();
    $('#profileEmail').textContent = user.email || '';
    $('#patientCount').textContent = `(${patients.length}/${MAX_PATIENTS})`;
    const addBtn = $('#addPatientBtn');
    const full = patients.length >= MAX_PATIENTS;
    addBtn.setAttribute('aria-disabled', String(full));
    addBtn.textContent = full ? 'Limit reached' : '+ Add patient';

    $('#patientList').innerHTML = patients.map((p) => {
      const on = p.id === activeId;
      const age = ageOf(p.data?.dob);
      return `
      <li class="patient-card${on ? ' active' : ''}">
        <span class="avatar" aria-hidden="true">${esc(pname(p)[0].toUpperCase())}</span>
        <div class="p-info">
          <strong>${esc(pname(p))}</strong>
          <span class="muted">${esc([p.data?.relation, age !== '' ? `${age} yrs` : '', p.data?.blood].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="p-actions">
          ${on ? '<span class="tag">Viewing</span>' : `<button class="link-btn" type="button" data-switch="${p.id}">View</button>`}
          <a class="link-btn" href="#patient/${p.id}" aria-label="Edit ${esc(pname(p))}">Edit</a>
        </div>
      </li>`;
    }).join('');

    const p = active();
    $('#activeTitle').textContent = p ? pname(p) : '—';
    $('#editActive').setAttribute('href', p ? `#patient/${p.id}` : '#profile');
    const d = p?.data || {};
    const age = ageOf(d.dob);
    const rows = [
      ['Relation', d.relation], ['Date of birth', d.dob ? `${fmtDate(d.dob)}${age !== '' ? ` (${age})` : ''}` : ''], ['Sex', d.sex],
      ['Blood group', d.blood], ['Aadhaar', maskAadhaar(p?.aadhaar_last4)], ['ABHA', d.abha],
      ['Health card', [d.cardType, d.cardNumber].filter(Boolean).join(' · ')], ['Insurer / scheme', d.insurer], ['Mobile', d.phone],
      ['Emergency', d.emergency], ['Height / weight', [d.height && `${d.height} cm`, d.weight && `${d.weight} kg`].filter(Boolean).join(' · ')],
      ['Allergies', d.allergies], ['Conditions', d.conditions],
    ];
    $('#activeDetails').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd></div>`).join('');

    const scanned = entries.filter((e) => e.scanned);
    $('#statRecords').textContent = entries.length;
    $('#statDoctors').textContent = new Set(scanned.map((e) => e.doctor).filter(Boolean)).size;
    const dated = scanned.map((e) => e.date).filter(Boolean).sort();
    $('#statLast').textContent = dated.length ? fmtDate(dated[dated.length - 1]) : '—';

    renderFullReport(p?.full_report || null);
    $('#genReportBtn').textContent = p?.full_report ? 'Regenerate' : 'Generate with AI';
    setStatus($('#genStatus'), '');
  }

  function list(items) {
    const arr = (items || []).filter(Boolean);
    return arr.length ? `<ul>${arr.map((i) => `<li>${esc(typeof i === 'string' ? i : [i.name, i.detail].filter(Boolean).join(' — '))}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
  }

  function renderFullReport(r) {
    const el = $('#fullReport');
    $('#printBtn').hidden = !r;
    if (!r) { el.innerHTML = ''; return; }
    const d = active()?.data || {};
    el.innerHTML = `
      <p><strong>${esc(d.name || 'Patient')}</strong>${d.dob ? ` · DOB ${esc(fmtDate(d.dob))}` : ''}${d.sex ? ` · ${esc(d.sex)}` : ''}${d.blood ? ` · Blood group ${esc(d.blood)}` : ''}${d.abha ? ` · ABHA ${esc(d.abha)}` : ''}</p>
      <h3>Overview</h3><p>${esc(r.overview)}</p>
      <h3>Conditions &amp; diagnoses</h3>${list(r.conditions)}
      <h3>Current / recent medicines</h3>${list(r.medicines)}
      <h3>Allergies</h3>${list(r.allergies)}
      <h3>Key test results over time</h3>${list(r.keyResults)}
      <h3>Doctors &amp; hospitals</h3>${list(r.careTeam)}
      <h3>Things to watch</h3>${list(r.watchouts)}
      <p class="generated">Generated ${esc(fmtDate((r.generatedAt || '').slice(0, 10)))} from ${esc(r.basedOn)} record(s) · Medical History. Not medical advice.</p>`;
  }

  async function generateFullReport() {
    const p = active();
    const btn = $('#genReportBtn');
    const status = $('#genStatus');
    const scanned = entries.filter((e) => e.scanned);
    if (!p || !scanned.length) { setStatus(status, 'Add and scan at least one report for this patient first.', 'error'); return; }
    btn.disabled = true;
    setStatus(status, spin('Building the complete health report…'));
    try {
      const records = scanned.map(({ files, id, createdAt, scanned: _s, error, ...rest }) => rest);
      const d = p.data || {};
      const profile = { name: d.name, dob: d.dob, sex: d.sex, blood: d.blood, height: d.height, weight: d.weight, allergies: d.allergies, conditions: d.conditions };
      const r = await api('/api/summary', { profile, records });
      r.generatedAt = new Date().toISOString();
      r.basedOn = scanned.length;
      const { error } = await sb.from('hh_patients').update({ full_report: r }).eq('id', p.id);
      if (error) throw error;
      p.full_report = r;
      renderFullReport(r);
      setStatus(status, 'Done.', 'ok');
      btn.textContent = 'Regenerate';
    } catch (err) {
      setStatus(status, 'Could not generate: ' + esc(err.message), 'error');
    } finally { btn.disabled = false; }
  }

  async function exportBackup() {
    const { data: recs } = await sb.from('hh_records').select('id, patient_id, record_date, data, created_at');
    const blob = new Blob([JSON.stringify({ app: 'medical-history', version: 3, email: user.email, exportedAt: new Date().toISOString(), patients, records: recs || [] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `medical-history-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Events ----------
  function bind() {
    $('#themeBtn').addEventListener('click', toggleTheme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paintThemeBtn);

    $('#tabLogin').addEventListener('click', () => setAuthMode('login'));
    $('#tabSignup').addEventListener('click', () => setAuthMode('signup'));
    $('#forgotBtn').addEventListener('click', () => setAuthMode('reset'));
    $('#authStatus').addEventListener('click', (e) => { if (e.target.id === 'backToLogin') setAuthMode('login'); });
    $('#authForm').addEventListener('submit', onAuthSubmit);
    $('#logoutBtn').addEventListener('click', () => sb.auth.signOut());

    $('#patientSelect').addEventListener('change', async (e) => {
      if (e.target.value === '__add') { e.target.value = activeId; location.hash = '#patient/new'; return; }
      await setActive(e.target.value);
      route();
    });
    $('#patientForm').addEventListener('submit', onPatientSubmit);
    $('#patientDelete').addEventListener('click', onPatientDelete);
    $('#pt-aadhaar').addEventListener('input', (e) => {
      e.target.value = fmtAadhaarInput(e.target.value);
      e.target.removeAttribute('aria-invalid');
      $('#aadhaarHint').className = 'hint';
      $('#aadhaarHint').textContent = '12 digits. For your privacy only the last 4 digits are stored.';
    });
    $('#patientList').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-switch]');
      if (!b) return;
      await setActive(b.dataset.switch);
      renderProfile();
    });

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
      if (d && confirm('Delete this record and its files?')) {
        try { await delEntry(d.dataset.delete); await loadEntries(); renderHistory(); }
        catch (err) { alert('Delete failed: ' + err.message); }
      }
    });
    const dlg = $('#sourcesDialog');
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });

    $('#genReportBtn').addEventListener('click', generateFullReport);
    $('#printBtn').addEventListener('click', () => {
      const panel = $('#fullReport').closest('.panel');
      panel.classList.add('print-me');
      window.print();
      panel.classList.remove('print-me');
    });
    $('#exportBtn').addEventListener('click', () => exportBackup().catch((err) => alert('Export failed: ' + err.message)));
  }

  // ---------- Boot ----------
  (async function init() {
    if (!sb) {
      showView('auth');
      $('#authForm').hidden = true;
      $('.tabs').hidden = true;
      $('#authSub').textContent = 'Couldn’t connect to the server. Check your internet connection and reload.';
      return;
    }
    bind();
    paintThemeBtn();
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
