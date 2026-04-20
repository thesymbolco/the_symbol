create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  primary key (company_id, user_id)
);

create table if not exists public.company_documents (
  company_id uuid not null references public.companies(id) on delete cascade,
  doc_key text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (company_id, doc_key)
);

alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_documents enable row level security;

drop policy if exists "members_can_view_companies" on public.companies;
create policy "members_can_view_companies"
on public.companies
for select
using (
  created_by = auth.uid()
  or
  exists (
    select 1
    from public.company_members members
    where members.company_id = companies.id
      and members.user_id = auth.uid()
      and members.status = 'active'
  )
);

drop policy if exists "authenticated_can_create_companies" on public.companies;
create policy "authenticated_can_create_companies"
on public.companies
for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists "members_can_view_company_members" on public.company_members;
create policy "members_can_view_company_members"
on public.company_members
for select
using (user_id = auth.uid());

drop policy if exists "authenticated_can_join_owned_company" on public.company_members;
create policy "authenticated_can_join_owned_company"
on public.company_members
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "members_can_view_documents" on public.company_documents;
create policy "members_can_view_documents"
on public.company_documents
for select
using (
  exists (
    select 1
    from public.company_members members
    where members.company_id = company_documents.company_id
      and members.user_id = auth.uid()
      and members.status = 'active'
  )
);

drop policy if exists "members_can_upsert_documents" on public.company_documents;
create policy "members_can_upsert_documents"
on public.company_documents
for insert
to authenticated
with check (
  exists (
    select 1
    from public.company_members members
    where members.company_id = company_documents.company_id
      and members.user_id = auth.uid()
      and members.status = 'active'
  )
);

drop policy if exists "members_can_update_documents" on public.company_documents;
create policy "members_can_update_documents"
on public.company_documents
for update
using (
  exists (
    select 1
    from public.company_members members
    where members.company_id = company_documents.company_id
      and members.user_id = auth.uid()
      and members.status = 'active'
  )
)
with check (
  exists (
    select 1
    from public.company_members members
    where members.company_id = company_documents.company_id
      and members.user_id = auth.uid()
      and members.status = 'active'
  )
);
