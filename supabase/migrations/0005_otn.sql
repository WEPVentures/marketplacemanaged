-- One-Time Notification (OTN) support for Messenger.
-- Meta only lets a Page message a user within 24 hours of the user's last message. An OTN token, obtained
-- when the user taps an opt-in during an active conversation, lets us send ONE follow-up later (e.g. the
-- day-7 price-reduction notice). Tokens are single-use, so each follow-up needs a fresh opt-in.
-- The token is a sending credential: keep it service-role only, never log it, and erase it with the rest
-- of the customer's data (see the purge and delete_customer_data below). Safe to re-run. Apply after 0004.

alter table public.intakes add column if not exists otn_token       text;         -- single-use; null once spent
alter table public.intakes add column if not exists otn_topic       text;         -- what the user opted in to, e.g. 'price_changes'
alter table public.intakes add column if not exists otn_opted_in_at timestamptz;

-- The 90-day purge now also erases the OTN token/topic when it scrubs an unlisted paid intake.
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
         model_number = null, damage = null, included = null, photo_refs = '{}',
         otn_token = null, otn_topic = null, otn_opted_in_at = null
   where i.created_at < now() - interval '90 days'
     and i.status = 'paid'
     and (i.customer_name is not null or i.messenger_psid is not null or i.title is not null
          or i.description is not null or i.model_number is not null or i.damage is not null
          or i.included is not null or cardinality(i.photo_refs) > 0 or i.otn_token is not null)
     and not exists (select 1 from public.items it where it.intake_ref = i.ref);
  get diagnostics v_scrubbed = row_count;

  return jsonb_build_object('deleted', v_deleted, 'scrubbed', v_scrubbed);
end $$;
revoke all on function private.purge_stale_intakes() from public, anon, authenticated;
-- delete_customer_data() deletes whole intake rows, so any OTN token goes with them.
