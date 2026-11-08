-- Follow curators. Safe to re-run.
create table if not exists follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  creator_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, creator_id),
  check (follower_id <> creator_id)
);
create index if not exists follows_creator on follows (creator_id);
alter table follows enable row level security;
