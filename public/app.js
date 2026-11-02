/* VIDXX frontend core: router, API client, public + viewer pages. */
(() => {
'use strict';
const CFG = window.CLIPVAULT || {};
const API = (CFG.API || '').replace(/\/$/, '') + '/api';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-KE');
const usd = n => '$' + Number(n || 0).toFixed(3);
const kes = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
const date = d => d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const dtime = d => d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.7-1 1.4-2.5 1.8-2.5.8-2.5 1.8 1 1.7 2.5 1.7 2.5-.5 2.5-1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'
};
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ---------- state ----------
const S = { me: null, config: null };
const tok = {
  get a() { return localStorage.getItem('cv_at'); }, get r() { return localStorage.getItem('cv_rt'); },
  set(a, r) { localStorage.setItem('cv_at', a); localStorage.setItem('cv_rt', r); },
  clear() { localStorage.removeItem('cv_at'); localStorage.removeItem('cv_rt'); }
};

// ---------- API ----------
async function raw(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (tok.a) headers.Authorization = 'Bearer ' + tok.a;
  return fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
}
async function api(path, opts = {}) {
  let r = await raw(path, opts);
  if (r.status === 401 && tok.r && !path.startsWith('/login') && !path.startsWith('/refresh')) {
    const rr = await fetch(API + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: tok.r }) });
    if (rr.ok) { const t = await rr.json(); tok.set(t.access_token, t.refresh_token); r = await raw(path, opts); }
    else { logout(true); throw new Error('Session expired. Please log in again.'); }
  }
  let data = null;
  try { data = await r.json(); } catch (_) { /* no body */ }
  if (!r.ok) { const e = new Error((data && data.error) || 'Request failed'); e.status = r.status; e.data = data; throw e; }
  return data;
}

// ---------- UI helpers ----------
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function modal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  return $('#modal-box');
}
function closeModal() { $('#modal').hidden = true; $('#modal-box').innerHTML = ''; }
const loading = '<div class="spin" role="status" aria-label="Loading"></div>';
const errBox = m => `<div class="notice bad">${esc(m)}</div>`;
const initial = u => esc((u || '?').slice(0, 1).toUpperCase());
const avatarHtml = (u, src, cls = '') => src ? `<img class="avatar ${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<span class="avatar ${cls}">${initial(u)}</span>`;
function busy(btn, on, txt) {
  if (!btn) return;
  if (on) { btn.dataset.t = btn.textContent; btn.disabled = true; if (txt) btn.textContent = txt; }
  else { btn.disabled = false; if (btn.dataset.t) btn.textContent = btn.dataset.t; }
}

// crop-to-fill resize in the browser to keep uploads small
function resizeImage(file, w, h, type = 'image/jpeg', q = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const s = Math.max(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve({ blob: b, dataUrl: c.toDataURL(type, q) }) : reject(new Error('Image failed')), type, q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read')); };
    img.src = url;
  });
}

// ---------- router ----------
const routes = {};
function route(name, roles, handler) { routes[name] = { roles, handler }; }
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, qs] = h.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = h => { location.hash = '#/' + h; };
function homeFor(me) {
  if (!me) return '';
  return me.account_type === 'curator' ? 'dashboard' : me.account_type === 'admin' ? 'admin' : 'explore';
}
async function render() {
  const { name, args, query } = parseHash();
  const r = routes[name] || routes[''];
  const main = $('#main');
  if (r.roles) {
    if (!S.me) { go('login'); return; }
    if (r.roles !== 'auth' && !r.roles.includes(S.me.account_type)) { toast('That page is not available for your account type', true); go(homeFor(S.me)); return; }
  }
  document.body.classList.toggle('bd', ['', 'login', 'register'].includes(name));
  updateNav();
  window.scrollTo(0, 0);
  main.innerHTML = loading;
  try { await r.handler({ root: main, args, query }); }
  catch (e) { main.innerHTML = errBox(e.message || 'Something went wrong'); }
  main.focus({ preventScroll: true });
}

