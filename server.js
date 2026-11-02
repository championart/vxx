require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) { /* optional */ }

const {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  PAYSTACK_SECRET_KEY, PAYSTACK_CHANNELS, APP_URL, FRONTEND_ORIGIN,
  PORT = 3000, ALLOW_UNSECURED_PREVIEW
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, clientOpts);
const anonClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOpts);

const CATEGORIES = ['General', 'Comedy', 'Music', 'Dance', 'Education', 'Lifestyle', 'Fashion', 'Fitness', 'Cooking', 'Travel', 'Gaming', 'Other'];
const GENDERS = ['female', 'male', 'transgender'];

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(cors(FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN.split(',') } : {}));

// ---------- helpers ----------
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUrl = (bucket, p) => (p ? `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${p}` : null);
const avatarOf = p => publicUrl('avatars', p.avatar_url);
const shapeProfile = p => ({
  id: p.id, username: p.username, gender: p.gender, account_type: p.account_type,
  avatar: avatarOf(p), created_at: p.created_at, status: p.status
});
async function getSettings() {
  const { data } = await db.from('settings').select('key,value');
  const o = {};
  (data || []).forEach(r => { o[r.key] = r.value; });
  return o;
}
async function audit(actor, action, detail) {
  await db.from('audit_log').insert({ actor_id: actor || null, action, detail: detail || null });
}
async function signed(bucket, p, secs) {
  const { data, error } = await db.storage.from(bucket).createSignedUrl(p, secs);
  if (error) throw new Error('Could not sign URL: ' + error.message);
  return data.signedUrl;
}
function parseImage(dataUrl, maxBytes) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return null;
  return { mime: m[1], buf };
}
async function saveAvatar(uid, dataUrl) {
  const img = parseImage(dataUrl, 1.5 * 1024 * 1024);
  if (!img) return null;
  const p = `${uid}.${img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg'}`;
  const { error } = await db.storage.from('avatars').upload(p, img.buf, { contentType: img.mime, upsert: true });
  if (error) throw new Error('Avatar upload failed: ' + error.message);
  return p;
}
const cleanQ = s => String(s || '').replace(/[^\w\s-]/g, '').trim().slice(0, 40);

// ---------- auth middleware ----------
async function loadUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return { error: 'Session expired' };
  const { data: p } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!p) return { error: 'Profile missing' };
  return { user: data.user, profile: p };
}
const auth = wrap(async (req, res, next) => {
  const r = await loadUser(req);
  if (!r) return res.status(401).json({ error: 'Please log in' });
  if (r.error) return res.status(401).json({ error: r.error });
  if (r.profile.status !== 'active') return res.status(403).json({ error: `Your account is ${r.profile.status}. Contact support.` });
  req.user = r.user; req.profile = r.profile;
  next();
});
const optionalAuth = wrap(async (req, res, next) => {
  const r = await loadUser(req);
  if (r && r.profile && r.profile.status === 'active') { req.user = r.user; req.profile = r.profile; }
  next();
});
const role = (...roles) => (req, res, next) =>
  roles.includes(req.profile.account_type) ? next() : res.status(403).json({ error: 'Not available for your account type' });

// ---------- Paystack ----------
async function paystack(method, endpoint, body) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('Paystack is not configured');
  const r = await fetch('https://api.paystack.co' + endpoint, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}
// Always confirm with Paystack server-side; never trust the browser or the webhook body alone.
async function verifyAndCredit(reference) {
  const v = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  if (!v.status || !v.data) return 'verify_failed';
  const d = v.data;
  if (d.status === 'success' && d.currency === 'KES') {
    const { data, error } = await db.rpc('credit_payment', {
      p_reference: reference, p_channel: d.channel || null, p_amount_kes: Math.floor(d.amount / 100)
    });
    if (error) throw new Error(error.message);
    return data;
  }
  if (d.status === 'failed' || d.status === 'abandoned') {
    await db.from('payments').update({ status: 'failed' }).eq('reference', reference).eq('status', 'pending');
    return 'failed';
  }
  return 'pending';
}

// Webhook must see the raw body, so it is mounted before express.json()
app.post('/api/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  if (!PAYSTACK_SECRET_KEY || !sig) return res.sendStatus(400);
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  let evt;
  try { evt = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (evt.event === 'charge.success' && evt.data && evt.data.reference) {
    try { await verifyAndCredit(evt.data.reference); } catch (e) { console.error('webhook credit error', e.message); return res.sendStatus(500); }
  }
  res.sendStatus(200);
}));

app.use(express.json({ limit: '3mb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts. Try again later.' } });

