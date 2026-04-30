create extension if not exists pgcrypto;

create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  email text not null,
  persona text not null,
  persona_other text,
  first_use_case text not null,
  use_case text not null,
  monthly_volume text not null,
  market_context text not null,
  lead_status text not null default 'new',
  lead_score integer not null default 0,
  qualified_for_call boolean not null default false,
  referrer text,
  page_url text,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  user_agent text
);

alter table public.waitlist_signups enable row level security;

drop policy if exists "waitlist inserts from public site" on public.waitlist_signups;

create policy "waitlist inserts from public site"
on public.waitlist_signups
for insert
to anon, authenticated
with check (true);
