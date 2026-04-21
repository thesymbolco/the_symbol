-- 팀 관리(owner가 앱 내에서 구성원 계정을 만들고 관리) 기능 마이그레이션
-- Supabase 대시보드 > SQL Editor 에서 1회 실행

-- 1) profiles 테이블: 이름/연락처/직책/실제이메일 보관
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  phone text,
  title text,
  email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles enable row level security;

-- 2) 회사 소속 확인용 SECURITY DEFINER 함수 (company_members RLS 재귀 방지)
create or replace function public.is_company_owner(target_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_members
    where company_id = target_company
      and user_id = auth.uid()
      and role = 'owner'
      and status = 'active'
  );
$$;

create or replace function public.share_company_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_members cm1
    join public.company_members cm2 on cm1.company_id = cm2.company_id
    where cm1.user_id = auth.uid()
      and cm1.status = 'active'
      and cm2.user_id = target_user
      and cm2.status = 'active'
  );
$$;

create or replace function public.is_owner_of_any_shared_company(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_members cm1
    join public.company_members cm2 on cm1.company_id = cm2.company_id
    where cm1.user_id = auth.uid()
      and cm1.role = 'owner'
      and cm1.status = 'active'
      and cm2.user_id = target_user
  );
$$;

grant execute on function public.is_company_owner(uuid) to authenticated;
grant execute on function public.share_company_with(uuid) to authenticated;
grant execute on function public.is_owner_of_any_shared_company(uuid) to authenticated;

-- 3) profiles RLS
drop policy if exists "profiles_self_or_shared_read" on public.profiles;
create policy "profiles_self_or_shared_read"
on public.profiles
for select
using (
  user_id = auth.uid()
  or public.share_company_with(user_id)
);

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
on public.profiles
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "profiles_owner_upsert" on public.profiles;
create policy "profiles_owner_upsert"
on public.profiles
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.is_owner_of_any_shared_company(user_id)
);

drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update"
on public.profiles
for update
using (public.is_owner_of_any_shared_company(user_id))
with check (public.is_owner_of_any_shared_company(user_id));

-- 4) company_members: owner가 회사 구성원을 추가/수정/삭제/조회할 수 있게 확장
drop policy if exists "owner_can_view_all_members" on public.company_members;
create policy "owner_can_view_all_members"
on public.company_members
for select
using (
  user_id = auth.uid()
  or public.is_company_owner(company_id)
);

drop policy if exists "owner_can_add_members" on public.company_members;
create policy "owner_can_add_members"
on public.company_members
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.is_company_owner(company_id)
);

drop policy if exists "owner_can_update_members" on public.company_members;
create policy "owner_can_update_members"
on public.company_members
for update
using (public.is_company_owner(company_id))
with check (public.is_company_owner(company_id));

drop policy if exists "owner_can_delete_members" on public.company_members;
create policy "owner_can_delete_members"
on public.company_members
for delete
using (public.is_company_owner(company_id));

-- 5) updated_at 자동 갱신 트리거 (profiles)
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute procedure public.touch_updated_at();
