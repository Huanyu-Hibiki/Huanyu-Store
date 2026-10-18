-- 一期全部表。字段与 docs/designs/2026-10-18-store-api-design.md「数据模型」逐字对齐；
-- 幂等用 if not exists，版本记录由 scripts/migrate.mjs 写入 schema_migrations。
create table if not exists users (
  id uuid primary key,
  email text not null unique,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists login_codes (
  email text not null,
  code_hash text not null,
  ip text,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists web_sessions (
  id uuid primary key,
  user_id uuid not null references users (id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists cli_tokens (
  id uuid primary key,
  user_id uuid not null references users (id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists device_grants (
  device_code_hash text primary key,
  user_code text not null unique,
  user_id uuid references users (id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  interval_seconds int not null default 5,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id text primary key,
  name text not null,
  summary text,
  repo text,
  page text,
  free_skill text unique,
  paid_skill text unique,
  prices jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists releases (
  skill text not null,
  version text not null,
  sha256 char(64) not null,
  size int not null,
  notes text,
  blob_path text not null,
  yanked boolean not null default false,
  published_at timestamptz not null default now(),
  primary key (skill, version)
);
