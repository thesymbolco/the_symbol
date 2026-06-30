-- Supabase Realtime: 다른 사용자 저장 시 즉시 동기화 (REST 폴링 egress 절감)
-- Dashboard → Database → Replication 에서 company_documents 가 켜져 있어야 합니다.
--
-- 주의: replica identity 는 기본값(PK)로 둡니다.
--   클라이언트는 Realtime 의 old 레코드를 사용하지 않으며, FULL 로 두면 변경 시
--   old 레코드(거대한 payload 포함)까지 웹소켓으로 전송돼 egress 가 2배가 됩니다.

alter table public.company_documents replica identity default;

do $$
begin
  alter publication supabase_realtime add table public.company_documents;
exception
  when duplicate_object then
    null;
  when undefined_object then
    raise notice 'supabase_realtime publication not found — enable Realtime for company_documents in Supabase Dashboard';
end $$;
