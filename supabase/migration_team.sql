-- VIDXX Team welcome messages + labeled demo accounts. Safe to re-run.
alter table profiles add column if not exists is_demo boolean not null default false;
alter table profiles add column if not exists is_system boolean not null default false;
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'welcomed_at') then
    alter table profiles add column welcomed_at timestamptz;
    update profiles set welcomed_at = now() where account_type = 'viewer';   -- existing viewers are not welcomed retroactively
  end if;
end $$;

insert into settings (key, value) values
  ('welcome_enabled', '1'),
  ('welcome_delay_seconds', '3'),
  ('welcome_gap_seconds', '10'),
  ('demo_enabled', '1'),
  ('welcome_text', E'Welcome to VIDXX! 👋 Browse videos in Explore. Every video has a free 10-second preview.\n---\nUnlock a full video with points. Get points any time in Buy Points (M-Pesa, card or bank).\n---\nFollow creators you like, and you will see a dot when they go live. This is an automated message from the VIDXX Team.')
on conflict (key) do nothing;

create or replace function viewer_reply(p_viewer uuid, p_conv uuid, p_body text)
returns jsonb language plpgsql security definer as $$
declare c conversations; free int; cost int := 0; bal bigint; newbal bigint; mid bigint;
        batch int; prog int;
begin
  select * into c from conversations where id = p_conv for update;
  if not found or c.viewer_id <> p_viewer then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.curator_blocked then
    return jsonb_build_object('ok', false, 'error', 'blocked_by_creator');
  end if;
  free := setting_num('message_free_replies')::int;
  select points_balance into bal from profiles where id = p_viewer for update;
  newbal := bal;
  if c.viewer_replies >= free and not coalesce((select is_system from profiles where id = c.curator_id), false) then
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

drop function if exists creator_directory();
create or replace function creator_directory()
returns table(id uuid, username text, avatar_url text, followers bigint, videos bigint, live boolean, last_active timestamptz, demo boolean)
language sql stable as $$
  select p.id, p.username, p.avatar_url,
    (select count(*) from follows f where f.creator_id = p.id),
    (select count(*) from videos v where v.owner_id = p.id and v.status = 'approved'),
    exists (select 1 from streams s where s.host_id = p.id and s.status = 'live' and s.last_ping > now() - interval '120 seconds'),
    greatest((select max(v.approved_at) from videos v where v.owner_id = p.id and v.status = 'approved'),
             (select max(s.started_at) from streams s where s.host_id = p.id)),
    p.is_demo
  from profiles p
  where p.account_type = 'curator' and p.status = 'active' and not p.is_system
$$;
revoke execute on function creator_directory() from public, anon, authenticated;
revoke execute on function viewer_reply(uuid, uuid, text) from public, anon, authenticated;
