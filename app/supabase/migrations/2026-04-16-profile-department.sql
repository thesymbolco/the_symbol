-- profiles에 부서명(department) 컬럼 추가.
-- 직책(title)은 앱에서 enum처럼 관리하지만 DB 컬럼 타입은 text 유지(유연성).

alter table public.profiles
  add column if not exists department text;