// ---------- public ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, categories: CATEGORIES }));
app.get('/api/packages', wrap(async (req, res) => {
  const { data } = await db.from('point_packages').select('id,name,points,price_kes').eq('active', true).order('sort');
  const s = await getSettings();
  res.json({ packages: data || [], unlock_price: Number(s.unlock_price_points) });
}));

// ---------- auth ----------
app.post('/api/register', authLimiter, wrap(async (req, res) => {
  const { username, email, password, gender, account_type, avatar, adult } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!GENDERS.includes(gender)) return res.status(400).json({ error: 'Select a gender' });
  if (!['curator', 'viewer'].includes(account_type)) return res.status(400).json({ error: 'Select an account type' });
  if (adult !== true) return res.status(400).json({ error: 'You must confirm you are 18 or older' });
  if (gender === 'female' && account_type === 'curator' && !avatar) return res.status(400).json({ error: 'A profile picture is required for female curators' });

  const { data: taken } = await db.from('profiles').select('id').ilike('username', username).maybeSingle();
  if (taken) return res.status(409).json({ error: 'That username is taken' });

  const { data, error } = await anonClient().auth.signUp({
    email, password, options: { emailRedirectTo: APP_URL || undefined }
  });
  if (error) return res.status(400).json({ error: error.message });
  const u = data.user;
  if (!u || (u.identities && u.identities.length === 0)) return res.status(409).json({ error: 'That email is already registered' });

  let avatarPath = null, avatarErr = null;
  try { if (avatar) avatarPath = await saveAvatar(u.id, avatar); } catch (e) { avatarErr = e.message; console.error('avatar save failed:', e.message); }
  if (avatar && !avatarPath && gender === 'female' && account_type === 'curator') {
    await db.auth.admin.deleteUser(u.id);
    return res.status(avatarErr ? 500 : 400).json({ error: avatarErr ? 'Could not save your profile picture (' + avatarErr + '). Please try again.' : 'Profile picture invalid (use JPG/PNG/WebP under 1.5MB)' });
  }
  const { error: pe } = await db.from('profiles').insert({
    id: u.id, username, gender, account_type, avatar_url: avatarPath, is_adult_confirmed: true
  });
  if (pe) {
    console.error('profile insert failed:', pe.code, pe.message);
    await db.auth.admin.deleteUser(u.id);
    return res.status(pe.code === '23505' ? 409 : 500).json({ error: pe.code === '23505' ? 'That username is taken' : 'Could not create profile' });
  }
  await audit(u.id, 'registered', { account_type, gender });
  res.json({ ok: true, needs_verification: !data.session });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { data, error } = await anonClient().auth.signInWithPassword({ email: String(email || ''), password: String(password || '') });
  if (error || !data.session) {
    const msg = /confirm/i.test(error && error.message) ? 'Please verify your email first (check your inbox)' : 'Wrong email or password';
    return res.status(401).json({ error: msg });
  }
  const { data: p } = await db.from('profiles').select('status').eq('id', data.user.id).maybeSingle();
  if (!p) return res.status(403).json({ error: 'Account setup incomplete' });
  if (p.status !== 'active') return res.status(403).json({ error: `Your account is ${p.status}` });
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: String((req.body || {}).refresh_token || '') });
  if (error || !data.session) return res.status(401).json({ error: 'Session expired' });
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const p = req.profile;
  const out = { ...shapeProfile(p), email: req.user.email };
  if (p.account_type === 'viewer') out.points_balance = p.points_balance;
  if (p.account_type === 'curator') {
    const { data } = await db.rpc('creator_balance', { p_creator: p.id });
    out.balance = data;
  }
  res.json(out);
}));

app.put('/api/me/avatar', auth, wrap(async (req, res) => {
  const path_ = await saveAvatar(req.profile.id, (req.body || {}).avatar);
  if (!path_) return res.status(400).json({ error: 'Invalid image (JPG/PNG/WebP under 1.5MB)' });
  await db.from('profiles').update({ avatar_url: path_ }).eq('id', req.profile.id);
  res.json({ ok: true, avatar: publicUrl('avatars', path_) + '?t=' + Date.now() });
}));

