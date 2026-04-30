alter table public.waitlist_signups
  drop column if exists ip_timezone,
  drop column if exists ip_city,
  drop column if exists ip_region;
