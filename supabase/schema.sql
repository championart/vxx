-- VIDXX schema. Run in the Supabase SQL editor (once).
-- All money-moving logic lives in SQL functions so it is atomic and idempotent.
-- The backend uses the service-role key; browsers never touch these tables directly.

create extension if not exists pgcrypto;

-- ---------- settings (admin-configurable) ----------
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values
  ('unlock_price_points', '50'),          -- default points to unlock a video
  ('creator_rate_usd', '0.001'),          -- creator earning per qualified paid unlock
  ('min_withdrawal_usd', '5'),            -- minimum withdrawal
  ('preview_seconds', '10'),
  ('usd_to_kes', '129'),                  -- used to show withdrawals in KES
  ('video_lifetime_hours', '24'),         -- videos auto-delete this many hours after going live (0 = keep forever)
  ('auto_approve', '1')                   -- 1 = videos go live automatically once their preview is ready
on conflict (key) do nothing;

-- ---------- profiles ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  gender text not null check (gender in ('female','male','transgender')),
  account_type text not null check (account_type in ('curator','viewer','admin')),
  avatar_url text,
  is_adult_confirmed boolean not null default false,
  status text not null default 'active' check (status in ('active','suspended','deactivated')),
  points_balance bigint not null default 0 check (points_balance >= 0),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on profiles (lower(username));

-- ---------- videos ----------
create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  description text,
  category text not null default 'General',
  video_path text not null,            -- path in private storage bucket "videos"
  thumb_path text,                     -- path in public bucket "thumbs"
  preview_path text,                   -- optional short clip in private bucket
  price_points int,                    -- null = use default setting
  status text not null default 'pending' check (status in ('pending','approved','rejected','deleted')),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table videos add column if not exists approved_at timestamptz;
create index if not exists videos_status_created on videos (status, created_at desc);
create index if not exists videos_owner on videos (owner_id);

-- ---------- unlocks (one per viewer+video; this is what prevents double charge/earn) ----------
create table if not exists video_unlocks (
  id uuid primary key default gen_random_uuid(),
  viewer_id uuid not null references profiles(id) on delete cascade,
  video_id uuid not null references videos(id) on delete cascade,
  points_spent int not null,
  created_at timestamptz not null default now(),
  unique (viewer_id, video_id)
);

-- ---------- view events (free previews + paid) ----------
create table if not exists video_views (
  id bigserial primary key,
  video_id uuid not null references videos(id) on delete cascade,
  viewer_id uuid references profiles(id) on delete set null,
  kind text not null check (kind in ('preview','paid')),
  day date not null default current_date,
  created_at timestamptz not null default now()
);
-- one preview count per viewer per video per day (anti view-farming)
create unique index if not exists video_views_preview_once
  on video_views (video_id, viewer_id, day) where kind = 'preview';

-- ---------- points packages ----------
create table if not exists point_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  points int not null check (points > 0),
  price_kes int not null check (price_kes > 0),
  sort int not null default 0,
  active boolean not null default true
);
insert into point_packages (name, points, price_kes, sort)
select * from (values
  ('Starter', 100, 50, 1),
  ('Basic', 500, 200, 2),
  ('Standard', 1000, 380, 3),
  ('Premium', 5000, 1800, 4),
  ('VIP', 10000, 3400, 5)
) v(name, points, price_kes, sort)
where not exists (select 1 from point_packages);

-- ---------- payments (Paystack money in) ----------
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  user_id uuid not null references profiles(id) on delete cascade,
  package_id uuid references point_packages(id),
  points int not null,
  amount_kes int not null,
  currency text not null default 'KES',
  amount_minor int,
  status text not null default 'pending' check (status in ('pending','success','failed')),
  channel text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists payments_user on payments (user_id, created_at desc);

-- ---------- ledgers (separate: points vs creator earnings) ----------
create table if not exists points_ledger (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  delta bigint not null,
  reason text not null check (reason in ('purchase','unlock','admin_adjust')),
  ref_payment uuid references payments(id),
  ref_video uuid references videos(id),
  balance_after bigint not null,
  created_at timestamptz not null default now()
);
-- a payment can credit points only once
create unique index if not exists points_ledger_one_purchase
  on points_ledger (ref_payment) where reason = 'purchase';