// ---------- public profile ----------
app.get('/api/users/:username', optionalAuth, wrap(async (req, res) => {
  const { data: p } = await db.from('profiles').select('*').ilike('username', req.params.username).maybeSingle();
  if (!p || p.status === 'deactivated') return res.status(404).json({ error: 'User not found' });
  const out = shapeProfile(p);
  const isOwner = req.profile && req.profile.id === p.id;
  const isAdmin = req.profile && req.profile.account_type === 'admin';
  if (p.account_type === 'curator') {
    const { data: vids } = await db.from('videos').select('id,title,thumb_path,created_at')
      .eq('owner_id', p.id).eq('status', 'approved').order('created_at', { ascending: false }).limit(50);
    out.videos = (vids || []).map(v => ({ id: v.id, title: v.title, thumb: publicUrl('thumbs', v.thumb_path), created_at: v.created_at }));
    const { data: st } = await db.rpc('creator_video_stats', { p_creator: p.id });
    out.total_views = (st || []).reduce((a, v) => a + Number(v.previews) + Number(v.paid), 0);
    // financials are private: owner and admin only
    if (isOwner || isAdmin) {
      const { data: bal } = await db.rpc('creator_balance', { p_creator: p.id });
      out.balance = bal;
    }
  }
  if (p.account_type === 'viewer' && (isOwner || isAdmin)) out.points_balance = p.points_balance;
  res.json(out);
}));

// ---------- videos: browse ----------
const videoCard = (v, unlocked, defaultPrice) => ({
  id: v.id, title: v.title, category: v.category, created_at: v.created_at,
  thumb: publicUrl('thumbs', v.thumb_path),
  price: v.price_points || defaultPrice,
  unlocked: !!unlocked,
  owner: v.owner ? { username: v.owner.username, avatar: publicUrl('avatars', v.owner.avatar_url) } : null
});

app.get('/api/videos', optionalAuth, wrap(async (req, res) => {
  if (req.profile && req.profile.account_type === 'curator') return res.status(403).json({ error: 'Curators cannot browse other creators\' videos' });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = 18;
  let q = db.from('videos').select('id,title,category,thumb_path,price_points,created_at,owner:profiles(username,avatar_url)', { count: 'exact' })
    .eq('status', 'approved').order('created_at', { ascending: false }).range((page - 1) * size, page * size - 1);
  if (req.query.category && CATEGORIES.includes(req.query.category)) q = q.eq('category', req.query.category);
  const term = cleanQ(req.query.q);
  if (term) q = q.ilike('title', `%${term}%`);
  const { data, count, error } = await q;
  if (error) throw new Error(error.message);
  const s = await getSettings();
  let unlockedIds = new Set();
  if (req.profile && req.profile.account_type === 'viewer' && data.length) {
    const { data: u } = await db.from('video_unlocks').select('video_id').eq('viewer_id', req.profile.id).in('video_id', data.map(v => v.id));
    unlockedIds = new Set((u || []).map(x => x.video_id));
  }
  res.json({ videos: data.map(v => videoCard(v, unlockedIds.has(v.id), Number(s.unlock_price_points))), total: count, page, page_size: size });
}));

async function getApprovedVideo(id) {
  const { data } = await db.from('videos').select('*, owner:profiles(username,avatar_url)').eq('id', id).maybeSingle();
  return data;
}

app.get('/api/videos/:id', optionalAuth, wrap(async (req, res) => {
  const v = await getApprovedVideo(req.params.id);
  const me = req.profile;
  const isOwner = me && v && v.owner_id === me.id;
  const isAdmin = me && me.account_type === 'admin';
  if (!v || v.status === 'deleted' || (v.status !== 'approved' && !isOwner && !isAdmin)) return res.status(404).json({ error: 'Video not found' });
  if (me && me.account_type === 'curator' && !isOwner) return res.status(403).json({ error: 'Curators cannot watch other creators\' videos' });
  const s = await getSettings();
  let unlocked = false;
  if (me && me.account_type === 'viewer') {
    const { data: u } = await db.from('video_unlocks').select('id').eq('viewer_id', me.id).eq('video_id', v.id).maybeSingle();
    unlocked = !!u;
  }
  const life = Number(s.video_lifetime_hours) || 0;
  const expires_at = life > 0 && v.status === 'approved' && v.approved_at ? new Date(new Date(v.approved_at).getTime() + life * 3600000).toISOString() : null;
  res.json({ ...videoCard(v, unlocked, Number(s.unlock_price_points)), description: v.description, status: v.status, preview_seconds: Number(s.preview_seconds), expires_at });
}));

