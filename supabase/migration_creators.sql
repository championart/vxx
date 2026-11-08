-- Creator directory (popular active creators first). Safe to re-run.
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
