import { EXPENSE_PAGE_STORAGE_KEY, EXPENSE_PAGE_SAVED_EVENT } from './ExpensePage'
import { GREEN_BEAN_ORDER_STORAGE_KEY, GREEN_BEAN_ORDER_SAVED_EVENT } from './GreenBeanOrderPage'
import { MONTHLY_MEETING_DATA_KEY } from './MonthlyMeetingPage'
import { STAFF_PAYROLL_STORAGE_KEY } from './StaffPayrollPage'

/** `InventoryStatusPage`와 동일 키 — 연동 수집 전용 */
export const INVENTORY_HISTORY_NOTES_STORAGE_KEY = 'inventory-history-notes-v1'

export type LinkedMemoScope = 'inventory' | 'meeting' | 'expense' | 'staffPayroll' | 'greenBeanOrder'

export type LinkedMemoRow = {
  linkKey: string
  scope: LinkedMemoScope
  /** 카드에 짧게 표시 (예: 입출고 히스토리) */
  origin: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

function monthToIsoStart(monthYm: string): string {
  const m = monthYm.trim()
  if (/^\d{4}-\d{2}$/.test(m)) {
    return `${m}-01T12:00:00.000`
  }
  return new Date().toISOString()
}

function parseInventoryHistoryNotes(raw: string | null): LinkedMemoRow[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) {
      return []
    }
    const out: LinkedMemoRow[] = []
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const row = entry as Record<string, unknown>
      const id = typeof row.id === 'string' && row.id ? row.id : ''
      const date = typeof row.date === 'string' ? row.date.trim() : ''
      const note = typeof row.note === 'string' ? row.note.trim() : ''
      const createdAt = typeof row.createdAt === 'string' ? row.createdAt : monthToIsoStart(date.slice(0, 7) || '2000-01')
      if (!note) {
        continue
      }
      out.push({
        linkKey: `inv-history:${id || `${date}-${note.slice(0, 20)}`}`,
        scope: 'inventory',
        origin: '입출고 히스토리',
        title: date ? `기준일 ${date}` : '입출고 메모',
        body: note,
        createdAt,
        updatedAt: createdAt,
      })
    }
    return out
  } catch {
    return []
  }
}

