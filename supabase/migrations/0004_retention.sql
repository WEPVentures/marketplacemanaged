-- Retention + deletion, backing the privacy policy:
--   "Intake data for items that never list is deleted within 90 days."
--   "You may request ... deletion at any time."
-- Photos: unreviewed photos are held only transiently in the private `intake-photos` bucket (7-day maximum).
-- SQL cannot delete storage objects, so file deletion is done by the agent / an Edge Function through the
-- Storage API. These functions only touch rows (and return the file paths that must be removed).
-- Safe to re-run. Apply after 0003.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 1) Daily purge of stale, never-listed intakes.
--    new / quoted  -> row deleted.
--    paid          -> payment happened, so keep a minimal record (ref, status, quote, timestamps) and
--                     erase everything personal or descriptive.
--    listed / sold -> untouched (transaction records, kept as long as needed for accounting/legal).
create or replace function private.purge_stale_intakes() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_deleted int; v_scrubbed int;
begin
  delete from public.intakes i
   where i.created_at < now() - interval '90 days'
     and i.status in ('new', 'quoted')
     and not exists (select 1 from public.items it where it.intake_ref = i.ref);
  get diagnostics v_deleted = row_count;

  update public.intakes i
     set customer_name = null, messenger_psid = null, title = null, description = null,
         model_number = null, damage = null, included = null, photo_refs = '{}'
   where i.created_at < now() - interval '90 days'
     and i.status = 'paid'
     and (i.customer_name is not null or i.messenger_psid is not null or i.title is not null
          or i.description is not null or i.model_number is not null or i.damage is not null
          or i.included is not null or cardinality(i.photo_refs) > 0)
     and not exists (select 1 from public.items it where it.intake_ref = i.ref);
  get diagnostics v_scrubbed = row_count;

  return jsonb_build_object('deleted', v_deleted, 'scrubbed', v_scrubbed);
end $$;
revoke all on function private.purge_stale_intakes() from public, anon, authenticated;

-- 2) Schedule it daily at 03:17 UTC with pg_cron (enabled by the line below; on Supabase you can also
--    enable it under Database > Extensions).
create extension if not exists pg_cron;
select cron.unschedule('purge-stale-intakes') where exists (select 1 from cron.job where jobname = 'purge-stale-intakes');
select cron.schedule('purge-stale-intakes', '17 3 * * *', $$select private.purge_stale_intakes()$$);

-- 3) On-request deletion for one customer (called by the Messenger agent / an admin with the service_role key).
--    Deletes their published items and intakes and RETURNS {item_photos: [...], intake_photos: [...]} so the
--    caller can remove those files from `item-photos` / `intake-photos` via the Storage API (SQL can't delete
--    storage objects). The caller should first confirm the request in the customer's Messenger thread.
--    Deleting a customer's data before a sale completes cancels the listing. Meta's own copy of the
--    conversation can't be deleted by us (see the privacy policy).
drop function if exists public.delete_customer_data(text);
create or replace function public.delete_customer_data(p_psid text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_item_paths text[]; v_intake_paths text[];
begin
  if p_psid is null or length(trim(p_psid)) = 0 then
    raise exception 'psid required';
  end if;

  select coalesce(array_agg(p), '{}') into v_item_paths
    from public.items it
    join public.intakes i on i.ref = it.intake_ref
    cross join lateral unnest(it.photo_urls) as p
   where i.messenger_psid = p_psid;

  select coalesce(array_agg(p), '{}') into v_intake_paths
    from public.intakes i
    cross join lateral unnest(i.photo_refs) as p
   where i.messenger_psid = p_psid;

  delete from public.items it using public.intakes i
   where it.intake_ref = i.ref and i.messenger_psid = p_psid;
  delete from public.intakes where messenger_psid = p_psid;

  return jsonb_build_object('item_photos', to_jsonb(v_item_paths), 'intake_photos', to_jsonb(v_intake_paths));
end $$;
revoke all on function public.delete_customer_data(text) from public, anon, authenticated;
grant execute on function public.delete_customer_data(text) to service_role;