create table if not exists earnings_ledger (
  id bigserial primary key,
  creator_id uuid not null references profiles(id) on delete cascade,
  amount_usd numeric(14,6) not null,
  reason text not null check (reason in ('unlock','withdrawal_hold','withdrawal_release','admin_adjust')),
  ref_video uuid references videos(id),
  ref_viewer uuid references profiles(id),
  ref_withdrawal uuid,
  created_at timestamptz not null default now()
);
create index if not exists earnings_creator on earnings_ledger (creator_id, created_at desc);
-- one earning per viewer+video, ever
create unique index if not exists earnings_one_per_unlock
  on earnings_ledger (creator_id, ref_video, ref_viewer) where reason = 'unlock';

-- ---------- withdrawals ----------
create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete cascade,
  amount_usd numeric(14,6) not null check (amount_usd > 0),
  method text not null default 'mpesa',
  destination text not null,            -- phone number / account
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid')),
  admin_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- ---------- reports / moderation ----------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  reporter_id uuid references profiles(id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now()
);

-- ---------- audit log ----------
create table if not exists audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------- helpers ----------
create or replace function setting_num(k text) returns numeric
language sql stable as $$ select value::numeric from settings where key = k $$;

-- ---------- credit points after VERIFIED payment (idempotent) ----------
alter table payments add column if not exists currency text not null default 'KES';
alter table payments add column if not exists amount_minor int;
drop function if exists credit_payment(text, text, int);

create or replace function credit_payment(p_reference text, p_channel text, p_currency text, p_amount_minor int)
returns text language plpgsql security definer as $$
declare pay payments; newbal bigint; expected int;
begin
  select * into pay from payments where reference = p_reference for update;
  if not found then return 'not_found'; end if;
  if pay.status = 'success' then return 'already_credited'; end if;
  expected := coalesce(pay.amount_minor, pay.amount_kes * 100);
  if p_currency is distinct from pay.currency or p_amount_minor < expected then
    update payments set status = 'failed' where id = pay.id;
    insert into audit_log(actor_id, action, detail)
      values (pay.user_id, 'payment_amount_mismatch', jsonb_build_object('reference', p_reference, 'expected', expected, 'expected_currency', pay.currency, 'got', p_amount_minor, 'got_currency', p_currency));
    return 'amount_mismatch';
  end if;
  update profiles set points_balance = points_balance + pay.points where id = pay.user_id
    returning points_balance into newbal;
  update payments set status = 'success', channel = p_channel, paid_at = now() where id = pay.id;
  insert into points_ledger(user_id, delta, reason, ref_payment, balance_after)
    values (pay.user_id, pay.points, 'purchase', pay.id, newbal);
  insert into audit_log(actor_id, action, detail)
    values (pay.user_id, 'points_purchased', jsonb_build_object('reference', p_reference, 'points', pay.points, 'kes', pay.amount_kes, 'currency', pay.currency, 'minor', p_amount_minor));
  return 'credited';
end $$;

-- ---------- unlock a video (atomic; never double-charges or double-earns) ----------
create or replace function unlock_video(p_viewer uuid, p_video uuid)
returns jsonb language plpgsql security definer as $$
declare v videos; price int; bal bigint; rate numeric; newbal bigint; vstatus text; vtype text;
begin
  select status, account_type into vstatus, vtype from profiles where id = p_viewer;
  if vtype is distinct from 'viewer' or vstatus <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  select * into v from videos where id = p_video and status = 'approved';
  if not found then return jsonb_build_object('ok', false, 'error', 'video_not_found'); end if;

  if exists (select 1 from video_unlocks where viewer_id = p_viewer and video_id = p_video) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  price := coalesce(v.price_points, setting_num('unlock_price_points')::int);
  select points_balance into bal from profiles where id = p_viewer for update;
  if bal < price then
    return jsonb_build_object('ok', false, 'error', 'insufficient_points', 'needed', price, 'balance', bal);
  end if;

  update profiles set points_balance = points_balance - price where id = p_viewer
    returning points_balance into newbal;
  insert into video_unlocks(viewer_id, video_id, points_spent) values (p_viewer, p_video, price);
  insert into points_ledger(user_id, delta, reason, ref_video, balance_after)
    values (p_viewer, -price, 'unlock', p_video, newbal);

  rate := setting_num('creator_rate_usd');
  insert into earnings_ledger(creator_id, amount_usd, reason, ref_video, ref_viewer)
    values (v.owner_id, rate, 'unlock', p_video, p_viewer);
  insert into video_views(video_id, viewer_id, kind) values (p_video, p_viewer, 'paid');

  return jsonb_build_object('ok', true, 'already', false, 'balance', newbal, 'spent', price);
