/* VIDXX social features: comments, live streaming (LiveKit), messages. */
(() => {
'use strict';
const { S, api, route, esc, num, date, toast, modal, closeModal, loading, errBox, avatarHtml, busy, go, renderTopRight, updateNav, icon, $, $$ } = window.CV;

const attached = el => !!el && document.body.contains(el);
const ago = d => {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return date(d);
};
const nameLink = (u, blank) => u ? `<a href="#/u/${esc(u.username)}" ${blank ? 'target="_blank" rel="noopener"' : ''}><b>${esc(u.username)}</b></a>` : '<b>deleted</b>';

// ---------------------------------------------------------------- comments / live chat
function comments(el, target) {
  const isLive = !!target.stream;
  const qs = isLive ? 'stream=' + encodeURIComponent(target.stream) : 'video=' + encodeURIComponent(target.video);
  el.innerHTML = `<div class="cm ${isLive ? 'cm-live' : ''}">
    ${isLive ? '' : '<h2 style="margin-top:0">Comments</h2>'}
    <div class="cm-list" role="log" aria-live="polite">${loading}</div>
    <form class="cm-form" novalidate><input type="text" maxlength="300" placeholder="${isLive ? 'Say something…' : 'Add a comment…'}" aria-label="${isLive ? 'Chat message' : 'Comment'}" autocomplete="off"><button class="btn sm">Send</button></form></div>`;
  const list = $('.cm-list', el), form = $('.cm-form', el), input = $('input', form), send = $('button', form);
  const seen = new Set();
  let lastId = 0, stopped = false;

  const item = c => `<div class="cm-item" data-id="${c.id}">${avatarHtml(c.user && c.user.username, c.user && c.user.avatar)}
    <div class="cm-body"><div>${nameLink(c.user, isLive)}${c.user && c.user.account_type === 'curator' ? ' <span class="badge ok">Creator</span>' : ''} <span class="muted small">${ago(c.created_at)}</span></div>
    <div class="cm-text">${esc(c.body)}</div></div>
    ${c.can_delete ? `<button type="button" class="btn ghost sm cm-del" data-id="${c.id}" aria-label="Delete comment">✕</button>` : ''}</div>`;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const add = (c, atTop) => {
    if (seen.has(c.id)) return;
    seen.add(c.id); lastId = Math.max(lastId, c.id);
    const stick = isLive && nearBottom();
    if (list.querySelector('.cm-empty')) list.innerHTML = '';
    list.insertAdjacentHTML(atTop ? 'afterbegin' : 'beforeend', item(c));
    if (isLive) { while (list.children.length > 200) list.removeChild(list.firstChild); if (stick) list.scrollTop = list.scrollHeight; }
  };
  const empty = () => { if (!list.children.length) list.innerHTML = `<div class="cm-empty muted small">${isLive ? 'No messages yet. Say hi!' : 'No comments yet. Be the first.'}</div>`; };

  (async () => {
    try {
      const d = await api('/comments?' + qs);
      list.innerHTML = '';
      const rows = d.order === 'desc' && isLive ? d.comments.slice().reverse() : d.comments;
      rows.forEach(c => add(c, false));
      empty();
      if (isLive) list.scrollTop = list.scrollHeight;
    } catch (e) { list.innerHTML = `<div class="cm-empty muted small">${esc(e.message)}</div>`; }
    if (isLive) {
      const t = setInterval(async () => {
        if (stopped || !attached(el)) return clearInterval(t);
        try {
          const d = await api('/comments?' + qs + '&after=' + lastId);
          d.comments.forEach(c => add(c, false));
          if (d.ended) clearInterval(t);
        } catch (e) { if (e.status === 403 || e.status === 404) clearInterval(t); }
      }, 3000);
    }
  })();

  form.onsubmit = async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      const d = await api('/comments', { method: 'POST', body: { ...target, body } });
      input.value = '';
      add(d.comment, !isLive);
      if (isLive) list.scrollTop = list.scrollHeight;
    } catch (er) { toast(er.message, true); }
    send.disabled = false; input.focus();
  };
  list.onclick = async e => {
    const b = e.target.closest('.cm-del'); if (!b) return;
    try { await api('/comments/' + b.dataset.id, { method: 'DELETE' }); const n = b.closest('.cm-item'); n && n.remove(); empty(); }
    catch (er) { toast(er.message, true); }
  };
  return { stop() { stopped = true; } };
}