function navItems() {
  const t = S.me && S.me.account_type;
  if (!S.me) return [['', 'Home', 'home'], ['explore', 'Explore', 'compass'], ['login', 'Log in', 'user'], ['register', 'Join', 'plus']];
  if (t === 'viewer') return [['explore', 'Explore', 'compass'], ['buy', 'Buy Points', 'coin'], ['profile', 'Profile', 'user']];
  if (t === 'curator') return [['dashboard', 'Dashboard', 'chart'], ['upload', 'Upload', 'upload'], ['withdraw', 'Withdraw', 'cash'], ['profile', 'Profile', 'user']];
  return [['admin', 'Admin', 'shield'], ['explore', 'Videos', 'compass'], ['profile', 'Profile', 'user']];
}
function updateNav() {
  const cur = parseHash().name;
  const items = navItems();
  const link = ([h, label, ic]) => `<a href="#/${h}" class="${cur === h ? 'on' : ''}" ${cur === h ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  $('#side-nav').innerHTML = items.map(link).join('');
  $('#bottom-nav').innerHTML = items.map(link).join('');
  $('#side-foot').innerHTML = S.me ? `<div class="row" style="flex-wrap:nowrap">${avatarHtml(S.me.username, S.me.avatar)}<div><b>${esc(S.me.username)}</b><div class="small muted" style="text-transform:capitalize">${esc(S.me.account_type)}</div></div></div><button class="btn alt sm block" id="logout-side" style="margin-top:10px">Log out</button>` : '';
  const lo = $('#logout-side'); if (lo) lo.onclick = () => logout();
  renderTopRight();
}
function renderTopRight() {
  const el = $('#top-right');
  const me = S.me;
  if (!me) { el.innerHTML = '<a class="btn sm" href="#/login">Log in</a>'; return; }
  if (me.account_type === 'viewer') el.innerHTML = `<a class="pts" href="#/buy" title="Your points balance"><i></i>${num(me.points_balance)} pts</a>`;
  else if (me.account_type === 'curator') el.innerHTML = `<a class="pts" href="#/withdraw" title="Available earnings"><i></i>${usd(me.balance && me.balance.available)}</a>`;
  else el.innerHTML = '<span class="badge ok">Admin</span>';
}
async function loadMe() {
  if (!tok.a) { S.me = null; return; }
  try { S.me = await api('/me'); } catch (e) { S.me = null; if (e.status === 401 || e.status === 403) tok.clear(); }
}
function logout(silent) {
  tok.clear(); S.me = null; updateNav();
  if (!silent) toast('Logged out');
  go('login');
}

// ---------- reusable: video card + points packages ----------
function videoCard(v) {
  return `<a class="vcard" href="#/video/${esc(v.id)}">
    <div class="th">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" decoding="async">` : ''}<span class="tag ${v.unlocked ? 'ok' : ''}">${v.unlocked ? 'Unlocked' : num(v.price) + ' pts'}</span></div>
    <div class="bd"><div class="t">${esc(v.title)}</div>
    ${v.owner ? `<div class="owner">${avatarHtml(v.owner.username, v.owner.avatar)}<span>${esc(v.owner.username)}</span></div>` : ''}</div></a>`;
}

async function packagesSection(root) {
  const d = await api('/packages');
  root.innerHTML = d.packages.length ? `<div class="grid">${d.packages.map(p => `
    <button class="card pkg btn-pkg" data-id="${esc(p.id)}" style="cursor:pointer">
      <span class="n">${esc(p.name)}</span><span class="p">${num(p.points)} pts</span>
      <span class="muted small">${kes(p.price_kes)}</span>
      <span class="muted small">≈ ${Math.floor(p.points / d.unlock_price)} video unlocks</span>
    </button>`).join('')}</div>
    <p class="hint">Pay with M-Pesa, Visa/Mastercard, Apple Pay (where supported) or bank, securely through Paystack. Points are added only after the payment is verified.</p>` : '<div class="empty">No packages available right now.</div>';
  $$('.btn-pkg', root).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api('/payments/init', { method: 'POST', body: { package_id: b.dataset.id } });
      sessionStorage.setItem('cv_ref', r.reference);
      location.href = r.authorization_url;
    } catch (e) { toast(e.message, true); b.disabled = false; }
  });
}

// ---------- pages ----------
route('', null, ({ root }) => {
  const me = S.me;
  const cta = me ? `<a class="btn" href="#/${homeFor(me)}">Go to your ${me.account_type === 'curator' ? 'dashboard' : me.account_type === 'admin' ? 'admin panel' : 'videos'}</a>`
    : `<a class="btn" href="#/register?type=curator">Join as a Curator</a><a class="btn alt" href="#/register?type=viewer">Join as a Viewer</a>`;
  root.innerHTML = `<section class="hero stack">
    <h1>Watch a preview. Unlock with points. Creators get paid.</h1>
    <p>VIDXX is a lightweight video platform where creators earn every time a viewer unlocks their content.</p>
    <div class="row">${cta}</div></section>
    <p class="small muted" style="margin-top:20px">VIDXX is for adults only (18+). By joining you agree to our <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</p>`;
});

// --- register ---
route('register', null, ({ root, query }) => {
  if (S.me) { go(homeFor(S.me)); return; }
  const reg = { type: ['curator', 'viewer'].includes(query.type) ? query.type : '', gender: '', avatar: null };
  const step1 = () => {
    root.innerHTML = `<div class="stack auth-panel" style="max-width:520px;margin:0 auto"><h1>Create your account</h1>
      <div class="field"><label>I want to join as</label><div class="pick two">
        <label><input type="radio" name="type" value="curator" ${reg.type === 'curator' ? 'checked' : ''}><span>Curator<br><small class="muted">Upload &amp; earn</small></span></label>
        <label><input type="radio" name="type" value="viewer" ${reg.type === 'viewer' ? 'checked' : ''}><span>Viewer<br><small class="muted">Watch &amp; unlock</small></span></label></div></div>
      <div class="field"><label>Gender</label><div class="pick">
        ${['female', 'male', 'transgender'].map(g => `<label><input type="radio" name="gender" value="${g}" ${reg.gender === g ? 'checked' : ''}><span style="text-transform:capitalize">${g}</span></label>`).join('')}</div></div>
      <button class="btn block" id="next">Continue</button>
      <p class="center small muted">Already registered? <a href="#/login">Log in</a></p></div>`;
    $('#next').onclick = () => {
      const t = $('input[name=type]:checked'), g = $('input[name=gender]:checked');
      if (!t || !g) return toast('Please choose an account type and gender', true);
      reg.type = t.value; reg.gender = g.value; step2();
    };
  };
  const step2 = () => {
    const needPic = reg.gender === 'female' && reg.type === 'curator';
    root.innerHTML = `<form class="stack auth-panel" id="rf" style="max-width:520px;margin:0 auto" novalidate>
      <button type="button" class="btn ghost sm" id="back">← Back</button>
      <h1>Your details</h1>
      <p class="muted" style="text-transform:capitalize">${esc(reg.type)} account · ${esc(reg.gender)}</p>
      <div class="row" style="flex-wrap:nowrap"><span id="av-prev" class="avatar lg">+</span>
        <div><label for="avatar">Profile picture${needPic ? ' (required)' : ''}</label><input type="file" id="avatar" accept="image/jpeg,image/png,image/webp"></div></div>
      <div class="field"><label for="username">Username</label><input type="text" id="username" autocomplete="username" maxlength="20" required><div class="hint">3–20 letters, numbers or underscores. Shown publicly.</div></div>
      <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="email" required></div>
      <div class="field"><label for="pw">Password</label><input type="password" id="pw" autocomplete="new-password" minlength="8" required><div class="hint">At least 8 characters.</div></div>
      <div class="field"><label for="pw2">Confirm password</label><input type="password" id="pw2" autocomplete="new-password" required></div>
      <label style="display:flex;gap:10px;align-items:flex-start;font-weight:500"><input type="checkbox" id="adult" style="margin-top:4px"><span>I am 18 or older and agree to the <a href="#/terms" target="_blank">Terms</a>, <a href="#/privacy" target="_blank">Privacy Policy</a> and <a href="#/guidelines" target="_blank">Content Guidelines</a>.</span></label>
      <div id="rerr"></div>
      <button class="btn block" id="sub">Create account</button></form>`;
    $('#back').onclick = step1;
    $('#avatar').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const r = await resizeImage(f, 256, 256);
        reg.avatar = r.dataUrl;
        $('#av-prev').outerHTML = `<img id="av-prev" class="avatar lg" src="${r.dataUrl}" alt="">`;
      } catch (er) { toast(er.message, true); }
    };
    $('#rf').onsubmit = async e => {
      e.preventDefault();
      const err = m => { $('#rerr').innerHTML = errBox(m); };
      const body = { username: $('#username').value.trim(), email: $('#email').value.trim(), password: $('#pw').value, gender: reg.gender, account_type: reg.type, avatar: reg.avatar, adult: $('#adult').checked };
      if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username)) return err('Username must be 3–20 letters, numbers or underscores');
      if (body.password.length < 8) return err('Password must be at least 8 characters');
      if (body.password !== $('#pw2').value) return err('Passwords do not match');
      if (needPic && !reg.avatar) return err('A profile picture is required for female curators');
      if (!body.adult) return err('You must confirm you are 18 or older');
      busy($('#sub'), true, 'Creating…');
      try {
        const r = await api('/register', { method: 'POST', body });
        root.innerHTML = `<div class="card stack center" style="max-width:480px;margin:30px auto"><h1>${r.needs_verification ? 'Check your email' : 'Account created'}</h1>
          <p class="muted">${r.needs_verification ? `We sent a verification link to <b>${esc(body.email)}</b>. Verify your email, then log in.` : 'You can log in now.'}</p>
          <a class="btn" href="#/login">Go to login</a></div>`;
      } catch (er) { err(er.message); busy($('#sub'), false); }
    };
  };
  step1();
});

// --- login ---
route('login', null, ({ root }) => {
  if (S.me) { go(homeFor(S.me)); return; }
  root.innerHTML = `<form class="stack auth-panel" id="lf" style="max-width:420px;margin:20px auto" novalidate><h1>Welcome back</h1>
    <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="email" required></div>
    <div class="field"><label for="pw">Password</label><input type="password" id="pw" autocomplete="current-password" required></div>
    <div id="lerr"></div><button class="btn block" id="sub">Log in</button>
    <p class="center small muted">New here? <a href="#/register">Create an account</a></p></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    busy($('#sub'), true, 'Logging in…');
    try {
      const t = await api('/login', { method: 'POST', body: { email: $('#email').value.trim(), password: $('#pw').value } });
      tok.set(t.access_token, t.refresh_token);
      await loadMe();
      updateNav();
      go(homeFor(S.me));
    } catch (er) { $('#lerr').innerHTML = errBox(er.message); busy($('#sub'), false); }
  };
});