// Returns a signed playback URL: full file if unlocked/owner/admin, otherwise the short preview clip.
app.post('/api/videos/:id/play', auth, wrap(async (req, res) => {
  const me = req.profile;
  const v = await getApprovedVideo(req.params.id);
  if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Video not found' });
  const s = await getSettings();
  const previewSeconds = Number(s.preview_seconds);
  const price = v.price_points || Number(s.unlock_price_points);

  const isOwner = v.owner_id === me.id;
  if (me.account_type === 'admin' || isOwner) {
    return res.json({ unlocked: true, url: await signed('videos', v.video_path, 7200), preview_seconds: previewSeconds, price });
  }
  if (me.account_type !== 'viewer') return res.status(403).json({ error: 'Not allowed' });
  if (v.status !== 'approved') return res.status(404).json({ error: 'Video not found' });

  const { data: u } = await db.from('video_unlocks').select('id').eq('viewer_id', me.id).eq('video_id', v.id).maybeSingle();
  if (u) return res.json({ unlocked: true, url: await signed('videos', v.video_path, 7200), balance: me.points_balance, price });

  let url;
  if (v.preview_path) url = await signed('videos', v.preview_path, 3600);
  else if (ALLOW_UNSECURED_PREVIEW === 'true') url = await signed('videos', v.video_path, 3600);
  else return res.status(503).json({ error: 'Preview is still being prepared. Try again shortly.' });

  // count one free preview per viewer per video per day (unique index absorbs repeats)
  const { error: ve } = await db.from('video_views').insert({ video_id: v.id, viewer_id: me.id, kind: 'preview' });
  if (ve && ve.code !== '23505') console.error('view log', ve.message);
  res.json({ unlocked: false, url, preview_seconds: previewSeconds, balance: me.points_balance, price });
}));

app.post('/api/videos/:id/unlock', auth, role('viewer'), wrap(async (req, res) => {
  const { data, error } = await db.rpc('unlock_video', { p_viewer: req.profile.id, p_video: req.params.id });
  if (error) throw new Error(error.message);
  if (!data.ok) {
    const code = data.error === 'insufficient_points' ? 402 : data.error === 'video_not_found' ? 404 : 403;
    return res.status(code).json(data);
  }
  const { data: v } = await db.from('videos').select('video_path').eq('id', req.params.id).single();
  res.json({ ...data, url: await signed('videos', v.video_path, 7200) });
}));

app.post('/api/videos/:id/report', auth, role('viewer'), wrap(async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (reason.length < 3) return res.status(400).json({ error: 'Please describe the problem' });
  await db.from('reports').insert({ video_id: req.params.id, reporter_id: req.profile.id, reason });
  res.json({ ok: true });
}));

// ---------- viewer ----------
app.get('/api/viewer/history', auth, role('viewer'), wrap(async (req, res) => {
  const { data } = await db.from('video_unlocks')
    .select('created_at,points_spent,video:videos(id,title,thumb_path,status,owner:profiles(username))')
    .eq('viewer_id', req.profile.id).order('created_at', { ascending: false }).limit(100);
  res.json({
    history: (data || []).filter(r => r.video && r.video.status !== 'deleted').map(r => ({
      unlocked_at: r.created_at, points_spent: r.points_spent,
      id: r.video.id, title: r.video.title, thumb: publicUrl('thumbs', r.video.thumb_path),
      owner: r.video.owner && r.video.owner.username
    }))
  });
}));

app.get('/api/viewer/payments', auth, role('viewer'), wrap(async (req, res) => {
  const { data } = await db.from('payments').select('reference,points,amount_kes,status,channel,created_at,paid_at')
    .eq('user_id', req.profile.id).order('created_at', { ascending: false }).limit(100);
  res.json({ payments: data || [] });
}));

// ---------- payments ----------
app.post('/api/payments/init', auth, role('viewer'), wrap(async (req, res) => {
  const { package_id } = req.body || {};
  const { data: pkg } = await db.from('point_packages').select('*').eq('id', package_id).eq('active', true).maybeSingle();
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  const reference = 'CV' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase();
  const { error: ie } = await db.from('payments').insert({
    reference, user_id: req.profile.id, package_id: pkg.id, points: pkg.points, amount_kes: pkg.price_kes
  });
  if (ie) throw new Error(ie.message);
  const body = {
    email: req.user.email, amount: pkg.price_kes * 100, currency: 'KES', reference,
    callback_url: `${APP_URL || ''}/#/buy`,
    metadata: { user_id: req.profile.id, package: pkg.name, points: pkg.points }
  };
  if (PAYSTACK_CHANNELS) body.channels = PAYSTACK_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  const r = await paystack('POST', '/transaction/initialize', body);
  if (!r.status) {
    await db.from('payments').update({ status: 'failed' }).eq('reference', reference);
    return res.status(502).json({ error: r.message || 'Could not start payment' });
  }
  res.json({ authorization_url: r.data.authorization_url, reference });
}));

app.get('/api/payments/verify/:reference', auth, role('viewer'), wrap(async (req, res) => {
  const { data: pay } = await db.from('payments').select('user_id').eq('reference', req.params.reference).maybeSingle();
  if (!pay || pay.user_id !== req.profile.id) return res.status(404).json({ error: 'Payment not found' });
  const result = await verifyAndCredit(req.params.reference);
  const { data: p } = await db.from('profiles').select('points_balance').eq('id', req.profile.id).single();
  res.json({ result, points_balance: p.points_balance });
}));