// ---------------------------------------------------------------- live: list
function liveCard(s) {
  return `<a class="vcard" href="#/live/${esc(s.id)}">
    <div class="th live-th">${avatarHtml(s.host && s.host.username, s.host && s.host.avatar, 'lg')}<span class="tag live">● LIVE</span><span class="tag right">${num(s.viewers)} watching</span></div>
    <div class="bd"><div class="t">${esc(s.title)}</div><div class="owner">${avatarHtml(s.host && s.host.username, s.host && s.host.avatar)}<span>${esc(s.host && s.host.username)}</span></div></div></a>`;
}
function liveList(el) {
  const token = String(Math.random());
  el.dataset.live = token;
  el.innerHTML = loading;
  const draw = async first => {
    try {
      const d = await api('/live');
      if (el.dataset.live !== token || !attached(el)) return;
      el.innerHTML = d.streams.length
        ? `<p class="muted small" style="margin-top:0">Watching live costs ${num(d.price)} points per minute.</p><div class="grid">${d.streams.map(liveCard).join('')}</div>`
        : '<div class="empty">No one is live right now. Check back soon.</div>';
    } catch (e) { if (first) el.innerHTML = errBox(e.message); }
  };
  draw(true).then(() => {
    const t = setInterval(() => { if (el.dataset.live !== token || !attached(el)) return clearInterval(t); draw(false); }, 10000);
  });
}

// ---------------------------------------------------------------- live: LiveKit client loader
let lkLoad = null;
function loadLivekit() {
  if (window.LivekitClient) return Promise.resolve();
  if (lkLoad) return lkLoad;
  lkLoad = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2.9.0/dist/livekit-client.umd.js';
    sc.onload = resolve;
    sc.onerror = () => { lkLoad = null; reject(new Error('Could not load the live video player. Check your connection and try again.')); };
    document.head.appendChild(sc);
  });
  return lkLoad;
}