end $$;

-- ---------- creator balance ----------
create or replace function creator_balance(p_creator uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total_earned', coalesce(sum(amount_usd) filter (where reason in ('unlock','live','reply','admin_adjust')), 0),
    'pending',      coalesce(-sum(amount_usd) filter (where reason = 'withdrawal_hold'), 0)
                    - coalesce(sum(amount_usd) filter (where reason = 'withdrawal_release'), 0),
    'available',    coalesce(sum(amount_usd), 0)
  ) from earnings_ledger where creator_id = p_creator
$$;

-- ---------- request withdrawal (holds funds immediately) ----------
create or replace function request_withdrawal(p_creator uuid, p_amount numeric, p_method text, p_dest text)
returns jsonb language plpgsql security definer as $$
declare avail numeric; minw numeric; wid uuid;
begin
  perform 1 from profiles where id = p_creator and account_type = 'curator' and status = 'active' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_allowed'); end if;
  minw := setting_num('min_withdrawal_usd');
  select coalesce(sum(amount_usd), 0) into avail from earnings_ledger where creator_id = p_creator;
  if p_amount < minw then return jsonb_build_object('ok', false, 'error', 'below_minimum', 'minimum', minw); end if;
  if p_amount > avail then return jsonb_build_object('ok', false, 'error', 'insufficient_funds', 'available', avail); end if;
  insert into withdrawals(creator_id, amount_usd, method, destination)
    values (p_creator, p_amount, p_method, p_dest) returning id into wid;
  insert into earnings_ledger(creator_id, amount_usd, reason, ref_withdrawal)
    values (p_creator, -p_amount, 'withdrawal_hold', wid);
  insert into audit_log(actor_id, action, detail)
    values (p_creator, 'withdrawal_requested', jsonb_build_object('id', wid, 'usd', p_amount));
  return jsonb_build_object('ok', true, 'id', wid);
end $$;

-- ---------- admin review of a withdrawal ----------
create or replace function review_withdrawal(p_admin uuid, p_id uuid, p_action text, p_note text)
returns jsonb language plpgsql security definer as $$
declare w withdrawals;
begin
  select * into w from withdrawals where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_action = 'reject' and w.status in ('pending','approved') then
    update withdrawals set status = 'rejected', admin_note = p_note, reviewed_at = now() where id = p_id;
    -- release the held funds back to the creator
    insert into earnings_ledger(creator_id, amount_usd, reason, ref_withdrawal)
      values (w.creator_id, w.amount_usd, 'withdrawal_release', p_id);
  elsif p_action = 'approve' and w.status = 'pending' then
    update withdrawals set status = 'approved', admin_note = p_note, reviewed_at = now() where id = p_id;
  elsif p_action = 'paid' and w.status = 'approved' then
    update withdrawals set status = 'paid', admin_note = coalesce(p_note, admin_note), reviewed_at = now() where id = p_id;
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  insert into audit_log(actor_id, action, detail)
    values (p_admin, 'withdrawal_' || p_action, jsonb_build_object('id', p_id, 'usd', w.amount_usd));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- per-video stats for a creator ----------
create or replace function creator_video_stats(p_creator uuid)
returns table(video_id uuid, title text, status text, thumb_path text, created_at timestamptz,
              previews bigint, paid bigint, earned numeric)
language sql stable as $$
  select v.id, v.title, v.status, v.thumb_path, v.created_at,
    (select count(*) from video_views w where w.video_id = v.id and w.kind = 'preview'),
    (select count(*) from video_views w where w.video_id = v.id and w.kind = 'paid'),
    coalesce((select sum(amount_usd) from earnings_ledger e where e.ref_video = v.id and e.reason = 'unlock'), 0)
  from videos v where v.owner_id = p_creator and v.status <> 'deleted' order by v.created_at desc
$$;

-- ---------- creator earnings report (day | week | month) ----------
create or replace function creator_report(p_creator uuid, p_unit text, p_since timestamptz)
returns table(bucket date, unlocks bigint, earned numeric)
language sql stable as $$
  select date_trunc(p_unit, created_at)::date, count(*), sum(amount_usd)
  from earnings_ledger
  where creator_id = p_creator and reason in ('unlock','live','reply') and created_at >= p_since
  group by 1 order by 1
