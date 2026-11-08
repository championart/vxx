-- Viewers can start conversations; creators can block viewers. Safe to re-run.
alter table conversations add column if not exists curator_blocked boolean not null default false;

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
revoke execute on function viewer_reply(uuid, uuid, text) from public, anon, authenticated;