// ---------------------------------------------------------------- live: viewer page
route('live', null, async ({ root, args }) => {
  const id = args[0];
  const info = await api('/live/' + encodeURIComponent(id));
  if (info.is_host) { go('golive'); return; }
  const me = S.me;
  root.innerHTML = `<div class="stack"><a class="btn ghost sm" href="#/explore?tab=live" style="padding-left:0">← Back</a>
    <div class="player live-stage" id="stage"><div id="media"></div><div class="overlay" id="lov"></div></div>
    <div class="live-bar" id="bar" hidden><span class="live-dot">● LIVE</span><span id="lb-bal"></span><span id="lb-next" class="muted small"></span><button class="btn alt sm" id="leave" style="margin-left:auto">Leave</button></div>
    <div><h1 style="margin-bottom:4px">${esc(info.title)}</h1>
      <div class="row between"><a class="owner" href="#/u/${esc(info.host && info.host.username)}" style="margin:0">${avatarHtml(info.host && info.host.username, info.host && info.host.avatar)}<b style="color:var(--ink);font-size:.95rem">${esc(info.host && info.host.username)}</b></a>
      <span class="muted small" id="vc">${info.status === 'live' ? num(info.viewers) + ' watching' : 'Ended'}</span></div></div>
    <div id="chat"></div></div>`;
  const stage = $('#stage'), media = $('#media'), lov = $('#lov'), bar = $('#bar');
  const price = info.price;
  let room = null, hbTimer = null, tickTimer = null, paidUntil = 0, left = false, chatBox = null;

  const overlay = html => { lov.innerHTML = html; lov.hidden = false; };
  const stopAll = (sendLeave) => {
    clearInterval(hbTimer); clearInterval(tickTimer);
    if (room) { const r = room; room = null; try { r.disconnect(); } catch (_) {} }
    if (sendLeave && S.me) api('/live/' + encodeURIComponent(id) + '/leave', { method: 'POST' }).catch(() => {});
    bar.hidden = true;
  };
  const setBalance = b => { if (b == null) return; S.me.points_balance = b; renderTopRight(); const e = $('#lb-bal'); if (e) e.textContent = num(b) + ' pts'; };

  const pre = () => {
    stopAll(false);
    media.innerHTML = '';
    if (info.status !== 'live') return overlay('<div><h2>This live has ended</h2><p>Look for another one in the Live tab.</p><a class="btn" href="#/explore?tab=live">See live streams</a></div>');
    if (!me) return overlay(`<div><h2>Log in to watch</h2><p>Live costs ${num(price)} points per minute.</p><div class="row" style="justify-content:center"><a class="btn" href="#/login">Log in</a><a class="btn alt" href="#/register?type=viewer">Join as a Viewer</a></div></div>`);
    if (me.account_type !== 'viewer') return overlay('<div><h2>Viewers only</h2><p>Admins can end streams from Admin → Live.</p></div>');
    const enough = me.points_balance >= price;
    overlay(`<div>${icon('live', 'lock')}<h2>${esc(info.title)}</h2>
      <p>Watching costs <b>${num(price)} points per minute</b>, charged while you watch. Leave any time.</p>
      ${enough ? `<button class="btn" id="join">Watch live · ${num(price)} pts/min</button>` : `<a class="btn" href="#/buy">Buy Points to watch</a>`}
      <p class="small">Your balance: ${num(me.points_balance)} pts</p></div>`);
    const jb = $('#join'); if (jb) jb.onclick = () => join(jb);
  };

  const showEnded = () => { stopAll(false); overlay('<div><h2>This live has ended</h2><a class="btn" href="#/explore?tab=live">See live streams</a></div>'); };
  const showOut = () => { stopAll(false); overlay(`<div><h2>Out of points</h2><p>You need ${num(price)} points for the next minute.</p><a class="btn" href="#/buy">Buy Points</a><p class="small">Your balance: ${num(me.points_balance)} pts</p></div>`); };

  const tick = () => {
    const e = $('#lb-next'); if (!e) return;
    const s = Math.max(0, Math.ceil((paidUntil - Date.now()) / 1000));
    e.textContent = `· next ${num(price)} pts in ${s}s`;
  };
  const heartbeat = async () => {
    try {
      const d = await api('/live/' + encodeURIComponent(id) + '/heartbeat', { method: 'POST' });
      paidUntil = new Date(d.paid_until).getTime(); setBalance(d.balance);
    } catch (e) {
      if (e.status === 402) { if (e.data && e.data.balance != null) me.points_balance = e.data.balance; showOut(); }
      else if (e.status === 410) showEnded();
      /* other errors: network blip, the next beat retries */
    }
  };

  const connect = async r => {
    const LK = window.LivekitClient;
    left = false;
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    room.on(LK.RoomEvent.TrackSubscribed, track => {
      if (track.kind !== 'video' && track.kind !== 'audio') return;
      const el = track.attach();
      if (track.kind === 'video') { el.setAttribute('playsinline', ''); el.className = 'live-video'; lov.hidden = true; }
      media.appendChild(el);
    });
    room.on(LK.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(e => e.remove()));
    room.on(LK.RoomEvent.ParticipantDisconnected, () => { if (room && room.remoteParticipants.size === 0) overlay('<div><h2>The host left</h2><p>The stream may be back in a moment, or it has ended.</p></div>'); });
    room.on(LK.RoomEvent.Disconnected, () => {
      if (left || !room) return;
      overlay('<div><h2>Connection lost</h2><p>Check your internet and rejoin. You won\'t be charged again for the minute you already paid.</p><button class="btn" id="rejoin">Rejoin</button></div>');
      const rj = $('#rejoin'); if (rj) rj.onclick = () => join(rj);
    });
    await room.connect(r.url, r.token);
    try { await room.startAudio(); } catch (_) { /* needs a tap on some browsers; the join click normally covers it */ }
    if (room.remoteParticipants.size === 0) overlay('<div><div class="spin"></div><h2>Waiting for the host\'s video…</h2></div>');
  };

  const join = async btn => {
    busy(btn, true, 'Joining…');
    try {
      await loadLivekit();                       // load the player first so a failure never costs points
      const r = await api('/live/' + encodeURIComponent(id) + '/watch', { method: 'POST' });
      setBalance(r.balance); paidUntil = new Date(r.paid_until).getTime();
      try { await connect(r); }
      catch (e) { stopAll(false); overlay(`<div><h2>Couldn't connect</h2><p>${esc(e.message || 'Please try again.')}</p><button class="btn" id="retry">Try again</button></div>`); $('#retry').onclick = () => join($('#retry')); return; }
      bar.hidden = false; $('#lb-bal').textContent = num(me.points_balance) + ' pts'; tick();
      clearInterval(hbTimer); clearInterval(tickTimer);
      hbTimer = setInterval(() => { if (!attached(stage)) return stopAll(true); heartbeat(); }, 15000);
      tickTimer = setInterval(() => { if (!attached(stage)) return clearInterval(tickTimer); tick(); }, 1000);
      if (!chatBox) chatBox = comments($('#chat'), { stream: id });
    } catch (e) {
      if (e.status === 402) { if (e.data && e.data.balance != null) me.points_balance = e.data.balance; showOut(); }
      else if (e.status === 410) showEnded();
      else { toast(e.message, true); busy(btn, false); }
    }
  };
  $('#leave').onclick = () => { left = true; stopAll(true); chatBox && chatBox.stop(); chatBox = null; $('#chat').innerHTML = ''; pre(); };
  pre();
});

