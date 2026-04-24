import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  collectLinkedMemos,
  deleteLinkedMemo,
  LINKED_MEMO_REFRESH_EVENT_NAMES,
  type LinkedMemoRow,
  updateLinkedMemo,
} from './memoLinkedSources'
import PageSaveStatus from './components/PageSaveStatus'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export const MEMO_PAGE_STORAGE_KEY = 'memo-page-data-v1'

export type MemoScope =
  | 'general'
  | 'statements'
  | 'meeting'
  | 'inventory'
  | 'expense'
  | 'staffPayroll'
  | 'greenBeanOrder'

export type ConvenienceMemo = {
  id: string
  scope: MemoScope
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export type MemoTodoItem = {
  id: string
  text: string
  done: boolean
  createdAt: string
  dueDate: string
  priority: 'high' | 'normal' | 'low'
}

/** 날짜(YYYY-MM-DD)별 일일회의 메모 + 당일 할 일 */
export type DailyMeetingDay = {
  note: string
  todos: MemoTodoItem[]
}

type MemoPagePersisted = {
  items: ConvenienceMemo[]
  todos: MemoTodoItem[]
  dailyByDate: Record<string, DailyMeetingDay>
}

type MemoPageTab = 'comfort' | 'daily'
type MemoPageMode = 'all' | 'comfortOnly' | 'dailyOnly'
type MemoPageProps = {
  mode?: MemoPageMode
}

function todayLocalIsoDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const SCOPE_META: { id: MemoScope; label: string }[] = [
  { id: 'general', label: '기타·전반' },
  { id: 'statements', label: '거래명세' },
  { id: 'meeting', label: '월 마감회의' },
  { id: 'inventory', label: '입출고 현황' },
  { id: 'expense', label: '지출표' },
  { id: 'staffPayroll', label: '직원·급여' },
  { id: 'greenBeanOrder', label: '생두 주문' },
]

const DAILY_MEETING_TEMPLATE = `이슈
- 

결정 사항
- 

요청/공유 사항
- 

내일 할 일
- `

const DAILY_MEETING_SECTION_ORDER = ['issues', 'decisions', 'requests', 'nextTodos'] as const
type DailyMeetingSectionKey = (typeof DAILY_MEETING_SECTION_ORDER)[number]
type DailyMeetingSections = Record<DailyMeetingSectionKey, string>

const DAILY_MEETING_SECTION_META: { key: DailyMeetingSectionKey; label: string; placeholder: string }[] = [
  { key: 'issues', label: '이슈', placeholder: '오늘 발생한 이슈, 문제 상황...' },
  { key: 'decisions', label: '결정 사항', placeholder: '회의에서 확정한 내용...' },
  { key: 'requests', label: '요청/공유 사항', placeholder: '협업 요청, 공유할 전달사항...' },
  { key: 'nextTodos', label: '내일 할 일', placeholder: '내일 진행할 핵심 작업...' },
]
const TODO_PRIORITY_OPTIONS: { value: MemoTodoItem['priority']; label: string }[] = [
  { value: 'high', label: '높음' },
  { value: 'normal', label: '보통' },
  { value: 'low', label: '낮음' },
]

const EMPTY_DAILY_MEETING_SECTIONS: DailyMeetingSections = {
  issues: '',
  decisions: '',
  requests: '',
  nextTodos: '',
}

function parseDailyMeetingSections(note: string): DailyMeetingSections {
  if (!note.trim()) {
    return { ...EMPTY_DAILY_MEETING_SECTIONS }
  }
  const lines = note.split('\n')
  const sections: DailyMeetingSections = { ...EMPTY_DAILY_MEETING_SECTIONS }
  let current: DailyMeetingSectionKey | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '이슈') {
      current = 'issues'
      continue
    }
    if (trimmed === '결정 사항') {
      current = 'decisions'
      continue
    }
    if (trimmed === '요청/공유 사항') {
      current = 'requests'
      continue
    }
    if (trimmed === '내일 할 일') {
      current = 'nextTodos'
      continue
    }
    if (!current) {
      continue
    }
    sections[current] = sections[current] ? `${sections[current]}\n${line}` : line
  }
  return sections
}

function buildDailyMeetingNoteFromSections(sections: DailyMeetingSections): string {
  const hasAnyText = DAILY_MEETING_SECTION_ORDER.some((key) => sections[key].trim())
  if (!hasAnyText) {
    return ''
  }
  const byKeyLabel: Record<DailyMeetingSectionKey, string> = {
    issues: '이슈',
    decisions: '결정 사항',
    requests: '요청/공유 사항',
    nextTodos: '내일 할 일',
  }
  return DAILY_MEETING_SECTION_ORDER.map((key) => `${byKeyLabel[key]}\n${sections[key].trim()}`).join('\n\n').trim()
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function isMemoScope(value: unknown): value is MemoScope {
  return (
    value === 'general' ||
    value === 'statements' ||
    value === 'meeting' ||
    value === 'inventory' ||
    value === 'expense' ||
    value === 'staffPayroll' ||
    value === 'greenBeanOrder'
  )
}

function normalizeTodos(raw: unknown): MemoTodoItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: MemoTodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' && row.id ? row.id : createId()
    const text = typeof row.text === 'string' ? row.text : ''
    const done = row.done === true
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString()
    const dueDate = typeof row.dueDate === 'string' ? row.dueDate : ''
    const priority = row.priority === 'high' || row.priority === 'low' ? row.priority : 'normal'
    if (!text.trim()) {
      continue
    }
    out.push({ id, text: text.trim(), done, createdAt, dueDate, priority })
  }
  return out
}

function todoPriorityRank(priority: MemoTodoItem['priority']): number {
  if (priority === 'high') {
    return 0
  }
  if (priority === 'normal') {
    return 1
  }
  return 2
}

function normalizeDailyByDate(raw: unknown): Record<string, DailyMeetingDay> {
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const out: Record<string, DailyMeetingDay> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      continue
    }
    if (!value || typeof value !== 'object') {
      continue
    }
    const v = value as Record<string, unknown>
    const note = typeof v.note === 'string' ? v.note : ''
    const todos = normalizeTodos(v.todos)
    out[key] = { note, todos }
  }
  return out
}

function pruneDailyByDate(d: Record<string, DailyMeetingDay>): Record<string, DailyMeetingDay> {
  const out: Record<string, DailyMeetingDay> = {}
  for (const [k, v] of Object.entries(d)) {
    if (v.note.trim() || v.todos.length > 0) {
      out[k] = v
    }
  }
  return out
}

function normalizePersisted(raw: unknown): MemoPagePersisted {
  const empty: MemoPagePersisted = { items: [], todos: [], dailyByDate: {} }
  if (!raw || typeof raw !== 'object') {
    return empty
  }
  const o = raw as Record<string, unknown>
  const itemsUnknown = o.items
  const todos = normalizeTodos(o.todos)
  const dailyByDate = normalizeDailyByDate(o.dailyByDate)
  if (!Array.isArray(itemsUnknown)) {
    return { items: [], todos, dailyByDate }
  }
  const items: ConvenienceMemo[] = []
  for (const entry of itemsUnknown) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' && row.id ? row.id : createId()
    const scope = isMemoScope(row.scope) ? row.scope : 'general'
    const title = typeof row.title === 'string' ? row.title : ''
    const body = typeof row.body === 'string' ? row.body : ''
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString()
    const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : createdAt
    items.push({ id, scope, title, body, createdAt, updatedAt })
  }
  return { items, todos, dailyByDate }
}

