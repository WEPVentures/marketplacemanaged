-- Messenger webhook inbox. The Netlify function (netlify/functions/messenger-webhook.js) verifies Meta's
-- signature and calls record_webhook_event(); the Messenger agent (service_role) reads rows, acts on them,
-- and sets processed_at. Safe to re-run. Apply after 0004.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.config (key text primary key, value text not null);
revoke all on private.config from public, anon, authenticated;

-- 1) Inbox table. RLS on, ZERO policies: only the service role (agent) and the security-definer RPC touch it.
create table if not exists public.webhook_events (
  id           bigserial primary key,
  received_at  timestamptz not null default now(),
  dedupe_key   text not null unique,          -- message id, or a hash of the event; makes Meta's retries idempotent
  psid         text,                          -- Messenger page-scoped user id
  event_type   text not null check (event_type in ('message', 'postback', 'referral')),
  event_ts     timestamptz,
  payload      jsonb not null,                -- raw event; may hold message text and attachment URLs (bearer URLs)
  processed_at timestamptz
);
create index if not exists webhook_events_unprocessed_idx on public.webhook_events (id) where processed_at is null;
alter table public.webhook_events enable row level security;

-- 2) Ingest secret: generated here, shown once below. Copy it into Netlify as WEBHOOK_INGEST_SECRET.
insert into private.config (key, value)
  values ('webhook_ingest_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;

-- 3) The only write path from the website's function. Callable with the public anon key, but it does nothing
--    unless p_secret matches the stored ingest secret, and it can only insert into webhook_events.
create or replace function public.record_webhook_event(p_secret text, p_events jsonb) returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_secret text; v_n integer;
begin
  select value into v_secret from private.config where key = 'webhook_ingest_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'bad request' using errcode = '22023';
  end if;
  insert into public.webhook_events (dedupe_key, psid, event_type, event_ts, payload)
  select e->>'dedupe_key', e->>'psid', e->>'event_type',
         to_timestamp((e->>'event_ts')::numeric / 1000.0), e->'payload'
    from jsonb_array_elements(p_events) e
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.record_webhook_event(text, jsonb) from public;
grant execute on function public.record_webhook_event(text, jsonb) to anon, authenticated;

-- 4) Retention: payloads can hold message text and expiring-but-live attachment URLs, so keep them briefly.
--    Processed events are deleted after 24 hours; anything still unprocessed after 7 days is deleted too.
create or replace function private.purge_webhook_events() returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_n integer;
begin
  delete from public.webhook_events
   where (processed_at is not null and processed_at < now() - interval '24 hours')
      or received_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function private.purge_webhook_events() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.unschedule('purge-webhook-events') where exists (select 1 from cron.job where jobname = 'purge-webhook-events');
select cron.schedule('purge-webhook-events', '41 * * * *', $$select private.purge_webhook_events()$$);

-- 5) Show the ingest secret once so it can be copied into Netlify. Treat it like a password.
select value as webhook_ingest_secret from private.config where key = 'webhook_ingest_secret';
