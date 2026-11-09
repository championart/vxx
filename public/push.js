/* VIDXX web push: enable/disable notifications on this device. */
(() => {
'use strict';
const { S, api, esc, toast, $, $$ } = window.CV;

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const b64ToU8 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };

let regP = null;
function register() {
  if (!supported()) return Promise.resolve(null);
  if (!regP) regP = navigator.serviceWorker.register('sw.js').catch(() => null);
  return regP;
}
window.addEventListener('load', () => { register(); });

async function currentSub() {
  const reg = await register(); if (!reg) return null;
  return reg.pushManager.getSubscription();
}
async function enable() {
  if (!supported()) throw new Error('This browser does not support notifications.');
  if (isIOS() && !standalone()) throw new Error('On iPhone, first tap Share, then "Add to Home Screen", and open VIDXX from there.');
  const k = await api('/push/key');
  if (!k.publicKey) throw new Error('Notifications are not set up on the server yet.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings for this site.');
  const reg = await register(); if (!reg) throw new Error('Could not start the notification service.');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(k.publicKey) });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  try { localStorage.setItem('cv_push_off', '0'); } catch (_) {}
}
async function disable() {
  const sub = await currentSub();
  if (sub) { try { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch (_) {} await sub.unsubscribe().catch(() => {}); }
}

// Card for the Profile page
async function pushControls(el) {
  if (!el) return;
  if (!supported()) { el.innerHTML = '<div class="notice">Notifications are not supported in this browser.</div>'; return; }
  const draw = async () => {
    const sub = await currentSub();
    const on = !!sub && Notification.permission === 'granted';
    const denied = Notification.permission === 'denied';
    el.innerHTML = `<div class="card"><div class="row between" style="flex-wrap:nowrap;gap:12px"><div><b>Notifications</b><div class="small muted">${on ? 'On for this device. You get alerts for new messages' + (S.me && S.me.account_type === 'viewer' ? ' and when creators you follow go live.' : '.') : denied ? 'Blocked in your browser settings.' : 'Get alerts for new messages' + (S.me && S.me.account_type === 'viewer' ? ' and when creators you follow go live.' : '.')}${isIOS() && !standalone() ? ' On iPhone, add VIDXX to your Home Screen first.' : ''}</div></div>
      <button class="btn sm ${on ? 'alt' : ''}" id="pushbtn" ${denied ? 'disabled' : ''}>${on ? 'Turn off' : 'Turn on'}</button></div></div>`;
    $('#pushbtn', el).onclick = async e => {
      e.target.disabled = true;
      try { on ? await disable() : await enable(); toast(on ? 'Notifications off' : 'Notifications on'); }
      catch (er) { toast(er.message, true); }
      draw();
    };
  };
  await draw();
}

// One-time banner (Explore / Messages)
async function pushBanner(el) {
  if (!el || !S.me || !['viewer', 'curator'].includes(S.me.account_type) || !supported()) return;
  try { if (localStorage.getItem('cv_push_banner') === '1') return; } catch (_) {}
  if (Notification.permission !== 'default') return;
  if (isIOS() && !standalone()) return;
  const k = await api('/push/key').catch(() => ({}));
  if (!k.publicKey || !el.isConnected) return;
  const b = document.createElement('div');
  b.className = 'notice';
  b.innerHTML = `<div class="row between" style="gap:10px"><span>Get notified about new messages${S.me.account_type === 'viewer' ? ' and when creators you follow go live' : ''}.</span><span class="row" style="gap:6px"><button class="btn sm" id="pb-on">Turn on</button><button class="btn alt sm" id="pb-no">Not now</button></span></div>`;
  el.prepend(b);
  const done = () => { try { localStorage.setItem('cv_push_banner', '1'); } catch (_) {} b.remove(); };
  $('#pb-no', b).onclick = done;
  $('#pb-on', b).onclick = async () => { try { await enable(); toast('Notifications on'); } catch (e) { toast(e.message, true); } done(); };
}

Object.assign(window.CV, { pushControls, pushBanner });
})();
