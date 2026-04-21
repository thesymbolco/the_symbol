-- 팀 관리 RLS 수정: profile insert 시, 대상 user가 아직 company_members에 없더라도
-- 요청자가 "어떤 회사의 owner"이기만 하면 허용되도록 완화한다.
-- (앱 로직상 profile 먼저 또는 company_members 먼저 넣더라도 문제 없게.)

-- 보조 함수: 요청자가 어떤 회사의 owner인지 여부
create or replace function public.is_any_company_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_members
    where user_id = auth.uid()
      and role = 'owner'
      and status = 'active'
  );
$$;

grant execute on function public.is_any_company_owner() to authenticated;

-- profiles insert 정책 재정의
drop policy if exists "profiles_owner_upsert" on public.profiles;
create policy "profiles_owner_upsert"
on public.profiles
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.is_any_company_owner()
);

-- profiles update 정책도 일관되게 완화 (owner는 자기 회사 소속이든 새 유저든 프로필 수정 가능)
drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update"
on public.profiles
for update
using (public.is_any_company_owner() or user_id = auth.uid())
with check (public.is_any_company_owner() or user_id = auth.uid());
