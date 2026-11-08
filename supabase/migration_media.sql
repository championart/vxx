-- Paid picture/video messages (curator -> viewer). Safe to re-run.
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
