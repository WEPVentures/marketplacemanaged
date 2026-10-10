-- Marketplace. Managed. — core schema, RLS, storage.
-- Run in the Supabase SQL editor (or `supabase db push`).

-- ---------- refs ----------
create sequence if not exists public.intake_ref_seq start 1;
create sequence if not exists public.item_id_seq start 1;

-- ---------- intakes (PRIVATE: no anon/authenticated policies at all) ----------
create table if not exists public.intakes (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique
                   default ('intake-' || lpad(nextval('public.intake_ref_seq')::text, 4, '0')),
  customer_name  text not null check (char_length(customer_name) between 1 and 80),
  title          text not null check (char_length(title) between 1 and 120),
  description    text not null check (char_length(description) <= 2000),
  condition      text not null check (condition in ('Like new','Good','Fair','For parts')),
  model_number   text check (char_length(model_number) <= 80),
  works          text not null check (works in ('yes','no','partially')),
  damage         text check (char_length(damage) <= 1000),
  included       text check (char_length(included) <= 1000),
  -- Object paths inside the private `intake-photos` bucket, hero first.
  photo_urls     text[] not null check (cardinality(photo_urls) between 1 and 8),
  status         text not null default 'new' check (status in ('new','quoted','paid','listed','sold')),
  quote_band     text,            -- e.g. '$40–$60' (set by the processing agent)
  floor          numeric(8,2),    -- lowest acceptable price (set by the processing agent)
  created_at     timestamptz not null default now()
);
create index if not exists intakes_status_idx on public.intakes (status, created_at);
alter table public.intakes enable row level security;
-- Deliberately NO policies: anon/authenticated can neither read nor write directly.
-- The browser only writes through submit_intake(); the agent uses the service_role key (bypasses RLS).

-- ---------- items (public read of ACTIVE rows only) ----------
create table if not exists public.items (
  id            text primary key
                  default ('item-' || lpad(nextval('public.item_id_seq')::text, 4, '0')),
  intake_ref    text references public.intakes(ref),
  title         text not null,
  description   text not null default '',
  price         numeric(8,2) not null check (price >= 0),
  condition     text not null check (condition in ('Like new','Good','Fair','For parts')),
  -- Paths in the public `item-photos` bucket (or absolute URLs), hero first.
  photo_urls    text[] not null default '{}',
  status        text not null default 'active' check (status in ('active','sold')),
  published_at  timestamptz not null default now()
);
create index if not exists items_status_idx on public.items (status, published_at desc);
alter table public.items enable row level security;

drop policy if exists "public can read active items" on public.items;
create policy "public can read active items" on public.items
  for select to anon, authenticated using (status = 'active');

-- ---------- submit_intake(): the ONLY way the browser writes an intake ----------
create or replace function public.submit_intake(
  p_customer_name text, p_title text, p_description text, p_condition text,
  p_model_number text, p_works text, p_damage text, p_included text, p_photo_paths text[]
) returns text
language plpgsql security definer set search_path = ''
as $$
declare v_ref text; p text;
begin
  if p_photo_paths is null or cardinality(p_photo_paths) not between 1 and 8 then
    raise exception 'photos required (1-8)';
  end if;
  foreach p in array p_photo_paths loop
    if p !~ '^[0-9a-f-]{36}/[0-9]{1,2}-[0-9a-f]{16}\.(jpg|jpeg|png|webp|heic)$' then
      raise exception 'invalid photo path';
    end if;
  end loop;
  insert into public.intakes (customer_name, title, description, condition, model_number, works, damage, included, photo_urls)
  values (trim(p_customer_name), trim(p_title), trim(p_description), p_condition,
          nullif(trim(p_model_number), ''), p_works, nullif(trim(p_damage), ''), nullif(trim(p_included), ''), p_photo_paths)
  returning ref into v_ref;   -- CHECK constraints validate lengths/enums
  return v_ref;
end $$;
revoke all on function public.submit_intake(text,text,text,text,text,text,text,text,text[]) from public;
grant execute on function public.submit_intake(text,text,text,text,text,text,text,text,text[]) to anon, authenticated;

-- ---------- storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('intake-photos', 'intake-photos', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic']),
  ('item-photos',   'item-photos',   true,  10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- intake-photos: anon may INSERT (path-constrained). No select/update/delete => not readable or listable by the public.
drop policy if exists "anon can upload intake photos" on storage.objects;
create policy "anon can upload intake photos" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'intake-photos'
              and name ~ '^[0-9a-f-]{36}/[0-9]{1,2}-[0-9a-f]{16}\.(jpg|jpeg|png|webp|heic)$');

-- item-photos: public bucket => files are readable by URL; no write policies => only service_role can write.