// ---------- creator ----------
app.post('/api/videos/upload-urls', auth, role('curator'), wrap(async (req, res) => {
  const id = crypto.randomUUID();
  const uid = req.profile.id;
  const vPath = `${uid}/${id}.mp4`;
  const tPath = `${uid}/${id}.jpg`;
  const [v, t] = await Promise.all([
    db.storage.from('videos').createSignedUploadUrl(vPath),
    db.storage.from('thumbs').createSignedUploadUrl(tPath)
  ]);
  if (v.error || t.error) throw new Error((v.error || t.error).message);
  res.json({ video_id: id, video: { path: vPath, token: v.data.token }, thumb: { path: tPath, token: t.data.token } });
}));

app.post('/api/videos', auth, role('curator'), wrap(async (req, res) => {
  const { id, title, description, category, video_path, thumb_path } = req.body || {};
  const uid = req.profile.id;
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return res.status(400).json({ error: 'Bad video id' });
  if (video_path !== `${uid}/${id}.mp4` || thumb_path !== `${uid}/${id}.jpg`) return res.status(400).json({ error: 'Invalid file paths' });
  const t = String(title || '').trim();
  if (t.length < 3 || t.length > 100) return res.status(400).json({ error: 'Title must be 3-100 characters' });
  const cat = CATEGORIES.includes(category) ? category : 'General';
  const { data: found } = await db.storage.from('videos').list(uid, { search: `${id}.mp4`, limit: 1 });
  if (!found || !found.length) return res.status(400).json({ error: 'Video file was not uploaded' });
  const { error } = await db.from('videos').insert({
    id, owner_id: uid, title: t, description: String(description || '').slice(0, 2000), category: cat,
    video_path, thumb_path
  });
  if (error) throw new Error(error.message);
  generatePreview(id).catch(e => { console.error('preview error', e.message); }).then(() => maybeAutoApprove(id)).catch(e => console.error('auto-approve error', e.message));
  res.json({ ok: true, id });
}));

app.delete('/api/videos/:id', auth, wrap(async (req, res) => {
  const { data: v } = await db.from('videos').select('*').eq('id', req.params.id).maybeSingle();
  if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Video not found' });
  if (v.owner_id !== req.profile.id && req.profile.account_type !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  await removeVideoFiles(v);
  await db.from('videos').update({ status: 'deleted' }).eq('id', v.id);
  await audit(req.profile.id, 'video_deleted', { id: v.id });
  res.json({ ok: true });
}));

// Publish a new video automatically once its preview clip is ready (admin setting auto_approve = 1).
async function maybeAutoApprove(id) {
  const s = await getSettings();
  if (Number(s.auto_approve) !== 1) return false;
  const { data: v } = await db.from('videos').select('status,preview_path').eq('id', id).maybeSingle();
  if (!v || v.status !== 'pending') return false;
  if (!v.preview_path && ALLOW_UNSECURED_PREVIEW !== 'true') return false; // stays pending for an admin to handle
  await db.from('videos').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id);
  await audit(null, 'video_auto_approved', { id });
  return true;
}

async function removeVideoFiles(v) {
  const vids = [v.video_path, v.preview_path].filter(Boolean);
  if (vids.length) await db.storage.from('videos').remove(vids);
  if (v.thumb_path) await db.storage.from('thumbs').remove([v.thumb_path]);
}

// Build a short, lower-resolution preview clip so the full file is never exposed before unlock.
async function generatePreview(videoId) {
  if (!ffmpegPath) { await audit(null, 'preview_skipped_no_ffmpeg', { videoId }); return false; }
  const { data: v } = await db.from('videos').select('*').eq('id', videoId).single();
  const s = await getSettings();
  const secs = String(Number(s.preview_seconds) || 10);
  const src = await signed('videos', v.video_path, 900);
  const out = path.join(os.tmpdir(), `preview-${videoId}.mp4`);
  await new Promise((resolve, reject) => {
    const args = ['-y', '-i', src, '-t', secs, '-vf', 'scale=-2:min(480\\,ih)',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', out];
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-800); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 180000);
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err)); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
  }).catch(async e => { await audit(null, 'preview_failed', { videoId, error: String(e.message).slice(0, 300) }); throw e; });
  const buf = fs.readFileSync(out);
  fs.unlink(out, () => {});
  const pPath = `${v.owner_id}/previews/${videoId}.mp4`;
  const { error } = await db.storage.from('videos').upload(pPath, buf, { contentType: 'video/mp4', upsert: true });
  if (error) throw new Error(error.message);
  await db.from('videos').update({ preview_path: pPath }).eq('id', videoId);
  return true;
}