// --- explore ---
route('explore', null, async ({ root }) => {
  if (S.me && S.me.account_type === 'curator') { root.innerHTML = `<div class="notice warn">Curators can't browse other creators' videos. Manage your own videos from the <a href="#/dashboard">dashboard</a>.</div>`; return; }
  if (!S.config) S.config = await api('/config');
  const st = { q: '', category: '', page: 1 };
  root.innerHTML = `<h1>Explore</h1>
    <input type="search" id="q" placeholder="Search videos" aria-label="Search videos" style="margin-bottom:8px">
    <div class="chips" id="cats"><button class="chip on" data-c="">All</button>${S.config.categories.map(c => `<button class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div id="vlist">${loading}</div><div class="center" style="margin-top:16px"><button class="btn alt" id="more" hidden>Load more</button></div>`;
  let shown = 0;
  const load = async (reset) => {
    if (reset) { st.page = 1; shown = 0; $('#vlist').innerHTML = loading; }
    const p = new URLSearchParams({ page: st.page });
    if (st.q) p.set('q', st.q); if (st.category) p.set('category', st.category);
    const d = await api('/videos?' + p);
    if (reset) $('#vlist').innerHTML = '<div class="grid" id="g"></div>';
    if (!d.videos.length && reset) $('#vlist').innerHTML = '<div class="empty">No videos found.</div>';
    $('#g') && $('#g').insertAdjacentHTML('beforeend', d.videos.map(videoCard).join(''));
    shown += d.videos.length;
    $('#more').hidden = shown >= d.total;
  };
  let timer;
  $('#q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { st.q = e.target.value.trim(); load(true).catch(x => toast(x.message, true)); }, 350); };
  $('#cats').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    $$('.chip', root).forEach(c => c.classList.toggle('on', c === b));
    st.category = b.dataset.c; load(true).catch(x => toast(x.message, true));
  };
  $('#more').onclick = () => { st.page++; load(false).catch(x => toast(x.message, true)); };
  await load(true);
});

// --- video player ---
route('video', null, async ({ root, args }) => {
  const id = args[0];
  const v = await api('/videos/' + encodeURIComponent(id));
  const me = S.me;
  root.innerHTML = `<div class="stack"><a class="btn ghost sm" href="#/explore" style="padding-left:0">← Back</a>
    <div class="player" id="player">
      <video id="vid" playsinline controls controlsList="nodownload noplaybackrate" disablePictureInPicture preload="auto" ${v.thumb ? `poster="${esc(v.thumb)}"` : ''}></video>
      <div class="overlay" id="ov" hidden></div></div>
    <div><h1>${esc(v.title)}</h1>
      <div class="row between"><a class="owner" href="#/u/${esc(v.owner && v.owner.username)}" style="margin:0">${avatarHtml(v.owner && v.owner.username, v.owner && v.owner.avatar)}<b style="color:var(--ink);font-size:.95rem">${esc(v.owner && v.owner.username)}</b></a>
      <span class="badge">${esc(v.category)}</span></div>
      ${v.description ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(v.description)}</p>` : ''}
      ${me && me.account_type === 'viewer' ? '<button class="btn ghost sm" id="rep" style="padding-left:0">Report this video</button>' : ''}</div></div>`;
  const vid = $('#vid'), ov = $('#ov');
  vid.oncontextmenu = e => e.preventDefault();
  const setOv = html => { ov.innerHTML = html; ov.hidden = false; };
  if (!me) { setOv(`<div><h2>Log in to watch</h2><p>Create a free account to watch the first ${v.preview_seconds} seconds of every video.</p><div class="row" style="justify-content:center"><a class="btn" href="#/login">Log in</a><a class="btn alt" href="#/register?type=viewer">Join as a Viewer</a></div></div>`); vid.controls = false; return; }

  let play;
  try { play = await api('/videos/' + encodeURIComponent(id) + '/play', { method: 'POST' }); }
  catch (e) { setOv(`<div><h2>Can't play this video</h2><p>${esc(e.message)}</p></div>`); vid.controls = false; return; }
  let unlocked = play.unlocked;
  let price = play.price;
  if (me.account_type === 'viewer' && play.balance != null) { me.points_balance = play.balance; renderTopRight(); }
  vid.src = play.url;
  vid.play().catch(() => { /* autoplay may be blocked; user can press play */ });

  const lockOverlay = () => {
    vid.pause(); vid.controls = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const enough = me.points_balance >= price;
    setOv(`<div>${icon('lock', 'lock')}<h2>Video Locked</h2><h3 style="margin-top:6px">Unlock this video</h3>
      <p>Purchase points to continue watching this video.</p>
      ${enough ? `<button class="btn" id="unlock">Unlock for ${num(price)} points</button>` : `<a class="btn" href="#/buy">Buy Points to Unlock</a>`}
      <p class="small">Your balance: ${num(me.points_balance)} pts · This video costs ${num(price)} pts.<br>Your points balance will be updated after a successful payment.</p></div>`);
    const ub = $('#unlock');
    if (ub) ub.onclick = async () => {
      busy(ub, true, 'Unlocking…');
      try {
        const d = await api('/videos/' + encodeURIComponent(id) + '/unlock', { method: 'POST' });
        const resumeAt = vid.currentTime || 0;
        unlocked = true; ov.hidden = true; vid.controls = true;
        if (d.balance != null) { me.points_balance = d.balance; renderTopRight(); }
        vid.src = d.url;
        vid.addEventListener('loadedmetadata', () => { vid.currentTime = resumeAt; vid.play().catch(() => {}); }, { once: true });
        toast(d.already ? 'Already unlocked' : `Unlocked! ${num(d.spent)} points used.`);
      } catch (e) {
        toast(e.message, true);
        if (e.status === 402) { me.points_balance = e.data.balance; lockOverlay(); }
        else busy(ub, false);
      }
    };
  };
  if (!unlocked) {
    const limit = (play.preview_seconds || 10) - 0.2;
    vid.addEventListener('timeupdate', () => { if (!unlocked && vid.currentTime >= limit) lockOverlay(); });
    vid.addEventListener('ended', () => { if (!unlocked) lockOverlay(); });
  }
  const rep = $('#rep');
  if (rep) rep.onclick = () => {
    const box = modal(`<h2 style="margin-top:0">Report video</h2><div class="field"><label for="rr">What's wrong?</label><textarea id="rr" rows="3" maxlength="500"></textarea></div><div class="row"><button class="btn" id="rs">Send report</button><button class="btn alt" id="rc">Cancel</button></div>`);
    $('#rc', box).onclick = closeModal;
    $('#rs', box).onclick = async () => {
      try { await api('/videos/' + encodeURIComponent(id) + '/report', { method: 'POST', body: { reason: $('#rr').value } }); closeModal(); toast('Thanks, our team will review it.'); }
      catch (e) { toast(e.message, true); }
    };
  };
});