// ---------------------------------------------------------------- live: host page (curators)
route('golive', ['curator'], async ({ root }) => {
  const m = await api('/live/mine');
  if (!m.configured) {
    root.innerHTML = '<div class="notice warn">Live streaming isn\'t switched on yet. The site owner needs to finish the live setup.</div>';
    return;
  }
  const setup = () => {
    root.innerHTML = `<div class="stack" style="max-width:560px"><h1>Go live</h1>
      ${m.stream ? `<div class="notice warn"><b>You already have a live running:</b> ${esc(m.stream.title)}<div class="row" style="margin-top:10px"><button class="btn sm" id="resume">Continue streaming</button><button class="btn alt sm" id="endold">End it</button></div></div>` : ''}
      <form class="card stack" id="gf" novalidate>
        <div class="field"><label for="gt">Title</label><input type="text" id="gt" maxlength="80" placeholder="What's your live about?"></div>
        <div id="gerr"></div>
        <button class="btn block" id="gsub">${m.stream ? 'End the old one and start new' : 'Go live'}</button>
        <p class="hint">You stream from this page, using your phone or computer camera and microphone, so keep it open. Viewers pay points for every minute they watch, and you earn for each paid viewer-minute. Adults only, follow the <a href="#/guidelines" target="_blank">content guidelines</a>.</p>
      </form></div>`;
    const start = async resume => {
      const d = await api('/live/start', { method: 'POST', body: { title: $('#gt').value, resume: !!resume } });
      host(d);
    };
    $('#gf').onsubmit = async e => {
      e.preventDefault();
      busy($('#gsub'), true, 'Starting…');
      try { await start(false); } catch (er) { $('#gerr').innerHTML = errBox(er.message); busy($('#gsub'), false); }
    };
    const rs = $('#resume'); if (rs) rs.onclick = async () => { try { await start(true); } catch (er) { toast(er.message, true); } };
    const eo = $('#endold'); if (eo) eo.onclick = async () => { try { await api('/live/' + m.stream.id + '/end', { method: 'POST' }); m.stream = null; setup(); } catch (er) { toast(er.message, true); } };
  };

  const host = d => {
    const sid = d.stream.id;
    root.innerHTML = `<div class="stack"><div><h1 style="margin-bottom:2px">You're live</h1><div class="muted">${esc(d.stream.title)}</div></div>
      <div class="player live-stage"><div id="media"></div><div class="overlay" id="hov"><div><div class="spin"></div><h2>Starting your camera…</h2><p>Allow camera and microphone access if your browser asks.</p></div></div></div>
      <div class="live-bar"><span class="live-dot">● LIVE</span><span id="hv">0 watching</span><span style="margin-left:auto" class="row"><button class="btn alt sm" id="flip">Switch camera</button><button class="btn bad sm" id="endlive">End live</button></span></div>
      <div id="chat"></div></div>`;
    const media = $('#media'), hov = $('#hov');
    let room = null, pingTimer = null, over = false;
    const finish = (msg) => {
      over = true; clearInterval(pingTimer);
      if (room) { try { room.disconnect(); } catch (_) {} room = null; }
      root.innerHTML = `<div class="card stack center" style="max-width:480px;margin:30px auto"><h1>${esc(msg)}</h1><p class="muted">Your earnings from this live are in your dashboard.</p><div class="row" style="justify-content:center"><a class="btn" href="#/dashboard">Dashboard</a><a class="btn alt" href="#/golive">Go live again</a></div></div>`;
    };
    (async () => {
      try {
        await loadLivekit();
        const LK = window.LivekitClient;
        room = new LK.Room({ adaptiveStream: true, dynacast: true });
        room.on(LK.RoomEvent.Disconnected, () => { if (!over && attached(media)) { hov.hidden = false; hov.innerHTML = '<div><h2>Connection lost</h2><p>Check your internet, then reload this page and choose Continue streaming.</p></div>'; } });
        await room.connect(d.url, d.token);
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
        if (pub && pub.track) { const el = pub.track.attach(); el.muted = true; el.setAttribute('playsinline', ''); el.className = 'live-video'; media.appendChild(el); }
        hov.hidden = true;
      } catch (e) {
        const denied = /permission|denied|NotAllowed/i.test(String(e && (e.name + ' ' + e.message)));
        hov.hidden = false;
        hov.innerHTML = `<div><h2>Couldn't start</h2><p>${denied ? 'Allow camera and microphone access in your browser, then try again.' : esc(e.message || 'Something went wrong.')}</p><button class="btn" id="again">Try again</button></div>`;
        const ag = $('#again'); if (ag) ag.onclick = () => host(d);
      }
    })();
    pingTimer = setInterval(async () => {
      if (!attached(media)) { clearInterval(pingTimer); if (room) { try { room.disconnect(); } catch (_) {} room = null; } return; }
      try { const r = await api('/live/' + sid + '/ping', { method: 'POST' }); $('#hv').textContent = num(r.viewers) + ' watching'; }
      catch (e) { if (e.status === 410) finish('This live has ended'); }
    }, 25000);
    $('#flip').onclick = async () => {
      try {
        const devs = await window.LivekitClient.Room.getLocalDevices('videoinput');
        if (devs.length < 2) return toast('No other camera found');
        const cur = room.getActiveDevice('videoinput');
        const i = devs.findIndex(x => x.deviceId === cur);
        await room.switchActiveDevice('videoinput', devs[(i + 1) % devs.length].deviceId);
      } catch (e) { toast('Could not switch camera', true); }
    };
    $('#endlive').onclick = () => {
      const box = modal('<h2 style="margin-top:0">End this live?</h2><p class="muted">Everyone watching will be disconnected.</p><div class="row"><button class="btn bad" id="y">End live</button><button class="btn alt" id="n">Keep going</button></div>');
      $('#n', box).onclick = closeModal;
      $('#y', box).onclick = async () => { try { await api('/live/' + sid + '/end', { method: 'POST' }); closeModal(); finish('Live ended'); } catch (e) { toast(e.message, true); } };
    };
    comments($('#chat'), { stream: sid });
  };
  setup();
});

