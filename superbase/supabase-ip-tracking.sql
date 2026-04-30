alter table public.waitlist_signups
  add column if not exists ip_address inet,
  add column if not exists ip_country text,
  add column if not exists ip_region text,
  add column if not exists ip_city text,
  add column if not exists ip_timezone text,
  add column if not exists request_headers jsonb,
  add column if not exists tracked_at timestamptz;
