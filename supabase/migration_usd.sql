-- USD support for visitors outside Kenya. Safe to re-run.
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
revoke execute on function credit_payment(text, text, text, int) from public, anon, authenticated;