// ---------------------------------------------------------------- messages
function composeMessage(username) {
  const box = modal(`<h2 style="margin-top:0">New message</h2>
    <div class="field"><label for="mu">Viewer's username</label><input type="text" id="mu" value="${esc(username || '')}" ${username ? 'readonly' : ''} autocomplete="off"></div>
    <div class="field"><label for="mb">Message</label><textarea id="mb" rows="4" maxlength="1000"></textarea><div class="hint">Free for you to send. The viewer's first replies are free for them too.</div></div>
    <div id="merr"></div><div class="row"><button class="btn" id="ms">Send</button><button class="btn alt" id="mc">Cancel</button></div>`);
  $('#mc', box).onclick = closeModal;
  $('#ms', box).onclick = async () => {
    busy($('#ms', box), true, 'Sending…');
    try {
      const r = await api('/messages/send', { method: 'POST', body: { username: $('#mu', box).value, body: $('#mb', box).value } });
      closeModal(); toast('Message sent'); go('messages/' + r.conversation_id);
    } catch (e) { $('#merr', box).innerHTML = errBox(e.message); busy($('#ms', box), false); }
  };
}

route('messages', ['viewer', 'curator'], async ({ root, args }) => {
  if (args[0]) return thread(root, args[0]);
  const isCur = S.me.account_type === 'curator';
  const d = await api('/conversations');
  root.innerHTML = `<div class="stack"><div class="row between"><h1 style="margin:0">Messages</h1>${isCur ? '<button class="btn sm" id="newmsg">New message</button>' : ''}</div>
    ${isCur ? `<p class="muted small" style="margin:0">You can message any viewer for free. Find a viewer by username, or tap Message on their profile. You also earn $${d.reply_batch_usd} for every ${d.reply_batch_size} paid replies from viewers.</p>`
      : `<p class="muted small" style="margin:0">Creators can message you for free. Your first ${d.free_replies} ${d.free_replies === 1 ? 'reply' : 'replies'} in each conversation are free, then each reply costs ${d.reply_cost} points.</p>`}
    <div id="inbox">${d.conversations.length ? d.conversations.map(c => `<a class="card msg-row" href="#/messages/${esc(c.id)}">${avatarHtml(c.other.username, c.other.avatar)}
      <div style="min-width:0;flex:1"><div class="row between" style="flex-wrap:nowrap"><b>${esc(c.other.username)}</b><span class="muted small">${ago(c.last_at)}</span></div>
      <div class="muted small msg-last">${esc(c.last_body || '')}</div></div>${c.unread ? `<b class="dot" style="position:static">${c.unread > 9 ? '9+' : c.unread}</b>` : ''}</a>`).join('')
      : `<div class="empty">No messages yet.${isCur ? '' : ' When a creator writes to you, it will show up here.'}</div>`}</div></div>`;
  const nb = $('#newmsg'); if (nb) nb.onclick = () => composeMessage('');
});

