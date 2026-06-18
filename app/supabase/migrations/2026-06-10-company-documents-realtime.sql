-- Supabase Realtime: 다른 사용자 저장 시 즉시 동기화 (REST 폴링 egress 절감)
-- Dashboard → Database → Replication 에서 company_documents 가 켜져 있어야 합니다.

alter table public.company_documents replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.company_documents;
exception
  when duplicate_object then
    null;
  when undefined_object then
    raise notice 'supabase_realtime publication not found — enable Realtime for company_documents in Supabase Dashboard';
end $$;
