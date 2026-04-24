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
 * BeanSales · 거래명세가 공유하는 “로컬 우선, tick 시 클라우드, 이벤트로 재로드” 패턴
 */
export async function loadStatementRecordsMirror<T = unknown>(options: {
  mode: 'local' | 'cloud'
  companyId: string | null
  cloudDocRefreshTick: number
}): Promise<T[]> {
  const local = readStatementRecordsFromLocalStorage<T>()
  const preferRemote = options.cloudDocRefreshTick > 0
  if (local.length > 0 && !preferRemote) {
    return local
  }
  if (options.mode === 'cloud' && options.companyId) {
    try {
      const remote = await loadCompanyDocument<StatementPageDocumentLike>(
        options.companyId,
        COMPANY_DOCUMENT_KEYS.statementPage,
      )
      if (Array.isArray(remote?.records)) {
        if (preferRemote || local.length === 0) {
          return remote.records as T[]
        }
        return local
      }
    } catch (error) {
      console.error('statementRecordsMirror: 클라우드에서 거래명세 records를 읽지 못했습니다.', error)
    }
  }
  if (local.length > 0) {
    return local
  }
  return []
}
