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
    // new columns come from migration 002; fall back gracefully if it hasn't been run yet
    let { data, error } = await sb.from('hh_patients').select('id, data, aadhaar_last4, full_report, created_at, public_code, emergency_token, emergency_enabled, emergency_fields').order('created_at');
    if (error) ({ data, error } = await sb.from('hh_patients').select('id, data, aadhaar_last4, full_report, created_at').order('created_at'));
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

  // a future date is a misread — sort such records by upload date instead so they don't sit on top
  const sortKey = (e) => {
    const up = (e.createdAt || '').slice(0, 10);
    const d = e.date && (!up || e.date <= up) ? e.date : up;
    return `${d} ${e.time || '00:00'} ${e.createdAt || ''}`;
  };
  function byDateDesc(a, b) { return sortKey(b).localeCompare(sortKey(a)); }

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

  const fileMeta = (f, path) => {
    const m = { id: f.id, name: f.name, mediaType: f.mediaType, path };
    if (f.storeOnly) m.storeOnly = true;          // original PDF kept for viewing/download, not sent to the AI
    if (f.docId) m.docId = f.docId;
    if (f.page) m.page = f.page;
    if (f.side) m.side = f.side;
    if (f.text) m.text = String(f.text).slice(0, 20000); // exact text layer of a PDF page
    return m;
  };

  async function putEntry(e, patientId) {
    const files = [];
    for (const f of e.files || []) {
      if (!f.path && f.dataUrl) {
        const ext = f.mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        const path = `${user.id}/${patientId}/${e.id}/${f.id}.${ext}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, dataUrlToBlob(f.dataUrl), { contentType: f.mediaType, upsert: true });
        if (error) throw new Error('File upload failed: ' + error.message);
        files.push(fileMeta(f, path));
      } else {
        files.push(fileMeta(f, f.path));
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
  const VIEWS = ['home', 'history', 'profile', 'patient', 'doctor'];
  function showView(view) { $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view)); }

  function route() {
    if (!user) { showView('auth'); return; }
    const [name, arg] = (location.hash || '#home').slice(1).split('/');
    // Doctor tools work without a patient profile (a doctor may not add their own family).
    if (name === 'doctor') {
      document.body.classList.remove('onboarding');
      showView('doctor');
      $$('[data-nav]').forEach((a) => { a.classList.toggle('active', a.dataset.nav === 'doctor'); });
      window.MHF?.renderDoctor?.(arg);
      window.scrollTo(0, 0);
      return;
    }
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
    sel.innerHTML = patients.map((p) => `<option value="${p.id}">${esc(pname(p))}</option>`).join('')
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
    $('#doctorSkip').hidden = !onboarding;
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
  const MAX_FILES = 24;           // total items in one upload (PDF pages count individually)
  const MAX_PDF_PAGES = 20;
  const MAX_PDF_BYTES = 40e6;     // original PDF size we accept (pages are rendered on the phone)
  const MAX_SIDE = 2400; // keep small print (dates, doses) readable
  let pending = [];

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open image'));
      img.src = src;
    });
  }
  async function compressImage(file, maxSide = MAX_SIDE) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.8);
    } finally { URL.revokeObjectURL(url); }
  }

  async function addFiles(fileList) {
    const scanStatus = $('#scanStatus');
    for (const f of [...fileList]) {
      if (pending.length >= MAX_FILES) { setStatus(scanStatus, `Up to ${MAX_FILES} files per scan.`, 'error'); break; }
      try {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          if (f.size > MAX_PDF_BYTES) { setStatus(scanStatus, `${esc(f.name)} is too large (max 40 MB).`, 'error'); continue; }
          await addPdf(f, scanStatus);
        } else if (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)) {
          pending.push({ id: uid(), name: f.name, mediaType: 'image/jpeg', dataUrl: await compressImage(f) });
        } else {
          setStatus(scanStatus, `${esc(f.name)}: only images and PDFs are supported.`, 'error');
        }
      } catch (err) {
        setStatus(scanStatus, /pdf/i.test(f.type + f.name) ? esc(err.message || `Couldn’t read ${f.name}.`) : `Couldn’t read ${esc(f.name)}. If it’s HEIC, try exporting as JPG.`, 'error');
      }
    }
    renderPending();
  }

  // ---------- PDF: render each page to a sharp image + keep its exact text ----------
  let pdfjsReady = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsReady) {
      pdfjsReady = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        sc.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        sc.onerror = () => { pdfjsReady = null; reject(new Error('PDF reader did not load. Check your internet and try again.')); };
        document.head.appendChild(sc);
      });
    }
    return pdfjsReady;
  }

  async function addPdf(file, statusEl) {
    setStatus(statusEl, spin(`Opening ${file.name}…`));
    const lib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    let doc;
    try {
      doc = await lib.getDocument({ data: buf.slice(0) }).promise;
    } catch (err) {
      throw new Error(/password/i.test(err?.name || err?.message || '') ? `${file.name} is password-protected. Remove the password and try again.` : `Couldn’t open ${file.name}.`);
    }
    const docId = 'pdf-' + uid().slice(0, 8);
    const base = file.name.replace(/\.pdf$/i, '');
    const n = Math.min(doc.numPages, MAX_PDF_PAGES);
    const room = MAX_FILES - pending.length;
    if (room <= 0) throw new Error(`Up to ${MAX_FILES} pages per upload.`);
    const count = Math.min(n, room);
    for (let i = 1; i <= count; i++) {
      setStatus(statusEl, spin(`Reading ${file.name} — page ${i} of ${count}…`));
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2000 / Math.max(v1.width, v1.height)); // ~2000px long side, sharp small print
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      let text = '';
      try {
        const tc = await page.getTextContent();
        // rebuild lines from text items (y position), so tables read left-to-right
        const rows = new Map();
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue;
          const y = Math.round(it.transform[5] / 3);
          if (!rows.has(y)) rows.set(y, []);
          rows.get(y).push({ x: it.transform[4], s: it.str });
        }
        text = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r.sort((a, b) => a.x - b.x).map((t) => t.s).join('  ')).join('\n');
      } catch { /* scanned PDFs have no text layer */ }
      pending.push({
        id: uid(), name: `${base} – page ${i} of ${n}.jpg`, mediaType: 'image/jpeg',
        dataUrl: c.toDataURL('image/jpeg', 0.85), docId, page: i, text,
      });
      page.cleanup();
      renderPending();
    }
    // keep the untouched original too (viewing / sharing), but don't send it to the AI
    pending.push({ id: uid(), name: file.name, mediaType: 'application/pdf', dataUrl: await blobToDataURL(file), docId, storeOnly: true });
    renderPending();
    doc.destroy();
    setStatus(statusEl, n > count
      ? `Added ${count} of ${n} pages (limit ${MAX_FILES} per upload).`
      : `Added ${count} page${count > 1 ? 's' : ''} from ${esc(file.name)}.`, n > count ? 'error' : 'ok');
  }

  function renderPending() {
    $('#pending').hidden = pending.length === 0;
    $('#pendingCount').textContent = pending.filter((p) => !p.storeOnly).length;
    $('#pendingList').innerHTML = pending.map((p) => `
      <li class="thumb">
        ${p.mediaType === 'application/pdf' ? `<div class="pdf">PDF<small>${p.storeOnly ? 'Original file' : esc(p.name)}</small></div>` : `<img src="${p.dataUrl}" alt="${esc(p.name)}">`}
        ${p.docId && !p.side && p.page ? `<span class="side-badge">p${p.page}</span>` : ''}
        ${p.side ? `<span class="side-badge">${p.side === 'back' ? 'Back' : 'Front'} · p${p.page}</span>` : ''}
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
    if (!res.ok) {
      const msg = res.status === 413 ? 'Files too large for one request.'
        : res.status === 504 ? 'The AI took too long.'
        : (data && data.error) || `Request failed (${res.status})`;
      throw Object.assign(new Error(msg), { status: res.status, code: data && data.code });
    }
    return data;
  }
  const toApiFile = async (f) => ({ name: f.name, mediaType: f.mediaType, data: (await fileAsDataURL(f)).split(',')[1], ...(f.text ? { text: f.text } : {}) });

  const VITAL_KEYS = ['bpSystolic', 'bpDiastolic', 'pulse', 'sugar', 'spo2', 'temperature', 'weight', 'height'];
  function cleanVitals(v) {
    const out = {};
    if (v && typeof v === 'object') for (const k of VITAL_KEYS) { const x = String(v[k] ?? '').trim(); if (x) out[k] = x; }
    return out;
  }

  function entryFromAI(ai, files) {
    const idx = Array.isArray(ai.sourceIndexes) && ai.sourceIndexes.length ? ai.sourceIndexes : files.map((_, i) => i);
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    const str = (v) => (v == null ? '' : String(v));
    return {
      id: uid(), createdAt: new Date().toISOString(), scanned: true,
      date: isoDate(ai.date) || '', title: str(ai.title) || 'Health record', documentType: str(ai.documentType),
      madeBy: str(ai.madeBy), reportSays: str(ai.reportSays),
      findings: arr(ai.findings),
      doctor: str(ai.doctor), hospital: str(ai.hospital), diagnosis: str(ai.diagnosis), suggestions: str(ai.suggestions),
      medicines: arr(ai.medicines),
      billAmount: str(ai.billAmount),
      time: /^\d{1,2}:\d{2}$/.test(str(ai.time)) ? str(ai.time).padStart(5, '0') : '',
      vitals: cleanVitals(ai.vitals),
      symptoms: Array.isArray(ai.symptoms) ? ai.symptoms.map(str).filter(Boolean) : [],
      needsReview: Array.isArray(ai.needsReview) ? ai.needsReview.map(str).filter(Boolean) : [],
      dateRead: str(ai.dateRead),
      dateText: str(ai.dateText),
      dateAutoFixed: !!ai.dateAutoFixed,
      files: [...new Set(idx.map(Number))].map((i) => files[i]).filter(Boolean),
    };
  }
  function assignFiles(list, files) {
    const used = new Set();
    for (const e of list) e.files = e.files.filter((f) => !used.has(f.id) && used.add(f.id));
    const orphans = files.filter((f) => !used.has(f.id));
    if (orphans.length) list[0].files.push(...orphans);
  }

  // Split files into requests that stay under Vercel's 4.5 MB body limit and a sane page count.
  const MAX_BATCH_BYTES = 3.2e6;
  const MAX_BATCH_FILES = 4;
  async function makeBatches(files) {
    const payload = await Promise.all(files.map(toApiFile));
    const batches = [];
    let cur = [], size = 0;
    payload.forEach((p, i) => {
      const b = p.data.length;
      const sameDoc = cur.length && files[i].docId && cur[cur.length - 1].file.docId === files[i].docId;
      const full = size + b > MAX_BATCH_BYTES || cur.length >= MAX_BATCH_FILES;
      // keep front & back of one scanned paper in the same request (hard cap 4 MB for Vercel's limit)
      if (cur.length && full && !(sameDoc && size + b <= 4.0e6 && cur.length < 6)) { batches.push(cur); cur = []; size = 0; }
      cur.push({ file: files[i], api: p }); size += b;
    });
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function scanBatch(batch) {
    const files = batch.map((x) => x.file);
    const data = await api('/api/scan', { files: batch.map((x) => x.api) });
    const list = (data.entries || []).map((e) => entryFromAI(e, files));
    if (!list.length) throw new Error('The AI could not find a health record in these files.');
    assignFiles(list, files);
    return list;
  }

  // Read files with the AI. Groups up to 4 pages per request; if a group fails, retries each file alone.
  // Returns records; files that still fail come back as one "not scanned yet" record so nothing is lost.
  async function scanFiles(allFiles, onProgress) {
    const originals = allFiles.filter((f) => f.storeOnly);
    const files = allFiles.filter((f) => !f.storeOnly);
    if (!files.length) throw new Error('Nothing to read in these files.');
    const result = await scanFilesInner(files, onProgress);
    for (const o of originals) {
      const home = result.find((e) => (e.files || []).some((f) => f.docId && f.docId === o.docId)) || result[0];
      if (home) home.files.push(o);
    }
    return result;
  }
  async function scanFilesInner(files, onProgress) {
    const batches = await makeBatches(files);
    const out = [];
    const failed = [];
    let lastErr = '';
    let done = 0;
    for (const batch of batches) {
      onProgress?.(done, files.length);
      try {
        out.push(...await scanBatch(batch));
      } catch (err) {
        if (err.status === 401) throw err;
        lastErr = err.message;
        if (batch.length === 1) failed.push(batch[0].file);
        else {
          for (const one of batch) {
            onProgress?.(done, files.length);
            try { out.push(...await scanBatch([one])); }
            catch (e) { if (e.status === 401) throw e; lastErr = e.message; failed.push(one.file); }
            done++;
          }
          continue;
        }
      }
      done += batch.length;
    }
    if (failed.length) {
      out.push({ id: uid(), createdAt: new Date().toISOString(), scanned: false, date: new Date().toISOString().slice(0, 10), title: 'Uploaded — not scanned yet', files: failed, error: lastErr });
    }
    return out;
  }

  async function scanPending() {
    if (!pending.length || !activeId) return;
    const btn = $('#scanBtn');
    const status = $('#scanStatus');
    const files = pending.slice();
    const patientId = activeId;
    const who = pname(active());
    btn.disabled = true;
    try {
      const list = await scanFiles(files, (d, n) => setStatus(status, spin(n > 1 ? `Reading pages for ${who}… ${d}/${n} done` : `Reading the file for ${who}… ~20 seconds`)));
      setStatus(status, spin('Saving to your account…'));
      for (const e of list) await putEntry(e, patientId);
      pending = [];
      renderPending();
      await loadEntries();
      const ok = list.filter((e) => e.scanned);
      const bad = list.find((e) => !e.scanned);
      if (ok.length && !bad) {
        setStatus(status, `Saved ${ok.length} record${ok.length > 1 ? 's' : ''} to ${esc(who)}’s history.`, 'ok');
        location.hash = '#history/' + ok[0].id;
      } else if (ok.length) {
        setStatus(status, `Saved ${ok.length} record${ok.length > 1 ? 's' : ''}. ${bad.files.length} file${bad.files.length > 1 ? 's' : ''} couldn’t be read — use “Retry scan” in History.`, 'error');
      } else {
        setStatus(status, `AI couldn’t read these files (${esc(bad.error)}). They’re saved — use “Retry scan” in History.`, 'error');
      }
    } catch (err) {
      setStatus(status, esc(err.status === 401 ? 'Session expired — please log in again.' : err.message), 'error');
    } finally { btn.disabled = false; }
  }

  async function retryScan(id, btn) {
    const old = entries.find((e) => e.id === id);
    if (!old) return;
    btn.disabled = true;
    btn.innerHTML = spin('Scanning…');
    try {
      const list = await scanFiles(old.files, (d, n) => { btn.innerHTML = spin(n > 1 ? `Scanning ${d}/${n}…` : 'Scanning…'); });
      if (!list.some((e) => e.scanned)) throw new Error(list[0]?.error || 'No health record found');
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
    window.MHF?.afterHome?.();
    const recent = entries.slice(0, 3);
    $('#recentWrap').hidden = !recent.length;
    $('#recentList').innerHTML = recent.map((e) => `
      <li><a href="#history/${e.id}"><span>${esc(e.title)}${e.madeBy ? ` <span class="muted">· ${esc(e.madeBy)}</span>` : ''}</span><span class="r-date">${esc(fmtDate(e.date))}</span></a></li>`).join('');
  }

  // ---------- History ----------
  function matches(e, q) {
    if (!q) return true;
    const hay = [e.title, e.madeBy, e.reportSays, e.doctor, e.hospital, e.diagnosis, e.suggestions, e.tldr, e.documentType,
      ...(e.medicines || []).map((m) => m.name), ...(e.findings || []).map((f) => f.name), ...(e.symptoms || [])].join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }
  function flagClass(flag) {
    const f = String(flag || '').toLowerCase();
    if (f.startsWith('h')) return 'flag-high';
    if (f.startsWith('l')) return 'flag-low';
    return '';
  }

  // ---------- Record cards ----------
  const ICONS = {
    lab: '<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/>',
    rx: '<rect x="3" y="9" width="18" height="7" rx="3.5"/><path d="M12 9v7"/><path d="M7 5h10"/>',
    doctor: '<path d="M6 3v6a6 6 0 0 0 12 0V3"/><path d="M12 15v2a4 4 0 0 0 8 0v-3"/><circle cx="20" cy="12" r="2"/>',
    discharge: '<path d="M3 20V8"/><path d="M3 14h18v6"/><path d="M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="2"/>',
    scan: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 8v8M8 12h8"/>',
    bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    vitals: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
    other: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  };
  function kindOf(e) {
    const t = String(e.documentType || '').toLowerCase();
    if (t.includes('vital')) return 'vitals';
    if (t.includes('lab')) return 'lab';
    if (t.includes('prescription')) return 'rx';
    if (t.includes('discharge')) return 'discharge';
    if (t.includes('scan') || t.includes('x-ray') || t.includes('imaging')) return 'scan';
    if (t.includes('bill')) return 'bill';
    if (t.includes('doctor') || t.includes('consult') || t.includes('note')) return 'doctor';
    return 'other';
  }
  const icon = (k, size = 18) => `<svg class="k-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.other}</svg>`;
  const clip = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10.2 17a1.7 1.7 0 0 1-2.4-2.4L15.5 7"/></svg>';
  const hospIcon = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M9 2h6v4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4zm2 2v2h2V4zm0 7v2.5H8.5v2H11V18h2v-2.5h2.5v-2H13V11z"/></svg>';
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function dayLabel(iso) {
    if (!iso) return 'Date unknown';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / 864e5);
    const base = `${DAYS[d.getDay()]}, ${fmtDate(iso)}`;
    return diff === 0 ? `Today · ${fmtDate(iso)}` : diff === 1 ? `Yesterday · ${fmtDate(iso)}` : base;
  }

  function vitalsChips(v = {}) {
    const chips = [];
    if (v.bpSystolic || v.bpDiastolic) {
      chips.push([v.bpSystolic || '—', 'Systolic'], [v.bpDiastolic || '—', 'Diastolic']);
    }
    if (v.pulse) chips.push([v.pulse, 'Pulse']);
    if (v.sugar) chips.push([v.sugar, 'Sugar']);
    if (v.spo2) chips.push([String(v.spo2).replace(/%?$/, '%'), 'SpO₂']);
    if (v.temperature) chips.push([v.temperature, 'Temperature']);
    if (v.weight) chips.push([/[a-z]/i.test(v.weight) ? v.weight : `${v.weight} kg`, 'Weight']);
    if (v.height) chips.push([/[a-z]/i.test(v.height) ? v.height : `${v.height} cm`, 'Height']);
    if (!chips.length) return '';
    return `<div class="chips">${chips.map(([val, lab]) => `<div class="chip"><strong>${esc(val)}</strong><span>${esc(lab)}</span></div>`).join('')}</div>`;
  }

  function bpNote(v = {}) {
    const sy = parseFloat(v.bpSystolic), di = parseFloat(v.bpDiastolic);
    if (!sy || !di) return '';
    if (sy >= 140 || di >= 90) return '<p class="c-note warn">Above the usual range (under 120/80). Show this to your doctor.</p>';
    if (sy < 90 || di < 60) return '<p class="c-note warn">Below the usual range (90/60 – 120/80). Show this to your doctor.</p>';
    return '';
  }

  function bulletList(items) {
    const arr = (items || []).map((x) => String(x).trim()).filter(Boolean);
    return arr.length ? `<ul class="bullets">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }
  const splitList = (s) => String(s || '').split(/\s*[,;]\s*|\n+/).filter(Boolean);

  function testsTable(findings) {
    const groups = [];
    for (const f of findings) {
      const sec = String(f.section || '').trim();
      let g = groups.find((x) => x.sec.toLowerCase() === sec.toLowerCase());
      if (!g) groups.push(g = { sec, rows: [] });
      g.rows.push(f);
    }
    return `
      <div class="inv">
        <div class="inv-head"><span>Test</span><span>Result</span><span><button type="button" class="abbr" data-abbr title="Reference range" aria-label="Reference range"><span class="ab-short">Ref.</span><span class="ab-full">Reference</span></button></span></div>
        ${groups.map((g) => `
          ${g.sec ? `<div class="inv-sec">${esc(g.sec)}</div>` : ''}
          ${g.rows.map((f) => {
            const fc = flagClass(f.flag);
            return `<div class="inv-row ${fc}">
              <span class="inv-name">${esc(f.name)}</span>
              <span class="inv-val">${esc(f.value)}${f.unit ? ` <small>${esc(f.unit)}</small>` : ''}${fc ? ` <b class="inv-flag">${fc === 'flag-high' ? 'High' : 'Low'}</b>` : ''}</span>
              <span class="inv-ref">${esc(f.range || '—')}</span>
            </div>`;
          }).join('')}`).join('')}
      </div>`;
  }

  function kebab(e) {
    return `
      <details class="kebab">
        <summary aria-label="More actions"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></summary>
        <div class="kebab-menu" role="menu">
          ${(e.files || []).length ? `<button type="button" role="menuitem" data-sources="${e.id}">View original files</button>
          <button type="button" role="menuitem" data-pdf="${e.id}">Download PDF</button>` : ''}
          ${!e.scanned && (e.files || []).length ? `<button type="button" role="menuitem" data-retry="${e.id}">Retry scan</button>` : ''}
          <button type="button" role="menuitem" data-setdate="${e.id}">Change date</button>
          <button type="button" role="menuitem" class="danger" data-delete="${e.id}">Delete record</button>
        </div>
      </details>`;
  }

  const todayISO = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  const dateSuspect = (e) => !e.date || e.date > todayISO() || e.date < '1950-01-01' || (e.needsReview || []).includes('date');

  // Same rule as the server: a future year is a misread digit — keep day & month, use the latest past year.
  function suggestDate(iso) {
    const t = todayISO();
    const [, mm, dd] = String(iso).split('-');
    for (let y = +t.slice(0, 4); y >= +t.slice(0, 4) - 1; y--) {
      const c = `${y}-${mm}-${dd}`;
      if (isoDate(c) && !isNaN(new Date(c + 'T00:00:00')) && c <= t) return c;
    }
    return '';
  }
  function reviewBanner(e) {
    const r = (e.needsReview || []).filter((x) => x !== 'date');
    const parts = [];
    if (!e.manual) {
      if (e.date && e.date > todayISO()) {
        const sug = suggestDate(e.date);
        parts.push(`<div class="rv-item">⚠ ${esc(fmtDate(e.date))} is in the future — misread.${sug ? ` Did you mean <strong>${esc(fmtDate(sug))}</strong>?` : ''}
          <span class="rv-actions">${sug ? `<button type="button" class="rv-btn" data-fixdate="${e.id}" data-to="${sug}">Yes, fix</button>` : ''}<button type="button" class="rv-btn ghost" data-setdate="${e.id}">Pick date</button></span></div>`);
      } else if (e.dateAutoFixed || (e.needsReview || []).includes('date')) {
        parts.push(`<div class="rv-item">⚠ ${e.dateAutoFixed ? `AI read “${esc(e.dateRead ? fmtDate(e.dateRead) : e.dateText)}”, corrected to ${esc(fmtDate(e.date))}.` : 'Please confirm the date.'}${e.dateText ? ` Printed: “${esc(e.dateText)}”.` : ''}
          <span class="rv-actions"><button type="button" class="rv-btn" data-okdate="${e.id}">Correct</button><button type="button" class="rv-btn ghost" data-setdate="${e.id}">Change</button></span></div>`);
      } else if (!e.date) {
        parts.push(`<div class="rv-item">⚠ Date not found on the document. <span class="rv-actions"><button type="button" class="rv-btn" data-setdate="${e.id}">Set date</button></span></div>`);
      }
    }
    if (r.length) parts.push(`<div class="rv-item">⚠ AI wasn’t sure about: ${esc(r.join(', '))}. Check the original file.</div>`);
    return parts.length ? `<div class="review">${parts.join('')}</div>` : '';
  }

  function cardHTML(e) {
    const k = kindOf(e);
    const nFiles = (e.files || []).length;
    const findings = (e.findings || []).filter((f) => f && f.name);
    const abnormal = findings.filter((f) => flagClass(f.flag));
    const meds = (e.medicines || []).filter((m) => m && m.name);
    const v = e.vitals || {};
    const who = [e.doctor, e.hospital || e.madeBy].filter(Boolean);
    // the day heading and time rail already show when; the card only adds the document type and files
    const meta = (e.documentType || nFiles) ? `
      <div class="c-meta-row">
        <span>${esc(e.documentType || '')}</span>
        ${nFiles ? `<button class="attach" type="button" data-sources="${e.id}">${clip}${nFiles} Attachment${nFiles > 1 ? 's' : ''}</button>` : ''}
      </div>` : '';

    if (!e.scanned) {
      return `
      <article class="t-card k-other unscanned">
        <header class="c-top">${icon('other')}<h3 class="c-name">${esc(e.title)}</h3>${kebab(e)}</header>
        ${meta}
        <p class="c-text muted">${esc(e.error ? 'Last attempt: ' + e.error : 'Saved, not read by the AI yet.')}</p>
        <button class="btn btn-primary btn-sm" type="button" data-retry="${e.id}">Retry scan</button>
      </article>`;
    }

    // one-line preview while collapsed
    const preview = abnormal.length
      ? `<p class="c-flags">${abnormal.slice(0, 3).map((f) => `<span class="${flagClass(f.flag)}">${esc(f.name)} ${flagClass(f.flag) === 'flag-high' ? '↑' : '↓'}</span>`).join('')}${abnormal.length > 3 ? `<span class="more">+${abnormal.length - 3}</span>` : ''}</p>`
      : findings.length ? `<p class="c-flags"><span class="ok">All ${findings.length} results in normal range</span></p>`
      : e.diagnosis ? `<p class="c-line">${esc(e.diagnosis)}</p>`
      : e.reportSays ? `<p class="c-line">${esc(e.reportSays)}</p>` : '';

    const hasMore = k !== 'vitals' && (e.reportSays || findings.length || e.symptoms?.length || e.diagnosis || e.suggestions || meds.length || e.billAmount);

    return `
      <article class="t-card k-${k}">
        <header class="c-top">${icon(k)}<h3 class="c-name">${esc(e.title)}</h3>${kebab(e)}</header>
        ${meta}
        ${who.length ? `<p class="c-who">${hospIcon}<span>${esc(who.join(' · '))}</span></p>` : ''}
        ${reviewBanner(e)}
        ${vitalsChips(v)}
        ${bpNote(v)}
        ${preview}
        ${hasMore ? `
        <div class="c-details">
          ${e.reportSays ? `<p class="c-text">${esc(e.reportSays)}</p>` : ''}
          ${findings.length ? testsTable(findings) : ''}
          ${e.symptoms?.length ? `<h4 class="c-h">Symptoms</h4>${bulletList(e.symptoms)}` : ''}
          ${e.diagnosis ? `<h4 class="c-h">Diagnosis</h4>${bulletList(splitList(e.diagnosis))}` : ''}
          ${e.suggestions ? `<h4 class="c-h">Doctor’s advice</h4><p class="c-text">${esc(e.suggestions)}</p>` : ''}
          ${meds.length ? `<h4 class="c-h">Medicines</h4>
          <p class="med-warn">Read by AI${k === 'rx' || k === 'doctor' ? ' from handwriting' : ''}. Always match name and dose with the original prescription before taking.</p>
          <ul class="meds">${meds.map((m, mi) => `
            <li class="${m.unclear ? 'unclear' : ''}"><button type="button" class="pill pill-btn${m.photo ? ' has-photo' : ''}" data-medpic="${e.id}" data-medi="${mi}" aria-label="Tablet picture for ${esc(m.name)}">${icon('rx', 14)}</button><div class="med-main"><strong>${esc(m.name)}${m.unclear ? ' <b class="chk">Check</b>' : ''}</strong>${[m.dose, m.frequency, m.duration].some(Boolean) ? `<span>${esc([m.dose, m.frequency, m.duration].filter(Boolean).join(' · '))}</span>` : ''}</div><button type="button" class="add-daily" data-adddaily="${e.id}" data-medi="${mi}" title="Add to Daily Tablets">+ Daily</button></li>`).join('')}
          </ul>
          ${(e.files || []).length ? `<button type="button" class="link-btn" data-sources="${e.id}">View original prescription</button>` : ''}` : ''}
          ${e.billAmount ? `<p class="c-bill">Bill amount <strong>${esc(e.billAmount)}</strong></p>` : ''}
          ${k !== 'vitals' ? `
          <div class="tldr-wrap">
            <button class="tldr-btn" type="button" data-tldr="${e.id}" aria-expanded="false" aria-controls="tldr-${e.id}">
              <span class="tldr-k">TL;DR</span><span class="tldr-hint">Explain this report simply</span>
            </button>
            <p class="tldr" id="tldr-${e.id}" hidden></p>
          </div>` : ''}
        </div>
        <button class="c-toggle" type="button" data-expand aria-expanded="false">
          <span class="when-closed">View details</span><span class="when-open">Hide details</span>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>` : ''}
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
    // left rail: "Oct 17, / 2026 / Tue" on the first card of each day; later cards that day show only the time
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let prevDay = null;
    $('#timeline').innerHTML = list.map((e) => {
      const d = e.date || (e.createdAt || '').slice(0, 10);
      const first = d !== prevDay;
      prevDay = d;
      const dt = new Date(d + 'T00:00:00');
      const dateBlock = first
        ? (isNaN(dt) ? '<span class="r-md">No date</span>'
          : `<span class="r-cal"><span class="r-wd">${WD[dt.getDay()]}</span><span class="r-d">${dt.getDate()}</span><span class="r-m">${MON[dt.getMonth()]}</span></span><span class="r-y">${dt.getFullYear()}</span>`)
        : '';
      return `
      <li class="t-item k-${e.scanned ? kindOf(e) : 'other'}${first ? ' day-first' : ''}" id="rec-${e.id}">
        <span class="t-rail${first && dateSuspect(e) && !e.manual ? ' suspect' : ''}">${dateBlock}${e.time ? `<span class="r-time">${esc(fmtTime(e.time))}</span>` : ''}</span>
        <span class="t-dot" aria-hidden="true"></span>
        ${cardHTML(e)}
      </li>`;
    }).join('');
    window.MHF?.afterHistory?.();
  }

  // ---------- Document scanner ----------
  function openScanner() {
    if (!window.MHScanner) return alert('Scanner did not load. Please refresh the page.');
    window.MHScanner.open({
      onDone(pages, docId) {
        const room = MAX_FILES - pending.length;
        if (pages.length > room) alert(`Only ${room} more file${room === 1 ? '' : 's'} fit in one scan. Extra pages were left out.`);
        for (const pg of pages.slice(0, Math.max(0, room))) {
          pending.push({ id: uid(), name: pg.name, mediaType: 'image/jpeg', dataUrl: pg.dataUrl, docId, side: pg.side, page: pg.page });
        }
        renderPending();
        $('#pending').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    });
  }

  // ---------- PDF of a record (for doctors) ----------
  async function downloadPdf(id, btn) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const imgs = (e.files || []).filter((f) => f.mediaType !== 'application/pdf');
    const pdfs = (e.files || []).filter((f) => f.mediaType === 'application/pdf');
    const label = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = spin('Making PDF…'); }
    try {
      if (pdfs.length && (pdfs.some((f) => f.storeOnly) || !imgs.length)) { // original PDF exists — give that, untouched
        const orig = pdfs.find((f) => f.storeOnly) || pdfs[0];
        const { data } = await sb.storage.from(BUCKET).createSignedUrl(orig.path, 600, { download: orig.name });
        if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener');
        return;
      }
      if (!imgs.length) throw new Error('This record has no pages to export.');
      const pages = [];
      for (const f of imgs) pages.push({ dataUrl: await fileAsDataURL(f), name: f.name });
      const who = pname(active()).replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '-');
      const title = `${e.title || 'Report'} — ${pname(active())}${e.date ? ' — ' + fmtDate(e.date) : ''}`;
      const pdf = await window.MHPdf.build(pages, title);
      pdf.save(`${who}_${(e.title || 'report').replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '-')}_${e.date || 'undated'}.pdf`);
    } catch (err) {
      alert('Could not make the PDF: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  // ---------- Fix a record's date ----------
  async function saveDate(id, d) {
    const e = entries.find((x) => x.id === id);
    if (!e || !isoDate(d)) return;
    e.date = d;
    e.dateAutoFixed = false;
    e.needsReview = (e.needsReview || []).filter((x) => x !== 'date');
    try {
      const { id: rid, ...data } = e;
      const { error } = await sb.from('hh_records').update({ data, record_date: d }).eq('id', rid);
      if (error) throw error;
      await loadEntries();
      renderHistory();
      document.getElementById('rec-' + rid)?.scrollIntoView({ block: 'center' });
    } catch (err) { alert('Could not save date: ' + err.message); }
  }
  function changeDate(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.max = todayISO();
    inp.value = isoDate(e.date) && e.date <= todayISO() ? e.date : '';
    inp.className = 'sr-only';
    document.body.appendChild(inp);
    const done = () => setTimeout(() => inp.remove(), 0);
    inp.addEventListener('change', () => { const d = inp.value; done(); saveDate(id, d); });
    inp.addEventListener('blur', done);
    try { inp.showPicker(); } catch { inp.classList.remove('sr-only'); inp.focus(); inp.click(); }
  }

  // ---------- Manual BP / vitals ----------
  function openVitals() {
    const dlg = $('#vitalsDialog');
    const f = $('#vitalsForm');
    f.reset();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    f.elements.date.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    f.elements.time.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    $('#vitalsFor').textContent = `For ${pname(active())}`;
    setStatus($('#vitalsStatus'), '');
    dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
  }
  async function saveVitals(ev) {
    ev.preventDefault();
    const f = ev.target;
    const status = $('#vitalsStatus');
    const v = {};
    for (const k of VITAL_KEYS) if (f.elements[k] && f.elements[k].value.trim()) v[k] = f.elements[k].value.trim();
    if (v.temperature) v.temperature += ' °F';
    if (!Object.keys(v).length) return setStatus(status, 'Enter at least one reading.', 'error');
    if (!!v.bpSystolic !== !!v.bpDiastolic) return setStatus(status, 'Enter both systolic and diastolic for BP.', 'error');
    const date = f.elements.date.value;
    if (!isoDate(date)) return setStatus(status, 'Pick a date.', 'error');
    const btn = $('#vitalsSave');
    btn.disabled = true;
    try {
      const note = f.elements.note.value.trim();
      const e = {
        id: uid(), createdAt: new Date().toISOString(), scanned: true, manual: true,
        date, time: f.elements.time.value || '', documentType: 'Vitals',
        title: v.bpSystolic ? 'Blood pressure' : 'Vitals check', vitals: v,
        reportSays: note, files: [],
      };
      await putEntry(e, activeId);
      await loadEntries();
      $('#vitalsDialog').close();
      renderHistory();
    } catch (err) { setStatus(status, esc(err.message), 'error'); }
    finally { btn.disabled = false; }
  }

  // TL;DR is made only when asked, then saved on the record so it is never generated twice.
  async function toggleTldr(btn) {
    const id = btn.dataset.tldr;
    const box = document.getElementById('tldr-' + id);
    if (btn.getAttribute('aria-expanded') === 'true') {
      btn.setAttribute('aria-expanded', 'false');
      box.hidden = true;
      return;
    }
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    btn.setAttribute('aria-expanded', 'true');
    box.hidden = false;
    if (e.tldr) { box.textContent = e.tldr; return; }
    box.innerHTML = spin('Summarising…');
    btn.disabled = true;
    try {
      const { files, id: _id, createdAt, scanned, error, tldr, ...record } = e;
      const { tldr: text } = await api('/api/tldr', { record });
      e.tldr = text;
      box.textContent = text;
      try { // saving is best-effort; the summary is already on screen
        const { id: rid, ...data } = e;
        await sb.from('hh_records').update({ data }).eq('id', rid);
      } catch (saveErr) { console.warn('TL;DR not saved', saveErr); }
    } catch (err) {
      box.innerHTML = `<span class="status error">${esc(err.status === 401 ? 'Session expired — please log in again.' : 'Couldn’t summarise: ' + err.message)}</span>`;
    } finally { btn.disabled = false; }
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
    const pdfBtn = files.length ? `<button type="button" class="btn btn-primary btn-sm src-pdf" data-pdf="${e.id}">Download as PDF</button>` : '';
    $('#sourcesBody').innerHTML = pdfBtn + files.map((f, i) => {
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
    window.MHF?.afterProfile?.();
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
      const gone = pending.find((p) => p.id === b.dataset.remove);
      pending = pending.filter((p) => p.id !== b.dataset.remove);
      if (gone?.storeOnly) pending = pending.filter((p) => p.docId !== gone.docId);           // remove the whole PDF
      else if (gone?.docId && !pending.some((p) => p.docId === gone.docId && !p.storeOnly))   // last page removed
        pending = pending.filter((p) => p.docId !== gone.docId);
      renderPending();
    });
    $('#clearPending').addEventListener('click', () => { pending = []; renderPending(); setStatus($('#scanStatus'), ''); });
    $('#scanBtn').addEventListener('click', scanPending);

    $('#searchInput').addEventListener('input', renderHistory);
    $('#timeline').addEventListener('click', async (e) => {
      const t = e.target.closest('[data-tldr]');
      if (t) return toggleTldr(t);
      const mp = e.target.closest('[data-medpic]');
      if (mp) return window.MHF?.medPicture?.(mp.dataset.medpic, +mp.dataset.medi);
      const ad = e.target.closest('[data-adddaily]');
      if (ad) return window.MHF?.addDailyFromRecord?.(ad.dataset.adddaily, +ad.dataset.medi);
      const pd = e.target.closest('[data-pdf]');
      if (pd) { pd.closest('details')?.removeAttribute('open'); return downloadPdf(pd.dataset.pdf); }
      const fx = e.target.closest('[data-fixdate]');
      if (fx) return saveDate(fx.dataset.fixdate, fx.dataset.to);
      const ok = e.target.closest('[data-okdate]');
      if (ok) { const r = entries.find((x) => x.id === ok.dataset.okdate); return r && saveDate(r.id, r.date); }
      const sd = e.target.closest('[data-setdate]');
      if (sd) { sd.closest('details')?.removeAttribute('open'); return changeDate(sd.dataset.setdate); }
      const ab = e.target.closest('[data-abbr]');
      if (ab) { ab.classList.toggle('show-full'); return; }
      const x = e.target.closest('[data-expand]');
      if (x) {
        const open = x.closest('.t-card').classList.toggle('open');
        x.setAttribute('aria-expanded', String(open));
        return;
      }
      if (e.target.closest('.kebab-menu button')) e.target.closest('details')?.removeAttribute('open');
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
    $('#addVitalsBtn').addEventListener('click', openVitals);
    $('#scanDocBtn').addEventListener('click', openScanner);
    $('#sourcesBody').addEventListener('click', (ev) => { const b = ev.target.closest('[data-pdf]'); if (b) downloadPdf(b.dataset.pdf, b); });
    $('#vitalsForm').addEventListener('submit', saveVitals);
    $('#vitalsDialog').addEventListener('click', (e) => { if (e.target.id === 'vitalsDialog' || e.target.closest('[data-close]')) $('#vitalsDialog').close(); });
    document.addEventListener('click', (e) => {
      $$('details.kebab[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
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

  // ---------- Auto-hide header & bottom nav on scroll ----------
  function autoHideChrome() {
    let lastY = window.scrollY, ticking = false;
    const update = () => {
      const y = window.scrollY;
      const nearBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 40;
      if (y < 60 || nearBottom) document.body.classList.remove('chrome-hidden');
      else if (y > lastY + 6) document.body.classList.add('chrome-hidden');
      else if (y < lastY - 6) document.body.classList.remove('chrome-hidden');
      if (Math.abs(y - lastY) > 6) lastY = y;
      ticking = false;
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('hashchange', () => document.body.classList.remove('chrome-hidden'));
    document.addEventListener('focusin', (e) => { if (e.target.closest('.topbar, .nav-mobile')) document.body.classList.remove('chrome-hidden'); });
  }

  // ---------- shared with features.js ----------
  window.MHApp = {
    get sb() { return sb; }, get user() { return user; }, get patients() { return patients; },
    get activeId() { return activeId; }, get entries() { return entries; },
    active, pname, esc, spin, setStatus, fmtDate, fmtTime, isoDate, uid, api, todayISO, ageOf,
    compressImage, blobToDataURL, fileAsDataURL, dataUrlToBlob, BUCKET,
    loadPatients, loadEntries, renderHistory, renderProfile, route, paintPatientSwitch, validAadhaar, fmtAadhaarInput,
    render: { testsTable, vitalsChips, bulletList, splitList, kindOf, icon, flagClass },
    async refreshPatients() { await loadPatients(); paintPatientSwitch(); },
  };

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
    autoHideChrome();
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