// --- buy points ---
route('buy', ['viewer'], async ({ root }) => {
  root.innerHTML = `<h1>Buy Points</h1><div id="status"></div><div class="card" style="margin-bottom:14px"><span class="muted small">Current balance</span><div style="font-size:1.8rem;font-weight:800" id="bal">${num(S.me.points_balance)} pts</div></div><div id="pk">${loading}</div>
    <h2>Payment history</h2><div id="ph">${loading}</div>`;
  const q = parseHash().query;
  const hq = new URLSearchParams(location.search);
  const ref = q.reference || q.trxref || hq.get('reference') || hq.get('trxref');
  const refresh = async () => { await loadMe(); renderTopRight(); $('#bal').textContent = num(S.me.points_balance) + ' pts'; };
  if (ref) {
    history.replaceState(null, '', location.pathname + '#/buy');
    $('#status').innerHTML = '<div class="notice">Confirming your payment…</div>';
    let result = 'pending';
    for (let i = 0; i < 8 && result === 'pending'; i++) {
      try { const r = await api('/payments/verify/' + encodeURIComponent(ref)); result = r.result; } catch (e) { result = 'error'; }
      if (result === 'pending') await new Promise(r => setTimeout(r, 3000));
    }
    sessionStorage.removeItem('cv_ref');
    $('#status').innerHTML = result === 'credited' || result === 'already_credited' ? '<div class="notice ok">Payment confirmed. Your points have been added.</div>'
      : result === 'pending' ? '<div class="notice warn">Your payment is still processing. Your points will be added automatically once it is confirmed.</div>'
      : '<div class="notice bad">We could not confirm that payment. If money left your account it will be credited automatically once confirmed, or contact support with your payment reference.</div>';
    await refresh();
  }
  await packagesSection($('#pk'));
  paymentHistory($('#ph'));
});

