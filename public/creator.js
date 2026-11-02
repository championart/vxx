/* Curator pages: dashboard, upload, withdraw */
(() => {
'use strict';
const { S, api, route, esc, num, usd, kes, date, dtime, toast, modal, closeModal, loading, errBox, busy, resizeImage, go, loadMe, renderTopRight, $, $$ } = window.CV;

const statusBadge = s => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

// ---------- dashboard ----------
route('dashboard', ['curator'], async ({ root }) => {
  const d = await api('/creator/dashboard');
  const t = d.totals;
  root.innerHTML = `<div class="stack"><div class="row between"><h1 style="margin:0">Creator dashboard</h1><div class="row"><a class="btn" href="#/upload">Upload video</a><a class="btn alt" href="#/withdraw">Withdraw</a></div></div>
    <div class="stats">
      <div class="stat"><span>Total video views</span><b>${num(t.total_views)}</b></div>
      <div class="stat"><span>Paid unlocks</span><b>${num(t.paid_unlocks)}</b></div>
      <div class="stat"><span>Free previews</span><b>${num(t.previews)}</b></div>
      <div class="stat"><span>Total earnings</span><b>${usd(t.total_earned)}</b></div>
      <div class="stat"><span>Available</span><b>${usd(t.available)}</b></div>
      <div class="stat"><span>Pending</span><b>${usd(t.pending)}</b></div>
      <div class="stat"><span>Withdrawn</span><b>${usd(t.withdrawn)}</b></div>
      <div class="stat"><span>Rate per paid unlock</span><b>${usd(d.settings.creator_rate_usd)}</b></div></div>
    <div class="card"><div class="row between"><h2 style="margin:0">Earnings report</h2>
      <div class="tabs" style="margin:0" id="ptabs"><button data-p="day" class="on">Daily</button><button data-p="week">Weekly</button><button data-p="month">Monthly</button></div></div>
      <div id="rep">${loading}</div></div>
    <h2 style="margin-bottom:0">Your videos</h2>
    ${d.videos.length ? `<div class="tablewrap"><table><thead><tr><th>Video</th><th>Status</th><th>Previews</th><th>Paid unlocks</th><th>Earned</th><th></th></tr></thead><tbody>
      ${d.videos.map(v => `<tr><td class="wrap"><a href="#/video/${esc(v.id)}"><b>${esc(v.title)}</b></a><div class="small muted">${date(v.created_at)}</div></td><td>${statusBadge(v.status)}</td><td>${num(v.previews)}</td><td>${num(v.paid)}</td><td>${usd(v.earned)}</td><td><button class="btn alt sm del" data-id="${esc(v.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">You haven\'t uploaded anything yet. <a href="#/upload">Upload your first video</a>.</div>'}
    </div>`;
  const loadReport = async p => {
    $('#rep').innerHTML = loading;
    try {
      const r = await api('/creator/report?period=' + p);
      if (!r.rows.length) { $('#rep').innerHTML = '<div class="empty">No paid unlocks in this period yet.</div>'; return; }
      const max = Math.max(...r.rows.map(x => x.earned), 0.000001);
      const lbl = b => new Date(b).toLocaleDateString('en-KE', p === 'month' ? { month: 'short' } : { day: 'numeric', month: 'short' });
      $('#rep').innerHTML = `<div class="bars" role="img" aria-label="Earnings chart">${r.rows.map(x => `<div title="${esc(lbl(x.bucket))}: ${usd(x.earned)}" style="height:${Math.max(4, x.earned / max * 100)}%"></div>`).join('')}</div>
        <div class="bar-labels">${r.rows.map(x => `<span>${esc(lbl(x.bucket))}</span>`).join('')}</div>
        <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Period starting</th><th>Paid unlocks</th><th>Earned</th></tr></thead><tbody>${r.rows.slice().reverse().map(x => `<tr><td>${date(x.bucket)}</td><td>${num(x.unlocks)}</td><td>${usd(x.earned)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (e) { $('#rep').innerHTML = errBox(e.message); }
  };
  $('#ptabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#ptabs button').forEach(x => x.classList.toggle('on', x === b));
    loadReport(b.dataset.p);
  };
  loadReport('day');
  $$('.del', root).forEach(b => b.onclick = () => {
    const box = modal('<h2 style="margin-top:0">Delete this video?</h2><p class="muted">The video files are removed permanently. Earnings already credited stay in your balance.</p><div class="row"><button class="btn bad" id="y">Delete</button><button class="btn alt" id="n">Cancel</button></div>');
    $('#n', box).onclick = closeModal;
    $('#y', box).onclick = async () => {
      try { await api('/videos/' + b.dataset.id, { method: 'DELETE' }); closeModal(); toast('Video deleted'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
      catch (e) { toast(e.message, true); }
    };
  });
});

// ---------- upload ----------
let sbLib = null;
function loadSupabaseLib() {
  if (window.supabase) return Promise.resolve();
  if (sbLib) return sbLib;
  sbLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Could not load the upload library. Check your connection.'));
    document.head.appendChild(s);
  });
  return sbLib;
}
const MAX_MB = 50;

route('upload', ['curator'], async ({ root }) => {
  const cfg = await api('/config');
  root.innerHTML = `<form class="stack" id="uf" style="max-width:560px" novalidate><h1>Upload video</h1>
    <div class="notice">Your video goes live automatically once it has been processed. Adults only (18+), with consent from everyone shown. Videos that break the rules are removed. See the <a href="#/guidelines" target="_blank">content guidelines</a>.</div>
    <div class="field"><label for="file">Video (MP4, up to ${MAX_MB} MB)</label><input type="file" id="file" accept="video/mp4"></div>
    <div class="field"><label for="thumb">Thumbnail image</label><input type="file" id="thumb" accept="image/jpeg,image/png,image/webp"><div id="tprev" style="margin-top:8px"></div></div>
    <div class="field"><label for="title">Title</label><input type="text" id="title" maxlength="100"></div>
    <div class="field"><label for="desc">Description</label><textarea id="desc" rows="3" maxlength="2000"></textarea></div>
    <div class="field"><label for="cat">Category</label><select id="cat">${cfg.categories.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div id="uerr"></div><div id="ustat"></div>
    <button class="btn block" id="usub">Upload video</button></form>`;
  let thumbBlob = null;
  $('#thumb').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await resizeImage(f, 640, 360); thumbBlob = r.blob; $('#tprev').innerHTML = `<img src="${r.dataUrl}" alt="Thumbnail preview" style="border-radius:10px;max-width:280px">`; }
    catch (er) { toast(er.message, true); }
  };
  $('#uf').onsubmit = async e => {
    e.preventDefault();
    const err = m => { $('#uerr').innerHTML = errBox(m); };
    $('#uerr').innerHTML = '';
    const file = $('#file').files[0];
    const title = $('#title').value.trim();
    if (!file) return err('Choose an MP4 video');
    if (file.type !== 'video/mp4' && !/\.mp4$/i.test(file.name)) return err('Only MP4 videos are supported');
    if (file.size > MAX_MB * 1024 * 1024) return err(`Video is larger than ${MAX_MB} MB`);
    if (!thumbBlob) return err('Choose a thumbnail image');
    if (title.length < 3) return err('Enter a title (at least 3 characters)');
    busy($('#usub'), true, 'Uploading…');
    $('#ustat').innerHTML = '<div class="notice">Uploading your video. Keep this page open, this can take a minute.</div>';
    try {
      await loadSupabaseLib();
      const u = await api('/videos/upload-urls', { method: 'POST' });
      const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey, { auth: { persistSession: false } });
      const [a, b] = await Promise.all([
        sb.storage.from('videos').uploadToSignedUrl(u.video.path, u.video.token, file, { contentType: 'video/mp4' }),
        sb.storage.from('thumbs').uploadToSignedUrl(u.thumb.path, u.thumb.token, thumbBlob, { contentType: 'image/jpeg' })
      ]);
      if (a.error) throw new Error('Video upload failed: ' + a.error.message);
      if (b.error) throw new Error('Thumbnail upload failed: ' + b.error.message);
      await api('/videos', { method: 'POST', body: { id: u.video_id, title, description: $('#desc').value, category: $('#cat').value, video_path: u.video.path, thumb_path: u.thumb.path } });
      root.innerHTML = `<div class="card stack center" style="max-width:480px;margin:30px auto"><h1>Upload complete</h1><p class="muted">We're preparing your preview clip. Your video goes live in about a minute and shows as Approved on your dashboard.</p><div class="row" style="justify-content:center"><a class="btn" href="#/dashboard">Go to dashboard</a><a class="btn alt" href="#/upload">Upload another</a></div></div>`;
    } catch (er) { $('#ustat').innerHTML = ''; err(er.message); busy($('#usub'), false); }
  };
});

// ---------- withdraw ----------
route('withdraw', ['curator'], async ({ root }) => {
  await loadMe(); renderTopRight();
  const [dash, wd] = await Promise.all([api('/creator/dashboard'), api('/withdrawals')]);
  const t = dash.totals, st = dash.settings;
  root.innerHTML = `<div class="stack" style="max-width:640px"><h1>Withdraw earnings</h1>
    <div class="stats"><div class="stat"><span>Available</span><b>${usd(t.available)}</b><span>≈ ${kes(t.available * st.usd_to_kes)}</span></div>
      <div class="stat"><span>Pending</span><b>${usd(t.pending)}</b></div>
      <div class="stat"><span>Minimum</span><b>${usd(st.min_withdrawal_usd)}</b></div></div>
    <form class="card stack" id="wf" novalidate>
      <div class="field"><label for="amt">Amount (USD)</label><input type="number" id="amt" step="0.001" min="0" inputmode="decimal"><div class="hint" id="amtk"></div></div>
      <div class="field"><label>Pay out to</label><div class="pick two"><label><input type="radio" name="m" value="mpesa" checked><span>M-Pesa</span></label><label><input type="radio" name="m" value="bank"><span>Bank</span></label></div></div>
      <div class="field"><label for="dest" id="dl">M-Pesa phone number</label><input type="text" id="dest" placeholder="07XXXXXXXX"></div>
      <div id="werr"></div>
      <button class="btn block" id="wsub">Request withdrawal</button>
      <p class="hint">Requests are reviewed by an admin. The amount is held from your balance until approved or rejected.</p></form>
    <h2>Withdrawal history</h2>
    ${wd.withdrawals.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Note</th></tr></thead><tbody>${wd.withdrawals.map(w => `<tr><td>${dtime(w.created_at)}</td><td>${usd(w.amount_usd)}</td><td>${esc(w.method)}</td><td>${statusBadge(w.status)}</td><td class="wrap">${esc(w.admin_note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No withdrawals yet.</div>'}</div>`;
  $('#amt').oninput = e => { $('#amtk').textContent = e.target.value ? '≈ ' + kes(e.target.value * st.usd_to_kes) : ''; };
  $$('input[name=m]', root).forEach(r => r.onchange = () => {
    const bank = $('input[name=m]:checked').value === 'bank';
    $('#dl').textContent = bank ? 'Bank name, account number and account name' : 'M-Pesa phone number';
    $('#dest').placeholder = bank ? 'e.g. KCB, 1234567890, Jane Doe' : '07XXXXXXXX';
  });
  $('#wf').onsubmit = async e => {
    e.preventDefault();
    const amount = Number($('#amt').value);
    if (!(amount > 0)) return $('#werr').innerHTML = errBox('Enter an amount');
    busy($('#wsub'), true, 'Submitting…');
    try {
      await api('/withdrawals', { method: 'POST', body: { amount_usd: amount, method: $('input[name=m]:checked').value, destination: $('#dest').value } });
      toast('Withdrawal requested');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (er) {
      const d = er.data || {};
      $('#werr').innerHTML = errBox(d.error === 'below_minimum' ? `Minimum withdrawal is ${usd(d.minimum)}` : d.error === 'insufficient_funds' ? `You only have ${usd(d.available)} available` : er.message);
      busy($('#wsub'), false);
    }
  };
});
})();