function parseMeetingNotes(raw: string | null): LinkedMemoRow[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const notesByMonth = parsed.notesByMonth
    if (!notesByMonth || typeof notesByMonth !== 'object') {
      return []
    }
    const out: LinkedMemoRow[] = []
    for (const [month, rawNotes] of Object.entries(notesByMonth as Record<string, unknown>)) {
      if (!rawNotes || typeof rawNotes !== 'object') {
        continue
      }
      const n = rawNotes as Record<string, unknown>
      const summary = typeof n.summary === 'string' ? n.summary.trim() : ''
      const actions = typeof n.actions === 'string' ? n.actions.trim() : ''
      const base = monthToIsoStart(month)
      if (summary) {
        out.push({
          linkKey: `meet:${month}:summary`,
          scope: 'meeting',
          origin: '월 마감회의',
          title: `${month} 요약`,
          body: summary,
          createdAt: base,
          updatedAt: base,
        })
      }
      if (actions) {
        out.push({
          linkKey: `meet:${month}:actions`,
          scope: 'meeting',
          origin: '월 마감회의',
          title: `${month} 액션`,
          body: actions,
          createdAt: `${month}-01T12:01:00.000`,
          updatedAt: `${month}-01T12:01:00.000`,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

function parseExpenseMemos(raw: string | null): LinkedMemoRow[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const records = parsed.records
    if (!Array.isArray(records)) {
      return []
    }
    const out: LinkedMemoRow[] = []
    for (const entry of records) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const r = entry as Record<string, unknown>
      const memo = typeof r.memo === 'string' ? r.memo.trim() : ''
      if (!memo) {
        continue
      }
      const id = typeof r.id === 'string' && r.id ? r.id : String(out.length)
      const vendor = typeof r.vendorName === 'string' ? r.vendorName.trim() : ''
      const expenseDate = typeof r.expenseDate === 'string' ? r.expenseDate.trim() : ''
      const detail = typeof r.detail === 'string' ? r.detail.trim() : ''
      const isoGuess =
        expenseDate.length >= 10 ? `${expenseDate.slice(0, 10)}T12:00:00.000` : new Date().toISOString()
      const titleFromParts = [vendor, expenseDate, detail].filter(Boolean).join(' · ')
      out.push({
        linkKey: `exp:${id}:memo`,
        scope: 'expense',
        origin: '지출표',
        title: titleFromParts || '지출 메모',
        body: memo,
        createdAt: isoGuess,
        updatedAt: isoGuess,
      })
    }
    return out
  } catch {
    return []
  }
}

function parseStaffPayrollMemos(raw: string | null): LinkedMemoRow[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const records = parsed.records
    if (!Array.isArray(records)) {
      return []
    }
    const out: LinkedMemoRow[] = []
    for (const entry of records) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const r = entry as Record<string, unknown>
      const memo = typeof r.memo === 'string' ? r.memo.trim() : ''
      if (!memo) {
        continue
      }
      const id = typeof r.id === 'string' && r.id ? r.id : String(out.length)
      const name = typeof r.name === 'string' ? r.name.trim() : ''
      const store = typeof r.storeName === 'string' ? r.storeName.trim() : ''
      const title = [name, store].filter(Boolean).join(' · ') || '직원 메모'
      const hire = typeof r.hireDate === 'string' ? r.hireDate.trim().slice(0, 10) : ''
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(hire) ? `${hire}T12:00:00.000` : '1970-01-01T00:00:00.000Z'
      out.push({
        linkKey: `staff:${id}:memo`,
        scope: 'staffPayroll',
        origin: '직원·급여',
        title,
        body: memo,
        createdAt: iso,
        updatedAt: iso,
      })
    }
    return out
  } catch {
    return []
  }
}

function parseGreenBeanSnapshotMemos(raw: string | null): LinkedMemoRow[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const snaps = parsed.orderSnapshots
    if (!Array.isArray(snaps)) {
      return []
    }
    const out: LinkedMemoRow[] = []
    for (const entry of snaps) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const row = entry as Record<string, unknown>
      const memo = typeof row.memo === 'string' ? row.memo.trim() : ''
      if (!memo) {
        continue
      }
      const id = typeof row.id === 'string' && row.id ? row.id : String(out.length)
      const orderDate = typeof row.orderDate === 'string' ? row.orderDate.trim() : ''
      const savedAt = typeof row.savedAt === 'string' ? row.savedAt : new Date().toISOString()
      out.push({
        linkKey: `gbean:${id}:memo`,
        scope: 'greenBeanOrder',
        origin: '생두 주문',
        title: orderDate ? `기록 ${orderDate}` : '생두 기록 메모',
        body: memo,
        createdAt: savedAt,
        updatedAt: savedAt,
      })
    }
    return out
  } catch {
    return []
  }
}

/** 이 페이지에서 연동 메모를 수정·삭제한 뒤 목록을 갱신할 때 */
export const LINKED_MEMO_MUTATED_EVENT = 'linked-memo-mutated-v1'

/** 다른 탭에서 저장했을 때 편의 메모 연동 목록을 다시 읽기 위한 이벤트 이름 */
export const LINKED_MEMO_REFRESH_EVENT_NAMES = [
  EXPENSE_PAGE_SAVED_EVENT,
  GREEN_BEAN_ORDER_SAVED_EVENT,
  LINKED_MEMO_MUTATED_EVENT,
] as const

function emitLinkedMemosChanged(kind: 'inv' | 'meet' | 'exp' | 'staff' | 'gbean') {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new Event(LINKED_MEMO_MUTATED_EVENT))
  if (kind === 'exp') {
    window.dispatchEvent(new Event(EXPENSE_PAGE_SAVED_EVENT))
  }
  if (kind === 'gbean') {
    window.dispatchEvent(new Event(GREEN_BEAN_ORDER_SAVED_EVENT))
  }
}

function inventoryHistoryLinkKeyFromRow(row: Record<string, unknown>): string {
  const id = typeof row.id === 'string' && row.id ? row.id : ''
  const date = typeof row.date === 'string' ? row.date.trim() : ''
  const note = typeof row.note === 'string' ? row.note.trim() : ''
  return `inv-history:${id || `${date}-${note.slice(0, 20)}`}`
}

type ParsedLinkKey =
  | { kind: 'inv'; rest: string }
  | { kind: 'meet'; month: string; part: 'summary' | 'actions' }
  | { kind: 'exp'; id: string }
  | { kind: 'staff'; id: string }
  | { kind: 'gbean'; id: string }

