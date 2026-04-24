/**
 * 거래명세 `records`만 로컬에 복제해 두고 이벤트로 월마감·원두분석·거래명세가 같은 데이터를
 * 보게 할 때 쓰는 기본 경로(원두별 매출 분석의 읽기·쓰기와 동일).
 */
import { STATEMENT_RECORDS_SAVED_EVENT, STATEMENT_RECORDS_STORAGE_KEY } from './MonthlyMeetingPage'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument } from './lib/companyDocuments'

type StatementPageDocumentLike = { records?: unknown[] }

export function readStatementRecordsFromLocalStorage<T = unknown>(): T[] {
  try {
    const raw = window.localStorage.getItem(STATEMENT_RECORDS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/** `statement-records-v1` + `STATEMENT_RECORDS_SAVED_EVENT` — App·원두와 동일 */
export function writeStatementRecordsToMirror(records: unknown): void {
  try {
    window.localStorage.setItem(STATEMENT_RECORDS_STORAGE_KEY, JSON.stringify(records))
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(STATEMENT_RECORDS_SAVED_EVENT))
}

/**
 * BeanSales 등: 클라우드일 때는 **항상** 먼저 `company_documents`를 읽는다(다른 PC/탭이 최신이면 local만 보면 꼬임).
 * `cloudDocRefreshTick`은 “창/주기 끌기”는 그대로 두고, 0 tick에서도 **최초 로드**에 서버를 쓰기 위한 것이 아님(옛: tick 0+로컬 있으면 서버를 아예 안 읽는 버그).
 */
export async function loadStatementRecordsMirror<T = unknown>(options: {
  mode: 'local' | 'cloud'
  companyId: string | null
  /** `BeanSalesAnalysisPage` 등 effect 의존성용 — 탭 복귀/주기마다 재로드 */
  cloudDocRefreshTick: number
}): Promise<T[]> {
  const { mode, companyId, cloudDocRefreshTick: _cloudDocRefreshTick } = options
  void _cloudDocRefreshTick
  const local = readStatementRecordsFromLocalStorage<T>()

  if (mode === 'local' || !companyId) {
    return local
  }

  try {
    const remote = await loadCompanyDocument<StatementPageDocumentLike>(
      companyId,
      COMPANY_DOCUMENT_KEYS.statementPage,
    )
    if (remote && Array.isArray(remote.records)) {
      return remote.records as T[]
    }
  } catch (error) {
    console.error('statementRecordsMirror: 클라우드에서 거래명세 records를 읽지 못했습니다.', error)
  }
  if (local.length > 0) {
    return local
  }
  return []
}
