-- Admin announcements to viewers, curators, everyone, or one user. Safe to re-run.
create table if not exists announcements (
  id bigserial primary key,
  body text not null check (char_length(body) between 1 and 1000),
  audience text not null check (audience in ('all','viewers','curators','user')),
  user_id uuid references profiles(id) on delete cascade,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists announcements_created on announcements (created_at desc);
create table if not exists announcement_reads (
  user_id uuid not null references profiles(id) on delete cascade,
  announcement_id bigint not null references announcements(id) on delete cascade,
  primary key (user_id, announcement_id)
);
alter table announcements enable row level security;
alter table announcement_reads enable row level security;
