-- Run this in Supabase SQL Editor

create extension if not exists pgcrypto;

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  purpose text not null check (purpose in ('Business', 'Private')),
  odo_start numeric(10,2) not null,
  odo_end numeric(10,2) not null,
  km numeric(10,2) not null,
  from_location text,
  to_location text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists fares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  week_end date,
  platform text not null,
  gross numeric(12,2) not null,
  gst_included boolean not null default true,
  platform_fee numeric(12,2) not null default 0,
  platform_fee_gst numeric(12,2) not null default 0,
  tip_extra numeric(12,2) not null default 0,
  net_payout numeric(12,2) not null default 0,
  created_at timestamptz default now()
);

alter table fares add column if not exists week_end date;
alter table fares add column if not exists platform_fee numeric(12,2) not null default 0;
alter table fares add column if not exists platform_fee_gst numeric(12,2) not null default 0;
alter table fares add column if not exists tip_extra numeric(12,2) not null default 0;
alter table fares add column if not exists net_payout numeric(12,2) not null default 0;
update fares
set week_end = coalesce(week_end, date + 6),
    net_payout = case
      when coalesce(net_payout, 0) = 0 then coalesce(gross, 0) + coalesce(tip_extra, 0) - coalesce(platform_fee, 0)
      else net_payout
    end
where week_end is null or coalesce(net_payout, 0) = 0;

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  category text not null,
  amount numeric(12,2) not null,
  is_vehicle_expense boolean,
  gst_amount numeric(12,2) not null default 0,
  gst_claimable boolean not null default true,
  gst_credit numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz default now()
);

alter table expenses add column if not exists gst_amount numeric(12,2) not null default 0;
alter table expenses add column if not exists gst_credit numeric(12,2) not null default 0;
alter table expenses add column if not exists is_vehicle_expense boolean;
update expenses
set gst_amount = case when coalesce(gst_amount, 0) = 0 and gst_claimable then round(amount / 11.0, 2) else coalesce(gst_amount, 0) end,
    gst_credit = case when coalesce(gst_credit, 0) = 0 and gst_claimable then coalesce(gst_amount, round(amount / 11.0, 2)) else coalesce(gst_credit, 0) end
where coalesce(gst_amount, 0) = 0 or coalesce(gst_credit, 0) = 0;
update expenses
set is_vehicle_expense = lower(category) in ('fuel', 'maintenance', 'insurance', 'registration', 'car wash', 'cleaning service')
where is_vehicle_expense is null;

create table if not exists tolls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  amount numeric(12,2) not null,
  reimbursed boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_date date not null default current_date,
  title text not null default 'Receipt',
  image_data text not null,
  created_at timestamptz default now()
);

create table if not exists tax_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  other_income numeric(12,2) not null default 0,
  super_contribution numeric(12,2) not null default 0,
  deduction_method text not null default 'logbook' check (deduction_method in ('logbook', 'cents_per_km')),
  cents_per_km_rate numeric(6,2) not null default 0.88,
  cents_per_km_cap numeric(8,0) not null default 5000,
  tax_reserve_pct numeric(5,2) not null default 22,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table tax_settings add column if not exists deduction_method text not null default 'logbook';
alter table tax_settings add column if not exists cents_per_km_rate numeric(6,2) not null default 0.88;
alter table tax_settings add column if not exists cents_per_km_cap numeric(8,0) not null default 5000;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tax_settings_deduction_method_check'
      and conrelid = 'tax_settings'::regclass
  ) then
    alter table tax_settings
      add constraint tax_settings_deduction_method_check
      check (deduction_method in ('logbook', 'cents_per_km'));
  end if;
end $$;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  role text not null default 'driver' check (role in ('admin', 'driver')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists platform_options (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_default boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

alter table profiles add column if not exists role text not null default 'driver';
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('admin', 'driver'));
update profiles
set role = 'admin', updated_at = now()
where lower(email) = 'jobitpgeorge@gmail.com';

alter table trips enable row level security;
alter table fares enable row level security;
alter table expenses enable row level security;
alter table tolls enable row level security;
alter table receipts enable row level security;
alter table tax_settings enable row level security;
alter table profiles enable row level security;
alter table platform_options enable row level security;

create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

drop policy if exists "trips owner read" on trips;
drop policy if exists "trips owner write" on trips;
create policy "trips owner read" on trips for select using (auth.uid() = user_id);
create policy "trips owner write" on trips for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "fares owner read" on fares;
drop policy if exists "fares owner write" on fares;
create policy "fares owner read" on fares for select using (auth.uid() = user_id);
create policy "fares owner write" on fares for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "expenses owner read" on expenses;
drop policy if exists "expenses owner write" on expenses;
create policy "expenses owner read" on expenses for select using (auth.uid() = user_id);
create policy "expenses owner write" on expenses for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tolls owner read" on tolls;
drop policy if exists "tolls owner write" on tolls;
create policy "tolls owner read" on tolls for select using (auth.uid() = user_id);
create policy "tolls owner write" on tolls for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "receipts owner read" on receipts;
drop policy if exists "receipts owner write" on receipts;
create policy "receipts owner read" on receipts for select using (auth.uid() = user_id);
create policy "receipts owner write" on receipts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tax owner read" on tax_settings;
drop policy if exists "tax owner write" on tax_settings;
create policy "tax owner read" on tax_settings for select using (auth.uid() = user_id);
create policy "tax owner write" on tax_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "profiles owner read" on profiles;
drop policy if exists "profiles owner upsert own" on profiles;
drop policy if exists "profiles owner update own" on profiles;
drop policy if exists "profiles admin read all" on profiles;
drop policy if exists "profiles admin update all" on profiles;
create policy "profiles owner read" on profiles for select using (auth.uid() = id);
create policy "profiles owner upsert own" on profiles for insert with check (auth.uid() = id);
create policy "profiles owner update own" on profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles admin read all" on profiles for select using (public.is_current_user_admin());
create policy "profiles admin update all" on profiles for update using (public.is_current_user_admin()) with check (public.is_current_user_admin());

drop policy if exists "platform read all auth users" on platform_options;
drop policy if exists "platform admin write" on platform_options;
create policy "platform read all auth users" on platform_options for select using (auth.uid() is not null);
create policy "platform admin write" on platform_options for all using (public.is_current_user_admin()) with check (public.is_current_user_admin());

insert into platform_options (name, is_default)
values ('Uber', true)
on conflict (name) do nothing;

create index if not exists trips_user_date_idx on trips(user_id, date desc);
create index if not exists fares_user_date_idx on fares(user_id, date desc);
create index if not exists expenses_user_date_idx on expenses(user_id, date desc);
create index if not exists tolls_user_date_idx on tolls(user_id, date desc);
create index if not exists receipts_user_date_idx on receipts(user_id, receipt_date desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when lower(coalesce(new.email, '')) = 'jobitpgeorge@gmail.com' then 'admin' else 'driver' end
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        role = excluded.role,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