$$;

-- ---------- platform stats for admin ----------
create or replace function admin_stats()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'users_total',     (select count(*) from profiles),
    'curators',        (select count(*) from profiles where account_type = 'curator'),
    'viewers',         (select count(*) from profiles where account_type = 'viewer'),
    'videos_total',    (select count(*) from videos),
    'videos_pending',  (select count(*) from videos where status = 'pending'),
    'views_total',     (select count(*) from video_views),
    'previews_total',  (select count(*) from video_views where kind = 'preview'),
    'paid_unlocks',    (select count(*) from video_unlocks),
    'revenue_kes',     (select coalesce(sum(amount_kes), 0) from payments where status = 'success'),
    'creator_earned_usd', (select coalesce(sum(amount_usd), 0) from earnings_ledger where reason in ('unlock','live','reply','admin_adjust')),
    'withdrawals_pending', (select count(*) from withdrawals where status = 'pending'),
    'open_reports',    (select count(*) from reports where status = 'open')
  )
$$;

revoke execute on function creator_video_stats(uuid) from public, anon, authenticated;
revoke execute on function admin_stats() from public, anon, authenticated;
revoke execute on function creator_report(uuid, text, timestamptz) from public, anon, authenticated;

-- ---------- row level security: deny everything to browsers ----------
-- The backend uses the service-role key, which bypasses RLS. Enabling RLS with no
-- policies means the public anon key can read/write nothing directly.
alter table settings enable row level security;
alter table profiles enable row level security;
alter table videos enable row level security;
alter table video_unlocks enable row level security;
alter table video_views enable row level security;
alter table point_packages enable row level security;
alter table payments enable row level security;
alter table points_ledger enable row level security;
alter table earnings_ledger enable row level security;
alter table withdrawals enable row level security;
alter table reports enable row level security;
alter table audit_log enable row level security;