async function thread(root, convId) {
  const first = await api('/conversations/' + encodeURIComponent(convId) + '/messages');
  const isViewer = S.me.account_type === 'viewer';
  let meta = first, lastId = 0;
  root.innerHTML = `<div class="stack thread"><div class="row between"><div class="row" style="flex-wrap:nowrap"><a class="btn ghost sm" href="#/messages" style="padding-left:0">←</a>${avatarHtml(meta.other.username, meta.other.avatar)}<a href="#/u/${esc(meta.other.username)}"><b>${esc(meta.other.username)}</b></a></div>
      ${isViewer ? '<button class="btn alt sm" id="blk"></button>' : ''}</div>
    <div class="msg-list" id="ml" role="log" aria-live="polite"></div>
    <div id="composer"></div></div>`;
  const ml = $('#ml');
  const bubble = m => `<div class="bubble ${m.mine ? 'mine' : ''}" data-id="${m.id}"><div>${esc(m.body)}</div><div class="bmeta">${ago(m.created_at)}${m.mine && m.cost ? ` · −${m.cost} pts` : ''}</div></div>`;
  const addMsgs = list => {
    if (!list.length) return;
    const stick = ml.scrollHeight - ml.scrollTop - ml.clientHeight < 80 || !lastId;
    list.forEach(m => { if (m.id > lastId) { ml.insertAdjacentHTML('beforeend', bubble(m)); lastId = m.id; } });
    if (stick) ml.scrollTop = ml.scrollHeight;
  };
  const hint = () => {
    if (!isViewer) return '';
    return meta.free_left > 0
      ? `${meta.free_left} free ${meta.free_left === 1 ? 'reply' : 'replies'} left, then ${meta.reply_cost} points each`
      : `Each reply costs ${meta.reply_cost} points · Balance ${num(S.me.points_balance)} pts`;
  };
  const drawComposer = () => {
    const c = $('#composer');
    const blk = $('#blk'); if (blk) blk.textContent = meta.blocked ? 'Unblock' : 'Block';
    if (meta.blocked) {
      c.innerHTML = isViewer ? '<div class="notice warn">You blocked this creator. Unblock to reply.</div>' : '<div class="notice warn">This viewer has blocked messages from you.</div>';
      return;
    }
    c.innerHTML = `<form class="cm-form" id="mf" novalidate><input type="text" id="mi" maxlength="1000" placeholder="Write a message…" aria-label="Message" autocomplete="off"><button class="btn sm" id="msend">Send</button></form>
      <div class="hint" id="mh">${esc(hint())}</div><div id="merr2"></div>`;
    $('#mf').onsubmit = async e => {
      e.preventDefault();
      const body = $('#mi').value.trim(); if (!body) return;
      $('#msend').disabled = true;
      try {
        const r = await api('/conversations/' + encodeURIComponent(convId) + '/messages', { method: 'POST', body: { body } });
        $('#mi').value = ''; $('#merr2').innerHTML = '';
        if (isViewer) { meta.free_left = r.free_left; if (r.balance != null) { S.me.points_balance = r.balance; renderTopRight(); } $('#mh').textContent = hint(); }
        await poll();
      } catch (er) {
        $('#merr2').innerHTML = er.status === 402 ? `<div class="notice bad">${esc(er.message)} <a href="#/buy">Buy Points</a></div>` : errBox(er.message);
      }
      const sb = $('#msend'); if (sb) sb.disabled = false;
    };
  };
  const poll = async () => {
    const d = await api('/conversations/' + encodeURIComponent(convId) + '/messages?after=' + lastId);
    const changed = d.blocked !== meta.blocked;
    meta = d;
    addMsgs(d.messages);
    if (changed) drawComposer();
  };
  addMsgs(first.messages); drawComposer();
  const blk = $('#blk');
  if (blk) blk.onclick = async () => {
    try { await api('/conversations/' + encodeURIComponent(convId) + '/block', { method: 'POST', body: { blocked: !meta.blocked } }); meta.blocked = !meta.blocked; drawComposer(); }
    catch (e) { toast(e.message, true); }
  };
  refreshUnread(true);
  const t = setInterval(() => { if (!attached(ml)) return clearInterval(t); poll().catch(() => {}); }, 5000);
}

// ---------------------------------------------------------------- unread badge
let lastUnreadCheck = 0;
async function refreshUnread(force) {
  if (!S.me || !['viewer', 'curator'].includes(S.me.account_type)) { if (S.unread) { S.unread = 0; updateNav(); } return; }
  if (!force && Date.now() - lastUnreadCheck < 8000) return;
  lastUnreadCheck = Date.now();
  try { const d = await api('/messages/unread'); if (d.unread !== S.unread) { S.unread = d.unread; updateNav(); } } catch (_) { /* ignore */ }
}
window.addEventListener('hashchange', () => refreshUnread(false));
setInterval(() => refreshUnread(true), 30000);
window.addEventListener('DOMContentLoaded', () => setTimeout(() => refreshUnread(true), 1500));

Object.assign(window.CV, { comments, liveList, composeMessage });
})();
