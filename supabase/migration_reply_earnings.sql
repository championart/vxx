-- VIDXX: creators earn a reward for every N paid viewer replies.
-- Run once in Supabase -> SQL Editor. Safe to run again.

insert into settings (key, value) values
  ('reply_batch_size', '10'),
  ('reply_batch_usd', '0.01')
on conflict (key) do nothing;

alter table profiles add column if not exists reply_progress int not null default 0;
alter table earnings_ledger add column if not exists ref_conversation uuid;
alter table earnings_ledger drop constraint if exists earnings_ledger_reason_check;
alter table earnings_ledger add constraint earnings_ledger_reason_check
  check (reason in ('unlock','live','reply','withdrawal_hold','withdrawal_release','admin_adjust'));

create or replace function creator_balance(p_creator uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total_earned', coalesce(sum(amount_usd) filter (where reason in ('unlock','live','reply','admin_adjust')), 0),
    'pending',      coalesce(-sum(amount_usd) filter (where reason = 'withdrawal_hold'), 0)
                    - coalesce(sum(amount_usd) filter (where reason = 'withdrawal_release'), 0),
    'available',    coalesce(sum(amount_usd), 0)
  ) from earnings_ledger where creator_id = p_creator
$$;

create or replace function creator_report(p_creator uuid, p_unit text, p_since timestamptz)
returns table(bucket date, unlocks bigint, earned numeric)
language sql stable as $$
  select date_trunc(p_unit, created_at)::date, count(*), sum(amount_usd)
  from earnings_ledger
  where creator_id = p_creator and reason in ('unlock','live','reply') and created_at >= p_since
  group by 1 order by 1
$$;

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

-- keep the admin overview total in step (adds reply earnings)
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