function readMemoPagePersistedFromStorage(): MemoPagePersisted {
  const raw = window.localStorage.getItem(MEMO_PAGE_STORAGE_KEY)
  if (!raw) {
    return { items: [], todos: [], dailyByDate: {} }
  }
  try {
    return normalizePersisted(JSON.parse(raw))
  } catch {
    return { items: [], todos: [], dailyByDate: {} }
  }
}

function formatMemoDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) {
    return ''
  }
  return new Date(t).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/** ISO 문자열을 분 단위까지 같으면 동일 시각으로 봄 */
function sameUpToMinute(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16)
}

type MergedRow = { kind: 'local'; data: ConvenienceMemo } | { kind: 'linked'; data: LinkedMemoRow }

export default function MemoPage({ mode = 'all' }: MemoPageProps) {
  const { mode: runtimeMode, activeCompanyId, user } = useAppRuntime()
  const forceComfortOnly = mode === 'comfortOnly'
  const forceDailyOnly = mode === 'dailyOnly'
  const showModeTabs = mode === 'all'
  const [items, setItems] = useState<ConvenienceMemo[]>([])
  const [todos, setTodos] = useState<MemoTodoItem[]>([])
  const [dailyByDate, setDailyByDate] = useState<Record<string, DailyMeetingDay>>({})
  const [memoTab, setMemoTab] = useState<MemoPageTab>(forceDailyOnly ? 'daily' : 'comfort')
  const [dailyDate, setDailyDate] = useState(todayLocalIsoDate)
  const [dailySearch, setDailySearch] = useState('')
  const [draftDailyTodo, setDraftDailyTodo] = useState('')
  const [draftDailyTodoDueDate, setDraftDailyTodoDueDate] = useState('')
  const [draftDailyTodoPriority, setDraftDailyTodoPriority] = useState<MemoTodoItem['priority']>('normal')
  const [dailyMeetingSections, setDailyMeetingSections] = useState<DailyMeetingSections>({ ...EMPTY_DAILY_MEETING_SECTIONS })
  const [showDailyRawEditor, setShowDailyRawEditor] = useState(false)
  const dailyMeetingSectionEditingRef = useRef(false)
  const dailyNoteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dailyNoteHistoryRef = useRef<string[]>([])
  const dailyNoteHistoryIndexRef = useRef(0)
  const dailyNoteGroupTimerRef = useRef<number | null>(null)
  const dailyNoteGroupOpenRef = useRef(false)
  const dailyNoteIsComposingRef = useRef(false)
  const dailyNoteApplyingHistoryRef = useRef(false)
  const dailyNoteForceBoundaryRef = useRef(false)
  const [linkedRows, setLinkedRows] = useState<LinkedMemoRow[]>(() => collectLinkedMemos())
  const [isStorageReady, setIsStorageReady] = useState(false)
  const [isCloudReady, setIsCloudReady] = useState(runtimeMode === 'local')
  const [statusMessage, setStatusMessage] = useState('자동 저장')
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [lastSavedAt, setLastSavedAt] = useState('')
  const saveTimerRef = useRef<number | null>(null)
  const lastSyncedPayloadRef = useRef('')

  const [filterScope, setFilterScope] = useState<MemoScope | 'all'>('all')
  const [search, setSearch] = useState('')

  const [draftScope, setDraftScope] = useState<MemoScope>('general')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editScope, setEditScope] = useState<MemoScope>('general')

  const [editingLinkedRow, setEditingLinkedRow] = useState<LinkedMemoRow | null>(null)
  const [editLinkBody, setEditLinkBody] = useState('')
  /** 입출고 히스토리 기준일 YYYY-MM-DD */
  const [editLinkDate, setEditLinkDate] = useState('')

  useEffect(() => {
    let cancelled = false

    setIsStorageReady(false)
    setIsCloudReady(runtimeMode === 'local')
    setSaveState('saved')

    const applyPersisted = (parsed: MemoPagePersisted, source: 'local' | 'cloud', hasRemote: boolean) => {
      if (cancelled) {
        return
      }
      const nextItems = [...parsed.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const nextTodos = [...parsed.todos].sort((a, b) => {
          if (a.done !== b.done) {
            return a.done ? 1 : -1
          }
          return b.createdAt.localeCompare(a.createdAt)
        })
      const payloadForSync: MemoPagePersisted = {
        items: nextItems,
        todos: nextTodos,
        dailyByDate: pruneDailyByDate(parsed.dailyByDate),
      }
      lastSyncedPayloadRef.current = JSON.stringify(payloadForSync)
      setItems(nextItems)
      setTodos(nextTodos)
      setDailyByDate(parsed.dailyByDate)
      setStatusMessage(
        source === 'cloud' ? '클라우드에서 메모를 불러왔습니다.' : hasRemote ? '불러옴' : '브라우저 메모를 불러왔습니다.',
      )
      setLastSavedAt(new Date().toISOString())
      setIsStorageReady(true)
      setIsCloudReady(true)
    }

    const loadPersisted = async () => {
      const localPersisted = readMemoPagePersistedFromStorage()
      if (runtimeMode !== 'cloud' || !activeCompanyId) {
        applyPersisted(localPersisted, 'local', true)
        return
      }

      try {
        const remotePersisted = await loadCompanyDocument<MemoPagePersisted>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.memoPage,
        )
        applyPersisted(
          remotePersisted ? normalizePersisted(remotePersisted) : localPersisted,
          remotePersisted ? 'cloud' : 'local',
          Boolean(remotePersisted),
        )
      } catch (error) {
        console.error('메모 클라우드 문서를 읽지 못했습니다.', error)
        applyPersisted(localPersisted, 'local', true)
      }
    }

    void loadPersisted()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, runtimeMode])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }
    const payload: MemoPagePersisted = {
      items,
      todos,
      dailyByDate: pruneDailyByDate(dailyByDate),
    }
    try {
      window.localStorage.setItem(MEMO_PAGE_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      setStatusMessage('저장 실패 (저장 공간 확인 필요)')
    }
  }, [isStorageReady, items, todos, dailyByDate])

  const buildCloudPayload = useCallback(
    (): MemoPagePersisted => ({
      items,
      todos,
      dailyByDate: pruneDailyByDate(dailyByDate),
    }),
    [dailyByDate, items, todos],
  )

  const flushCloudSave = useCallback(
    async (payload: MemoPagePersisted) => {
      if (runtimeMode !== 'cloud' || !activeCompanyId) {
        setSaveState('saved')
        setLastSavedAt(new Date().toISOString())
        return
      }
      setSaveState('saving')
      try {
        await saveCompanyDocument(activeCompanyId, COMPANY_DOCUMENT_KEYS.memoPage, payload, user?.id)
        lastSyncedPayloadRef.current = JSON.stringify(payload)
        setSaveState('saved')
        setLastSavedAt(new Date().toISOString())
      } catch (error) {
        console.error('메모 클라우드 저장에 실패했습니다.', error)
        setSaveState('error')
        setStatusMessage('클라우드 저장 실패')
      }
    },
    [activeCompanyId, runtimeMode, user?.id],
  )

  useEffect(() => {
    if (!isStorageReady || !isCloudReady) {
      return
    }
    if (runtimeMode !== 'cloud' || !activeCompanyId) {
      return
    }

    const payload = buildCloudPayload()
    const serialized = JSON.stringify(payload)
    if (serialized === lastSyncedPayloadRef.current) {
      return
    }

    setSaveState((current) => (current === 'saving' ? current : 'dirty'))
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushCloudSave(payload)
    }, 600)

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [activeCompanyId, buildCloudPayload, flushCloudSave, isCloudReady, isStorageReady, runtimeMode])

  useEffect(() => {
    if (runtimeMode !== 'cloud') {
      return
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState !== 'dirty' && saveState !== 'saving') {
        return
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [runtimeMode, saveState])

  useEffect(() => {
    if (runtimeMode !== 'cloud' || !activeCompanyId) {
      return
    }
    let cancelled = false
    let inFlight = false
    let lastJson = ''

    const poll = async () => {
      if (cancelled || inFlight) {
        return
      }
      inFlight = true
      try {
        const remote = await loadCompanyDocument<MemoPagePersisted>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.memoPage,
        )
        if (cancelled || !remote) {
          return
        }
        const normalized = normalizePersisted(remote)
        const nextJson = JSON.stringify(normalized)
        if (nextJson !== lastJson) {
          lastJson = nextJson
          const sortedItems = [...normalized.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          const sortedTodos = [...normalized.todos].sort((a, b) => {
            if (a.done !== b.done) {
              return a.done ? 1 : -1
            }
            return b.createdAt.localeCompare(a.createdAt)
          })
          const payload: MemoPagePersisted = {
            items: sortedItems,
            todos: sortedTodos,
            dailyByDate: pruneDailyByDate(normalized.dailyByDate),
          }
          lastSyncedPayloadRef.current = JSON.stringify(payload)
          setItems(sortedItems)
          setTodos(sortedTodos)
          setDailyByDate(normalized.dailyByDate)
        }
      } catch {
        /* retry next cycle */
      } finally {
        inFlight = false
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [runtimeMode, activeCompanyId])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  const saveNow = async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await flushCloudSave(buildCloudPayload())
    setStatusMessage('저장됨')
  }

  const MAX_DAILY_NOTE_HISTORY = 80
  const DAILY_NOTE_WORD_BREAK_RE = /[\s.,!?;:()\[\]{}"'`~\-_/\\|]/
  const DAILY_NOTE_GROUP_IDLE_MS = 900

  useEffect(() => {
    if (forceDailyOnly && memoTab !== 'daily') {
      setMemoTab('daily')
      return
    }
    if (forceComfortOnly && memoTab !== 'comfort') {
      setMemoTab('comfort')
    }
  }, [forceComfortOnly, forceDailyOnly, memoTab])

  useEffect(() => {
    if (dailyNoteGroupTimerRef.current !== null) {
      window.clearTimeout(dailyNoteGroupTimerRef.current)
      dailyNoteGroupTimerRef.current = null
    }
    const note = dailyByDate[dailyDate]?.note ?? ''
    dailyNoteHistoryRef.current = [note]
    dailyNoteHistoryIndexRef.current = 0
    dailyNoteGroupOpenRef.current = false
    dailyNoteIsComposingRef.current = false
    dailyNoteApplyingHistoryRef.current = false
    dailyNoteForceBoundaryRef.current = false
  }, [dailyDate, memoTab])

  useEffect(() => {
    return () => {
      if (dailyNoteGroupTimerRef.current !== null) {
        window.clearTimeout(dailyNoteGroupTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const refresh = () => {
      setLinkedRows(collectLinkedMemos())
    }
    refresh()
    window.addEventListener('focus', refresh)
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    for (const name of LINKED_MEMO_REFRESH_EVENT_NAMES) {
      window.addEventListener(name, refresh)
    }
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVis)
      for (const name of LINKED_MEMO_REFRESH_EVENT_NAMES) {
        window.removeEventListener(name, refresh)
      }
    }
  }, [])

  const mergedRows = useMemo((): MergedRow[] => {
    const local = items.map((data) => ({ kind: 'local' as const, data, sort: data.updatedAt }))
    const linked = linkedRows.map((data) => ({ kind: 'linked' as const, data, sort: data.updatedAt }))
    return [...local, ...linked].sort((a, b) => b.sort.localeCompare(a.sort))
  }, [items, linkedRows])

  const filteredMerged = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mergedRows.filter((row) => {
      if (filterScope !== 'all') {
        const sc = row.kind === 'local' ? row.data.scope : row.data.scope
        if (sc !== filterScope) {
          return false
        }
      }
      if (!q) {
        return true
      }
      if (row.kind === 'local') {
        const d = row.data
        return (
          d.title.toLowerCase().includes(q) ||
          d.body.toLowerCase().includes(q) ||
          (SCOPE_META.find((s) => s.id === d.scope)?.label.toLowerCase().includes(q) ?? false)
        )
      }
      const d = row.data
      return (
        d.title.toLowerCase().includes(q) ||
        d.body.toLowerCase().includes(q) ||
        d.origin.toLowerCase().includes(q) ||
        (SCOPE_META.find((s) => s.id === d.scope)?.label.toLowerCase().includes(q) ?? false)
      )
    })
  }, [mergedRows, filterScope, search])

  const hasAnyMemo = items.length > 0 || linkedRows.length > 0

  const dailyDaySlice = useMemo(() => {
    const entry = dailyByDate[dailyDate] ?? { note: '', todos: [] as MemoTodoItem[] }
    const active = entry.todos.filter((t) => !t.done).sort((a, b) => {
      const priorityDiff = todoPriorityRank(a.priority) - todoPriorityRank(b.priority)
      if (priorityDiff !== 0) {
        return priorityDiff
      }
      if (a.dueDate && b.dueDate) {
        const dueDiff = a.dueDate.localeCompare(b.dueDate)
        if (dueDiff !== 0) {
          return dueDiff
        }
      } else if (a.dueDate || b.dueDate) {
        return a.dueDate ? -1 : 1
      }
      return b.createdAt.localeCompare(a.createdAt)
    })
    const done = entry.todos.filter((t) => t.done).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { note: entry.note, dailyActiveTodos: active, dailyDoneTodos: done }
  }, [dailyByDate, dailyDate])

  const dailySearchResults = useMemo(() => {
    const q = dailySearch.trim().toLowerCase()
    if (!q) {
      return []
    }
    return Object.entries(dailyByDate)
      .map(([date, day]) => {
        const note = day.note.toLowerCase()
        const todosText = day.todos
          .map((t) => `${t.text} ${t.priority} ${t.dueDate}`.toLowerCase())
          .join('\n')
        const hit = note.includes(q) || todosText.includes(q) || date.includes(q)
        return hit
          ? {
              date,
              preview: day.note.trim().slice(0, 80) || '(메모 없음)',
              todoCount: day.todos.length,
            }
          : null
      })
      .filter((row): row is { date: string; preview: string; todoCount: number } => row !== null)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 25)
  }, [dailyByDate, dailySearch])

  const recentLinkedRows = useMemo(
    () =>
      [...linkedRows]
        .filter((row) => row.scope !== 'meeting')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 10),
    [linkedRows],
  )

  const weeklyTimeline = useMemo(() => {
    const base = new Date(`${todayLocalIsoDate()}T12:00:00`)
    if (Number.isNaN(base.getTime())) {
      return []
    }
    return Array.from({ length: 7 }, (_, index) => {
      const d = new Date(base)
      d.setDate(base.getDate() - index)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const key = `${y}-${m}-${day}`
      const row = dailyByDate[key] ?? { note: '', todos: [] as MemoTodoItem[] }
      const doneCount = row.todos.filter((t) => t.done).length
      const activeTodos = row.todos.filter((t) => !t.done).slice(0, 3)
      const doneTodos = row.todos.filter((t) => t.done).slice(0, 2)
      return {
        date: key,
        title: `${m}/${day}`,
        notePreview: row.note.trim().slice(0, 220),
        todoTotal: row.todos.length,
        todoDone: doneCount,
        activeTodos,
        doneTodos,
      }
    })
  }, [dailyByDate])

  useEffect(() => {
    if (memoTab !== 'daily') {
      return
    }
    if (dailyNoteHistoryRef.current.length === 0) {
      dailyNoteHistoryRef.current = [dailyDaySlice.note]
      dailyNoteHistoryIndexRef.current = 0
      dailyNoteGroupOpenRef.current = false
    }
  }, [dailyDaySlice.note, memoTab])

  useEffect(() => {
    if (memoTab !== 'daily') {
      return
    }
    if (dailyMeetingSectionEditingRef.current) {
      return
    }
    setDailyMeetingSections(parseDailyMeetingSections(dailyDaySlice.note))
  }, [dailyDaySlice.note, memoTab])

  const scopeLabel = (id: MemoScope) => SCOPE_META.find((s) => s.id === id)?.label ?? id
  const todoPriorityLabel = (priority: MemoTodoItem['priority']) =>
    priority === 'high' ? '높음' : priority === 'low' ? '낮음' : '보통'

  const clearDailyNoteGroupTimer = () => {
    if (dailyNoteGroupTimerRef.current !== null) {
      window.clearTimeout(dailyNoteGroupTimerRef.current)
      dailyNoteGroupTimerRef.current = null
    }
  }

  const restartDailyNoteGroupTimer = () => {
    clearDailyNoteGroupTimer()
    dailyNoteGroupTimerRef.current = window.setTimeout(() => {
      dailyNoteGroupOpenRef.current = false
      dailyNoteGroupTimerRef.current = null
    }, DAILY_NOTE_GROUP_IDLE_MS)
  }

  const pushDailyNoteHistory = (next: string) => {
    let history = dailyNoteHistoryRef.current
    let index = dailyNoteHistoryIndexRef.current
    const current = history[index] ?? ''
    if (next === current) {
      return
    }

    if (index < history.length - 1) {
      history = history.slice(0, index + 1)
    }

    history = [...history, next]
    if (history.length > MAX_DAILY_NOTE_HISTORY) {
      history = history.slice(history.length - MAX_DAILY_NOTE_HISTORY)
    }
    dailyNoteHistoryRef.current = history
    dailyNoteHistoryIndexRef.current = history.length - 1
  }

  const replaceDailyNoteHistoryTop = (next: string) => {
    const history = dailyNoteHistoryRef.current
    const index = dailyNoteHistoryIndexRef.current
    if (index < 0 || index >= history.length) {
      return
    }
    if (history[index] === next) {
      return
    }
    history[index] = next
    dailyNoteHistoryRef.current = [...history]
  }

  const applyDailyNoteFromHistory = (note: string) => {
    dailyNoteApplyingHistoryRef.current = true
    setDailyByDate((prev) => {
      const todos = prev[dailyDate]?.todos ?? []
      return { ...prev, [dailyDate]: { note, todos } }
    })
    dailyNoteApplyingHistoryRef.current = false
    dailyNoteGroupOpenRef.current = false
    clearDailyNoteGroupTimer()
  }

  const flushLiveDailyNoteToHistory = () => {
    const live = dailyNoteTextareaRef.current?.value ?? dailyDaySlice.note
    const current = dailyNoteHistoryRef.current[dailyNoteHistoryIndexRef.current] ?? ''
    if (live === current) {
      return
    }
    pushDailyNoteHistory(live)
    dailyNoteGroupOpenRef.current = false
    clearDailyNoteGroupTimer()
  }

  const handleDailyNoteChange = (next: string) => {
    if (dailyNoteApplyingHistoryRef.current) {
      return
    }
    if (dailyNoteIsComposingRef.current) {
      setDailyByDate((prev) => {
        const todos = prev[dailyDate]?.todos ?? []
        return { ...prev, [dailyDate]: { note: next, todos } }
      })
      return
    }

    const historyCurrent = dailyNoteHistoryRef.current[dailyNoteHistoryIndexRef.current] ?? ''
    const forceBoundary = dailyNoteForceBoundaryRef.current
    dailyNoteForceBoundaryRef.current = false

    if (!dailyNoteGroupOpenRef.current || forceBoundary) {
      pushDailyNoteHistory(next)
      dailyNoteGroupOpenRef.current = !forceBoundary
      if (forceBoundary) {
        clearDailyNoteGroupTimer()
      } else {
        restartDailyNoteGroupTimer()
      }
    } else {
      replaceDailyNoteHistoryTop(next)
      restartDailyNoteGroupTimer()
    }

    const insertedOneChar = next.length === historyCurrent.length + 1
    if (insertedOneChar && DAILY_NOTE_WORD_BREAK_RE.test(next.slice(-1))) {
      dailyNoteGroupOpenRef.current = false
      clearDailyNoteGroupTimer()
    }

    setDailyByDate((prev) => {
      const todos = prev[dailyDate]?.todos ?? []
      return { ...prev, [dailyDate]: { note: next, todos } }
    })
  }

  const undoDailyNote = () => {
    flushLiveDailyNoteToHistory()
    const index = dailyNoteHistoryIndexRef.current
    if (index <= 0) {
      setStatusMessage('실행 취소할 단계 없음')
      return
    }
    const nextIndex = index - 1
    dailyNoteHistoryIndexRef.current = nextIndex
    const previous = dailyNoteHistoryRef.current[nextIndex] ?? ''
    applyDailyNoteFromHistory(previous)
    setStatusMessage('실행 취소 · Ctrl+Z')
  }

  const redoDailyNote = () => {
    flushLiveDailyNoteToHistory()
    const index = dailyNoteHistoryIndexRef.current
    if (index >= dailyNoteHistoryRef.current.length - 1) {
      setStatusMessage('다시 실행할 단계 없음')
      return
    }
    const nextIndex = index + 1
    dailyNoteHistoryIndexRef.current = nextIndex
    const next = dailyNoteHistoryRef.current[nextIndex] ?? ''
    applyDailyNoteFromHistory(next)
    setStatusMessage('다시 실행 · Ctrl+Y / Ctrl+Shift+Z')
  }

  const onDailyNoteKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      undoDailyNote()
      return
    }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault()
      redoDailyNote()
      return
    }
    if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      redoDailyNote()
    }
  }

  const addDailyTodo = () => {
    const text = draftDailyTodo.trim()
    if (!text) {
      return
    }
    const now = new Date().toISOString()
    const nextTodo: MemoTodoItem = {
      id: createId(),
      text,
      done: false,
      createdAt: now,
      dueDate: draftDailyTodoDueDate,
      priority: draftDailyTodoPriority,
    }
    setDailyByDate((prev) => {
      const cur = prev[dailyDate] ?? { note: '', todos: [] }
      return {
        ...prev,
        [dailyDate]: {
          ...cur,
          todos: [nextTodo, ...cur.todos],
        },
      }
    })
    setTodos((prev) => [nextTodo, ...prev])
    setDraftDailyTodo('')
    setDraftDailyTodoDueDate('')
    setDraftDailyTodoPriority('normal')
    setStatusMessage('할 일 추가')
  }

  const removeDailyTodoEverywhere = (id: string) => {
    setDailyByDate((prev) => {
      let changed = false
      const next: Record<string, DailyMeetingDay> = {}
      for (const [dateKey, day] of Object.entries(prev)) {
        const todos = day.todos.filter((t) => t.id !== id)
        if (todos.length !== day.todos.length) {
          changed = true
        }
        next[dateKey] = { ...day, todos }
      }
      return changed ? next : prev
    })
  }

  const toggleDailyTodo = (id: string) => {
    const target =
      dailyDaySlice.dailyActiveTodos.find((t) => t.id === id) ?? dailyDaySlice.dailyDoneTodos.find((t) => t.id === id)
    if (!target) {
      return
    }
    const nextDone = !target.done
    setDailyByDate((prev) => {
      const cur = prev[dailyDate] ?? { note: '', todos: [] }
      const todos = cur.todos.map((t) => {
        if (t.id !== id) {
          return t
        }
        return { ...t, done: nextDone }
      })
      return { ...prev, [dailyDate]: { ...cur, todos } }
    })
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: nextDone } : t)))
  }

  const removeDailyTodo = (id: string) => {
    removeDailyTodoEverywhere(id)
    setTodos((prev) => prev.filter((t) => t.id !== id))
    setStatusMessage('할 일 삭제')
  }

  const shiftDailyDate = (deltaDays: number) => {
    const base = new Date(`${dailyDate}T12:00:00`)
    if (Number.isNaN(base.getTime())) {
      setDailyDate(todayLocalIsoDate())
      return
    }
    base.setDate(base.getDate() + deltaDays)
    const y = base.getFullYear()
    const m = String(base.getMonth() + 1).padStart(2, '0')
    const day = String(base.getDate()).padStart(2, '0')
    setDailyDate(`${y}-${m}-${day}`)
  }

  const addMemo = () => {
    const title = draftTitle.trim()
    const body = draftBody.trim()
    if (!title && !body) {
      setStatusMessage('제목 또는 내용 필요')
      return
    }
    const now = new Date().toISOString()
    const next: ConvenienceMemo = {
      id: createId(),
      scope: draftScope,
      title: title || '(제목 없음)',
      body,
      createdAt: now,
      updatedAt: now,
    }
    setItems((prev) => [next, ...prev])
    setDraftTitle('')
    setDraftBody('')
    setStatusMessage('추가됨')
  }

  const startEdit = (item: ConvenienceMemo) => {
    setEditingLinkedRow(null)
    setEditingId(item.id)
    setEditTitle(item.title === '(제목 없음)' ? '' : item.title)
    setEditBody(item.body)
    setEditScope(item.scope)
  }

  const parseInventoryTitleDate = (title: string) => {
    const m = title.match(/기준일\s+(\S+)/)
    const raw = (m?.[1] ?? '').trim().slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
  }

  const startEditLinked = (row: LinkedMemoRow) => {
    setEditingId(null)
    setEditingLinkedRow(row)
    setEditLinkBody(row.body)
    setEditLinkDate(row.scope === 'inventory' ? parseInventoryTitleDate(row.title) : '')
  }

  const cancelEditLinked = () => {
    setEditingLinkedRow(null)
    setEditLinkBody('')
    setEditLinkDate('')
  }

  const saveEditLinked = () => {
    if (!editingLinkedRow) {
      return
    }
    const ok = updateLinkedMemo(editingLinkedRow.linkKey, {
      body: editLinkBody,
      inventoryDate: editingLinkedRow.scope === 'inventory' ? editLinkDate : undefined,
    })
    if (ok) {
      setLinkedRows(collectLinkedMemos())
      cancelEditLinked()
      setStatusMessage('저장됨')
    } else {
      setStatusMessage('저장 실패')
    }
  }

  const removeLinked = (row: LinkedMemoRow) => {
    if (
      !window.confirm(
        `${row.origin}에 저장된 내용에서 이 메모를 지웁니다. 계속할까요?`,
      )
    ) {
      return
    }
    if (deleteLinkedMemo(row.linkKey)) {
      if (editingLinkedRow?.linkKey === row.linkKey) {
        cancelEditLinked()
      }
      setLinkedRows(collectLinkedMemos())
      setStatusMessage('삭제됨')
    } else {
      setStatusMessage('삭제 실패')
    }
  }

  const saveEdit = () => {
    if (!editingId) {
      return
    }
    const title = editTitle.trim()
    const body = editBody.trim()
    if (!title && !body) {
      setStatusMessage('비우려면 삭제')
      return
    }
    const now = new Date().toISOString()
    setItems((prev) =>
      prev.map((row) =>
        row.id === editingId
          ? {
              ...row,
              scope: editScope,
              title: title || '(제목 없음)',
              body,
              updatedAt: now,
            }
          : row,
      ),
    )
    setEditingId(null)
    setEditingLinkedRow(null)
    setEditLinkBody('')
    setEditLinkDate('')
    setStatusMessage('저장됨')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingLinkedRow(null)
    setEditLinkBody('')
    setEditLinkDate('')
  }

  const removeMemo = (id: string) => {
    setItems((prev) => prev.filter((row) => row.id !== id))
    if (editingId === id) {
      setEditingId(null)
    }
    setStatusMessage('삭제됨')
  }

  const applyDailyMeetingTemplate = () => {
    const current = dailyByDate[dailyDate]?.note ?? ''
    if (current.trim()) {
      const ok = window.confirm('현재 회의 메모를 템플릿으로 바꿀까요?')
      if (!ok) {
        return
      }
    }
    setDailyByDate((prev) => {
      const todos = prev[dailyDate]?.todos ?? []
      return { ...prev, [dailyDate]: { note: DAILY_MEETING_TEMPLATE, todos } }
    })
    setDailyMeetingSections(parseDailyMeetingSections(DAILY_MEETING_TEMPLATE))
    dailyNoteHistoryRef.current = [DAILY_MEETING_TEMPLATE]
    dailyNoteHistoryIndexRef.current = 0
    dailyNoteGroupOpenRef.current = false
    clearDailyNoteGroupTimer()
    setStatusMessage('일일회의 템플릿 적용')
  }

  const updateDailyMeetingSection = (key: DailyMeetingSectionKey, value: string) => {
    const nextSections: DailyMeetingSections = { ...dailyMeetingSections, [key]: value }
    setDailyMeetingSections(nextSections)
  }

  const commitDailyMeetingSections = (sections: DailyMeetingSections) => {
    setDailyByDate((prev) => {
      const todos = prev[dailyDate]?.todos ?? []
      return { ...prev, [dailyDate]: { note: buildDailyMeetingNoteFromSections(sections), todos } }
    })
  }

  return (
    <div className="memo-page">
      <header className="memo-page-top">
        <div className="memo-page-top-main">
          <h2 className="memo-page-top-title">
            {forceDailyOnly ? '일일회의' : forceComfortOnly ? '편의 메모' : '편의 메모 · 일일회의'}
          </h2>
          <p className="memo-page-status" role="status">
            {statusMessage}
          </p>
        </div>
        <PageSaveStatus
          className="memo-page-savebox"
          mode={runtimeMode}
          saveState={saveState}
          lastSavedAt={lastSavedAt}
          onSaveNow={runtimeMode === 'cloud' ? () => void saveNow() : undefined}
          disabled={saveState === 'saving'}
        />
      </header>

      {showModeTabs ? (
        <div className="segmented memo-page-mode-tabs" role="tablist" aria-label="메모 구분">
          <button
            type="button"
            role="tab"
            aria-selected={memoTab === 'comfort'}
            className={memoTab === 'comfort' ? 'active' : ''}
            onClick={() => setMemoTab('comfort')}
          >
            편의 메모
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={memoTab === 'daily'}
            className={memoTab === 'daily' ? 'active' : ''}
            onClick={() => setMemoTab('daily')}
          >
            일일회의
          </button>
        </div>
      ) : null}

      {memoTab === 'daily' ? (
        <div className="memo-daily">
          <div className="panel memo-daily-toolbar">
            <label className="memo-daily-date-field">
              <span>날짜</span>
              <input type="date" value={dailyDate} onChange={(e) => setDailyDate(e.target.value)} />
            </label>
            <div className="memo-daily-date-nav">
              <button type="button" className="memo-page-btn memo-page-btn--ghost" onClick={() => shiftDailyDate(-1)}>
                이전 날
              </button>
              <button type="button" className="memo-page-btn memo-page-btn--ghost" onClick={() => setDailyDate(todayLocalIsoDate())}>
                오늘
              </button>
              <button type="button" className="memo-page-btn memo-page-btn--ghost" onClick={() => shiftDailyDate(1)}>
                다음 날
              </button>
            </div>
            <label className="memo-daily-search-field">
              <span>검색</span>
              <input
                type="search"
                value={dailySearch}
                onChange={(e) => setDailySearch(e.target.value)}
                placeholder="메모/할 일/날짜 검색"
              />
            </label>
          </div>
          {dailySearch.trim() ? (
            <div className="panel memo-daily-search-panel" role="status" aria-live="polite">
              {dailySearchResults.length === 0 ? (
                <p className="memo-daily-search-empty">검색 결과 없음</p>
              ) : (
                <ul className="memo-daily-search-list">
                  {dailySearchResults.map((row) => (
                    <li key={row.date}>
                      <button
                        type="button"
                        className="memo-daily-search-result-btn"
                        onClick={() => {
                          setDailyDate(row.date)
                          setStatusMessage(`검색 이동: ${row.date}`)
                        }}
                      >
                        <strong>{row.date}</strong>
                        <span>{row.preview}</span>
                        <em>할 일 {row.todoCount}개</em>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          <section className="panel memo-daily-weekly-panel" aria-labelledby="memo-daily-weekly-heading">
            <div className="memo-daily-weekly-head">
              <h3 id="memo-daily-weekly-heading" className="memo-daily-block-title">
                최근 7일 타임라인
              </h3>
              <span className="memo-daily-weekly-sub">기준일 포함 최근 7일</span>
            </div>
            <ul className="memo-daily-weekly-list">
              {weeklyTimeline.map((row) => (
                <li key={row.date}>
                  <button
                    type="button"
                    className={row.date === dailyDate ? 'memo-daily-weekly-item is-active' : 'memo-daily-weekly-item'}
                    onClick={() => setDailyDate(row.date)}
                  >
                    <strong>
                      {row.title} <span>{row.date}</span>
                    </strong>
                    <em>
                      할 일 {row.todoDone}/{row.todoTotal}
                    </em>
                    <span className="memo-daily-weekly-hover-detail">
                      <span className="memo-daily-weekly-hover-title">회의 메모</span>
                      <span className="memo-daily-weekly-hover-body">
                        {(row.notePreview || '해당 날짜의 회의 메모가 없습니다.').split('\n').map((line, idx) => {
                          const trimmed = line.trim()
                          const isHeading =
                            trimmed === '이슈' ||
                            trimmed === '결정 사항' ||
                            trimmed === '요청/공유 사항' ||
                            trimmed === '내일 할 일'
                          return (
                            <span key={`${row.date}-line-${idx}`} className={isHeading ? 'is-heading' : undefined}>
                              {line || '\u00A0'}
                            </span>
                          )
                        })}
                      </span>
                      {row.todoTotal > 0 ? (
                        <span className="memo-daily-weekly-hover-todos">
                          <strong>할 일</strong>
                          {row.activeTodos.length > 0 ? (
                            <span className="memo-daily-weekly-hover-todo-group">
                              <em>진행</em>
                              {row.activeTodos.map((todo) => (
                                <span key={`${row.date}-active-${todo.id}`} className="todo-item">
                                  • {todo.text}
                                </span>
                              ))}
                            </span>
                          ) : null}
                          {row.doneTodos.length > 0 ? (
                            <span className="memo-daily-weekly-hover-todo-group">
                              <em>완료</em>
                              {row.doneTodos.map((todo) => (
                                <span key={`${row.date}-done-${todo.id}`} className="todo-item done">
                                  • {todo.text}
                                </span>
                              ))}
                            </span>
                          ) : null}
                          {row.todoTotal > row.activeTodos.length + row.doneTodos.length ? (
                            <span className="memo-daily-weekly-hover-more">
                              +{row.todoTotal - (row.activeTodos.length + row.doneTodos.length)}개 더 있음
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <div className="memo-daily-layout">
            <section className="panel memo-daily-note-block">
              <div className="memo-daily-note-head">
                <h3 className="memo-daily-block-title">회의 메모</h3>
                <div className="memo-daily-note-head-actions">
                  <button
                    type="button"
                    className="memo-page-btn memo-page-btn--ghost memo-page-btn--small"
                    onClick={applyDailyMeetingTemplate}
                  >
                    템플릿 넣기
                  </button>
                  <button
                    type="button"
                    className="memo-page-btn memo-page-btn--ghost memo-page-btn--small"
                    onClick={() => setShowDailyRawEditor((prev) => !prev)}
                  >
                    {showDailyRawEditor ? '원문 숨기기' : '원문 편집'}
                  </button>
                </div>
              </div>
              <div className="memo-daily-section-grid">
                {DAILY_MEETING_SECTION_META.map((section) => (
                  <label key={section.key} className={`memo-daily-section-card section-${section.key}`}>
                    <span className="memo-daily-section-label">{section.label}</span>
                    <textarea
                      value={dailyMeetingSections[section.key]}
                      onChange={(e) => updateDailyMeetingSection(section.key, e.target.value)}
                      onFocus={() => {
                        dailyMeetingSectionEditingRef.current = true
                      }}
                      onBlur={() => {
                        dailyMeetingSectionEditingRef.current = false
                        commitDailyMeetingSections(dailyMeetingSections)
                      }}
                      placeholder={section.placeholder}
                      rows={4}
                    />
                  </label>
                ))}
              </div>
              {showDailyRawEditor ? (
                <textarea
                  ref={dailyNoteTextareaRef}
                  className="memo-daily-note-textarea"
                  value={dailyDaySlice.note}
                  onChange={(e) => handleDailyNoteChange(e.target.value)}
                  onKeyDown={onDailyNoteKeyDown}
                  onPaste={() => {
                    dailyNoteForceBoundaryRef.current = true
                  }}
                  onCut={() => {
                    dailyNoteForceBoundaryRef.current = true
                  }}
                  onDrop={() => {
                    dailyNoteForceBoundaryRef.current = true
                  }}
                  onCompositionStart={() => {
                    dailyNoteIsComposingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    dailyNoteIsComposingRef.current = false
                    dailyNoteGroupOpenRef.current = false
                    clearDailyNoteGroupTimer()
                  }}
                  placeholder="원문을 직접 편집할 수 있어요…"
                  rows={8}
                />
              ) : null}
            </section>

            <aside className="panel memo-daily-todos-block" aria-labelledby="memo-daily-todos-heading">
              <h3 id="memo-daily-todos-heading" className="memo-daily-block-title">
                오늘 할 일
              </h3>
              <div className="memo-todo-add">
                <input
                  type="text"
                  value={draftDailyTodo}
                  onChange={(e) => setDraftDailyTodo(e.target.value)}
                  onKeyDown={(e) => {
                    const native = e.nativeEvent as globalThis.KeyboardEvent
                    if (native.isComposing || native.keyCode === 229) {
                      return
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addDailyTodo()
                    }
                  }}
                  placeholder="새 할 일…"
                  maxLength={500}
                />
                <div className="memo-todo-add-meta">
                  <label className="memo-todo-meta-field">
                    <span>기한</span>
                    <input
                      type="date"
                      value={draftDailyTodoDueDate}
                      onChange={(e) => setDraftDailyTodoDueDate(e.target.value)}
                    />
                  </label>
                  <label className="memo-todo-meta-field">
                    <span>우선순위</span>
                    <div className="memo-todo-priority-buttons" role="group" aria-label="우선순위 선택">
                      {TODO_PRIORITY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={
                            draftDailyTodoPriority === option.value
                              ? `memo-todo-priority-btn is-active priority-${option.value}`
                              : `memo-todo-priority-btn priority-${option.value}`
                          }
                          onClick={() => setDraftDailyTodoPriority(option.value)}
                          aria-pressed={draftDailyTodoPriority === option.value}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </label>
                </div>
                <button type="button" className="memo-page-btn memo-page-btn--primary" onClick={addDailyTodo}>
                  추가
                </button>
              </div>
              <div className="memo-todo-sections">
                <section className="memo-todo-section" aria-label="진행 중">
                  <h4 className="memo-todo-section-title">진행 중</h4>
                  {dailyDaySlice.dailyActiveTodos.length === 0 ? (
                    <p className="memo-todo-empty">없음</p>
                  ) : (
                    <ul className="memo-todo-list">
                      {dailyDaySlice.dailyActiveTodos.map((t) => (
                        <li key={t.id} className="memo-todo-row">
                          <label className="memo-todo-check-label">
                            <input
                              type="checkbox"
                              className="memo-todo-check"
                              checked={false}
                              onChange={() => toggleDailyTodo(t.id)}
                              aria-label={`완료: ${t.text}`}
                            />
                            <span className="memo-todo-text-wrap">
                              <span className="memo-todo-text">{t.text}</span>
                              <span className="memo-todo-meta-badges">
                                <span className={`memo-todo-priority-badge priority-${t.priority}`}>
                                  우선 {todoPriorityLabel(t.priority)}
                                </span>
                                {t.dueDate ? <span className="memo-todo-due-badge">기한 {t.dueDate}</span> : null}
                              </span>
                            </span>
                          </label>
                          <button type="button" className="memo-todo-remove" onClick={() => removeDailyTodo(t.id)}>
                            삭제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="memo-todo-section" aria-label="완료">
                  <h4 className="memo-todo-section-title">완료</h4>
                  {dailyDaySlice.dailyDoneTodos.length === 0 ? (
                    <p className="memo-todo-empty">없음</p>
                  ) : (
                    <ul className="memo-todo-list">
                      {dailyDaySlice.dailyDoneTodos.map((t) => (
                        <li key={t.id} className="memo-todo-row memo-todo-row--done">
                          <label className="memo-todo-check-label">
                            <input
                              type="checkbox"
                              className="memo-todo-check"
                              checked
                              onChange={() => toggleDailyTodo(t.id)}
                              aria-label={`진행 중으로: ${t.text}`}
                            />
                            <span className="memo-todo-text-wrap">
                              <span className="memo-todo-text">{t.text}</span>
                              <span className="memo-todo-meta-badges">
                                <span className={`memo-todo-priority-badge priority-${t.priority}`}>
                                  우선 {todoPriorityLabel(t.priority)}
                                </span>
                                {t.dueDate ? <span className="memo-todo-due-badge">기한 {t.dueDate}</span> : null}
                              </span>
                            </span>
                          </label>
                          <button type="button" className="memo-todo-remove" onClick={() => removeDailyTodo(t.id)}>
                            삭제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </aside>
          </div>
          <section className="panel memo-daily-linked-panel" aria-labelledby="memo-daily-linked-heading">
            <div className="memo-daily-linked-head">
              <h3 id="memo-daily-linked-heading" className="memo-daily-block-title">
                연동 메모 최근 10개
              </h3>
              <span>마우스를 올리면 내용 보기</span>
            </div>
            {recentLinkedRows.length === 0 ? (
              <p className="memo-daily-linked-empty">연동된 메모가 없습니다.</p>
            ) : (
              <ul className="memo-daily-linked-list">
                {recentLinkedRows.map((row) => (
                  <li key={row.linkKey}>
                    <div className="memo-daily-linked-item">
                      <strong>{row.title}</strong>
                      <span>{row.origin}</span>
                      <em>{row.updatedAt.slice(0, 10)}</em>
                      <div className="memo-daily-linked-hover">{row.body || '내용 없음'}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
      <div className="memo-page-main">
      <section className="panel memo-page-compose">
        <h3 className="memo-page-compose-heading">새 메모</h3>
        <div className="memo-page-compose-grid">
          <label className="memo-page-field">
            <span>영역</span>
            <select value={draftScope} onChange={(e) => setDraftScope(e.target.value as MemoScope)}>
              {SCOPE_META.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="memo-page-field memo-page-field--title">
            <span>제목</span>
            <input type="text" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} maxLength={200} />
          </label>
          <label className="memo-page-field memo-page-field--body">
            <span>내용</span>
            <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={4} />
          </label>
        </div>
        <div className="memo-page-compose-actions">
          <button type="button" className="memo-page-btn memo-page-btn--primary" onClick={addMemo}>
            추가
          </button>
        </div>
      </section>

      <section className="memo-page-board">
        <div className="memo-page-toolbar panel">
          <div className="memo-page-chips" role="group" aria-label="영역 필터">
            <button
              type="button"
              className={filterScope === 'all' ? 'memo-chip memo-chip--active' : 'memo-chip'}
              onClick={() => setFilterScope('all')}
            >
              전체
            </button>
            {SCOPE_META.map((s) => (
              <button
                key={s.id}
                type="button"
                className={filterScope === s.id ? 'memo-chip memo-chip--active' : 'memo-chip'}
                onClick={() => setFilterScope(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="memo-page-search">
            <span className="visually-hidden">검색</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="검색" />
          </label>
        </div>

        {filteredMerged.length === 0 ? (
          <div className="panel memo-page-empty">
            <p className="memo-page-empty-title">{hasAnyMemo ? '없음' : '메모 없음'}</p>
          </div>
        ) : (
          <ul className="memo-page-list">
            {filteredMerged.map((row) =>
              row.kind === 'local' ? (
                <li
                  key={`local-${row.data.id}`}
                  className={`memo-card memo-card--${row.data.scope}`}
                  data-scope={row.data.scope}
                >
                  {editingId === row.data.id ? (
                    <div className="memo-card-edit">
                      <label className="memo-page-field memo-page-field--inline">
                        <span>영역</span>
                        <select value={editScope} onChange={(e) => setEditScope(e.target.value as MemoScope)}>
                          {SCOPE_META.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="memo-page-field">
                        <span>제목</span>
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          maxLength={200}
                        />
                      </label>
                      <label className="memo-page-field">
                        <span>내용</span>
                        <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={5} />
                      </label>
                      <div className="memo-card-edit-actions">
                        <button type="button" className="memo-page-btn memo-page-btn--primary" onClick={saveEdit}>
                          저장
                        </button>
                        <button type="button" className="memo-page-btn memo-page-btn--ghost" onClick={cancelEdit}>
                          취소
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <header className="memo-card-head">
                        <span className="memo-card-scope">{scopeLabel(row.data.scope)}</span>
                        <div className="memo-card-dates">
                          <time className="memo-card-date" dateTime={row.data.createdAt}>
                            작성 {formatMemoDateTime(row.data.createdAt)}
                          </time>
                          {!sameUpToMinute(row.data.createdAt, row.data.updatedAt) ? (
                            <span className="memo-card-edited">수정 {formatMemoDateTime(row.data.updatedAt)}</span>
                          ) : null}
                        </div>
                      </header>
                      <h4 className="memo-card-title">{row.data.title}</h4>
                      {row.data.body ? (
                        <p className="memo-card-body">{row.data.body}</p>
                      ) : (
                        <p className="memo-card-body memo-card-body--muted">내용 없음</p>
                      )}
                      <footer className="memo-card-foot">
                        <button
                          type="button"
                          className="memo-page-btn memo-page-btn--ghost"
                          onClick={() => startEdit(row.data)}
                        >
                          편집
                        </button>
                        <button
                          type="button"
                          className="memo-page-btn memo-page-btn--danger"
                          onClick={() => removeMemo(row.data.id)}
                        >
                          삭제
                        </button>
                      </footer>
                    </>
                  )}
                </li>
              ) : (
                <li
                  key={`link-${row.data.linkKey}`}
                  className={`memo-card memo-card--linked memo-card--${row.data.scope}`}
                  data-scope={row.data.scope}
                >
                  {editingLinkedRow?.linkKey === row.data.linkKey ? (
                    <div className="memo-card-edit">
                      {row.data.scope === 'inventory' ? (
                        <label className="memo-page-field">
                          <span>기준일</span>
                          <input
                            type="date"
                            value={editLinkDate}
                            onChange={(e) => setEditLinkDate(e.target.value)}
                          />
                        </label>
                      ) : null}
                      <label className="memo-page-field">
                        <span>{row.data.scope === 'meeting' ? '내용' : '메모'}</span>
                        <textarea value={editLinkBody} onChange={(e) => setEditLinkBody(e.target.value)} rows={6} />
                      </label>
                      <div className="memo-card-edit-actions">
                        <button type="button" className="memo-page-btn memo-page-btn--primary" onClick={saveEditLinked}>
                          저장
                        </button>
                        <button type="button" className="memo-page-btn memo-page-btn--ghost" onClick={cancelEditLinked}>
                          취소
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <header className="memo-card-head">
                        <div className="memo-card-scope-row">
                          <span className="memo-card-scope">{scopeLabel(row.data.scope as MemoScope)}</span>
                          <span className="memo-card-origin">{row.data.origin}</span>
                        </div>
                        <div className="memo-card-dates">
                          <time className="memo-card-date" dateTime={row.data.createdAt}>
                            작성 {formatMemoDateTime(row.data.createdAt)}
                          </time>
                          {!sameUpToMinute(row.data.createdAt, row.data.updatedAt) ? (
                            <span className="memo-card-edited">수정 {formatMemoDateTime(row.data.updatedAt)}</span>
                          ) : null}
                        </div>
                      </header>
                      <h4 className="memo-card-title">{row.data.title}</h4>
                      <p className="memo-card-body">{row.data.body}</p>
                      <footer className="memo-card-foot">
                        <button
                          type="button"
                          className="memo-page-btn memo-page-btn--ghost"
                          onClick={() => startEditLinked(row.data)}
                        >
                          편집
                        </button>
                        <button
                          type="button"
                          className="memo-page-btn memo-page-btn--danger"
                          onClick={() => removeLinked(row.data)}
                        >
                          삭제
                        </button>
                      </footer>
                    </>
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>
      </div>
      )}
    </div>
  )
}