app.get('/api/creator/dashboard', auth, role('curator'), wrap(async (req, res) => {
  const uid = req.profile.id;
  const [{ data: bal }, { data: stats }, { data: wd }] = await Promise.all([
    db.rpc('creator_balance', { p_creator: uid }),
    db.rpc('creator_video_stats', { p_creator: uid }),
    db.from('withdrawals').select('status,amount_usd').eq('creator_id', uid)
  ]);
  const videos = (stats || []).map(v => ({
    id: v.video_id, title: v.title, status: v.status, thumb: publicUrl('thumbs', v.thumb_path),
    created_at: v.created_at, previews: Number(v.previews), paid: Number(v.paid), earned: Number(v.earned)
  }));
  const withdrawn = (wd || []).filter(w => w.status === 'paid').reduce((a, w) => a + Number(w.amount_usd), 0);
  const s = await getSettings();
  res.json({
    totals: {
      previews: videos.reduce((a, v) => a + v.previews, 0),
      paid_unlocks: videos.reduce((a, v) => a + v.paid, 0),
      total_views: videos.reduce((a, v) => a + v.previews + v.paid, 0),
      total_earned: Number(bal.total_earned),
      available: Number(bal.available),
      pending: Number(bal.pending),
      withdrawn
    },
    videos,
    settings: { creator_rate_usd: Number(s.creator_rate_usd), min_withdrawal_usd: Number(s.min_withdrawal_usd), usd_to_kes: Number(s.usd_to_kes) }
  });
}));

app.get('/api/creator/report', auth, role('curator'), wrap(async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const days = period === 'day' ? 14 : period === 'week' ? 84 : 365;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await db.rpc('creator_report', { p_creator: req.profile.id, p_unit: period, p_since: since });
  if (error) throw new Error(error.message);
  res.json({ period, rows: (data || []).map(r => ({ bucket: r.bucket, unlocks: Number(r.unlocks), earned: Number(r.earned) })) });
}));

app.get('/api/withdrawals', auth, role('curator'), wrap(async (req, res) => {
  const { data } = await db.from('withdrawals').select('*').eq('creator_id', req.profile.id).order('created_at', { ascending: false }).limit(100);
  res.json({ withdrawals: data || [] });
}));

app.post('/api/withdrawals', auth, role('curator'), wrap(async (req, res) => {
  const amount = Number((req.body || {}).amount_usd);
  const method = (req.body || {}).method === 'bank' ? 'bank' : 'mpesa';
  const dest = String((req.body || {}).destination || '').trim().slice(0, 100);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount' });
  if (method === 'mpesa' && !/^(?:\+?254|0)(7|1)\d{8}$/.test(dest.replace(/\s/g, ''))) return res.status(400).json({ error: 'Enter a valid M-Pesa phone number' });
  if (method === 'bank' && dest.length < 6) return res.status(400).json({ error: 'Enter your bank details' });
  const { data, error } = await db.rpc('request_withdrawal', {
    p_creator: req.profile.id, p_amount: Math.round(amount * 1e6) / 1e6, p_method: method, p_dest: dest
  });
  if (error) throw new Error(error.message);
  if (!data.ok) return res.status(400).json(data);
  res.json(data);
}));

// ---------- admin ----------
const admin = [auth, role('admin')];

app.get('/api/admin/stats', ...admin, wrap(async (req, res) => {
  const { data, error } = await db.rpc('admin_stats');
  if (error) throw new Error(error.message);
  res.json(data);
}));

app.get('/api/admin/users', ...admin, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), size = 25;
  let q = db.from('profiles').select('id,username,gender,account_type,status,points_balance,avatar_url,created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range((page - 1) * size, page * size - 1);
  if (GENDERS.includes(req.query.gender)) q = q.eq('gender', req.query.gender);
  if (['curator', 'viewer', 'admin'].includes(req.query.type)) q = q.eq('account_type', req.query.type);
  const term = cleanQ(req.query.q);
  if (term) q = q.ilike('username', `%${term}%`);
  const { data, count, error } = await q;
  if (error) throw new Error(error.message);
  res.json({ users: data.map(u => ({ ...u, avatar: avatarOf(u) })), total: count, page, page_size: size });
}));