function parseLinkKey(linkKey: string): ParsedLinkKey | null {
  if (linkKey.startsWith('inv-history:')) {
    return { kind: 'inv', rest: linkKey.slice('inv-history:'.length) }
  }
  const meetM = linkKey.match(/^meet:(\d{4}-\d{2}):(summary|actions)$/)
  if (meetM) {
    return { kind: 'meet', month: meetM[1], part: meetM[2] as 'summary' | 'actions' }
  }
  const expM = linkKey.match(/^exp:(.+):memo$/)
  if (expM) {
    return { kind: 'exp', id: expM[1] }
  }
  const staffM = linkKey.match(/^staff:(.+):memo$/)
  if (staffM) {
    return { kind: 'staff', id: staffM[1] }
  }
  const gM = linkKey.match(/^gbean:(.+):memo$/)
  if (gM) {
    return { kind: 'gbean', id: gM[1] }
  }
  return null
}

/** 연동 메모 삭제 — 각 화면 저장소에서 해당 내용을 제거합니다. */
export function deleteLinkedMemo(linkKey: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const p = parseLinkKey(linkKey)
  if (!p) {
    return false
  }
  try {
    switch (p.kind) {
      case 'inv': {
        const raw = window.localStorage.getItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const arr = JSON.parse(raw) as unknown
        if (!Array.isArray(arr)) {
          return false
        }
        const next = arr.filter((entry) => {
          if (!entry || typeof entry !== 'object') {
            return true
          }
          return inventoryHistoryLinkKeyFromRow(entry as Record<string, unknown>) !== linkKey
        })
        window.localStorage.setItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY, JSON.stringify(next))
        break
      }
      case 'meet': {
        const raw = window.localStorage.getItem(MONTHLY_MEETING_DATA_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const nbm = state.notesByMonth
        if (!nbm || typeof nbm !== 'object') {
          return false
        }
        const notesByMonth = { ...(nbm as Record<string, unknown>) }
        const monthNotes = { ...(notesByMonth[p.month] as Record<string, unknown>) }
        monthNotes[p.part] = ''
        notesByMonth[p.month] = monthNotes
        state.notesByMonth = notesByMonth
        window.localStorage.setItem(MONTHLY_MEETING_DATA_KEY, JSON.stringify(state))
        break
      }
      case 'exp': {
        const raw = window.localStorage.getItem(EXPENSE_PAGE_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const records = Array.isArray(state.records) ? [...state.records] : []
        const idx = records.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(records[idx] as Record<string, unknown>) }
        row.memo = ''
        records[idx] = row
        state.records = records
        window.localStorage.setItem(EXPENSE_PAGE_STORAGE_KEY, JSON.stringify(state))
        break
      }
      case 'staff': {
        const raw = window.localStorage.getItem(STAFF_PAYROLL_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const records = Array.isArray(state.records) ? [...state.records] : []
        const idx = records.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(records[idx] as Record<string, unknown>) }
        row.memo = ''
        records[idx] = row
        state.records = records
        window.localStorage.setItem(STAFF_PAYROLL_STORAGE_KEY, JSON.stringify(state))
        break
      }
      case 'gbean': {
        const raw = window.localStorage.getItem(GREEN_BEAN_ORDER_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const snaps = Array.isArray(state.orderSnapshots) ? [...state.orderSnapshots] : []
        const idx = snaps.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(snaps[idx] as Record<string, unknown>) }
        delete row.memo
        snaps[idx] = row
        state.orderSnapshots = snaps
        window.localStorage.setItem(GREEN_BEAN_ORDER_STORAGE_KEY, JSON.stringify(state))
        break
      }
      default:
        return false
    }
    emitLinkedMemosChanged(p.kind)
    return true
  } catch {
    return false
  }
}

export type UpdateLinkedMemoPayload = {
  body: string
  /** 입출고 히스토리만: 기준일 YYYY-MM-DD */
  inventoryDate?: string
}