-- functions must only be callable by the backend
revoke execute on function credit_payment(text, text, text, int) from public, anon, authenticated;
revoke execute on function unlock_video(uuid, uuid) from public, anon, authenticated;
revoke execute on function request_withdrawal(uuid, numeric, text, text) from public, anon, authenticated;
revoke execute on function review_withdrawal(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function creator_balance(uuid) from public, anon, authenticated;

-- =====================================================================
-- Live streaming, comments and messages
-- =====================================================================
insert into settings (key, value) values
  ('live_points_per_minute', '30'),     -- points a viewer pays per minute of live
  ('live_creator_rate_usd', '0.001'),   -- creator earning per paid viewer-minute
  ('message_reply_points', '3'),        -- points per viewer reply after the free ones
  ('message_free_replies', '2'),        -- free viewer replies per conversation
  ('reply_batch_size', '10'),           -- creator earns a reward for every this-many paid viewer replies
  ('reply_batch_usd', '0.01')           -- ...of this many USD
on conflict (key) do nothing;

-- allow the new ledger reasons (works on a fresh or an existing database)
alter table points_ledger drop constraint if exists points_ledger_reason_check;
alter table points_ledger add constraint points_ledger_reason_check
  check (reason in ('purchase','unlock','admin_adjust','live','message','media'));
alter table points_ledger add column if not exists ref_stream uuid;
alter table earnings_ledger drop constraint if exists earnings_ledger_reason_check;
alter table earnings_ledger add constraint earnings_ledger_reason_check
  check (reason in ('unlock','live','reply','media','withdrawal_hold','withdrawal_release','admin_adjust'));
alter table earnings_ledger add column if not exists ref_stream uuid;
alter table earnings_ledger add column if not exists ref_conversation uuid;
alter table profiles add column if not exists reply_progress int not null default 0;

create table if not exists streams (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  room text not null unique,
  status text not null default 'live' check (status in ('live','ended')),
  started_at timestamptz not null default now(),
  last_ping timestamptz not null default now(),
  ended_at timestamptz,
  peak_viewers int not null default 0
);
create unique index if not exists streams_one_live_per_host on streams (host_id) where status = 'live';
create index if not exists streams_status on streams (status, started_at desc);

create table if not exists live_sessions (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references streams(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  paid_until timestamptz not null default now(),
  minutes_paid int not null default 0,
  points_spent int not null default 0,
  ended_at timestamptz
);
create unique index if not exists live_sessions_one_active on live_sessions (stream_id, viewer_id) where ended_at is null;
create index if not exists live_sessions_active on live_sessions (stream_id) where ended_at is null;

create table if not exists comments (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  video_id uuid references videos(id) on delete cascade,
  stream_id uuid references streams(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  check ((video_id is not null)::int + (stream_id is not null)::int = 1)
);
create index if not exists comments_video on comments (video_id, id desc) where video_id is not null;
create index if not exists comments_stream on comments (stream_id, id) where stream_id is not null;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  curator_id uuid not null references profiles(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  viewer_replies int not null default 0,
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (curator_id, viewer_id)
);
create index if not exists conversations_viewer on conversations (viewer_id, last_message_at desc);
create index if not exists conversations_curator on conversations (curator_id, last_message_at desc);

create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  cost int not null default 0,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv on messages (conversation_id, id);

-- Charge one minute of live viewing. Creates the viewer's session on first call and renews it after.
-- Safe to call repeatedly: the viewer row is locked and a minute is only charged inside the renewal window.
create or replace function live_charge(p_viewer uuid, p_stream uuid)
returns jsonb language plpgsql security definer as $$
declare st streams; sess live_sessions; has_sess boolean; price int; rate numeric;
        bal bigint; newbal bigint; vtype text; vstatus text;
begin
  select account_type, status into vtype, vstatus from profiles where id = p_viewer;
  if vtype is distinct from 'viewer' or vstatus <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  select * into st from streams where id = p_stream;
  if not found or st.status <> 'live' then
    update live_sessions set ended_at = now() where stream_id = p_stream and viewer_id = p_viewer and ended_at is null;
    return jsonb_build_object('ok', false, 'error', 'stream_ended');
  end if;
  price := setting_num('live_points_per_minute')::int;
  rate  := setting_num('live_creator_rate_usd');

  select points_balance into bal from profiles where id = p_viewer for update;
  select * into sess from live_sessions where stream_id = p_stream and viewer_id = p_viewer and ended_at is null for update;
  has_sess := found;

  if has_sess and now() < sess.paid_until - interval '15 seconds' then
    return jsonb_build_object('ok', true, 'charged', false, 'balance', bal, 'paid_until', sess.paid_until);
  end if;

  if bal < price then
    if has_sess then update live_sessions set ended_at = now() where id = sess.id; end if;
    return jsonb_build_object('ok', false, 'error', 'insufficient_points', 'needed', price, 'balance', bal);
  end if;

  update profiles set points_balance = points_balance - price where id = p_viewer
    returning points_balance into newbal;
  if has_sess then
    update live_sessions set paid_until = greatest(paid_until, now()) + interval '60 seconds',
      minutes_paid = minutes_paid + 1, points_spent = points_spent + price
      where id = sess.id returning * into sess;
  else
    insert into live_sessions(stream_id, viewer_id, paid_until, minutes_paid, points_spent)
      values (p_stream, p_viewer, now() + interval '60 seconds', 1, price) returning * into sess;
  end if;
  insert into points_ledger(user_id, delta, reason, ref_stream, balance_after)
    values (p_viewer, -price, 'live', p_stream, newbal);
  insert into earnings_ledger(creator_id, amount_usd, reason, ref_stream, ref_viewer)
    values (st.host_id, rate, 'live', p_stream, p_viewer);
  update streams set peak_viewers = greatest(peak_viewers,
    (select count(*) from live_sessions where stream_id = p_stream and ended_at is null)::int)
    where id = p_stream;
  return jsonb_build_object('ok', true, 'charged', true, 'spent', price, 'balance', newbal, 'paid_until', sess.paid_until);
end $$;

-- A viewer replies in a conversation a curator started. First N replies free, then points per reply.
create or replace function viewer_reply(p_viewer uuid, p_conv uuid, p_body text)
returns jsonb language plpgsql security definer as $$
declare c conversations; free int; cost int := 0; bal bigint; newbal bigint; mid bigint;
        batch int; prog int;
begin
  select * into c from conversations where id = p_conv for update;
  if not found or c.viewer_id <> p_viewer then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  free := setting_num('message_free_replies')::int;
  select points_balance into bal from profiles where id = p_viewer for update;
  newbal := bal;
  if c.viewer_replies >= free then
    cost := setting_num('message_reply_points')::int;
    if bal < cost then
      return jsonb_build_object('ok', false, 'error', 'insufficient_points', 'needed', cost, 'balance', bal);
    end if;
    update profiles set points_balance = points_balance - cost where id = p_viewer
      returning points_balance into newbal;
    insert into points_ledger(user_id, delta, reason, balance_after) values (p_viewer, -cost, 'message', newbal);
  end if;
  insert into messages(conversation_id, sender_id, body, cost) values (p_conv, p_viewer, p_body, cost) returning id into mid;
  update conversations set viewer_replies = viewer_replies + 1, last_message_at = now() where id = p_conv;

  -- creator reward: every N PAID replies (points actually spent) earns the creator a fixed amount.
  -- Free replies don't count, so fake accounts can't farm it.
  if cost > 0 then
    batch := setting_num('reply_batch_size')::int;
    update profiles set reply_progress = reply_progress + 1
      where id = c.curator_id and account_type = 'curator' returning reply_progress into prog;
    if prog is not null and batch > 0 and prog >= batch then
      update profiles set reply_progress = reply_progress - batch where id = c.curator_id;
      insert into earnings_ledger(creator_id, amount_usd, reason, ref_conversation, ref_viewer)
        values (c.curator_id, setting_num('reply_batch_usd'), 'reply', p_conv, p_viewer);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', mid, 'cost', cost, 'balance', newbal,
    'free_left', greatest(free - (c.viewer_replies + 1), 0));
end $$;

-- inbox for a user (curator or viewer)
create or replace function inbox(p_user uuid)
returns table(conv_id uuid, other_id uuid, other_username text, other_avatar text, blocked boolean,
              viewer_replies int, last_body text, last_at timestamptz, unread bigint)
language sql stable as $$
  select c.id, o.id, o.username, o.avatar_url, c.blocked, c.viewer_replies,
    (select m.body from messages m where m.conversation_id = c.id order by m.id desc limit 1),
    c.last_message_at,
    (select count(*) from messages m where m.conversation_id = c.id and m.sender_id <> p_user and m.read_at is null)
  from conversations c
  join profiles o on o.id = case when c.curator_id = p_user then c.viewer_id else c.curator_id end
  where c.curator_id = p_user or c.viewer_id = p_user
  order by c.last_message_at desc limit 100
$$;

create or replace function unread_total(p_user uuid)
returns bigint language sql stable as $$
  select count(*) from messages m join conversations c on c.id = m.conversation_id
  where (c.curator_id = p_user or c.viewer_id = p_user) and m.sender_id <> p_user and m.read_at is null
$$;

revoke execute on function live_charge(uuid, uuid) from public, anon, authenticated;
revoke execute on function viewer_reply(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function inbox(uuid) from public, anon, authenticated;
revoke execute on function unread_total(uuid) from public, anon, authenticated;

alter table streams enable row level security;
alter table live_sessions enable row level security;
alter table comments enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;

-- ---------- storage buckets ----------
insert into storage.buckets (id, name, public) values ('videos', 'videos', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('thumbs', 'thumbs', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;

-- To make an admin: sign up normally, then run
--   update profiles set account_type = 'admin' where lower(username) = 'yourusername';

-- ---------- follows ----------
create table if not exists follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  creator_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, creator_id),
  check (follower_id <> creator_id)
);
create index if not exists follows_creator on follows (creator_id);
alter table follows enable row level security;

-- ---------- paid media messages ----------
alter table messages drop constraint if exists messages_body_check;
alter table messages alter column body set default '';
alter table messages add constraint messages_body_check check (char_length(body) <= 1000);
alter table messages add column if not exists media_path text;
alter table messages add column if not exists media_type text;
alter table messages add column if not exists media_price int;
alter table messages drop constraint if exists messages_media_type_check;
alter table messages add constraint messages_media_type_check check (media_type is null or media_type in ('image','video'));
alter table messages drop constraint if exists messages_not_empty;
alter table messages add constraint messages_not_empty check (char_length(body) >= 1 or media_type is not null);

create table if not exists message_unlocks (
  id bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  points int not null,
  created_at timestamptz not null default now(),
  unique (message_id, viewer_id)
);
alter table message_unlocks enable row level security;

insert into settings (key, value) values
  ('media_image_points', '100'),        -- points a viewer pays to open a picture sent in messages
  ('media_video_points', '100'),        -- ...or a video
  ('media_creator_rate_usd', '0.002'),  -- creator earning per paid media unlock
  ('media_lifetime_hours', '24')        -- message pictures/videos are deleted from storage after this (0 = keep)
on conflict (key) do nothing;

alter table points_ledger drop constraint if exists points_ledger_reason_check;
alter table points_ledger add constraint points_ledger_reason_check
  check (reason in ('purchase','unlock','admin_adjust','live','message','media'));
alter table points_ledger add column if not exists ref_message bigint;
alter table earnings_ledger drop constraint if exists earnings_ledger_reason_check;
alter table earnings_ledger add constraint earnings_ledger_reason_check
  check (reason in ('unlock','live','reply','media','withdrawal_hold','withdrawal_release','admin_adjust'));
alter table earnings_ledger add column if not exists ref_message bigint;
create unique index if not exists earnings_one_per_media
  on earnings_ledger (creator_id, ref_message, ref_viewer) where reason = 'media';

create or replace function unlock_message_media(p_viewer uuid, p_message bigint)
returns jsonb language plpgsql security definer as $$
declare m messages; c conversations; vstatus text; vtype text; bal bigint; newbal bigint; price int;
begin
  select account_type, status into vtype, vstatus from profiles where id = p_viewer;
  if vtype is distinct from 'viewer' or vstatus <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  select * into m from messages where id = p_message and media_path is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into c from conversations where id = m.conversation_id;
  if c.viewer_id <> p_viewer or m.sender_id <> c.curator_id then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if exists (select 1 from message_unlocks where message_id = p_message and viewer_id = p_viewer) then
    select points_balance into bal from profiles where id = p_viewer;
    return jsonb_build_object('ok', true, 'already', true, 'balance', bal);
  end if;
  price := m.media_price;
  select points_balance into bal from profiles where id = p_viewer for update;
  if bal < price then
    return jsonb_build_object('ok', false, 'error', 'insufficient_points', 'needed', price, 'balance', bal);
  end if;
  update profiles set points_balance = points_balance - price where id = p_viewer returning points_balance into newbal;
  insert into points_ledger(user_id, delta, reason, ref_message, balance_after) values (p_viewer, -price, 'media', p_message, newbal);
  insert into message_unlocks(message_id, viewer_id, points) values (p_message, p_viewer, price);
  insert into earnings_ledger(creator_id, amount_usd, reason, ref_message, ref_viewer)
    values (c.curator_id, setting_num('media_creator_rate_usd'), 'media', p_message, p_viewer);
  return jsonb_build_object('ok', true, 'balance', newbal, 'price', price);
end $$;
revoke execute on function unlock_message_media(uuid, bigint) from public, anon, authenticated;

create or replace function inbox(p_user uuid)
returns table(conv_id uuid, other_id uuid, other_username text, other_avatar text, blocked boolean,
              viewer_replies int, last_body text, last_at timestamptz, unread bigint)
language sql stable as $$
  select c.id, o.id, o.username, o.avatar_url, c.blocked, c.viewer_replies,
    (select coalesce(nullif(m.body, ''), case m.media_type when 'image' then 'Picture' when 'video' then 'Video' else '' end)
       from messages m where m.conversation_id = c.id order by m.id desc limit 1),
    c.last_message_at,
    (select count(*) from messages m where m.conversation_id = c.id and m.sender_id <> p_user and m.read_at is null)
  from conversations c
  join profiles o on o.id = case when c.curator_id = p_user then c.viewer_id else c.curator_id end
  where c.curator_id = p_user or c.viewer_id = p_user
  order by c.last_message_at desc limit 100
$$;
revoke execute on function inbox(uuid) from public, anon, authenticated;

-- ---------- creator directory ----------
create or replace function creator_directory()
returns table(id uuid, username text, avatar_url text, followers bigint, videos bigint, live boolean, last_active timestamptz)
language sql stable as $$
  select p.id, p.username, p.avatar_url,
    (select count(*) from follows f where f.creator_id = p.id),
    (select count(*) from videos v where v.owner_id = p.id and v.status = 'approved'),
    exists (select 1 from streams s where s.host_id = p.id and s.status = 'live' and s.last_ping > now() - interval '120 seconds'),
    greatest((select max(v.approved_at) from videos v where v.owner_id = p.id and v.status = 'approved'),
             (select max(s.started_at) from streams s where s.host_id = p.id))
  from profiles p
  where p.account_type = 'curator' and p.status = 'active'
$$;
revoke execute on function creator_directory() from public, anon, authenticated;