app.post('/api/admin/users/:id/status', ...admin, wrap(async (req, res) => {
  const status = (req.body || {}).status;
  if (!['active', 'suspended', 'deactivated'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (req.params.id === req.profile.id) return res.status(400).json({ error: 'You cannot change your own status' });
  await db.from('profiles').update({ status }).eq('id', req.params.id);
  await audit(req.profile.id, 'user_status', { user: req.params.id, status });
  res.json({ ok: true });
}));

// Account type changes are admin-approved only
app.post('/api/admin/users/:id/type', ...admin, wrap(async (req, res) => {
  const t = (req.body || {}).account_type;
  if (!['curator', 'viewer'].includes(t)) return res.status(400).json({ error: 'Bad type' });
  await db.from('profiles').update({ account_type: t }).eq('id', req.params.id);
  await audit(req.profile.id, 'user_type_changed', { user: req.params.id, type: t });
  res.json({ ok: true });
}));

app.get('/api/admin/videos', ...admin, wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { data, error } = await db.from('videos')
    .select('id,title,category,status,price_points,thumb_path,preview_path,created_at,owner:profiles(username,avatar_url)')
    .eq('status', status).order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  res.json({ videos: data.map(v => ({ ...videoCard(v, false, null), status: v.status, has_preview: !!v.preview_path, price_override: v.price_points })) });
}));

app.post('/api/admin/videos/:id/review', ...admin, wrap(async (req, res) => {
  const action = (req.body || {}).action;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Bad action' });
  const { data: v } = await db.from('videos').select('preview_path,status').eq('id', req.params.id).maybeSingle();
  if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Not found' });
  if (action === 'approve' && !v.preview_path && ALLOW_UNSECURED_PREVIEW !== 'true') {
    return res.status(400).json({ error: 'Preview clip not ready yet. Use "Rebuild preview" and try again.' });
  }
  await db.from('videos').update(action === 'approve' ? { status: 'approved', approved_at: new Date().toISOString() } : { status: 'rejected' }).eq('id', req.params.id);
  await audit(req.profile.id, 'video_' + action, { id: req.params.id });
  res.json({ ok: true });
}));

app.post('/api/admin/videos/:id/preview', ...admin, wrap(async (req, res) => {
  const ok = await generatePreview(req.params.id);
  if (ok) await maybeAutoApprove(req.params.id);
  res.json({ ok });
}));

app.put('/api/admin/videos/:id/price', ...admin, wrap(async (req, res) => {
  const raw = (req.body || {}).price_points;
  const price = raw === null || raw === '' ? null : parseInt(raw);
  if (price !== null && !(price > 0)) return res.status(400).json({ error: 'Price must be a positive number or empty for default' });
  await db.from('videos').update({ price_points: price }).eq('id', req.params.id);
  await audit(req.profile.id, 'video_price', { id: req.params.id, price });
  res.json({ ok: true });
}));

const SETTING_KEYS = ['unlock_price_points', 'creator_rate_usd', 'min_withdrawal_usd', 'preview_seconds', 'usd_to_kes', 'video_lifetime_hours', 'auto_approve'];
app.get('/api/admin/settings', ...admin, wrap(async (req, res) => res.json(await getSettings())));
app.put('/api/admin/settings', ...admin, wrap(async (req, res) => {
  const body = req.body || {};
  for (const k of SETTING_KEYS) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    const zeroOk = k === 'video_lifetime_hours' || k === 'auto_approve';
    if (zeroOk ? !(n >= 0) : !(n > 0)) return res.status(400).json({ error: `${k} must be ${zeroOk ? 'zero or a positive number' : 'a positive number'}` });
    await db.from('settings').upsert({ key: k, value: String(n), updated_at: new Date().toISOString() });
  }
  await audit(req.profile.id, 'settings_changed', body);
  res.json({ ok: true });
}));

app.get('/api/admin/packages', ...admin, wrap(async (req, res) => {
  const { data } = await db.from('point_packages').select('*').order('sort');
  res.json({ packages: data || [] });
}));
app.post('/api/admin/packages', ...admin, wrap(async (req, res) => {
  const { name, points, price_kes, sort } = req.body || {};
  if (!name || !(points > 0) || !(price_kes > 0)) return res.status(400).json({ error: 'Name, points and price are required' });
  const { error } = await db.from('point_packages').insert({ name, points: parseInt(points), price_kes: parseInt(price_kes), sort: parseInt(sort) || 0 });
  if (error) throw new Error(error.message);
  await audit(req.profile.id, 'package_created', { name, points, price_kes });
  res.json({ ok: true });
}));
app.put('/api/admin/packages/:id', ...admin, wrap(async (req, res) => {
  const { name, points, price_kes, sort, active } = req.body || {};
  const patch = {};
  if (name) patch.name = name;
  if (points > 0) patch.points = parseInt(points);
  if (price_kes > 0) patch.price_kes = parseInt(price_kes);
  if (sort !== undefined) patch.sort = parseInt(sort) || 0;
  if (typeof active === 'boolean') patch.active = active;
  await db.from('point_packages').update(patch).eq('id', req.params.id);
  await audit(req.profile.id, 'package_updated', { id: req.params.id, ...patch });
  res.json({ ok: true });
}));

