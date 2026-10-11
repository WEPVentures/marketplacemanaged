-- Messenger-only intake. The website no longer writes anything: no form, no photo upload.
-- Intakes are created and managed by the Messenger agent (service_role). The site only reads active items.
-- Safe to re-run. Apply after 0001 (and 0002).

-- 1) Remove the browser write paths added in 0001.
drop function if exists public.submit_intake(text,text,text,text,text,text,text,text,text[]);
drop policy if exists "anon can upload intake photos" on storage.objects;

-- 2) intakes: reshape for a conversational flow. Details arrive over several messages, so they are nullable.
alter table public.intakes add column if not exists messenger_psid text;   -- Messenger page-scoped user id
create index if not exists intakes_psid_idx on public.intakes (messenger_psid);

alter table public.intakes alter column customer_name drop not null;
alter table public.intakes alter column title         drop not null;
alter table public.intakes alter column description   drop not null;
alter table public.intakes alter column condition     drop not null;
alter table public.intakes alter column works         drop not null;

-- photo_urls -> photo_refs: paths of the customer's photos in the PRIVATE `intake-photos` bucket
-- (transient copies, see the end of this file). Never store Meta attachment URLs here: they are bearer URLs.
alter table public.intakes drop constraint if exists intakes_photo_urls_check;
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='intakes' and column_name='photo_urls') then
    alter table public.intakes rename column photo_urls to photo_refs;
  end if;
end $$;
alter table public.intakes alter column photo_refs drop not null;
alter table public.intakes alter column photo_refs set default '{}';

-- RLS on intakes stays ON with zero policies: the public key can never read or write it.

-- 3) `intake-photos` stays, as a PRIVATE, TRANSIENT bucket. Messenger attachment URLs expire, so the agent
--    downloads each photo (service_role) at receipt, reviews it from that copy, and then either deletes it
--    (declined) or copies it to the public `item-photos` bucket (approved). Anything left is deleted within
--    7 days. The browser has no access: the anon upload policy was dropped above and no select policy exists.
--    NOTE: Supabase Storage has no built-in lifecycle rule and SQL can't delete storage objects, so the
--    7-day purge must be run by the agent (or an Edge Function) through the Storage API.
