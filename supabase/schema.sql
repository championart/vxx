-- ClipVault schema. Run in the Supabase SQL editor (once).
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
  ('usd_to_kes', '129')                   -- used to show withdrawals in KES
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
  created_at timestamptz not null default now()
);
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
create or replace function credit_payment(p_reference text, p_channel text, p_amount_kes int)
returns text language plpgsql security definer as $$
declare pay payments; newbal bigint;
begin
  select * into pay from payments where reference = p_reference for update;
  if not found then return 'not_found'; end if;
  if pay.status = 'success' then return 'already_credited'; end if;
  if p_amount_kes < pay.amount_kes then
    update payments set status = 'failed' where id = pay.id;
    insert into audit_log(actor_id, action, detail)
      values (pay.user_id, 'payment_amount_mismatch', jsonb_build_object('reference', p_reference, 'expected', pay.amount_kes, 'got', p_amount_kes));
    return 'amount_mismatch';
  end if;
  update profiles set points_balance = points_balance + pay.points where id = pay.user_id
    returning points_balance into newbal;
  update payments set status = 'success', channel = p_channel, paid_at = now() where id = pay.id;
  insert into points_ledger(user_id, delta, reason, ref_payment, balance_after)
    values (pay.user_id, pay.points, 'purchase', pay.id, newbal);
  insert into audit_log(actor_id, action, detail)
    values (pay.user_id, 'points_purchased', jsonb_build_object('reference', p_reference, 'points', pay.points, 'kes', pay.amount_kes));
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
    'total_earned', coalesce(sum(amount_usd) filter (where reason in ('unlock','admin_adjust')), 0),
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
  where creator_id = p_creator and reason = 'unlock' and created_at >= p_since
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
    'creator_earned_usd', (select coalesce(sum(amount_usd), 0) from earnings_ledger where reason in ('unlock','admin_adjust')),
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
revoke execute on function credit_payment(text, text, int) from public, anon, authenticated;
revoke execute on function unlock_video(uuid, uuid) from public, anon, authenticated;
revoke execute on function request_withdrawal(uuid, numeric, text, text) from public, anon, authenticated;
revoke execute on function review_withdrawal(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function creator_balance(uuid) from public, anon, authenticated;

-- ---------- storage buckets ----------
insert into storage.buckets (id, name, public) values ('videos', 'videos', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('thumbs', 'thumbs', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;

-- To make an admin: sign up normally, then run
--   update profiles set account_type = 'admin' where lower(username) = 'yourusername';