app.get('/api/admin/payments', ...admin, wrap(async (req, res) => {
  const { data } = await db.from('payments').select('reference,points,amount_kes,status,channel,created_at,paid_at,user:profiles(username)')
    .order('created_at', { ascending: false }).limit(200);
  res.json({ payments: data || [] });
}));

app.get('/api/admin/withdrawals', ...admin, wrap(async (req, res) => {
  const { data } = await db.from('withdrawals').select('*, creator:profiles(username)').order('created_at', { ascending: false }).limit(200);
  const s = await getSettings();
  res.json({ withdrawals: data || [], usd_to_kes: Number(s.usd_to_kes) });
}));
app.post('/api/admin/withdrawals/:id/review', ...admin, wrap(async (req, res) => {
  const { action, note } = req.body || {};
  if (!['approve', 'reject', 'paid'].includes(action)) return res.status(400).json({ error: 'Bad action' });
  const { data, error } = await db.rpc('review_withdrawal', { p_admin: req.profile.id, p_id: req.params.id, p_action: action, p_note: note || null });
  if (error) throw new Error(error.message);
  if (!data.ok) return res.status(400).json(data);
  res.json(data);
}));

app.get('/api/admin/reports', ...admin, wrap(async (req, res) => {
  const { data } = await db.from('reports').select('id,reason,status,created_at,video:videos(id,title),reporter:profiles(username)')
    .order('created_at', { ascending: false }).limit(100);
  res.json({ reports: data || [] });
}));
app.post('/api/admin/reports/:id/resolve', ...admin, wrap(async (req, res) => {
  await db.from('reports').update({ status: 'resolved' }).eq('id', req.params.id);
  res.json({ ok: true });
}));

app.get('/api/admin/audit', ...admin, wrap(async (req, res) => {
  const { data } = await db.from('audit_log').select('*').order('id', { ascending: false }).limit(200);
  res.json({ log: data || [] });
}));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Auto-delete videos a set number of hours after they go live (admin setting video_lifetime_hours, 0 = off).
// Files are removed to free storage; the DB row is kept (status 'deleted') so earnings and stats stay intact.
async function expireVideos() {
  const s = await getSettings();
  const life = Number(s.video_lifetime_hours) || 0;
  if (life <= 0) return;
  const cutoff = new Date(Date.now() - life * 3600000).toISOString();
  const { data, error } = await db.from('videos').select('*').in('status', ['approved', 'rejected']).lt('approved_at', cutoff).limit(50);
  if (error) { console.error('expire query failed:', error.message); return; }
  // rejected videos never got approved_at: expire them from upload time
  const { data: rej } = await db.from('videos').select('*').eq('status', 'rejected').is('approved_at', null).lt('created_at', cutoff).limit(50);
  for (const v of [...(data || []), ...(rej || [])]) {
    try {
      await removeVideoFiles(v);
      await db.from('videos').update({ status: 'deleted' }).eq('id', v.id);
      await audit(null, 'video_expired', { id: v.id, lifetime_hours: life });
    } catch (e) { console.error('expire failed for', v.id, e.message); }
  }
}
setInterval(() => expireVideos().catch(e => console.error('expireVideos', e.message)), 10 * 60 * 1000);
setTimeout(() => expireVideos().catch(() => {}), 30000);

// Make sure the storage buckets exist (creates them if the SQL step missed them)
async function ensureBuckets() {
  const want = [['videos', false], ['thumbs', true], ['avatars', true]];
  const { data, error } = await db.storage.listBuckets();
  if (error) { console.error('Storage check failed:', error.message); return; }
  const have = new Set((data || []).map(b => b.name));
  for (const [name, pub] of want) {
    if (have.has(name)) continue;
    const r = await db.storage.createBucket(name, { public: pub });
    console.log(r.error ? `Could not create bucket ${name}: ${r.error.message}` : `Created storage bucket: ${name}`);
  }
}
db.from('profiles').select('id', { head: true, count: 'exact' }).then(r => { if (r.error) console.error('DATABASE NOT READY: run supabase/schema.sql in the Supabase SQL Editor. (' + r.error.message + ')'); });
ensureBuckets().catch(e => console.error('ensureBuckets', e.message));

app.listen(PORT, () => console.log(`VIDXX running on port ${PORT}`));