async function paymentHistory(el) {
  const d = await api('/viewer/payments');
  el.innerHTML = d.payments.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Points</th><th>Amount</th><th>Status</th></tr></thead><tbody>${d.payments.map(p => `<tr><td>${dtime(p.created_at)}</td><td>${esc(p.reference)}</td><td>${num(p.points)}</td><td>${kes(p.amount_kes)}</td><td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No payments yet.</div>';
}

// --- own profile ---
route('profile', 'auth', async ({ root }) => {
  await loadMe(); renderTopRight();
  const me = S.me;
  root.innerHTML = `<div class="stack">
    <div class="card row" style="flex-wrap:nowrap;gap:16px"><div id="avwrap">${avatarHtml(me.username, me.avatar, 'lg')}</div>
      <div style="min-width:0"><h1 style="margin:0">${esc(me.username)}</h1>
      <div class="row" style="gap:6px;margin:6px 0"><span class="badge" style="text-transform:capitalize">${esc(me.account_type)}</span><span class="badge" style="text-transform:capitalize">${esc(me.gender)}</span></div>
      <div class="small muted">Joined ${date(me.created_at)} · ${esc(me.email)}</div>
      <label class="btn alt sm" style="margin-top:8px;cursor:pointer">Change photo<input type="file" id="newav" accept="image/jpeg,image/png,image/webp" hidden></label></div></div>
    <div id="role-sections"></div>
    <div class="small muted">Account type can only be changed by an admin. <button class="btn alt sm" id="lo" style="margin-left:6px">Log out</button></div></div>`;
  $('#lo').onclick = () => logout();
  $('#newav').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await resizeImage(f, 256, 256);
      const d = await api('/me/avatar', { method: 'PUT', body: { avatar: r.dataUrl } });
      S.me.avatar = d.avatar; $('#avwrap').innerHTML = avatarHtml(me.username, d.avatar, 'lg'); updateNav(); toast('Photo updated');
    } catch (er) { toast(er.message, true); }
  };
  const rs = $('#role-sections');
  if (me.account_type === 'viewer') {
    rs.innerHTML = `<div class="card"><span class="muted small">Points balance</span><div style="font-size:2rem;font-weight:800">${num(me.points_balance)} pts</div></div>
      <h2>Buy Points</h2><div id="pk"></div>
      <h2>Unlocked videos &amp; viewing history</h2><div id="hist">${loading}</div>
      <h2>Payment history</h2><div id="ph">${loading}</div>`;
    packagesSection($('#pk')).catch(e => toast(e.message, true));
    api('/viewer/history').then(d => {
      $('#hist').innerHTML = d.history.length ? `<div class="grid">${d.history.map(h => `<a class="vcard" href="#/video/${esc(h.id)}"><div class="th">${h.thumb ? `<img src="${esc(h.thumb)}" alt="" loading="lazy">` : ''}<span class="tag ok">Unlocked</span></div><div class="bd"><div class="t">${esc(h.title)}</div><div class="small muted">${esc(h.owner || '')} · ${date(h.unlocked_at)} · ${num(h.points_spent)} pts</div></div></a>`).join('')}</div>` : '<div class="empty">You haven\'t unlocked any videos yet.</div>';
    }).catch(e => { $('#hist').innerHTML = errBox(e.message); });
    paymentHistory($('#ph')).catch(e => { $('#ph').innerHTML = errBox(e.message); });
  } else if (me.account_type === 'curator') {
    const d = await api('/users/' + encodeURIComponent(me.username));
    const b = d.balance || {};
    rs.innerHTML = `<div class="stats">
      <div class="stat"><span>Published videos</span><b>${num((d.videos || []).length)}</b></div>
      <div class="stat"><span>Total views</span><b>${num(d.total_views)}</b></div>
      <div class="stat"><span>Total earnings</span><b>${usd(b.total_earned)}</b></div>
      <div class="stat"><span>Available balance</span><b>${usd(b.available)}</b></div>
      <div class="stat"><span>Pending withdrawals</span><b>${usd(b.pending)}</b></div></div>
      <div class="row"><a class="btn" href="#/dashboard">Creator dashboard</a><a class="btn alt" href="#/upload">Upload video</a></div>
      <h2>Your published videos</h2>${(d.videos || []).length ? `<div class="grid">${d.videos.map(x => `<a class="vcard" href="#/video/${esc(x.id)}"><div class="th">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}</div><div class="bd"><div class="t">${esc(x.title)}</div></div></a>`).join('')}</div>` : '<div class="empty">No approved videos yet.</div>'}`;
  } else {
    rs.innerHTML = '<div class="row"><a class="btn" href="#/admin">Open admin dashboard</a></div>';
  }
});

// --- public profile ---
route('u', null, async ({ root, args }) => {
  const d = await api('/users/' + encodeURIComponent(args[0] || ''));
  root.innerHTML = `<div class="stack"><div class="card row" style="flex-wrap:nowrap;gap:16px">${avatarHtml(d.username, d.avatar, 'lg')}
    <div><h1 style="margin:0">${esc(d.username)}</h1>
    <div class="row" style="gap:6px;margin:6px 0"><span class="badge" style="text-transform:capitalize">${esc(d.account_type)}</span><span class="badge" style="text-transform:capitalize">${esc(d.gender)}</span></div>
    <div class="small muted">Joined ${date(d.created_at)}</div></div></div>
    ${d.account_type === 'curator' ? `<div class="stats"><div class="stat"><span>Published videos</span><b>${num((d.videos || []).length)}</b></div><div class="stat"><span>Total views</span><b>${num(d.total_views)}</b></div></div>
    <h2>Videos</h2>${(d.videos || []).length ? `<div class="grid">${d.videos.map(x => `<a class="vcard" href="#/video/${esc(x.id)}"><div class="th">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}</div><div class="bd"><div class="t">${esc(x.title)}</div></div></a>`).join('')}</div>` : '<div class="empty">No videos yet.</div>'}` : ''}</div>`;
});

// --- legal pages ---
const LEGAL = {
  terms: ['Terms of Service', [
    ['Eligibility', 'VIDXX is for adults aged 18 and over. You confirm you are 18+ when you register. We may suspend accounts we believe belong to minors.'],
    ['Accounts', 'Choose one account type at sign-up: Curator (upload and earn) or Viewer (watch and unlock). Account type changes need admin approval. Keep your password safe; you are responsible for activity on your account.'],
    ['Points', 'Points are bought with real money through Paystack and spent to unlock videos. An unlocked video stays unlocked for your account. Points have no cash value and cannot be withdrawn or transferred. Purchases are non-refundable except where the law requires or where we made an error.'],
    ['Content', 'Curators must follow the Content Guidelines. We may approve, reject or remove content and suspend accounts at our discretion to keep the platform safe and lawful.'],
    ['Prohibited use', 'No fraud, fake views, bots, payment abuse, attempts to bypass the preview lock, or downloading and redistributing content.'],
    ['Liability', 'The service is provided "as is". To the extent the law allows, VIDXX is not liable for indirect or consequential loss.'],
    ['Changes', 'We may update these terms. Continued use after an update means you accept it.']]],
  privacy: ['Privacy Policy', [
    ['What we collect', 'Username, email, gender, profile picture, account type, payment records (via Paystack, we do not store card or M-Pesa PINs), viewing and unlock history, and basic technical logs.'],
    ['Why we collect it', 'To run your account, process payments and payouts, prevent fraud, moderate content and meet legal duties.'],
    ['Who sees what', 'Your username, profile picture, gender, account type and join date are public. Your email, payments, points and earnings are private to you and authorised admins.'],
    ['Sharing', 'We share data with service providers that run the platform (hosting, database, video storage, Paystack) and where the law requires. We do not sell personal data.'],
    ['Your rights', 'You may request access, correction or deletion of your data, subject to record-keeping duties (for example financial records), as provided under the Kenya Data Protection Act, 2019.'],
    ['Security & retention', 'Payments are verified server-side, access to videos uses short-lived signed links, and financial records are kept in an audit log. We keep data only as long as needed for the purposes above.']]],
  payout: ['Creator Payout Rules', [
    ['Earnings', 'A curator earns a fixed amount (set by the platform and shown on the dashboard) for each qualified paid unlock. Free previews do not earn.'],
    ['Qualified unlock', 'One viewer unlocking one video counts once. Repeat views by the same viewer, refunded or fraudulent unlocks do not earn.'],
    ['Withdrawals', 'Request a withdrawal once your available balance reaches the minimum. Funds are held when you request and released back if the request is rejected. All withdrawals are reviewed and approved by an admin.'],
    ['Payment methods', 'Payouts are sent by M-Pesa or bank. Amounts are in USD and converted to KES at the platform rate shown at payout.'],
    ['Fraud', 'Earnings from fake views, self-unlocking, bots or any manipulation will be reversed and the account may be suspended.']]],
  guidelines: ['Content Guidelines', [
    ['Adults only', 'Everyone appearing in content must be 18 or older and must have given clear consent to being filmed and published. We may ask for proof.'],
    ['Not allowed', 'Anyone under 18; non-consensual or secretly recorded content; violence, abuse, hate or harassment; illegal activity; content that infringes someone else\'s copyright or privacy.'],
    ['Your content', 'Upload only videos you own or have permission to share. Use accurate titles, descriptions and categories.'],
    ['Moderation', 'Every video is reviewed before it goes live. Viewers can report videos. We remove content that breaks these rules and may suspend the account.'],
    ['Reporting', 'Use the "Report this video" button on any video page.']]]
};
Object.keys(LEGAL).forEach(k => route(k, null, ({ root }) => {
  const [title, secs] = LEGAL[k];
  root.innerHTML = `<div class="prose" style="max-width:720px"><h1>${esc(title)}</h1><p class="small muted">Plain-language summary. Have it reviewed by a lawyer before launch.</p>${secs.map(([h, t]) => `<h2>${esc(h)}</h2><p>${esc(t)}</p>`).join('')}</div>`;
}));

// ---------- expose for creator.js / admin.js ----------
window.CV = { S, api, route, esc, num, usd, kes, date, dtime, toast, modal, closeModal, loading, errBox, avatarHtml, icon, busy, resizeImage, videoCard, go, loadMe, renderTopRight, $, $$, parseHash };

// ---------- boot ----------
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  await loadMe();
  // Paystack may append ?reference=... before the hash; route those to the buy page
  const sp = new URLSearchParams(location.search);
  if ((sp.get('reference') || sp.get('trxref')) && !location.hash.includes('/buy')) location.hash = '#/buy';
  render();
});
})();
