-- Keep only the core waitlist fields used for signup qualification and follow-up.
-- This removes the tracking columns that are currently optional/extra.

alter table public.waitlist_signups
  drop column if exists referrer,
  drop column if exists page_url,
  drop column if exists landing_path,
  drop column if exists utm_source,
  drop column if exists utm_medium,
  drop column if exists utm_campaign,
  drop column if exists utm_term,
  drop column if exists utm_content,
  drop column if exists user_agent;
