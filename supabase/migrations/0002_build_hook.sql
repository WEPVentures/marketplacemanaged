-- Fires the Netlify build hook when the PUBLIC set of items changes, so item pages
-- appear/disappear in ~a minute. Optional but recommended.
--
-- 1) Create a Netlify build hook (Site settings > Build & deploy > Build hooks).
-- 2) Store its URL (once, replace the value below):
--      insert into private.config (key, value) values ('netlify_build_hook', 'https://api.netlify.com/build_hooks/XXXX')
--      on conflict (key) do update set value = excluded.value;
-- Until a URL is stored the trigger is a no-op.

create extension if not exists pg_net with schema extensions;
create schema if not exists private;
create table if not exists private.config (key text primary key, value text not null);
revoke all on schema private from public, anon, authenticated;
revoke all on private.config from public, anon, authenticated;

create or replace function private.notify_netlify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_url text; v_fire boolean := false;
begin
  if tg_op = 'INSERT' then
    v_fire := new.status = 'active';                          -- item accepted/published
  elsif tg_op = 'UPDATE' then
    v_fire := (new.status = 'active' or old.status = 'active')  -- sold (or re-activated), or live item edited
              and (to_jsonb(new) is distinct from to_jsonb(old));
  elsif tg_op = 'DELETE' then
    v_fire := old.status = 'active';
  end if;
  if v_fire then
    select value into v_url from private.config where key = 'netlify_build_hook';
    if v_url is not null then
      perform net.http_post(url := v_url, body := '{}'::jsonb);
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists items_netlify_hook on public.items;
create trigger items_netlify_hook after insert or update or delete on public.items
  for each row execute function private.notify_netlify();