/** 연동 메모 수정 — 원본 필드를 덮어씁니다. */
export function updateLinkedMemo(linkKey: string, payload: UpdateLinkedMemoPayload): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const p = parseLinkKey(linkKey)
  if (!p) {
    return false
  }
  if (p.kind !== 'meet' && !payload.body.trim()) {
    return deleteLinkedMemo(linkKey)
  }
  const body = p.kind === 'meet' ? payload.body : payload.body.trim()
  try {
    switch (p.kind) {
      case 'inv': {
        const raw = window.localStorage.getItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const arr = JSON.parse(raw) as unknown
        if (!Array.isArray(arr)) {
          return false
        }
        const idx = arr.findIndex((entry) => {
          if (!entry || typeof entry !== 'object') {
            return false
          }
          return inventoryHistoryLinkKeyFromRow(entry as Record<string, unknown>) === linkKey
        })
        if (idx === -1) {
          return false
        }
        const row = { ...(arr[idx] as Record<string, unknown>) }
        row.note = body
        const dateIn = (payload.inventoryDate ?? '').trim().slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateIn)) {
          row.date = dateIn
        }
        arr[idx] = row
        window.localStorage.setItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY, JSON.stringify(arr))
        break
      }
      case 'meet': {
        const raw = window.localStorage.getItem(MONTHLY_MEETING_DATA_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const nbm = state.notesByMonth
        if (!nbm || typeof nbm !== 'object') {
          return false
        }
        const notesByMonth = { ...(nbm as Record<string, unknown>) }
        const prev = (notesByMonth[p.month] as Record<string, unknown>) ?? {}
        const monthNotes = { ...prev, [p.part]: body }
        notesByMonth[p.month] = monthNotes
        state.notesByMonth = notesByMonth
        window.localStorage.setItem(MONTHLY_MEETING_DATA_KEY, JSON.stringify(state))
        break
      }
      case 'exp': {
        const raw = window.localStorage.getItem(EXPENSE_PAGE_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const records = Array.isArray(state.records) ? [...state.records] : []
        const idx = records.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(records[idx] as Record<string, unknown>) }
        row.memo = body
        records[idx] = row
        state.records = records
        window.localStorage.setItem(EXPENSE_PAGE_STORAGE_KEY, JSON.stringify(state))
        break
      }
      case 'staff': {
        const raw = window.localStorage.getItem(STAFF_PAYROLL_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const records = Array.isArray(state.records) ? [...state.records] : []
        const idx = records.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(records[idx] as Record<string, unknown>) }
        row.memo = body
        records[idx] = row
        state.records = records
        window.localStorage.setItem(STAFF_PAYROLL_STORAGE_KEY, JSON.stringify(state))
        break
      }
      case 'gbean': {
        const raw = window.localStorage.getItem(GREEN_BEAN_ORDER_STORAGE_KEY)
        if (!raw?.trim()) {
          return false
        }
        const state = JSON.parse(raw) as Record<string, unknown>
        const snaps = Array.isArray(state.orderSnapshots) ? [...state.orderSnapshots] : []
        const idx = snaps.findIndex(
          (r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === p.id,
        )
        if (idx === -1) {
          return false
        }
        const row = { ...(snaps[idx] as Record<string, unknown>) }
        const trimmed = body.trim().slice(0, 500)
        if (trimmed) {
          row.memo = trimmed
        } else {
          delete row.memo
        }
        snaps[idx] = row
        state.orderSnapshots = snaps
        window.localStorage.setItem(GREEN_BEAN_ORDER_STORAGE_KEY, JSON.stringify(state))
        break
      }
      default:
        return false
    }
    emitLinkedMemosChanged(p.kind)
    return true
  } catch {
    return false
  }
}

/** 각 페이지 로컬 저장소에서 메모 성격 데이터만 모읍니다. */
export function collectLinkedMemos(): LinkedMemoRow[] {
  if (typeof window === 'undefined') {
    return []
  }
  const inv = parseInventoryHistoryNotes(window.localStorage.getItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY))
  const meet = parseMeetingNotes(window.localStorage.getItem(MONTHLY_MEETING_DATA_KEY))
  const exp = parseExpenseMemos(window.localStorage.getItem(EXPENSE_PAGE_STORAGE_KEY))
  const staff = parseStaffPayrollMemos(window.localStorage.getItem(STAFF_PAYROLL_STORAGE_KEY))
  const bean = parseGreenBeanSnapshotMemos(window.localStorage.getItem(GREEN_BEAN_ORDER_STORAGE_KEY))
  return [...inv, ...meet, ...exp, ...staff, ...bean].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
