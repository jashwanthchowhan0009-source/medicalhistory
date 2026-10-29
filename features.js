/* Medical History — family, doctor & tablet features.
 * Patient ID + one-time share code (general checkup), Emergency QR card, verified doctor tools,
 * Daily Tablets with reminders, health/insurance cards, tablet scan + "Look it up" box.
 * All privileged reads go through Postgres security-definer functions (see supabase/002_*.sql).
 */
(() => {
  'use strict';
  const A = () => window.MHApp;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => A().esc(v);
  const spin = (t) => A().spin(t);

  // ---------- small helpers ----------
  const SLOTS = [
    { k: 'M', label: 'Morning', time: '08:00' },
    { k: 'A', label: 'Afternoon', time: '13:00' },
    { k: 'E', label: 'Evening', time: '18:00' },
    { k: 'N', label: 'Night', time: '21:00' },
  ];
  const FOOD = { BF: 'Before food', AF: 'After food' };
  const scripts = {};
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    if (!scripts[src]) {
      scripts[src] = new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = src; s.async = true;
        s.onload = () => res(); s.onerror = () => { delete scripts[src]; rej(new Error('Could not load a tool. Check your internet.')); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }
  const loadQR = () => loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js', () => !!window.qrcode);
  const loadJsQR = () => loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', () => !!window.jsQR);
  const loadTesseract = () => loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', () => !!window.Tesseract);

  function dialog(title, html) {
    const d = $('#mhDialog');
    $('#mhDlgTitle').textContent = title;
    $('#mhDlgBody').innerHTML = html;
    if (!d.open) d.showModal ? d.showModal() : d.setAttribute('open', '');
    return $('#mhDlgBody');
  }
  const closeDialog = () => { const d = $('#mhDialog'); if (d.open) d.close(); };

  // tiny, safe markdown: escape first, then **bold** and bullet lines
  function md(text) {
    const lines = esc(text).split(/\n+/);
    let html = '', list = false;
    for (let l of lines) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
      if (/^\s*([-*•]|\d+\.)\s+/.test(l)) {
        if (!list) { html += '<ul>'; list = true; }
        html += `<li>${l.replace(/^\s*([-*•]|\d+\.)\s+/, '')}</li>`;
      } else {
        if (list) { html += '</ul>'; list = false; }
        if (l.trim()) html += `<p>${l}</p>`;
      }
    }
    return html + (list ? '</ul>' : '');
  }
  const sourcesHTML = (src) => (src && src.length ? `<div class="sources"><span>Sources</span>${src.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.title.replace(/^www\./, ''))}</a>`).join('')}</div>` : '');

  async function photoToApi(file, max = 1800) {
    const dataUrl = await A().compressImage(file, max);
    return { mediaType: 'image/jpeg', data: dataUrl.split(',')[1], dataUrl };
  }
  async function signed(path, secs = 3600, bucket) {
    const { data } = await A().sb.storage.from(bucket || A().BUCKET).createSignedUrl(path, secs);
    return data?.signedUrl || '';
  }
  async function uploadImage(path, dataUrl, bucket) {
    const { error } = await A().sb.storage.from(bucket || A().BUCKET).upload(path, A().dataUrlToBlob(dataUrl), { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error('Upload failed: ' + error.message);
    return path;
  }
  const hasMigration = () => (A().patients || []).some((p) => p.public_code);
  const setupNote = () => '<p class="setup-note">⚙️ One-time setup pending: run <code>supabase/002_family_doctor_emergency.sql</code> in Supabase → SQL Editor, then reload.</p>';

  async function savePatientData(p, patch) {
    const data = { ...(p.data || {}), ...patch };
    const { error } = await A().sb.from('hh_patients').update({ data }).eq('id', p.id);
    if (error) throw error;
    p.data = data;
  }

  // ═════════════ Patient ID + share with doctor (History top) ═════════════
  function afterHistory() {
    const p = A().active();
    const bar = $('#pidBar');
    if (!bar) return;
    if (!p) { bar.innerHTML = ''; return; }
    if (!p.public_code) { bar.innerHTML = setupNote(); return; }
    bar.innerHTML = `
      <div class="pid">
        <div class="pid-id"><span class="pid-k">Patient ID</span><button type="button" class="pid-code" data-copy="${esc(p.public_code)}" title="Copy">${esc(p.public_code)}</button></div>
        <button type="button" class="btn btn-primary btn-sm" id="shareDoctorBtn">Share with doctor</button>
      </div>`;
  }

  let codeTimer = null;
  async function shareWithDoctor() {
    const p = A().active();
    if (!p) return;
    const body = dialog('Share with your doctor', `<p class="muted">${spin('Making a one-time code…')}</p>`);
    try {
      const { data: code, error } = await A().sb.rpc('create_share_code', { p_patient: p.id });
      if (error) throw error;
      const until = Date.now() + 10 * 60e3;
      body.innerHTML = `
        <p class="muted">Tell the doctor these two. They can open ${esc(A().pname(p))}’s history for 24 hours, read-only. You’ll see it in Profile → Access.</p>
        <div class="share-box">
          <div><span>Patient ID</span><strong>${esc(p.public_code)}</strong></div>
          <div><span>Code</span><strong class="otp">${esc(String(code).replace(/(\d{3})(\d{3})/, '$1 $2'))}</strong></div>
        </div>
        <p class="share-timer" id="shareTimer"></p>
        <p class="hint">Only verified doctors can use it. It works once and expires in 10 minutes.</p>`;
      clearInterval(codeTimer);
      const tick = () => {
        const left = Math.max(0, until - Date.now());
        const el = $('#shareTimer'); if (!el) return clearInterval(codeTimer);
        el.textContent = left ? `Expires in ${Math.floor(left / 60e3)}:${String(Math.floor(left / 1e3) % 60).padStart(2, '0')}` : 'Expired — make a new code.';
        if (!left) clearInterval(codeTimer);
      };
      tick(); codeTimer = setInterval(tick, 1000);
    } catch (err) {
      body.innerHTML = `<p class="status error">${esc(errMsg(err))}</p>${setupNote()}`;
    }
  }

  // ═════════════ Profile extras ═════════════
  let medsCache = [];   // active patient's daily tablets
  let allMeds = [];     // every patient's (for reminders)

  async function loadMeds() {
    const { data, error } = await A().sb.from('hh_meds').select('id, patient_id, data, active, created_at').order('created_at');
    if (error) { allMeds = []; medsCache = []; return false; }
    allMeds = data || [];
    medsCache = allMeds.filter((m) => m.patient_id === A().activeId);
    return true;
  }

  async function afterProfile() {
    const root = $('#profileExtras');
    if (!root) return;
    const p = A().active();
    if (!p) { root.innerHTML = ''; return; }
    const ok = await loadMeds();
    root.innerHTML = `
      ${!hasMigration() || !ok ? setupNote() : ''}
      <section class="panel" id="medsPanel" aria-labelledby="medsTitle"></section>
      <section class="panel" id="cardsPanel" aria-labelledby="cardsTitle"></section>
      <section class="panel" id="emPanel" aria-labelledby="emTitle"></section>
      <section class="panel" id="accessPanel" aria-labelledby="accTitle"></section>
      <section class="panel doctor-entry">
        <div class="section-head"><h2 class="h3">Doctor tools</h2><a class="btn btn-outline btn-sm" href="#doctor">Open</a></div>
        <p class="muted">Doctors: register with your medical council number to use Emergency and General checkup access.</p>
      </section>`;
    renderMeds(); renderCards(); renderEmergency(); renderAccess();
  }

  // ───────── Daily tablets ─────────
  const slotTimes = (p) => ({ ...Object.fromEntries(SLOTS.map((s) => [s.k, s.time])), ...(p?.data?.slotTimes || {}) });

  function renderMeds() {
    const el = $('#medsPanel'); if (!el) return;
    const p = A().active();
    const t = slotTimes(p);
    const list = medsCache.filter((m) => m.active !== false);
    el.innerHTML = `
      <div class="section-head">
        <h2 class="h3" id="medsTitle">Daily Tablets</h2>
        <button class="btn btn-primary btn-sm" type="button" data-medadd>+ Add</button>
      </div>
      <p class="legend"><b>M</b> Morning ${esc(t.M)} · <b>A</b> Afternoon ${esc(t.A)} · <b>E</b> Evening ${esc(t.E)} · <b>N</b> Night ${esc(t.N)} · <b>BF</b> before food · <b>AF</b> after food <button type="button" class="link-btn tiny" data-slottimes>Edit times</button></p>
      ${list.length ? `<ul class="dmeds">${list.map((m) => {
        const d = m.data || {};
        return `<li>
          <button type="button" class="dm-pic${d.photo ? ' has' : ''}" data-dmpic="${m.id}" aria-label="Tablet picture">${A().render.icon('rx', 16)}</button>
          <div class="dm-main"><strong>${esc(d.name)}</strong>${d.dose ? `<span>${esc(d.dose)}</span>` : ''}${d.endDate ? `<span class="muted">till ${esc(A().fmtDate(d.endDate))}</span>` : ''}${d.doctor ? `<span class="muted dm-doc-line">${esc(d.doctor)}</span>` : ''}</div>
          <div class="dm-slots">${SLOTS.map((s) => `<i class="${(d.slots || []).includes(s.k) ? 'on' : ''}" title="${s.label}">${s.k}</i>`).join('')}${d.food ? `<em title="${FOOD[d.food]}">${d.food}</em>` : ''}</div>
          <button type="button" class="dm-bell${d.remind ? ' on' : ''}" data-dmbell="${m.id}" aria-label="${d.remind ? 'Reminder on' : 'Reminder off'}" aria-pressed="${!!d.remind}">🔔</button>
          <button type="button" class="dm-edit" data-dmedit="${m.id}" aria-label="Edit ${esc(d.name)}">✎</button>
        </li>`;
      }).join('')}</ul>` : '<p class="muted">No daily tablets yet. Add them here, from a prescription (“+ Daily”), or by scanning a tablet on Home.</p>'}
      ${list.length ? `<div class="row-actions rem-actions">
        <button type="button" class="btn btn-outline btn-sm" data-remon>${notifState()}</button>
        <button type="button" class="btn btn-outline btn-sm" data-ics>Add reminders to phone calendar</button>
      </div>
      <p class="hint">Phone calendar reminders work even when the app is closed. App notifications need the app open or installed.</p>` : ''}`;
  }
  const notifState = () => (!('Notification' in window) ? 'Notifications not supported'
    : Notification.permission === 'granted' ? '✓ App notifications on' : 'Turn on app notifications');

  // frequency like "1-0-1", "BD", "TDS", "OD", "HS" → slots; "after food" → AF
  function parseFrequency(f = '') {
    const s = String(f).toUpperCase();
    let slots = [];
    const m = s.match(/\b([01½]|1\/2)\s*-\s*([01½]|1\/2)\s*-\s*([01½]|1\/2)(?:\s*-\s*([01½]|1\/2))?\b/);
    if (m) {
      const on = (x) => x && x !== '0';
      slots = m[4] !== undefined ? ['M', 'A', 'E', 'N'].filter((k, i) => on(m[i + 1])) : ['M', 'A', 'N'].filter((k, i) => on(m[i + 1]));
    } else if (/\b(QID|QDS)\b/.test(s)) slots = ['M', 'A', 'E', 'N'];
    else if (/\b(TDS|TID|THRICE)\b/.test(s)) slots = ['M', 'A', 'N'];
    else if (/\b(BD|BID|TWICE)\b/.test(s)) slots = ['M', 'N'];
    else if (/\b(HS|BEDTIME|NIGHT)\b/.test(s)) slots = ['N'];
    else if (/\b(OD|ONCE|MORNING)\b/.test(s)) slots = ['M'];
    const food = /AFTER|\bAC\b|\bA\/F\b|\bAF\b/.test(s) ? 'AF' : /BEFORE|EMPTY|\bPC\b|\bB\/F\b|\bBF\b/.test(s) ? 'BF' : '';
    return { slots, food };
  }

  // ── Doctors from this patient's reports, and which one prescribed a tablet ──
  const docKey = (n) => String(n || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\bdr\b\.?/g, '').replace(/[^a-z]/g, '');
  const MED_STOP = /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syrup|inj|injection|t|c|oint|ointment|gel|drops?|susp|suspension|mg|ml|mcg|iu|sr|er|xr|cr|ds|forte|plus)$/;
  const medKey = (n) => (String(n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).find((w) => w.length >= 3 && /[a-z]/.test(w) && !MED_STOP.test(w)) || '');
  function reportDoctors() {
    const seen = new Map();
    [...(A().entries || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).forEach((e) => {
      const name = String(e.doctor || '').trim(); const k = docKey(name);
      if (k.length >= 3 && !seen.has(k)) seen.set(k, name);
    });
    return [...seen.values()];
  }
  // newest prescription that lists this tablet AND names a doctor; null when none (then we say nothing)
  function prescriberOf(names) {
    const keys = names.map(medKey).filter(Boolean);
    if (!keys.length) return null;
    const recs = [...(A().entries || [])].filter((e) => String(e.doctor || '').trim())
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    for (const e of recs) {
      if ((e.medicines || []).some((md) => keys.includes(medKey(md.name)))) return { doctor: e.doctor.trim(), date: e.date || '' };
    }
    return null;
  }

  // Supabase errors → words a person understands (the raw one stays in the console)
  function errMsg(err) {
    const msg = String(err?.message || err || 'Something went wrong');
    console.warn('[MedH]', msg);
    if (/schema cache|does not exist|could not find the (table|function)|PGRST20[25]|42P01|42883/i.test(msg)) {
      // only happens before the one-time database setup, i.e. while the owner is setting up
      return 'This feature isn’t switched on yet. Setup: run supabase/002_family_doctor_emergency.sql once in the Supabase SQL Editor, then reload.';
    }
    if (/failed to fetch|network|load failed/i.test(msg)) return 'No internet connection. Check it and try again.';
    if (/row-level security|permission denied|not allowed/i.test(msg)) return 'You don’t have permission for this.';
    return msg;
  }

  function medForm(m, prefill = {}) {
    const d = { ...(m?.data || {}), ...prefill };
    const body = dialog(m ? 'Edit tablet' : 'Add daily tablet', `
      <form id="dmForm" class="dm-form" novalidate>
        <div class="field"><label for="dm-name">Tablet name</label><input id="dm-name" name="name" required value="${esc(d.name || '')}" placeholder="e.g. Metformin 500 mg"></div>
        <div class="field"><label for="dm-dose">Dose</label><input id="dm-dose" name="dose" value="${esc(d.dose || '')}" placeholder="e.g. 1 tablet"></div>
        <fieldset class="slot-pick"><legend>When</legend>
          ${SLOTS.map((s) => `<label class="sp"><input type="checkbox" name="slots" value="${s.k}" ${(d.slots || []).includes(s.k) ? 'checked' : ''}><span><b>${s.k}</b><small>${s.label}</small></span></label>`).join('')}
        </fieldset>
        <fieldset class="slot-pick food"><legend>Food</legend>
          ${['BF', 'AF', ''].map((k) => `<label class="sp"><input type="radio" name="food" value="${k}" ${(d.food || '') === k ? 'checked' : ''}><span><b>${k || '–'}</b><small>${k ? FOOD[k] : 'Any time'}</small></span></label>`).join('')}
        </fieldset>
        <div class="form-grid">
          <div class="field"><label for="dm-start">From</label><input id="dm-start" name="startDate" type="date" value="${esc(d.startDate || A().todayISO())}"></div>
          <div class="field"><label for="dm-end">Till (optional)</label><input id="dm-end" name="endDate" type="date" value="${esc(d.endDate || '')}"></div>
        </div>
        <div class="field dm-doc" id="dmDocField" hidden>
          <span class="lbl" id="dmDocLbl">Prescribed by</span>
          <div class="doc-chips" role="radiogroup" aria-labelledby="dmDocLbl" id="dmDocChips"></div>
          <p class="hint" id="dmDocHint" hidden></p>
        </div>
        <div class="field"><label for="dm-note">Note</label><input id="dm-note" name="note" value="${esc(d.note || '')}" placeholder="e.g. take with warm water"></div>
        <label class="check"><input type="checkbox" name="remind" ${d.remind !== false ? 'checked' : ''}> Remind me</label>
        <p class="hint">Copy name and dose exactly from the prescription.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button>${m ? '<button class="link-btn danger" type="button" id="dmDelete">Remove</button>' : ''}</div>
        <p class="status" id="dmStatus" role="status"></p>
      </form>`);
    const f = $('#dmForm', body);
    // doctor chips: every doctor found in this patient's reports; auto-pick the one whose prescription lists this tablet
    const docs = reportDoctors();
    if (d.doctor && !docs.some((x) => docKey(x) === docKey(d.doctor))) docs.unshift(d.doctor);
    let pickedDoc = d.doctor || '';
    let userPicked = !!d.doctor;
    const chipsEl = $('#dmDocChips', body);
    const paintDocs = () => {
      chipsEl.innerHTML = docs.map((n) => `<button type="button" class="doc-chip${docKey(n) === docKey(pickedDoc) ? ' on' : ''}" role="radio" aria-checked="${docKey(n) === docKey(pickedDoc)}" data-doc="${esc(n)}">${esc(n)}</button>`).join('');
    };
    const detect = () => {
      if (userPicked) return;
      const hit = prescriberOf([$('#dm-name', body).value, ...(prefill.altNames || [])]);
      const hint = $('#dmDocHint', body);
      if (hit) {
        pickedDoc = hit.doctor;
        hint.hidden = false;
        hint.textContent = `Found on ${hit.doctor}’s prescription${hit.date ? ` (${A().fmtDate(hit.date)})` : ''}.`;
      } else { pickedDoc = ''; hint.hidden = true; }
      paintDocs();
    };
    if (docs.length) {
      $('#dmDocField', body).hidden = false;
      paintDocs();
      if (prefill.fromRecord && d.doctor) {
        const hint = $('#dmDocHint', body); hint.hidden = false; hint.textContent = 'From this prescription.';
      } else detect();
      chipsEl.addEventListener('click', (ev) => {
        const c = ev.target.closest('[data-doc]'); if (!c) return;
        userPicked = true;
        pickedDoc = docKey(c.dataset.doc) === docKey(pickedDoc) ? '' : c.dataset.doc;   // tap again to clear
        $('#dmDocHint', body).hidden = true;
        paintDocs();
      });
      let t; $('#dm-name', body).addEventListener('input', () => { clearTimeout(t); t = setTimeout(detect, 250); });
    }
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f);
      const data = {
        ...(m?.data || {}), ...prefill,
        name: String(fd.get('name') || '').trim(), dose: String(fd.get('dose') || '').trim(),
        slots: fd.getAll('slots'), food: String(fd.get('food') || ''),
        startDate: String(fd.get('startDate') || ''), endDate: String(fd.get('endDate') || ''),
        note: String(fd.get('note') || '').trim(), remind: !!fd.get('remind'),
        doctor: pickedDoc,
      };
      delete data.altNames;
      if (!data.name) return A().setStatus($('#dmStatus'), 'Enter the tablet name.', 'error');
      if (!data.slots.length) return A().setStatus($('#dmStatus'), 'Pick at least one time (M / A / E / N).', 'error');
      try {
        const sb = A().sb;
        const q = m ? sb.from('hh_meds').update({ data }).eq('id', m.id)
          : sb.from('hh_meds').insert({ patient_id: A().activeId, user_id: A().user.id, data });
        const { error } = await q;
        if (error) throw error;
        closeDialog();
        await loadMeds(); renderMeds(); scheduleReminders();
      } catch (err) { A().setStatus($('#dmStatus'), esc(errMsg(err)), 'error'); }
    });
    $('#dmDelete', body)?.addEventListener('click', async () => {
      if (!confirm(`Remove ${d.name} from Daily Tablets?`)) return;
      const { error } = await A().sb.from('hh_meds').delete().eq('id', m.id);
      if (error) return alert(errMsg(error));
      closeDialog(); await loadMeds(); renderMeds(); scheduleReminders();
    });
  }

  function editSlotTimes() {
    const p = A().active(); const t = slotTimes(p);
    const body = dialog('Reminder times', `
      <form id="stForm" class="form-grid">
        ${SLOTS.map((s) => `<div class="field"><label for="st-${s.k}"><b>${s.k}</b> ${s.label}</label><input id="st-${s.k}" name="${s.k}" type="time" value="${esc(t[s.k])}"></div>`).join('')}
        <div class="span-2 form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>`);
    $('#stForm', body).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const slot = Object.fromEntries(SLOTS.map((s) => [s.k, String(fd.get(s.k) || s.time)]));
      try { await savePatientData(p, { slotTimes: slot }); closeDialog(); renderMeds(); scheduleReminders(); }
      catch (err) { alert(err.message); }
    });
  }

  async function medPhotoDialog({ title, name, path, onUpload }) {
    const url = path ? await signed(path) : '';
    const body = dialog(title, `
      ${url ? `<img class="med-photo" src="${esc(url)}" alt="Photo of ${esc(name)}">` : `<p class="muted">No photo of this tablet yet.</p>`}
      <div class="row-actions">
        <label class="btn btn-primary btn-sm" for="medPhotoIn">${url ? 'Replace photo' : 'Add photo of the strip / box'}</label>
        <a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name + ' tablet strip')}">See pictures on Google</a>
      </div>
      <input class="sr-only" type="file" id="medPhotoIn" accept="image/*" capture="environment">
      <p class="hint">Google pictures may show a different brand or strength. Always match with your own strip.</p>
      <p class="status" id="medPhotoSt" role="status"></p>`);
    $('#medPhotoIn', body).addEventListener('change', async (ev) => {
      const file = ev.target.files[0]; if (!file) return;
      A().setStatus($('#medPhotoSt'), spin('Saving photo…'));
      try { await onUpload(file); closeDialog(); }
      catch (err) { A().setStatus($('#medPhotoSt'), esc(errMsg(err)), 'error'); }
    });
  }

  // tablet icon on a prescription medicine (History)
  async function medPicture(recId, i) {
    const e = A().entries.find((x) => x.id === recId);
    const m = e?.medicines?.[i];
    if (!m) return;
    await medPhotoDialog({
      title: m.name, name: m.name, path: m.photo,
      onUpload: async (file) => {
        const ph = await photoToApi(file, 1400);
        const path = `${A().user.id}/${A().activeId}/meds/${A().uid()}.jpg`;
        await uploadImage(path, ph.dataUrl);
        e.medicines[i] = { ...m, photo: path };
        const { id, ...data } = e;
        const { error } = await A().sb.from('hh_records').update({ data }).eq('id', id);
        if (error) throw error;
        A().renderHistory();
      },
    });
  }

  function addDailyFromRecord(recId, i) {
    const e = A().entries.find((x) => x.id === recId);
    const m = e?.medicines?.[i];
    if (!m) return;
    const { slots, food } = parseFrequency(`${m.frequency || ''} ${m.dose || ''}`);
    let endDate = '';
    const days = String(m.duration || '').match(/(\d+)\s*(day|week|month)/i);
    if (days) {
      const n = +days[1] * ({ day: 1, week: 7, month: 30 }[days[2].toLowerCase()] || 1);
      const start = e.date && e.date <= A().todayISO() ? e.date : A().todayISO();
      const d = new Date(start + 'T00:00:00'); d.setDate(d.getDate() + n - 1);
      endDate = d.toISOString().slice(0, 10);
    }
    medForm(null, { name: m.name, dose: m.dose || '', slots, food, endDate, photo: m.photo || '', doctor: String(e.doctor || '').trim(), note: m.frequency || '', fromRecord: recId });
  }

  // ───────── Reminders ─────────
  let remTimer = null;
  async function enableNotifications() {
    if (!('Notification' in window)) return alert('This browser cannot show notifications. Use “Add reminders to phone calendar”.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return alert('Notifications are blocked. Allow them in browser settings, or use phone calendar reminders.');
    await registerSW();
    scheduleReminders();
    renderMeds();
    notify('Reminders are on', 'You’ll get a notice at each tablet time while the app is open or installed.');
  }
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
  }
  async function notify(title, body, tag) {
    const reg = await registerSW();
    const opts = { body, tag, icon: '/assets/icon-192.png', badge: '/assets/icon-192.png', renotify: !!tag };
    if (reg?.showNotification) return reg.showNotification(title, opts);
    try { new Notification(title, opts); } catch { /* ignore */ }
  }
  function scheduleReminders() {
    clearInterval(remTimer);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const check = () => {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = A().todayISO();
      for (const p of A().patients || []) {
        const t = slotTimes(p);
        for (const s of SLOTS) {
          if (t[s.k] !== hm) continue;
          const due = allMeds.filter((m) => m.patient_id === p.id && m.active !== false && m.data?.remind !== false
            && (m.data?.slots || []).includes(s.k) && (!m.data.startDate || m.data.startDate <= today) && (!m.data.endDate || m.data.endDate >= today));
          if (!due.length) continue;
          const key = `mh-rem-${p.id}-${today}-${s.k}`;
          try { if (localStorage.getItem(key)) continue; localStorage.setItem(key, '1'); } catch { /* ignore */ }
          notify(`${s.label} tablets — ${A().pname(p)}`, due.map((m) => `${m.data.name}${m.data.dose ? ' · ' + m.data.dose : ''}${m.data.food ? ' · ' + m.data.food : ''}`).join('\n'), key);
        }
      }
    };
    check();
    remTimer = setInterval(check, 30e3);
  }
  function downloadICS() {
    const p = A().active(); const t = slotTimes(p);
    const meds = medsCache.filter((m) => m.active !== false);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const escI = (s) => String(s).replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Medical History//Tablets//EN\r\nCALSCALE:GREGORIAN\r\n';
    for (const s of SLOTS) {
      const due = meds.filter((m) => (m.data?.slots || []).includes(s.k));
      if (!due.length) continue;
      const start = (due.map((m) => m.data.startDate).filter(Boolean).sort()[0] || A().todayISO()).replace(/-/g, '');
      const ends = due.map((m) => m.data.endDate);
      const until = ends.every(Boolean) ? ends.sort().reverse()[0].replace(/-/g, '') : '';
      const [h, mi] = t[s.k].split(':');
      ics += 'BEGIN:VEVENT\r\n'
        + `UID:mh-${p.id}-${s.k}@mymedicalhistory\r\nDTSTAMP:${stamp}\r\n`
        + `DTSTART:${start}T${pad(h)}${pad(mi)}00\r\nDURATION:PT10M\r\n`
        + `RRULE:FREQ=DAILY${until ? `;UNTIL=${until}T235959` : ''}\r\n`
        + `SUMMARY:${escI(`💊 ${s.label} tablets — ${A().pname(p)}`)}\r\n`
        + `DESCRIPTION:${escI(due.map((m) => `${m.data.name}${m.data.dose ? ' · ' + m.data.dose : ''}${m.data.food ? ' · ' + FOOD[m.data.food] : ''}`).join('\n'))}\r\n`
        + 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Tablet time\r\nTRIGGER:PT0M\r\nEND:VALARM\r\nEND:VEVENT\r\n';
    }
    ics += 'END:VCALENDAR\r\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = `tablets-${A().pname(p).replace(/\W+/g, '-')}.ics`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // ───────── Health & insurance cards ─────────
  const CARD_LABELS = { holderName: 'Name', number: 'Card no.', abha: 'ABHA no.', abhaAddress: 'ABHA address', insurer: 'Insurer', scheme: 'Scheme', policyNo: 'Policy no.', validFrom: 'Valid from', validTill: 'Valid till', dob: 'DOB', sex: 'Sex', relation: 'Relation', tpa: 'TPA', helpline: 'Helpline' };
  function renderCards() {
    const el = $('#cardsPanel'); if (!el) return;
    const cards = A().active()?.data?.cards || [];
    el.innerHTML = `
      <div class="section-head">
        <h2 class="h3" id="cardsTitle">Health &amp; insurance cards</h2>
        <label class="btn btn-primary btn-sm" for="cardIn">+ Upload card</label>
      </div>
      <input class="sr-only" type="file" id="cardIn" accept="image/*" capture="environment">
      <p class="muted">ABHA, Ayushman / PM-JAY, Aarogyasri, CGHS, ESIC or insurance. Just upload a photo — the details fill in themselves.</p>
      ${cards.length ? `<ul class="cards">${cards.map((c) => `
        <li><button type="button" class="card-row" data-cardview="${esc(c.id)}">
          <strong>${esc(c.cardType || 'Card')}</strong>
          <span>${esc([c.insurer || c.scheme, c.policyNo || c.number || c.abha].filter(Boolean).join(' · '))}</span>
          ${c.validTill ? `<em class="${c.validTill < A().todayISO() ? 'expired' : ''}">${c.validTill < A().todayISO() ? 'Expired' : 'Valid till'} ${esc(A().fmtDate(c.validTill))}</em>` : ''}
        </button></li>`).join('')}</ul>` : ''}
      <p class="status" id="cardSt" role="status"></p>`;
  }
  async function uploadCard(file) {
    const st = $('#cardSt'); const p = A().active();
    A().setStatus(st, spin('Reading the card…'));
    try {
      const ph = await photoToApi(file, 1800);
      const { card } = await A().api('/api/card', { image: { mediaType: ph.mediaType, data: ph.data } });
      if (card.cardType === 'Aadhaar') {
        A().setStatus(st, `That’s an Aadhaar card — it isn’t stored. ${card.aadhaarLast4 ? `Last 4 digits read: ${esc(card.aadhaarLast4)}. ` : ''}Edit the patient to update Aadhaar.`, 'error');
        return;
      }
      cardEditor({ id: A().uid(), ...card }, ph.dataUrl, true);
      A().setStatus(st, '');
    } catch (err) { A().setStatus(st, esc(errMsg(err)), 'error'); }
    void p;
  }
  async function cardEditor(c, dataUrl, isNew) {
    const img = dataUrl || (c.path ? await signed(c.path) : '');
    const body = dialog(isNew ? 'Check card details' : (c.cardType || 'Card'), `
      ${img ? `<img class="card-img" src="${esc(img)}" alt="Card photo">` : ''}
      ${(c.notSure || []).length ? `<p class="rv-item">⚠ Check: ${esc(c.notSure.join(', '))}</p>` : ''}
      <form id="cardForm" class="form-grid">
        <div class="field span-2"><label>Card type</label><input name="cardType" value="${esc(c.cardType || '')}"></div>
        ${Object.entries(CARD_LABELS).map(([k, l]) => (c[k] || isNew) ? `<div class="field"><label>${l}</label><input name="${k}" value="${esc(c[k] || '')}"></div>` : '').join('')}
        <div class="span-2 form-actions"><button class="btn btn-primary" type="submit">${isNew ? 'Save card' : 'Save'}</button>${!isNew ? '<button type="button" class="link-btn danger" id="cardDel">Delete</button>' : ''}</div>
      </form>`);
    $('#cardForm', body).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const p = A().active();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      const card = { ...c, ...fd };
      delete card.notSure; delete card.aadhaarLast4;
      try {
        if (isNew && dataUrl) card.path = await uploadImage(`${A().user.id}/${p.id}/cards/${card.id}.jpg`, dataUrl);
        const cards = (p.data.cards || []).filter((x) => x.id !== card.id).concat(card);
        const patch = { cards };
        if (card.abha && !p.data.abha) patch.abha = card.abha;
        if (!p.data.cardType && card.cardType && !/abha/i.test(card.cardType)) { patch.cardType = card.cardType; patch.cardNumber = card.policyNo || card.number; patch.insurer = card.insurer || card.scheme; }
        await savePatientData(p, patch);
        closeDialog(); renderCards();
      } catch (err) { alert(err.message); }
    });
    $('#cardDel', body)?.addEventListener('click', async () => {
      if (!confirm('Delete this card?')) return;
      const p = A().active();
      if (c.path) await A().sb.storage.from(A().BUCKET).remove([c.path]);
      await savePatientData(p, { cards: (p.data.cards || []).filter((x) => x.id !== c.id) });
      closeDialog(); renderCards();
    });
  }

  // ───────── Emergency card ─────────
  const EM_FIELDS = [['blood', 'Blood group'], ['allergies', 'Allergies'], ['conditions', 'Conditions'], ['tablets', 'Daily tablets'], ['contact', 'Emergency contact'], ['age', 'Age']];
  const emUrl = (p) => `${location.origin}/e/${p.emergency_token}`;
  async function qrCanvas(text, size) {
    await loadQR();
    const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), quiet = 2, cell = Math.floor(size / (n + quiet * 2));
    const c = document.createElement('canvas'); c.width = c.height = cell * (n + quiet * 2);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
    return c;
  }
  async function renderEmergency() {
    const el = $('#emPanel'); if (!el) return;
    const p = A().active();
    if (!p?.emergency_token) { el.innerHTML = `<h2 class="h3" id="emTitle">Emergency card</h2>${setupNote()}`; return; }
    const f = p.emergency_fields || {};
    el.innerHTML = `
      <div class="section-head">
        <h2 class="h3" id="emTitle">Emergency card</h2>
        <label class="switch"><input type="checkbox" id="emOn" ${p.emergency_enabled ? 'checked' : ''}><span>${p.emergency_enabled ? 'On' : 'Off'}</span></label>
      </div>
      <p class="muted">If ${esc(A().pname(p))} is in an accident and can’t speak, anyone can scan this QR from the phone lock screen or wallet card and see only the info you tick below. Every scan is logged here.</p>
      <div class="em-grid">
        <div class="em-qr" id="emQr">${p.emergency_enabled ? spin('') : '<span class="muted">Turn on to get the QR</span>'}</div>
        <div class="em-fields">${EM_FIELDS.map(([k, l]) => `<label class="check"><input type="checkbox" data-emf="${k}" ${f[k] !== false ? 'checked' : ''} ${p.emergency_enabled ? '' : 'disabled'}> ${l}</label>`).join('')}
          <p class="hint">Full history is never shown on the card. Doctors need the Patient ID + your code for that.</p></div>
      </div>
      ${p.emergency_enabled ? `<div class="row-actions">
        <button type="button" class="btn btn-primary btn-sm" data-emwall>Download lock-screen wallpaper</button>
        <button type="button" class="btn btn-outline btn-sm" data-emcard>Wallet card (print)</button>
        <a class="btn btn-outline btn-sm" href="${esc(emUrl(p))}" target="_blank" rel="noopener">Preview</a>
        <button type="button" class="link-btn" data-emrotate>Make new QR (old stops working)</button>
      </div>` : ''}`;
    if (p.emergency_enabled) {
      try { const c = await qrCanvas(emUrl(p), 220); c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'Emergency QR code'); $('#emQr').replaceChildren(c); }
      catch (err) { $('#emQr').textContent = err.message; }
    }
  }
  async function setEmergency(patch) {
    const p = A().active();
    const { error } = await A().sb.from('hh_patients').update(patch).eq('id', p.id);
    if (error) return alert(errMsg(error));
    Object.assign(p, patch); renderEmergency();
  }
  async function emergencyImage(kind) {
    const p = A().active(); const d = p.data || {};
    const W = kind === 'wall' ? 1080 : 1012, H = kind === 'wall' ? 2340 : 638;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const font = (w, s) => `${w} ${s}px Montserrat, "Segoe UI", Arial, sans-serif`;
    g.fillStyle = '#0E1310'; g.fillRect(0, 0, W, H);
    const qr = await qrCanvas(emUrl(p), kind === 'wall' ? 620 : 420);
    if (kind === 'wall') {
      g.fillStyle = '#D93025'; g.fillRect(0, 760, W, 150);
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.font = font(800, 64); g.fillText('MEDICAL EMERGENCY', W / 2, 860);
      g.font = font(600, 40); g.fillStyle = '#DDDCD7'; g.fillText('Scan for my medical info', W / 2, 990);
      const qx = (W - qr.width) / 2, qy = 1040;
      g.fillStyle = '#fff'; g.fillRect(qx - 24, qy - 24, qr.width + 48, qr.height + 48); g.drawImage(qr, qx, qy);
      let y = qy + qr.height + 120;
      g.fillStyle = '#fff'; g.font = font(800, 60); g.fillText(d.name || '', W / 2, y);
      if (d.blood) { y += 90; g.fillStyle = '#FF6B6B'; g.font = font(800, 72); g.fillText(`Blood ${d.blood}`, W / 2, y); }
      if (d.emergency) { y += 80; g.fillStyle = '#DDDCD7'; g.font = font(600, 38); g.fillText(`ICE: ${d.emergency}`.slice(0, 44), W / 2, y); }
      g.font = font(600, 30); g.fillStyle = '#8FA595'; g.fillText(`Medical History · ${p.public_code}`, W / 2, H - 120);
    } else {
      g.fillStyle = '#00930A'; g.fillRect(0, 0, W, 110);
      g.fillStyle = '#fff'; g.font = font(800, 46); g.textAlign = 'left'; g.fillText('MEDICAL EMERGENCY CARD', 40, 72);
      g.fillStyle = '#fff'; g.fillRect(W - 460, 150, 440, 440); g.drawImage(qr, W - 450, 160, 420, 420);
      g.font = font(800, 44); g.fillText(d.name || '', 40, 200);
      g.font = font(700, 40); g.fillStyle = '#FF6B6B'; if (d.blood) g.fillText(`Blood: ${d.blood}`, 40, 270);
      g.fillStyle = '#DDDCD7'; g.font = font(500, 28);
      const lines = [d.allergies && `Allergies: ${d.allergies}`, d.conditions && `Conditions: ${d.conditions}`, d.emergency && `ICE: ${d.emergency}`].filter(Boolean);
      lines.forEach((l, i) => g.fillText(l.slice(0, 34), 40, 340 + i * 50));
      g.fillStyle = '#8FA595'; g.font = font(600, 26); g.fillText(`Scan QR in emergency · ${p.public_code}`, 40, H - 40);
    }
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png'); a.download = `medical-emergency-${(d.name || 'card').replace(/\W+/g, '-')}-${kind}.png`; a.click();
  }

  // ───────── Access log ─────────
  async function renderAccess() {
    const el = $('#accessPanel'); if (!el) return;
    const p = A().active();
    const sb = A().sb;
    const [log, grants] = await Promise.all([
      sb.from('hh_access_log').select('kind, actor_name, at').eq('patient_id', p.id).order('at', { ascending: false }).limit(15),
      sb.from('hh_grants').select('id, expires_at, created_at, doctor_id').eq('patient_id', p.id).gt('expires_at', new Date().toISOString()),
    ]);
    if (log.error) { el.innerHTML = `<h2 class="h3" id="accTitle">Who accessed</h2>${setupNote()}`; return; }
    const when = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    el.innerHTML = `
      <h2 class="h3" id="accTitle">Who accessed</h2>
      ${(grants.data || []).length ? `<ul class="acc">${grants.data.map((g) => `<li><span>🩺 Doctor has access till ${esc(when(g.expires_at))}</span><button type="button" class="link-btn danger" data-revoke="${g.id}">Stop access</button></li>`).join('')}</ul>` : ''}
      ${(log.data || []).length ? `<ul class="acc">${log.data.map((l) => `<li><span>${l.kind === 'emergency' ? '🚑 Emergency card scanned' : '🩺 Checkup access'}${l.actor_name ? ` · ${esc(l.actor_name)}` : ''}</span><em>${esc(when(l.at))}</em></li>`).join('')}</ul>` : '<p class="muted">Nobody has opened this patient’s data yet.</p>'}`;
  }

  // ═════════════ Doctor tools ═════════════
  let docRow = null, isAdmin = false, docChecked = false;
  async function loadDoctorState() {
    const sb = A().sb;
    const [d, a] = await Promise.all([
      sb.from('hh_doctors').select('*').eq('user_id', A().user.id).maybeSingle(),
      sb.rpc('hh_is_admin'),
    ]);
    docRow = d.error ? null : d.data;
    isAdmin = !a.error && a.data === true;
    docChecked = true;
    const show = isAdmin || docRow?.status === 'approved';
    const nav = $('#navDoctor'); if (nav) nav.hidden = !show;
    let mob = $('.nav-mobile [data-nav="doctor"]');
    if (show && !mob) {
      $('.nav-mobile').insertAdjacentHTML('beforeend', `<a href="#doctor" data-nav="doctor"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6a6 6 0 0 0 12 0V3"/><path d="M12 15v2a4 4 0 0 0 8 0v-3"/><circle cx="20" cy="12" r="2"/></svg>Doctor</a>`);
    }
    return { docRow, isAdmin, migrationOk: !d.error };
  }

  async function renderDoctor(arg) {
    const root = $('#doctorRoot'); if (!root) return;
    root.innerHTML = `<p class="muted">${spin('Loading…')}</p>`;
    const st = await loadDoctorState();
    if (!st.migrationOk) { root.innerHTML = `<h1 id="doctorTitle">Doctor tools</h1>${setupNote()}`; return; }
    const head = `<p class="eyebrow">For doctors &amp; hospitals</p><h1 id="doctorTitle">Doctor tools</h1>`;
    let html = head;
    if (!docRow) html += doctorRegisterHTML();
    else if (docRow.status === 'pending') html += `<section class="panel"><h2 class="h3">Verification pending</h2><p class="muted">We’re checking registration no. <strong>${esc(docRow.reg_no)}</strong> (${esc(docRow.council)}). You’ll get Emergency and Checkup access once approved.</p></section>`;
    else if (docRow.status === 'rejected') html += `<section class="panel"><h2 class="h3">Not approved</h2><p class="muted">${esc(docRow.note || 'Details could not be verified.')} Update and resubmit:</p></section>${doctorRegisterHTML(docRow)}`;
    else html += doctorToolsHTML();
    if (isAdmin) html += '<section class="panel" id="adminPanel"><h2 class="h3">Doctor approvals (admin)</h2><p class="muted">' + spin('Loading…') + '</p></section>';
    root.innerHTML = html;
    if (docRow?.status === 'approved') { renderMyPatients(); if (arg && /^[0-9a-f-]{36}$/.test(arg)) openBundle(arg); }
    if (isAdmin) renderAdmin();
  }

  function doctorRegisterHTML(d = {}) {
    const councils = ['National Medical Commission (NMC)', 'Andhra Pradesh Medical Council', 'Telangana State Medical Council', 'Travancore-Cochin Medical Council (Kerala)', 'Karnataka Medical Council', 'Tamil Nadu Medical Council', 'Maharashtra Medical Council', 'Delhi Medical Council', 'Other state council'];
    return `
      <section class="panel">
        <h2 class="h3">Register as a doctor</h2>
        <p class="muted">We verify your registration with the medical council before giving access. Patients see your name each time you open their data.</p>
        <form id="docForm" class="form-grid" novalidate>
          <div class="field span-2"><label for="dr-name">Full name (as registered)</label><input id="dr-name" name="full_name" required value="${esc(d.full_name || '')}"></div>
          <div class="field"><label for="dr-reg">Registration no.</label><input id="dr-reg" name="reg_no" required value="${esc(d.reg_no || '')}"></div>
          <div class="field"><label for="dr-council">Medical council</label><select id="dr-council" name="council">${councils.map((c) => `<option ${d.council === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div class="field"><label for="dr-spec">Speciality</label><input id="dr-spec" name="speciality" value="${esc(d.speciality || '')}"></div>
          <div class="field"><label for="dr-hosp">Hospital / clinic</label><input id="dr-hosp" name="hospital" value="${esc(d.hospital || '')}"></div>
          <div class="field"><label for="dr-phone">Mobile</label><input id="dr-phone" name="phone" type="tel" value="${esc(d.phone || '')}"></div>
          <div class="field"><label for="dr-id">Registration certificate / ID photo</label><input id="dr-id" name="id" type="file" accept="image/*,application/pdf" ${d.id_path ? '' : 'required'}></div>
          <div class="span-2 form-actions"><button class="btn btn-primary" type="submit">Submit for verification</button></div>
          <p class="status span-2" id="docSt" role="status"></p>
        </form>
      </section>`;
  }

  async function submitDoctor(form) {
    const st = $('#docSt');
    const fd = new FormData(form);
    const row = Object.fromEntries(['full_name', 'reg_no', 'council', 'speciality', 'hospital', 'phone'].map((k) => [k, String(fd.get(k) || '').trim()]));
    if (!row.full_name || !row.reg_no) return A().setStatus(st, 'Name and registration number are required.', 'error');
    const file = fd.get('id');
    if (!docRow?.id_path && !(file && file.size)) return A().setStatus(st, 'Upload your registration certificate or ID.', 'error');
    A().setStatus(st, spin('Submitting…'));
    try {
      const sb = A().sb;
      if (file && file.size) {
        const isPdf = file.type === 'application/pdf';
        const blob = isPdf ? file : A().dataUrlToBlob(await A().compressImage(file, 2000));
        const path = `${A().user.id}/id-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`;
        const up = await sb.storage.from('hh-doctor-ids').upload(path, blob, { contentType: isPdf ? 'application/pdf' : 'image/jpeg', upsert: true });
        if (up.error) throw up.error;
        row.id_path = path;
      }
      const q = docRow ? sb.from('hh_doctors').update({ ...row, status: 'pending' }).eq('user_id', A().user.id)
        : sb.from('hh_doctors').insert({ ...row, user_id: A().user.id });
      const { error } = await q;
      if (error) throw error;
      renderDoctor();
    } catch (err) { A().setStatus(st, esc(errMsg(err)), 'error'); }
  }

  function doctorToolsHTML() {
    return `
      <p class="muted">Verified: <strong>${esc(docRow.full_name)}</strong> · ${esc(docRow.reg_no)}</p>
      <div class="doc-modes">
        <button type="button" class="doc-mode em" data-docmode="emergency"><span>🚑</span><strong>Emergency</strong><small>Scan the patient’s MedH QR (lock screen / wallet card)</small></button>
        <button type="button" class="doc-mode" data-docmode="checkup"><span>🩺</span><strong>General checkup</strong><small>Patient ID + the code the patient shows you</small></button>
      </div>
      <section class="panel" id="docWork" hidden></section>
      <section class="panel" id="myPatients"><h2 class="h3">My patients (access active)</h2><p class="muted">${spin('')}</p></section>`;
  }

  function showDocMode(mode) {
    const w = $('#docWork'); w.hidden = false;
    if (mode === 'checkup') {
      w.innerHTML = `
        <h2 class="h3">General checkup</h2>
        <form id="chkForm" class="form-grid" novalidate>
          <div class="field"><label for="ck-id">Patient ID</label><input id="ck-id" name="pid" placeholder="MH-XXXX-XXXX" autocapitalize="characters" autocomplete="off" required></div>
          <div class="field"><label for="ck-code">6-digit code</label><input id="ck-code" name="code" inputmode="numeric" maxlength="7" placeholder="123 456" autocomplete="one-time-code" required></div>
          <div class="span-2 form-actions"><button class="btn btn-primary" type="submit">Open history</button></div>
          <p class="status span-2" id="ckSt" role="status"></p>
        </form>
        <p class="hint">The patient makes the code in their app: History → Share with doctor. Access lasts 24 hours and the patient can stop it anytime.</p>`;
      $('#ck-id').focus();
    } else {
      w.innerHTML = `
        <h2 class="h3">Emergency</h2>
        <p class="muted">Point the camera at the patient’s Medical History QR. Shows blood group, allergies, conditions, tablets and family contact — only what the patient chose to share.</p>
        <div class="qr-cam" id="qrCam" hidden><video id="qrVideo" playsinline muted></video><span class="qr-frame"></span></div>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="qrStart">Scan QR with camera</button>
          <label class="btn btn-outline" for="qrPhoto">Use a photo</label>
          <input class="sr-only" type="file" id="qrPhoto" accept="image/*" capture="environment">
        </div>
        <p class="status" id="qrSt" role="status"></p>
        <div id="emResult"></div>`;
    }
    w.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function openCheckup(form) {
    const st = $('#ckSt');
    const pid = String(new FormData(form).get('pid') || '').trim().toUpperCase().replace(/\s+/g, '');
    const code = String(new FormData(form).get('code') || '').replace(/\D/g, '');
    if (!/^MH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pid)) return A().setStatus(st, 'Patient ID looks like MH-AB12-CD34.', 'error');
    if (code.length !== 6) return A().setStatus(st, 'Enter the 6-digit code.', 'error');
    A().setStatus(st, spin('Checking…'));
    const { data, error } = await A().sb.rpc('doctor_open_checkup', { p_public_code: pid, p_code: code });
    if (error) return A().setStatus(st, esc(error.message), 'error');
    if (!data) return A().setStatus(st, 'Wrong or expired code. Ask the patient to make a new one.', 'error');
    A().setStatus(st, '');
    openBundle(data);
    renderMyPatients();
  }

  async function renderMyPatients() {
    const el = $('#myPatients'); if (!el) return;
    const { data, error } = await A().sb.from('hh_grants').select('patient_id, expires_at, purpose').eq('doctor_id', A().user.id).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false });
    if (error) { el.hidden = true; return; }
    const uniq = [...new Map((data || []).map((g) => [g.patient_id, g])).values()];
    el.innerHTML = `<h2 class="h3">My patients (access active)</h2>${uniq.length ? `<ul class="acc">${uniq.map((g) => `<li><button type="button" class="link-btn" data-bundle="${g.patient_id}">Open patient</button><em>till ${esc(new Date(g.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</em></li>`).join('')}</ul>` : '<p class="muted">None right now.</p>'}`;
  }

  async function openBundle(patientId) {
    const w = $('#docWork'); w.hidden = false;
    w.innerHTML = `<p class="muted">${spin('Opening patient…')}</p>`;
    const { data, error } = await A().sb.rpc('doctor_patient_bundle', { p_patient: patientId });
    if (error) { w.innerHTML = `<p class="status error">${esc(error.message)}</p>`; return; }
    const d = data.patient.data || {};
    const age = A().ageOf(d.dob);
    const R = A().render;
    const recs = (data.records || []).map((r) => ({ ...r.data, id: r.id }));
    w.innerHTML = `
      <div class="bundle-head">
        <div><p class="eyebrow">${esc(data.patient.public_code)} · access till ${esc(new Date(data.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</p>
        <h2 class="h3">${esc(d.name || 'Patient')}</h2>
        <p class="muted">${esc([age !== '' ? `${age} yrs` : '', d.sex, d.blood && `Blood ${d.blood}`, d.height && `${d.height} cm`, d.weight && `${d.weight} kg`].filter(Boolean).join(' · '))}</p></div>
      </div>
      ${d.allergies ? `<p class="em-alert">⚠ Allergies: ${esc(d.allergies)}</p>` : ''}
      ${d.conditions ? `<p><strong>Conditions:</strong> ${esc(d.conditions)}</p>` : ''}
      ${(data.meds || []).length ? `<h3 class="c-h">Daily tablets</h3><ul class="bullets">${data.meds.map((m) => `<li>${esc(m.name)}${m.dose ? ' · ' + esc(m.dose) : ''} · ${esc((m.slots || []).join(' '))}${m.food ? ' · ' + esc(m.food) : ''}</li>`).join('')}</ul>` : ''}
      <h3 class="c-h">Records (${recs.length})</h3>
      <ol class="doc-recs">${recs.map((e) => {
        const f = (e.findings || []).filter((x) => x && x.name);
        const ab = f.filter((x) => R.flagClass(x.flag));
        return `<li class="t-card k-${R.kindOf(e)}">
          <header class="c-top">${R.icon(R.kindOf(e))}<h4 class="c-name">${esc(e.title || 'Record')}</h4><span class="muted">${esc(A().fmtDate(e.date))}</span></header>
          ${[e.doctor, e.hospital || e.madeBy].filter(Boolean).length ? `<p class="c-who"><span>${esc([e.doctor, e.hospital || e.madeBy].filter(Boolean).join(' · '))}</span></p>` : ''}
          ${R.vitalsChips(e.vitals || {})}
          ${ab.length ? `<p class="c-flags">${ab.map((x) => `<span class="${R.flagClass(x.flag)}">${esc(x.name)} ${esc(x.value)} ${R.flagClass(x.flag) === 'flag-high' ? '↑' : '↓'}</span>`).join('')}</p>` : ''}
          <details class="doc-more"><summary>Details</summary>
            ${e.reportSays ? `<p class="c-text">${esc(e.reportSays)}</p>` : ''}
            ${f.length ? R.testsTable(f) : ''}
            ${e.diagnosis ? `<h5 class="c-h">Diagnosis</h5>${R.bulletList(R.splitList(e.diagnosis))}` : ''}
            ${(e.medicines || []).length ? `<h5 class="c-h">Medicines</h5>${R.bulletList(e.medicines.map((m) => [m.name, m.dose, m.frequency, m.duration].filter(Boolean).join(' · ')))}` : ''}
            ${(e.files || []).filter((x) => x.path).length ? `<button type="button" class="link-btn" data-docfiles='${esc(JSON.stringify(e.files.filter((x) => x.path).map((x) => ({ p: x.path, n: x.name, t: x.mediaType }))))}'>View original files</button>` : ''}
          </details>
        </li>`;
      }).join('')}</ol>
      <p class="hint">Read-only. Information extracted by AI — confirm with the original files before treatment decisions.</p>`;
    w.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function showDocFiles(files) {
    const body = dialog('Original files', `<p class="muted">${spin('Loading…')}</p>`);
    const { data } = await A().sb.storage.from(A().BUCKET).createSignedUrls(files.map((f) => f.p), 1800);
    body.innerHTML = files.map((f, i) => {
      const u = data?.[i]?.signedUrl;
      if (!u) return `<p class="muted">${esc(f.n)} — not available</p>`;
      return f.t === 'application/pdf' ? `<p><a href="${esc(u)}" target="_blank" rel="noopener">Open ${esc(f.n)}</a></p>` : `<a href="${esc(u)}" target="_blank" rel="noopener"><img class="med-photo" src="${esc(u)}" alt="${esc(f.n)}"></a>`;
    }).join('');
  }

  // QR scanning (doctor emergency)
  let camStream = null, camLoop = 0;
  function stopCam() { cancelAnimationFrame(camLoop); camStream?.getTracks().forEach((t) => t.stop()); camStream = null; const c = $('#qrCam'); if (c) c.hidden = true; }
  async function startCam() {
    const st = $('#qrSt');
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch { return A().setStatus(st, 'Camera not available. Use “Use a photo”.', 'error'); }
    const v = $('#qrVideo'); v.srcObject = camStream; await v.play(); $('#qrCam').hidden = false;
    const det = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!det) await loadJsQR();
    const cv = document.createElement('canvas'); const g = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!camStream) return;
      try {
        let text = '';
        if (det) { const r = await det.detect(v); text = r[0]?.rawValue || ''; }
        else if (v.videoWidth) {
          cv.width = v.videoWidth; cv.height = v.videoHeight; g.drawImage(v, 0, 0);
          text = window.jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)?.data || '';
        }
        if (text) { stopCam(); return handleQR(text); }
      } catch { /* keep trying */ }
      camLoop = requestAnimationFrame(tick);
    };
    tick();
  }
  async function qrFromPhoto(file) {
    const st = $('#qrSt');
    A().setStatus(st, spin('Reading QR…'));
    try {
      await loadJsQR();
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
      const r = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      if (!r?.data) throw new Error('No QR found in this photo.');
      handleQR(r.data);
    } catch (err) { A().setStatus(st, esc(errMsg(err)), 'error'); }
  }
  async function handleQR(text) {
    const st = $('#qrSt');
    const m = String(text).match(/\/e\/([a-f0-9]{32,80})/i);
    if (!m) return A().setStatus(st, 'This is not a Medical History emergency QR.', 'error');
    A().setStatus(st, spin('Opening emergency info…'));
    const { data, error } = await A().sb.rpc('get_emergency', { p_token: m[1] });
    if (error || !data) return A().setStatus(st, error ? esc(error.message) : 'This emergency card is turned off or replaced.', 'error');
    A().setStatus(st, '');
    $('#emResult').innerHTML = emergencyHTML(data) + `<p class="hint">For full history, ask family for the Patient ID + code, or call the emergency contact.</p>`;
  }

  // shared with e.html
  function emergencyHTML(v) {
    return `
      <div class="em-card">
        <div class="em-top"><strong>${esc(v.name || 'Patient')}</strong><span>${esc([v.age != null && `${v.age} yrs`, v.sex].filter(Boolean).join(' · '))}</span></div>
        ${v.blood ? `<div class="em-blood"><span>Blood group</span><strong>${esc(v.blood)}</strong></div>` : ''}
        ${v.allergies ? `<p class="em-alert">⚠ Allergies: ${esc(v.allergies)}</p>` : ''}
        ${v.conditions ? `<p><strong>Conditions:</strong> ${esc(v.conditions)}</p>` : ''}
        ${(v.tablets || []).length ? `<p><strong>Daily tablets:</strong></p><ul class="bullets">${v.tablets.map((t) => `<li>${esc(t.name)}${t.dose ? ' · ' + esc(t.dose) : ''}${(t.slots || []).length ? ' · ' + esc(t.slots.join(' ')) : ''}</li>`).join('')}</ul>` : ''}
        ${v.emergency ? `<p class="em-ice"><strong>Emergency contact:</strong> ${esc(v.emergency)} ${/\d{10}/.test(String(v.emergency).replace(/\D/g, '')) ? `<a class="btn btn-primary btn-sm" href="tel:${esc(String(v.emergency).replace(/[^\d+]/g, ''))}">Call</a>` : ''}</p>` : ''}
        <p class="muted">Patient ID ${esc(v.public_code || '')}</p>
      </div>`;
  }

  async function renderAdmin() {
    const el = $('#adminPanel'); if (!el) return;
    const { data, error } = await A().sb.rpc('admin_list_doctors');
    if (error) { el.innerHTML = `<p class="status error">${esc(error.message)}</p>`; return; }
    el.innerHTML = `<h2 class="h3">Doctor approvals (admin)</h2>${(data || []).length ? `<ul class="admin-list">${data.map((d) => `
      <li class="st-${d.status}">
        <div><strong>${esc(d.full_name)}</strong> <span class="tag">${esc(d.status)}</span>
        <p class="muted">${esc([d.reg_no, d.council, d.speciality, d.hospital, d.phone].filter(Boolean).join(' · '))}</p>
        <p class="hint">Check the number on the council / NMC register before approving.</p></div>
        <div class="row-actions">
          ${d.id_path ? `<button type="button" class="btn btn-outline btn-sm" data-viewid="${esc(d.id_path)}">View ID</button>` : ''}
          ${d.status !== 'approved' ? `<button type="button" class="btn btn-primary btn-sm" data-approve="${d.user_id}">Approve</button>` : ''}
          ${d.status !== 'rejected' ? `<button type="button" class="link-btn danger" data-reject="${d.user_id}">Reject</button>` : ''}
        </div>
      </li>`).join('')}</ul>` : '<p class="muted">No doctor applications yet.</p>'}`;
  }

  // ═════════════ Home: tablet scan + look-it-up box ═════════════
  let chat = [];
  function afterHome() {
    const root = $('#homeTools'); if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';
    root.innerHTML = `
      <section class="tools-card">
        <div class="tool-tablet">
          <div><h2 class="h3">Scan a tablet</h2><p class="muted">Photo of the strip or box → what it is and what it’s used for.</p></div>
          <label class="btn btn-outline btn-sm" for="tabIn">${A().render.icon('rx', 16)} Scan tablet</label>
          <input class="sr-only" type="file" id="tabIn" accept="image/*" capture="environment">
        </div>
        <div class="ask" id="askBox">
          <h2 class="h3">Look it up</h2>
          <div class="ask-log" id="askLog" aria-live="polite"><p class="muted ask-hint">Ask about a medicine, test or medical word — e.g. “What is HbA1c?”</p></div>
          <form class="ask-form" id="askForm"><label class="sr-only" for="askIn">Question</label><input id="askIn" maxlength="600" placeholder="Ask anything medical…" autocomplete="off"><button class="btn btn-primary btn-sm" type="submit" aria-label="Ask">Ask</button></form>
          <p class="hint">Information from the web, with sources. Not medical advice — ask your doctor before acting.</p>
        </div>
      </section>`;
    $('#tabIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scanTablet(f); });
    $('#askForm').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  }

  async function scanTablet(file) {
    const body = dialog('Tablet', `<p class="muted">${spin('Reading the pack and looking it up…')}</p>`);
    try {
      const ph = await photoToApi(file, 1800);
      const r = await A().api('/api/tablet', { images: [{ mediaType: ph.mediaType, data: ph.data }] });
      const pk = r.pack || {};
      if (!r.info) { body.innerHTML = `<p class="status error">${esc(r.error || 'Could not read it.')}</p>`; return; }
      body.innerHTML = `
        <img class="med-photo sm" src="${ph.dataUrl}" alt="Your photo">
        <h3 class="tab-name">${esc(pk.brand || pk.generic)}</h3>
        <p class="muted">${esc([pk.generic !== pk.brand && pk.generic, pk.strength, pk.form, pk.manufacturer].filter(Boolean).join(' · '))}</p>
        ${pk.expiry ? `<p class="${/\d{4}/.test(pk.expiry) && expired(pk.expiry) ? 'em-alert' : 'muted'}">Expiry: ${esc(pk.expiry)}${expired(pk.expiry) ? ' — expired, don’t use' : ''}</p>` : ''}
        <div class="md">${md(r.info.text)}</div>
        ${sourcesHTML(r.info.sources)}
        <div class="row-actions"><button type="button" class="btn btn-primary btn-sm" id="tabToDaily">+ Add to Daily Tablets</button></div>`;
      $('#tabToDaily').addEventListener('click', async () => {
        if (!A().activeId) return;
        let photo = '';
        try { photo = await uploadImage(`${A().user.id}/${A().activeId}/meds/${A().uid()}.jpg`, ph.dataUrl); } catch { /* optional */ }
        medForm(null, { name: [pk.brand || pk.generic, pk.strength].filter(Boolean).join(' '), photo, altNames: [pk.brand, pk.generic].filter(Boolean) });
      });
    } catch (err) { body.innerHTML = `<p class="status error">${esc(errMsg(err))}</p>`; }
  }
  function expired(s) {
    const m = String(s).match(/(\d{1,2})[/.-](\d{2,4})/) || String(s).match(/([A-Za-z]{3})\w*[\s.-]+(\d{2,4})/);
    if (!m) return false;
    const mon = isNaN(+m[1]) ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()) + 1 : +m[1];
    const yr = +m[2] < 100 ? 2000 + +m[2] : +m[2];
    if (!mon || mon > 12) return false;
    const end = new Date(yr, mon, 0);
    return end < new Date();
  }

  async function ask() {
    const inp = $('#askIn'); const q = inp.value.trim(); if (!q) return;
    inp.value = '';
    const log = $('#askLog');
    $('.ask-hint', log)?.remove();
    log.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg ai" id="askPending">${spin('Searching…')}</div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const r = await A().api('/api/ask', { question: q, history: chat.slice(-4) });
      chat.push({ role: 'user', text: q }, { role: 'ai', text: r.answer });
      $('#askPending').outerHTML = `<div class="msg ai"><div class="md">${md(r.answer)}</div>${sourcesHTML(r.sources)}</div>`;
    } catch (err) {
      $('#askPending').outerHTML = `<div class="msg ai err">${esc(errMsg(err))}</div>`;
    }
    log.scrollTop = log.scrollHeight;
  }

  // ═════════════ Aadhaar: read on the phone, never uploaded ═════════════
  async function scanAadhaar(file) {
    const hint = $('#aadhaarHint');
    hint.className = 'hint'; hint.innerHTML = spin('Reading Aadhaar on your phone… (first time takes ~20 s)');
    let url = '';
    try {
      await loadTesseract();
      url = URL.createObjectURL(file);
      const { data } = await window.Tesseract.recognize(url, 'eng');
      const text = data.text || '';
      const nums = (text.match(/\d[\d ]{10,16}\d/g) || []).map((x) => x.replace(/\s/g, '')).filter((x) => x.length === 12);
      const num = nums.find((x) => A().validAadhaar(x));
      const filled = [];
      if (num) { $('#pt-aadhaar').value = A().fmtAadhaarInput(num); filled.push('Aadhaar number'); }
      const dob = text.match(/(?:DOB|Birth|D\.O\.B)[^\d]{0,12}(\d{2})[/-](\d{2})[/-](\d{4})/i) || text.match(/\b(\d{2})\/(\d{2})\/(19\d{2}|20\d{2})\b/);
      if (dob && !$('#pt-dob').value) { $('#pt-dob').value = `${dob[3]}-${dob[2]}-${dob[1]}`; filled.push('date of birth'); }
      const sex = /\bFEMALE\b/i.test(text) ? 'Female' : /\bMALE\b/i.test(text) ? 'Male' : '';
      if (sex && !$('#pt-sex').value) { $('#pt-sex').value = sex; filled.push('sex'); }
      if (!$('#pt-name').value) {
        const lines = text.split('\n').map((l) => l.trim());
        const i = lines.findIndex((l) => /DOB|Birth|Year of/i.test(l));
        const cand = i > 0 ? lines[i - 1] : '';
        if (/^[A-Za-z .]{4,40}$/.test(cand) && cand.split(' ').length >= 2 && !/government|india|aadhaar/i.test(cand)) { $('#pt-name').value = cand.replace(/\s+/g, ' '); filled.push('name'); }
      }
      hint.className = filled.length ? 'hint ok' : 'hint error';
      hint.textContent = filled.length
        ? `Filled ${filled.join(', ')} — please check. The photo was not uploaded or saved.`
        : 'Couldn’t read it clearly. Try better light, or type the number.';
    } catch (err) {
      hint.className = 'hint error'; hint.textContent = err.message;
    } finally { if (url) URL.revokeObjectURL(url); }
  }

  // ═════════════ events ═════════════
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-mh-close]')) return closeDialog();
    if (t.id === 'mhDialog') return closeDialog();
    const copy = t.closest('[data-copy]');
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 1200); } catch { /* ignore */ } return; }
    if (t.closest('#shareDoctorBtn')) return shareWithDoctor();
    if (t.closest('[data-medadd]')) return medForm(null);
    const ed = t.closest('[data-dmedit]'); if (ed) return medForm(medsCache.find((m) => m.id === ed.dataset.dmedit));
    const bell = t.closest('[data-dmbell]');
    if (bell) {
      const m = medsCache.find((x) => x.id === bell.dataset.dmbell); if (!m) return;
      const data = { ...m.data, remind: !m.data.remind };
      const { error } = await A().sb.from('hh_meds').update({ data }).eq('id', m.id);
      if (error) return alert(errMsg(error));
      m.data = data; renderMeds(); scheduleReminders();
      if (data.remind && 'Notification' in window && Notification.permission === 'default') enableNotifications();
      return;
    }
    const pic = t.closest('[data-dmpic]');
    if (pic) {
      const m = medsCache.find((x) => x.id === pic.dataset.dmpic); if (!m) return;
      return medPhotoDialog({ title: m.data.name, name: m.data.name, path: m.data.photo, onUpload: async (file) => {
        const ph = await photoToApi(file, 1400);
        const path = await uploadImage(`${A().user.id}/${A().activeId}/meds/${A().uid()}.jpg`, ph.dataUrl);
        const data = { ...m.data, photo: path };
        const { error } = await A().sb.from('hh_meds').update({ data }).eq('id', m.id); if (error) throw error;
        m.data = data; renderMeds();
      } });
    }
    if (t.closest('[data-slottimes]')) return editSlotTimes();
    if (t.closest('[data-remon]')) return enableNotifications();
    if (t.closest('[data-ics]')) return downloadICS();
    const cv = t.closest('[data-cardview]');
    if (cv) { const c = (A().active()?.data?.cards || []).find((x) => x.id === cv.dataset.cardview); if (c) cardEditor(c, '', false); return; }
    const emf = t.closest('[data-emf]');
    if (emf) { const p = A().active(); return setEmergency({ emergency_fields: { ...(p.emergency_fields || {}), [emf.dataset.emf]: emf.checked } }); }
    if (t.closest('[data-emwall]')) return emergencyImage('wall').catch((err) => alert(err.message));
    if (t.closest('[data-emcard]')) return emergencyImage('card').catch((err) => alert(err.message));
    if (t.closest('[data-emrotate]')) {
      if (!confirm('Make a new QR? Old wallpapers and cards will stop working.')) return;
      const p = A().active();
      const { data, error } = await A().sb.rpc('rotate_emergency_token', { p_patient: p.id });
      if (error) return alert(errMsg(error));
      p.emergency_token = data; return renderEmergency();
    }
    const rv = t.closest('[data-revoke]');
    if (rv) { if (!confirm('Stop this doctor’s access now?')) return; await A().sb.from('hh_grants').delete().eq('id', rv.dataset.revoke); return renderAccess(); }
    const mode = t.closest('[data-docmode]'); if (mode) return showDocMode(mode.dataset.docmode);
    if (t.closest('#qrStart')) return startCam();
    const bun = t.closest('[data-bundle]'); if (bun) return openBundle(bun.dataset.bundle);
    const df = t.closest('[data-docfiles]'); if (df) return showDocFiles(JSON.parse(df.dataset.docfiles));
    const vid = t.closest('[data-viewid]');
    if (vid) { const u = await signed(vid.dataset.viewid, 600, 'hh-doctor-ids'); if (u) window.open(u, '_blank', 'noopener'); else alert('Could not open the ID.'); return; }
    const ap = t.closest('[data-approve]'), rj = t.closest('[data-reject]');
    if (ap || rj) {
      const note = rj ? prompt('Reason (shown to the doctor):', 'Registration number could not be verified') : '';
      if (rj && note === null) return;
      const { error } = await A().sb.rpc('admin_set_doctor', { p_user: (ap || rj).dataset[ap ? 'approve' : 'reject'], p_status: ap ? 'approved' : 'rejected', p_note: note || '' });
      if (error) return alert(errMsg(error));
      return renderAdmin();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'emOn') return setEmergency({ emergency_enabled: t.checked });
    if (t.id === 'cardIn') { const f = t.files[0]; t.value = ''; if (f) uploadCard(f); return; }
    if (t.id === 'qrPhoto') { const f = t.files[0]; t.value = ''; if (f) { stopCam(); qrFromPhoto(f); } return; }
    if (t.id === 'aadhaarScanInput') { const f = t.files[0]; t.value = ''; if (f) scanAadhaar(f); }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'docForm') { e.preventDefault(); submitDoctor(e.target); }
    if (e.target.id === 'chkForm') { e.preventDefault(); openCheckup(e.target); }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('#aadhaarScanBtn')) $('#aadhaarScanInput').click(); });
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#doctor')) stopCam(); });

  // start reminders + doctor nav once signed in
  let booted = false;
  const boot = setInterval(async () => {
    if (!A()?.user || booted) return;
    booted = true; clearInterval(boot);
    try { await loadMeds(); scheduleReminders(); } catch { /* ignore */ }
    try { await loadDoctorState(); } catch { /* ignore */ }
  }, 800);

  window.MHF = { afterHistory, afterProfile, afterHome, renderDoctor, medPicture, addDailyFromRecord, emergencyHTML, parseFrequency };
})();
