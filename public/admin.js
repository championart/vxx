/* Admin dashboard */
(() => {
'use strict';
const { api, route, esc, num, usd, kes, date, dtime, toast, modal, closeModal, loading, errBox, avatarHtml, busy, $, $$ } = window.CV;
const badge = s => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const TABS = [['overview', 'Overview'], ['users', 'Users'], ['videos', 'Videos'], ['live', 'Live'], ['payments', 'Payments'], ['withdrawals', 'Withdrawals'], ['settings', 'Pricing & settings'], ['reports', 'Reports'], ['audit', 'Audit log']];

route('admin', ['admin'], async ({ root }) => {
  root.innerHTML = `<h1>Admin dashboard</h1><div class="tabs" id="atabs">${TABS.map(([k, l], i) => `<button data-t="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div><div id="abody"></div>`;
  const body = $('#abody');
  const show = async k => {
    $$('#atabs button').forEach(b => b.classList.toggle('on', b.dataset.t === k));
    body.innerHTML = loading;
    try { await views[k](body); } catch (e) { body.innerHTML = errBox(e.message); }
  };
  $('#atabs').onclick = e => { const b = e.target.closest('button'); if (b) show(b.dataset.t); };
  window.__adminShow = show;
  show('overview');
});

const views = {
  async overview(el) {
    const s = await api('/admin/stats');
    const c = (l, v) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`;
    el.innerHTML = `<div class="stats">${c('Registered users', num(s.users_total))}${c('Curators', num(s.curators))}${c('Viewers', num(s.viewers))}${c('Videos', num(s.videos_total))}
      ${c('Awaiting review', num(s.videos_pending))}${c('Total views', num(s.views_total))}${c('Free previews', num(s.previews_total))}${c('Paid unlocks', num(s.paid_unlocks))}
      ${c('Platform revenue', kes(s.revenue_kes))}${c('Creator earnings', usd(s.creator_earned_usd))}${c('Pending withdrawals', num(s.withdrawals_pending))}${c('Open reports', num(s.open_reports))}</div>`;
  },

  async users(el) {
    const st = { q: '', gender: '', type: '', page: 1 };
    el.innerHTML = `<div class="row" style="margin-bottom:12px"><input type="search" id="uq" placeholder="Search username" style="max-width:240px">
      <select id="ug" style="max-width:160px"><option value="">All genders</option><option value="female">Female</option><option value="male">Male</option><option value="transgender">Transgender</option></select>
      <select id="ut" style="max-width:160px"><option value="">All types</option><option value="curator">Curators</option><option value="viewer">Viewers</option><option value="admin">Admins</option></select></div><div id="ul"></div>`;
    const load = async () => {
      const p = new URLSearchParams({ page: st.page }); if (st.q) p.set('q', st.q); if (st.gender) p.set('gender', st.gender); if (st.type) p.set('type', st.type);
      const d = await api('/admin/users?' + p);
      $('#ul').innerHTML = `<div class="tablewrap"><table><thead><tr><th>User</th><th>Type</th><th>Gender</th><th>Status</th><th>Points</th><th>Joined</th><th>Actions</th></tr></thead><tbody>
        ${d.users.map(u => `<tr><td><div class="row" style="flex-wrap:nowrap;gap:8px">${avatarHtml(u.username, u.avatar)}<a href="#/u/${esc(u.username)}">${esc(u.username)}</a></div></td><td style="text-transform:capitalize">${esc(u.account_type)}</td><td style="text-transform:capitalize">${esc(u.gender)}</td><td>${badge(u.status)}</td><td>${num(u.points_balance)}</td><td>${date(u.created_at)}</td>
        <td><div class="row" style="gap:6px;flex-wrap:nowrap">${u.account_type === 'admin' ? '' : `
          <button class="btn alt sm st" data-id="${esc(u.id)}" data-s="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspend' : 'Activate'}</button>
          <button class="btn alt sm st" data-id="${esc(u.id)}" data-s="deactivated">Deactivate</button>
          <button class="btn alt sm ty" data-id="${esc(u.id)}" data-t="${u.account_type === 'curator' ? 'viewer' : 'curator'}">Make ${u.account_type === 'curator' ? 'viewer' : 'curator'}</button>`}</div></td></tr>`).join('')}</tbody></table></div>
        <div class="row between" style="margin-top:10px"><span class="small muted">${num(d.total)} users</span><div class="row"><button class="btn alt sm" id="pp" ${st.page <= 1 ? 'disabled' : ''}>Prev</button><button class="btn alt sm" id="pn" ${st.page * d.page_size >= d.total ? 'disabled' : ''}>Next</button></div></div>`;
      $$('.st', el).forEach(b => b.onclick = async () => { try { await api(`/admin/users/${b.dataset.id}/status`, { method: 'POST', body: { status: b.dataset.s } }); toast('Updated'); load(); } catch (e) { toast(e.message, true); } });
      $$('.ty', el).forEach(b => b.onclick = async () => { if (!confirm('Change this account type? Existing balances stay with the account.')) return; try { await api(`/admin/users/${b.dataset.id}/type`, { method: 'POST', body: { account_type: b.dataset.t } }); toast('Updated'); load(); } catch (e) { toast(e.message, true); } });
      $('#pp').onclick = () => { st.page--; load(); }; $('#pn').onclick = () => { st.page++; load(); };
    };
    let t; $('#uq').oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); st.page = 1; load(); }, 300); };
    $('#ug').onchange = e => { st.gender = e.target.value; st.page = 1; load(); };
    $('#ut').onchange = e => { st.type = e.target.value; st.page = 1; load(); };
    await load();
  },

  async videos(el) {
    let status = 'pending';
    el.innerHTML = '<div class="tabs" id="vt"><button data-s="pending" class="on">Pending</button><button data-s="approved">Approved</button><button data-s="rejected">Rejected</button></div><div id="vl"></div>';
    const load = async () => {
      $('#vl').innerHTML = loading;
      const d = await api('/admin/videos?status=' + status);
      $('#vl').innerHTML = d.videos.length ? `<div class="tablewrap"><table><thead><tr><th>Video</th><th>Creator</th><th>Preview</th><th>Price (pts)</th><th>Actions</th></tr></thead><tbody>
        ${d.videos.map(v => `<tr><td class="wrap"><div class="row" style="flex-wrap:nowrap;gap:10px">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" style="width:80px;border-radius:8px">` : ''}<div><b>${esc(v.title)}</b><div class="small muted">${esc(v.category)} · ${date(v.created_at)}</div></div></div></td>
        <td>${esc(v.owner && v.owner.username)}</td><td>${v.has_preview ? badge('ok') : '<span class="badge pending">not ready</span>'}</td>
        <td><input type="number" min="1" class="pr" data-id="${esc(v.id)}" value="${v.price_override || ''}" placeholder="default" style="width:90px;padding:6px 8px"></td>
        <td><div class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn alt sm" href="#/video/${esc(v.id)}" target="_blank">Watch</a>
          ${status !== 'approved' ? `<button class="btn sm rv" data-a="approve" data-id="${esc(v.id)}">Approve</button>` : ''}
          ${status !== 'rejected' ? `<button class="btn alt sm rv" data-a="reject" data-id="${esc(v.id)}">Reject</button>` : ''}
          ${!v.has_preview ? `<button class="btn alt sm rb" data-id="${esc(v.id)}">Rebuild preview</button>` : ''}
          <button class="btn bad sm dl" data-id="${esc(v.id)}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing here.</div>';
      $$('.rv', el).forEach(b => b.onclick = async () => { try { await api(`/admin/videos/${b.dataset.id}/review`, { method: 'POST', body: { action: b.dataset.a } }); toast('Done'); load(); } catch (e) { toast(e.message, true); } });
      $$('.rb', el).forEach(b => b.onclick = async () => { busy(b, true, 'Working…'); try { const r = await api(`/admin/videos/${b.dataset.id}/preview`, { method: 'POST' }); toast(r.ok ? 'Preview ready' : ('Preview failed: ' + (r.error || 'unknown reason')), !r.ok); load(); } catch (e) { toast(e.message, true); busy(b, false); } });
      $$('.dl', el).forEach(b => b.onclick = async () => { if (!confirm('Delete this video permanently?')) return; try { await api('/videos/' + b.dataset.id, { method: 'DELETE' }); toast('Deleted'); load(); } catch (e) { toast(e.message, true); } });
      $$('.pr', el).forEach(i => i.onchange = async () => { try { await api(`/admin/videos/${i.dataset.id}/price`, { method: 'PUT', body: { price_points: i.value === '' ? null : i.value } }); toast('Price saved'); } catch (e) { toast(e.message, true); } });
    };
    $('#vt').onclick = e => { const b = e.target.closest('button'); if (!b) return; status = b.dataset.s; $$('#vt button').forEach(x => x.classList.toggle('on', x === b)); load(); };
    await load();
  },

  async live(el) {
    const d = await api('/admin/live');
    el.innerHTML = d.streams.length ? `<div class="tablewrap"><table><thead><tr><th>Started</th><th>Host</th><th>Title</th><th>Status</th><th>Peak viewers</th><th></th></tr></thead><tbody>${d.streams.map(s => `<tr><td>${dtime(s.started_at)}</td><td>${esc(s.host && s.host.username)}</td><td class="wrap">${esc(s.title)}</td><td>${badge(s.status === 'live' ? 'active' : 'pending')}</td><td>${num(s.peak_viewers)}</td><td>${s.status === 'live' ? `<button class="btn bad sm le" data-id="${esc(s.id)}">End stream</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No live streams yet.</div>';
    $$('.le', el).forEach(b => b.onclick = async () => { if (!confirm('End this live stream now?')) return; try { await api(`/live/${b.dataset.id}/end`, { method: 'POST' }); toast('Stream ended'); views.live(el); } catch (e) { toast(e.message, true); } });
  },

  async payments(el) {
    const d = await api('/admin/payments');
    el.innerHTML = d.payments.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>User</th><th>Reference</th><th>Points</th><th>Amount</th><th>Channel</th><th>Status</th></tr></thead><tbody>${d.payments.map(p => `<tr><td>${dtime(p.created_at)}</td><td>${esc(p.user && p.user.username)}</td><td>${esc(p.reference)}</td><td>${num(p.points)}</td><td>${kes(p.amount_kes)}</td><td>${esc(p.channel || '')}</td><td>${badge(p.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No payments yet.</div>';
  },

  async withdrawals(el) {
    const d = await api('/admin/withdrawals');
    el.innerHTML = d.withdrawals.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Creator</th><th>Amount</th><th>≈ KES</th><th>Method</th><th>Destination</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${d.withdrawals.map(w => `<tr><td>${dtime(w.created_at)}</td><td>${esc(w.creator && w.creator.username)}</td><td>${usd(w.amount_usd)}</td><td>${kes(w.amount_usd * d.usd_to_kes)}</td><td>${esc(w.method)}</td><td class="wrap">${esc(w.destination)}</td><td>${badge(w.status)}</td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap">${w.status === 'pending' ? `<button class="btn sm wr" data-a="approve" data-id="${esc(w.id)}">Approve</button><button class="btn alt sm wr" data-a="reject" data-id="${esc(w.id)}">Reject</button>` : ''}${w.status === 'approved' ? `<button class="btn sm wr" data-a="paid" data-id="${esc(w.id)}">Mark paid</button><button class="btn alt sm wr" data-a="reject" data-id="${esc(w.id)}">Reject</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>
      <p class="hint">Approve, send the money yourself (M-Pesa or bank), then press "Mark paid". Rejecting returns the held funds to the creator.</p>` : '<div class="empty">No withdrawal requests.</div>';
    $$('.wr', el).forEach(b => b.onclick = async () => {
      let note = null;
      if (b.dataset.a === 'reject') { note = prompt('Reason for rejecting (shown to the creator):'); if (note === null) return; }
      try { await api(`/admin/withdrawals/${b.dataset.id}/review`, { method: 'POST', body: { action: b.dataset.a, note } }); toast('Done'); views.withdrawals(el); } catch (e) { toast(e.message, true); }
    });
  },

  async settings(el) {
    const [s, pk] = await Promise.all([api('/admin/settings'), api('/admin/packages')]);
    el.innerHTML = `<div class="stack" style="max-width:760px"><form class="card" id="sf"><h2 style="margin-top:0">Platform settings</h2>
      <div class="field"><label>Default video unlock price (points)</label><input type="number" min="1" id="s1" value="${esc(s.unlock_price_points)}"></div>
      <div class="field"><label>Creator earning per qualified paid unlock (USD)</label><input type="number" step="0.0001" min="0" id="s2" value="${esc(s.creator_rate_usd)}"></div>
      <div class="field"><label>Minimum withdrawal (USD)</label><input type="number" step="0.01" min="0" id="s3" value="${esc(s.min_withdrawal_usd)}"></div>
      <div class="field"><label>Free preview length (seconds)</label><input type="number" min="1" id="s4" value="${esc(s.preview_seconds)}"><div class="hint">Applies to newly generated preview clips.</div></div>
      <div class="field"><label>New videos</label><select id="s7"><option value="1" ${Number(s.auto_approve) === 1 ? 'selected' : ''}>Go live automatically</option><option value="0" ${Number(s.auto_approve) === 1 ? '' : 'selected'}>Wait for my approval</option></select><div class="hint">Automatic videos go live as soon as their preview clip is ready (about a minute). You can still reject or delete any video.</div></div>
      <div class="field"><label>Videos auto-delete after (hours)</label><input type="number" min="0" id="s6" value="${esc(s.video_lifetime_hours || 0)}"><div class="hint">Counted from when you approve a video. 0 = never delete. Deleted videos free your storage and can't be watched again.</div></div>
      <div class="field"><label>Live: points per minute of watching</label><input type="number" min="1" id="s8" value="${esc(s.live_points_per_minute || 30)}"></div>
      <div class="field"><label>Live: creator earning per paid viewer-minute (USD)</label><input type="number" step="0.0001" min="0" id="s9" value="${esc(s.live_creator_rate_usd || 0.001)}"></div>
      <div class="field"><label>Messages: free viewer replies per conversation</label><input type="number" min="0" id="s10" value="${esc(s.message_free_replies == null ? 2 : s.message_free_replies)}"></div>
      <div class="field"><label>Messages: points per viewer reply after the free ones</label><input type="number" min="1" id="s11" value="${esc(s.message_reply_points || 3)}"></div>
      <div class="field"><label>Reply reward: paid viewer replies needed</label><input type="number" min="0" id="s12" value="${esc(s.reply_batch_size == null ? 10 : s.reply_batch_size)}"><div class="hint">Every this-many paid replies earn the creator the amount below. 0 turns it off. Free replies don't count.</div></div>
      <div class="field"><label>Reply reward: USD per batch</label><input type="number" step="0.001" min="0" id="s13" value="${esc(s.reply_batch_usd == null ? 0.01 : s.reply_batch_usd)}"></div>
      <div class="field"><label>Message picture price (coins the viewer pays to open)</label><input type="number" min="1" id="s14" value="${esc(s.media_image_points == null ? 100 : s.media_image_points)}"></div>
      <div class="field"><label>Message video price (coins)</label><input type="number" min="1" id="s15" value="${esc(s.media_video_points == null ? 100 : s.media_video_points)}"></div>
      <div class="field"><label>Creator earning per opened picture/video (USD)</label><input type="number" step="0.001" min="0.001" id="s16" value="${esc(s.media_creator_rate_usd == null ? 0.002 : s.media_creator_rate_usd)}"></div>
      <div class="field"><label>Delete message pictures/videos after (hours, 0 = keep)</label><input type="number" min="0" id="s17" value="${esc(s.media_lifetime_hours == null ? 24 : s.media_lifetime_hours)}"></div>
      <div class="field"><label>USD → KES rate (for payouts)</label><input type="number" step="0.01" min="1" id="s5" value="${esc(s.usd_to_kes)}"></div>
      <button class="btn">Save settings</button></form>
      <div class="card"><h2 style="margin-top:0">Points packages</h2>
        <div class="tablewrap"><table><thead><tr><th>Name</th><th>Points</th><th>Price (KES)</th><th>Active</th><th></th></tr></thead><tbody>
        ${pk.packages.map(p => `<tr data-id="${esc(p.id)}"><td><input type="text" class="pn" value="${esc(p.name)}" style="width:110px"></td><td><input type="number" class="pp" value="${p.points}" style="width:100px"></td><td><input type="number" class="pc" value="${p.price_kes}" style="width:100px"></td><td><input type="checkbox" class="pa" ${p.active ? 'checked' : ''}></td><td><button class="btn alt sm ps">Save</button></td></tr>`).join('')}</tbody></table></div>
        <form class="row" id="nf" style="margin-top:12px"><input type="text" id="nn" placeholder="Name" style="width:120px"><input type="number" id="np" placeholder="Points" style="width:110px"><input type="number" id="nc" placeholder="Price KES" style="width:110px"><button class="btn sm">Add package</button></form></div></div>`;
    $('#sf').onsubmit = async e => {
      e.preventDefault();
      try { await api('/admin/settings', { method: 'PUT', body: { unlock_price_points: $('#s1').value, creator_rate_usd: $('#s2').value, min_withdrawal_usd: $('#s3').value, preview_seconds: $('#s4').value, usd_to_kes: $('#s5').value, video_lifetime_hours: $('#s6').value, auto_approve: $('#s7').value, live_points_per_minute: $('#s8').value, live_creator_rate_usd: $('#s9').value, message_free_replies: $('#s10').value, message_reply_points: $('#s11').value, reply_batch_size: $('#s12').value, media_image_points: $('#s14').value, media_video_points: $('#s15').value, media_creator_rate_usd: $('#s16').value, media_lifetime_hours: $('#s17').value, reply_batch_usd: $('#s13').value } }); toast('Settings saved'); }
      catch (er) { toast(er.message, true); }
    };
    $$('.ps', el).forEach(b => b.onclick = async () => {
      const tr = b.closest('tr');
      try { await api('/admin/packages/' + tr.dataset.id, { method: 'PUT', body: { name: $('.pn', tr).value, points: $('.pp', tr).value, price_kes: $('.pc', tr).value, active: $('.pa', tr).checked } }); toast('Package saved'); } catch (er) { toast(er.message, true); }
    });
    $('#nf').onsubmit = async e => {
      e.preventDefault();
      try { await api('/admin/packages', { method: 'POST', body: { name: $('#nn').value, points: $('#np').value, price_kes: $('#nc').value, sort: 99 } }); toast('Package added'); views.settings(el); } catch (er) { toast(er.message, true); }
    };
  },

  async reports(el) {
    const d = await api('/admin/reports');
    el.innerHTML = d.reports.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Video</th><th>Reported by</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${d.reports.map(r => `<tr><td>${dtime(r.created_at)}</td><td>${r.video ? `<a href="#/video/${esc(r.video.id)}">${esc(r.video.title)}</a>` : ''}</td><td>${esc(r.reporter && r.reporter.username)}</td><td class="wrap">${esc(r.reason)}</td><td>${badge(r.status)}</td><td>${r.status === 'open' ? `<button class="btn alt sm rs" data-id="${esc(r.id)}">Resolve</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No reports.</div>';
    $$('.rs', el).forEach(b => b.onclick = async () => { try { await api(`/admin/reports/${b.dataset.id}/resolve`, { method: 'POST' }); views.reports(el); } catch (e) { toast(e.message, true); } });
  },

  async audit(el) {
    const d = await api('/admin/audit');
    el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead><tbody>${d.log.map(l => `<tr><td>${dtime(l.created_at)}</td><td>${esc(l.action)}</td><td class="wrap small">${esc(JSON.stringify(l.detail || {}))}</td></tr>`).join('')}</tbody></table></div>`;
  }
};
})();
