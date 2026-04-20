import { Fragment, useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import PageSaveStatus from './components/PageSaveStatus'
import {
  EXPENSE_PAGE_SAVED_EVENT,
  EXPENSE_PAGE_STORAGE_KEY,
  readExpensePageStateFromStorage,
  type ExpenseRecord,
} from './ExpensePage'
import {
  getGreenBeanOrderMonthAggregate,
  GREEN_BEAN_ORDER_SAVED_EVENT,
  GREEN_BEAN_ORDER_STORAGE_KEY,
} from './GreenBeanOrderPage'
import { INVENTORY_STATUS_STORAGE_KEY } from './InventoryStatusPage'
import { exportStyledMeetingMonthExcel, sanitizeExcelFileBaseName } from './monthlyMeetingExcelStyledExport'
import { dayIndexForReferenceDate } from './inventoryStatusUtils'
import {
  monthlyMeetingData,
  type MeetingProductionRow,
  type MeetingStoreSalesRow,
  type MeetingValueRow,
  type MonthlyMeetingData,
} from './monthlyMeetingData'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'

/** 출고 표에서 생두 열과 구분하기 위한 기본 수동 품목(더치·디저트 등) 헤더 */
const MEETING_OUTBOUND_MANUAL_COLUMN_LABELS = new Set(
  monthlyMeetingData.productionColumns.slice(1).map((label) => label.trim()),
)
const MEETING_OUTBOUND_TOTAL_EXCLUDED_BEAN_NAMES = new Set(['Blending-Dark'])

/** 생두 비율 도넛 — 채도 낮은 톤온톤(원두·로스터리 느낌), 무지개색 피함 */
const OUTBOUND_SHARE_PIE_COLORS = [
  '#3f3a36',
  '#5c524a',
  '#6f6358',
  '#8a7b6c',
  '#4d5c52',
  '#5a5f66',
  '#6b6560',
  '#7d7268',
  '#8b806f',
  '#52575e',
]

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** 도넛 조각용 방사 그라데이션: 위쪽 하이라이트 → 바닥 쪽 살짝 어둡게 */
const pieShadeStops = (hex: string) => {
  const [r, g, b] = hexToRgb(hex)
  const hi = `rgb(${clampByte(r + (255 - r) * 0.3)},${clampByte(g + (255 - g) * 0.28)},${clampByte(b + (255 - b) * 0.26)})`
  const lo = `rgb(${clampByte(r * 0.72)},${clampByte(g * 0.7)},${clampByte(b * 0.68)})`
  return { hi, base: hex, lo }
}

export const MONTHLY_MEETING_DATA_KEY = 'monthly-meeting-data-v2'
/** 로스팅실 매출 거래명세 집계 기준 연·월 (`YYYY-MM`) */
const ROASTING_REF_YM_STORAGE_KEY = 'monthly-meeting-roasting-ref-ym-v1'
/** 1~5번 섹션 +/- 접힘 상태 */
const MEETING_SECTION_COLLAPSE_STORAGE_KEY = 'monthly-meeting-section-collapse-v1'
/** 자동 연동을 멈추는 수동 수정 모드 상태 */
const MEETING_SECTION_EDIT_MODE_STORAGE_KEY = 'monthly-meeting-section-edit-modes-v1'
/** 거래명세 기록 저장 키 — `App.tsx`의 `STORAGE_KEY`와 동일합니다. */
export const STATEMENT_RECORDS_STORAGE_KEY = 'statement-records-v1'
/** 거래명세 저장 후 월 마감 2번 표가 같은 탭에서도 갱신되도록 */
export const STATEMENT_RECORDS_SAVED_EVENT = 'statement-records-saved'
const currencyFormatter = new Intl.NumberFormat('ko-KR')

type MonthlyMeetingNotes = {
  summary: string
  actions: string
}

type MonthlyMeetingMonthState = {
  currentMonthSales: MeetingValueRow[]
  currentMonthCosts: MeetingValueRow[]
  materialCostDetails: MeetingValueRow[]
  otherCostDetails: MeetingValueRow[]
  storeSales: MeetingStoreSalesRow
  productionRow: MeetingProductionRow
  inventoryRow: MeetingProductionRow
}

type MonthlyMeetingPageState = {
  data: MonthlyMeetingData
  activeMonth: string
  notesByMonth: Record<string, MonthlyMeetingNotes>
  monthStatesByMonth: Record<string, MonthlyMeetingMonthState>
}
type MeetingSectionKey = 'summary' | 'roasting' | 'storeSales' | 'productionInventory' | 'notes'
type MeetingSectionEditKey = Exclude<MeetingSectionKey, 'notes'>

const defaultCollapsedSections = (): Record<MeetingSectionKey, boolean> => ({
  summary: false,
  roasting: false,
  storeSales: false,
  productionInventory: false,
  notes: false,
})

const readStoredCollapsedSections = (): Record<MeetingSectionKey, boolean> => {
  const base = defaultCollapsedSections()
  if (typeof window === 'undefined') {
    return base
  }
  try {
    const raw = window.localStorage.getItem(MEETING_SECTION_COLLAPSE_STORAGE_KEY)
    if (!raw) {
      return base
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      return base
    }
    const keys: MeetingSectionKey[] = ['summary', 'roasting', 'storeSales', 'productionInventory', 'notes']
    const next = { ...base }
    for (const k of keys) {
      if (typeof parsed[k] === 'boolean') {
        next[k] = parsed[k] as boolean
      }
    }
    return next
  } catch {
    return base
  }
}

/** 섹션별 수정/완료 토글이 있는 영역(회의 메모는 항상 직접 수정) */
const defaultSectionEditModes = (): Record<MeetingSectionEditKey, boolean> => ({
  summary: false,
  roasting: false,
  storeSales: false,
  productionInventory: false,
})

const readStoredSectionEditModes = (): Record<MeetingSectionEditKey, boolean> => {
  const base = defaultSectionEditModes()
  if (typeof window === 'undefined') {
    return base
  }
  try {
    const raw = window.localStorage.getItem(MEETING_SECTION_EDIT_MODE_STORAGE_KEY)
    if (!raw) {
      return base
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      return base
    }
    const keys: MeetingSectionEditKey[] = ['summary', 'roasting', 'storeSales', 'productionInventory']
    const next = { ...base }
    for (const key of keys) {
      if (typeof parsed[key] === 'boolean') {
        next[key] = parsed[key] as boolean
      }
    }
    return next
  } catch {
    return base
  }
}
type InventoryStorageBeanRow = {
  name?: unknown
  production?: unknown
  outbound?: unknown
  stock?: unknown
}
type InventoryStorageState = {
  referenceDate?: unknown
  days?: unknown
  beanRows?: unknown
  roastingRows?: unknown
}

const formatMoney = (value: number | null) =>
  value === null ? '-' : `${currencyFormatter.format(value)}원`

const meetingAmountDisplayFormatter = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 10,
  minimumFractionDigits: 0,
})

/** 매출·금액 입력/표시용(천 단위 콤마). 저장값은 숫자 그대로. */
const formatAmountForInput = (value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return ''
  }
  return meetingAmountDisplayFormatter.format(value)
}

const sharePercentDisplayFormatter = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

/** 점유비(0~1 비율) → 퍼센트 문자열 */
const formatSharePercent = (value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return ''
  }
  return `${sharePercentDisplayFormatter.format(value * 100)}%`
}

const excelCellAmount = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : meetingAmountDisplayFormatter.format(value)
const excelCellShare = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : `${sharePercentDisplayFormatter.format(value * 100)}%`
const formatOutboundAmountForInput = (value: number | null | undefined) =>
  value === 0 ? '' : formatAmountForInput(value)

const parseNullableNumber = (value: string) => {
  const normalized = value.replaceAll(',', '').trim()
  if (normalized === '') {
    return null
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}
const sumValues = (values: Array<number | null | undefined>) =>
  values.reduce<number>((sum, value) => sum + (value ?? 0), 0)

const todayYm = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const parseYm = (ym: string): { y: number; m: number } | null => {
  const matched = ym.trim().match(/^(\d{4})-(\d{2})$/)
  if (!matched) {
    return null
  }
  const y = Number(matched[1])
  const m = Number(matched[2])
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return null
  }
  return { y, m }
}

const formatYmKorean = (ym: string) => {
  const parsed = parseYm(ym)
  return parsed ? `${parsed.y}년 ${parsed.m}월` : ym.trim()
}
const isComputedSalesRow = (label: string) => label === '⑧총매출' || label === '⑨순이익'
const isComputedCostRow = (label: string) => label === '⑨비용계'
const isComputedDetailRow = (label: string) => label === '비용계'
const isComputedRoastingRow = (label: string) => label === '합 계' || label === '순이익'
/** 로스팅 표에서 거래처 매출 블록 아래에 오는 집계·비용·손익 행 */
const ROASTING_SUMMARY_BLOCK_LABELS = new Set(['합 계', '생두비용', '순이익'])
const parseMonthLabel = (value: unknown) => {
  if (typeof value !== 'string') {
    return null
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  const month = Number(match[2])
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return null
  }
  return `${month}월`
}

type StatementRecordStored = {
  clientName?: unknown
  deliveryDate?: unknown
  totalAmount?: unknown
}

const normalizeClientLabel = (value: string) => value.trim().replace(/\s+/g, ' ')

const parseStatementRecordsForRoasting = (raw: string): StatementRecordStored[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StatementRecordStored[]) : []
  } catch {
    return []
  }
}

/**
 * 거래명세 납품일(YYYY-MM)이 지정 연·월과 같으면 합산. 표·저장 호환을 위해 금액은 `january`에만 넣습니다.
 */
const aggregateRoastingSalesForYm = (
  records: StatementRecordStored[],
  year: number,
  month: number,
): Map<string, { november: number; december: number; january: number }> => {
  const map = new Map<string, number>()

  for (const rec of records) {
    const clientRaw = typeof rec.clientName === 'string' ? rec.clientName : ''
    const client = normalizeClientLabel(clientRaw)
    if (!client) {
      continue
    }
    const ds = typeof rec.deliveryDate === 'string' ? rec.deliveryDate.trim() : ''
    if (ds.length < 7) {
      continue
    }
    const amt =
      typeof rec.totalAmount === 'number' && Number.isFinite(rec.totalAmount) ? rec.totalAmount : 0
    if (amt === 0) {
      continue
    }

    const ym = ds.slice(0, 7)
    const [yy, mm] = ym.split('-')
    const yNum = Number(yy)
    const mNum = Number(mm)
    if (!Number.isFinite(yNum) || !Number.isFinite(mNum)) {
      continue
    }
    if (yNum !== year || mNum !== month) {
      continue
    }

    map.set(client, (map.get(client) ?? 0) + amt)
  }

  const rounded = new Map<string, { november: number; december: number; january: number }>()
  for (const [key, total] of map) {
    rounded.set(key, {
      november: 0,
      december: 0,
      january: Math.round(total),
    })
  }
  return rounded
}

const mergeRoastingSalesWithStatementAggregates = (
  roastingSales: MonthlyMeetingData['roastingSales'],
  aggregates: Map<string, { november: number; december: number; january: number }>,
): MonthlyMeetingData['roastingSales'] => {
  const computedLabels = new Set(['합 계', '순이익', '생두비용'])
  const norm = (label: string) => normalizeClientLabel(label)

  const updated = roastingSales.map((row) => {
    if (computedLabels.has(row.label)) {
      return row
    }
    const agg = aggregates.get(norm(row.label))
    if (!agg) {
      return row
    }
    return {
      ...row,
      share: null,
      november: agg.november,
      december: agg.december,
      january: agg.january,
    }
  })

  const existingKeys = new Set(
    updated.filter((row) => !computedLabels.has(row.label)).map((row) => norm(row.label)),
  )

  const insertIndex = updated.findIndex((row) => row.label === '합 계')
  const insertAt = insertIndex === -1 ? updated.length : insertIndex
  const extras: MonthlyMeetingData['roastingSales'] = []

  for (const [client, agg] of aggregates) {
    if (!existingKeys.has(client)) {
      extras.push({
        label: client,
        november: agg.november,
        december: agg.december,
        january: agg.january,
        share: null,
      })
      existingKeys.add(client)
    }
  }

  if (extras.length === 0) {
    return updated
  }

  const merged = [...updated]
  merged.splice(insertAt, 0, ...extras)
  return merged
}

const roastingSalesStatementSyncSignature = (rows: MonthlyMeetingData['roastingSales']) =>
  JSON.stringify(
    rows.map((r) => ({
      label: r.label,
      november: r.november,
      december: r.december,
      january: r.january,
    })),
  )

/** 월마감 4번 표 첫 열(출고 합계 등)과 생두별 열을 붙일 때 인식하는 헤더 */
const findOutboundAggregateColumnIndex = (columns: string[]) =>
  columns.findIndex((label) => {
    const t = label.trim()
    const n = t.toLowerCase().replace(/\s/g, '')
    return (
      t === '원두(KG)' ||
      t === '원두' ||
      n === '원두(kg)' ||
      n === '출고합계(kg)' ||
      n === '출고합계' ||
      t === '출고 합계(KG)' ||
      t === '출고합계(KG)' ||
      t.toLowerCase() === '출고 합계(kg)' ||
      t.toLowerCase() === '출고합계(kg)'
    )
  })

/** 입출고 생두 행의 「출고」 일자별 값 합 = 품목별 출고량(기간 합) */
const getInventoryBeanOutboundSummaries = (beanRows: unknown) => {
  if (!Array.isArray(beanRows)) {
    return [] as Array<{ name: string; totalOutbound: number }>
  }
  return beanRows
    .map((bean) => {
      const candidate = bean as InventoryStorageBeanRow | null
      const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
      const outbound = Array.isArray(candidate?.outbound) ? candidate.outbound : []
      const totalOutbound = outbound.reduce<number>(
        (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
        0,
      )
      return { name, totalOutbound: Math.round(totalOutbound * 1000) / 1000 }
    })
    .filter((item) => item.name.length > 0)
}

/**
 * 재고 표 끝에 붙은 생두 열이 동기화 때마다 다시 붙으면 열이 중복됩니다.
 * 현재 입출고와 동일한 생두 순서 `orderedNames`와 맞는 꼬리 구간을 모두 제거한 뒤 한 번만 붙입니다.
 */
const stripTrailingBeanColumnSuffix = (columns: string[], orderedNames: string[]): string[] => {
  if (orderedNames.length === 0) {
    return [...columns]
  }
  const norm = (s: string) => s.trim()
  const names = orderedNames.map(norm)
  const result = [...columns]
  const n = names.length
  const matchesBlockAtEnd = (cols: string[]) =>
    cols.length >= n && names.every((name, i) => norm(cols[cols.length - n + i] ?? '') === name)

  while (matchesBlockAtEnd(result)) {
    result.splice(result.length - n, n)
  }
  return result
}

/** `oldValues` 끝에서 `blockLen`짜리 생두 값 블록을 반복 제거해 `headLen`칸만 남깁니다. */
const stripTrailingBeanValueSuffix = (
  oldValues: Array<number | null>,
  headLen: number,
  blockLen: number,
): Array<number | null> => {
  if (blockLen <= 0) {
    return [...oldValues]
  }
  const vals = [...oldValues]
  while (vals.length > headLen && vals.length >= headLen + blockLen) {
    vals.splice(vals.length - blockLen, blockLen)
  }
  return vals
}

/** 입출고 기준일 열의 품목별 재고(저장된 stock 배열 기준). */
const getInventoryBeanStockSummaries = (
  beanRows: unknown,
  days: unknown,
  referenceDate: string,
): Array<{ name: string; stockAtReference: number }> => {
  if (!Array.isArray(beanRows) || !Array.isArray(days) || referenceDate.length < 10) {
    return []
  }
  const dayIdx = dayIndexForReferenceDate(days as number[], referenceDate)
  return beanRows
    .map((bean) => {
      const candidate = bean as InventoryStorageBeanRow | null
      const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
      const stock = Array.isArray(candidate?.stock) ? candidate.stock : []
      const raw = stock[dayIdx]
      const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      return { name, stockAtReference: Math.round(n * 1000) / 1000 }
    })
    .filter((item) => item.name.length > 0)
}

const computeCurrentMonthCosts = (rows: MeetingValueRow[]) => {
  const totalCosts = sumValues(rows.filter((row) => row.label !== '⑨비용계').map((row) => row.amount))

  return rows.map((row) =>
    row.label === '⑨비용계'
      ? { ...row, amount: totalCosts, share: null }
      : { ...row, share: totalCosts > 0 && row.amount !== null ? row.amount / totalCosts : null },
  )
}

const computeCurrentMonthSales = (sales: MeetingValueRow[], costs: MeetingValueRow[]) => {
  const totalSales = sumValues(sales.filter((row) => !isComputedSalesRow(row.label)).map((row) => row.amount))
  const totalCosts = costs.find((row) => row.label === '⑨비용계')?.amount ?? 0

  return sales.map((row) => {
    if (row.label === '⑧총매출') {
      return { ...row, amount: totalSales, share: null }
    }
    if (row.label === '⑨순이익') {
      return { ...row, amount: totalSales - totalCosts, share: null }
    }

    return {
      ...row,
      share: totalSales > 0 && row.amount !== null ? row.amount / totalSales : null,
    }
  })
}

const computeDetailRows = (rows: MeetingValueRow[]) => {
  const total = sumValues(rows.filter((row) => !isComputedDetailRow(row.label)).map((row) => row.amount))

  return rows.map((row) =>
    isComputedDetailRow(row.label)
      ? { ...row, amount: total, share: null }
      : { ...row, share: total > 0 && row.amount !== null ? row.amount / total : null },
  )
}

const computeOtherDetailRows = (rows: MeetingValueRow[]) => {
  const total = sumValues(rows.filter((row) => !isComputedDetailRow(row.label)).map((row) => row.amount))

  return rows.map((row) => (isComputedDetailRow(row.label) ? { ...row, amount: total } : row))
}

const EXPENSE_CATEGORY_TO_MEETING_COST_LABEL: Array<{
  meetingLabel: string
  categories: string[]
}> = [
  { meetingLabel: '①재료비', categories: ['원재료비'] },
  { meetingLabel: '③임대료', categories: ['임차료'] },
  { meetingLabel: '⑥전기세', categories: ['전기/수도/가스'] },
  { meetingLabel: '⑧인건비', categories: ['인건비'] },
]

const EXPENSE_CATEGORY_TO_MEETING_COST_LABEL_MAP = new Map<string, string>(
  EXPENSE_CATEGORY_TO_MEETING_COST_LABEL.flatMap(({ meetingLabel, categories }) =>
    categories.map((category) => [category, meetingLabel] as const),
  ),
)

const inferCalendarYearForMeetingMonth = (monthNum: number, records: ExpenseRecord[]): number => {
  const counts = new Map<number, number>()
  for (const r of records) {
    const ds = typeof r.expenseDate === 'string' ? r.expenseDate.trim() : ''
    if (ds.length < 7) {
      continue
    }
    const ym = ds.slice(0, 7)
    const parts = ym.split('-')
    const y = Number(parts[0])
    const m = Number(parts[1])
    if (!Number.isFinite(y) || !Number.isFinite(m) || m !== monthNum) {
      continue
    }
    counts.set(y, (counts.get(y) ?? 0) + 1)
  }
  if (counts.size > 0) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
    return ranked[0]![0]
  }
  return new Date().getFullYear()
}

const meetingMonthLabelToExpenseYm = (monthLabel: string, records: ExpenseRecord[]): string | null => {
  const m = monthLabel.trim().match(/^(\d{1,2})월$/)
  if (!m) {
    return null
  }
  const monthNum = Number(m[1])
  if (monthNum < 1 || monthNum > 12) {
    return null
  }
  const y = inferCalendarYearForMeetingMonth(monthNum, records)
  return `${y}-${String(monthNum).padStart(2, '0')}`
}

const buildMeetingCostsFromExpenses = (records: ExpenseRecord[], ym: string, base: MeetingValueRow[]): MeetingValueRow[] => {
  const ymPrefix = ym.trim()
  if (!/^\d{4}-\d{2}$/.test(ymPrefix)) {
    return base
  }
  const map = new Map<string, number>()
  for (const r of records) {
    const ds = typeof r.expenseDate === 'string' ? r.expenseDate.trim() : ''
    if (!ds.startsWith(ymPrefix)) {
      continue
    }
    const cat = (r.category ?? '').trim() || '기타운영비'
    const amt = typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : 0
    if (amt === 0) {
      continue
    }
    const meetingLabel = EXPENSE_CATEGORY_TO_MEETING_COST_LABEL_MAP.get(cat) ?? '②기타'
    map.set(meetingLabel, (map.get(meetingLabel) ?? 0) + amt)
  }
  return base.map((row) => {
    if (row.label === '⑨비용계') {
      return row
    }
    if (!map.has(row.label)) {
      return { ...row, amount: null }
    }
    return { ...row, amount: Math.round(map.get(row.label) ?? 0) }
  })
}

type MeetingSalesPatchKey = 'baemin' | 'coupang' | 'quick' | 'cash' | 'receipt' | 'transfer' | 'card'

const haystackToSalesPatchKey = (hay: string): MeetingSalesPatchKey | null => {
  const t = hay.trim()
  if (!t) {
    return null
  }
  if (/배달의민족|배민|우아한|woowahans/i.test(t)) {
    return 'baemin'
  }
  if (/쿠팡이츠|쿠팡/i.test(t)) {
    return 'coupang'
  }
  if (/땡겨요|요기요/i.test(t)) {
    return 'quick'
  }
  if (/현금영수증/.test(t)) {
    return 'receipt'
  }
  if (/무통장|계좌이체|이체|송금/i.test(t)) {
    return 'transfer'
  }
  if (/현금/.test(t) && !/영수증/.test(t)) {
    return 'cash'
  }
  if (/카드|신한|삼성|현대|롯데|kb|국민|비씨|하나|농협/i.test(t)) {
    return 'card'
  }
  return null
}

const salesRowLabelToPatchKey = (label: string): MeetingSalesPatchKey | null => {
  const t = label.trim()
  if (/(⑤|배달|민족|배민)/.test(t)) {
    return 'baemin'
  }
  if (/(⑥|쿠팡)/.test(t)) {
    return 'coupang'
  }
  if (/(⑦|땡겨요|요기요)/.test(t)) {
    return 'quick'
  }
  if (/영수증/.test(t)) {
    return 'receipt'
  }
  if (/③|계좌|이체|송금/.test(t)) {
    return 'transfer'
  }
  if (/①|^①|현금/.test(t)) {
    return 'cash'
  }
  if (/④|카드/.test(t)) {
    return 'card'
  }
  return null
}

const mergeSalesPatchMaps = (a: Map<MeetingSalesPatchKey, number>, b: Map<MeetingSalesPatchKey, number>) => {
  const out = new Map(a)
  for (const [k, v] of b) {
    out.set(k, (out.get(k) ?? 0) + v)
  }
  return out
}

const aggregateExpenseSalesPatches = (records: ExpenseRecord[], ym: string): Map<MeetingSalesPatchKey, number> => {
  const ymPrefix = ym.trim()
  const map = new Map<MeetingSalesPatchKey, number>()
  for (const r of records) {
    const ds = typeof r.expenseDate === 'string' ? r.expenseDate.trim() : ''
    if (!ds.startsWith(ymPrefix)) {
      continue
    }
    const amt = typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : 0
    if (amt === 0) {
      continue
    }
    const hay = `${r.category} ${r.vendorName} ${r.detail} ${r.memo}`
    const key = haystackToSalesPatchKey(hay)
    if (!key) {
      continue
    }
    map.set(key, (map.get(key) ?? 0) + amt)
  }
  return map
}

const aggregateDetailLabelSalesPatches = (
  materialRows: MeetingValueRow[],
  otherRows: MeetingValueRow[],
): Map<MeetingSalesPatchKey, number> => {
  const map = new Map<MeetingSalesPatchKey, number>()
  for (const row of [...materialRows, ...otherRows]) {
    if (isComputedDetailRow(row.label)) {
      continue
    }
    if (row.amount === null || row.amount === 0) {
      continue
    }
    const key = haystackToSalesPatchKey(row.label)
    if (!key) {
      continue
    }
    map.set(key, (map.get(key) ?? 0) + row.amount)
  }
  return map
}

const applySalesPatchesFromMap = (
  sales: MeetingValueRow[],
  patches: Map<MeetingSalesPatchKey, number>,
): MeetingValueRow[] => {
  if (patches.size === 0) {
    return sales
  }
  const consumed = new Set<MeetingSalesPatchKey>()
  return sales.map((row) => {
    if (isComputedSalesRow(row.label)) {
      return row
    }
    const pk = salesRowLabelToPatchKey(row.label)
    if (!pk || !patches.has(pk) || consumed.has(pk)) {
      return row
    }
    consumed.add(pk)
    const v = Math.round(patches.get(pk) ?? 0)
    if (row.amount === v) {
      return row
    }
    return { ...row, amount: v }
  })
}

const computeStoreSales = (row: MeetingStoreSalesRow) => {
  const total = sumValues([row.hall, row.delivery, row.quick])

  return {
    ...row,
    total,
    hallShare: total > 0 && row.hall !== null ? row.hall / total : null,
    deliveryShare: total > 0 && row.delivery !== null ? row.delivery / total : null,
    quickShare: total > 0 && row.quick !== null ? row.quick / total : null,
  }
}

const computeInventoryRow = (row: MeetingProductionRow): MeetingProductionRow => ({
  ...row,
  values: [...row.values],
})

const computeRoastingSales = (rows: MonthlyMeetingData['roastingSales']) => {
  const targetRows = rows.filter((row) => !['합 계', '생두비용', '순이익'].includes(row.label))
  const totalNovember = sumValues(targetRows.map((row) => row.november))
  const totalDecember = sumValues(targetRows.map((row) => row.december))
  const totalJanuary = sumValues(targetRows.map((row) => row.january))
  /** 집계 월 매출(거래명세·표에서 `january` 열에 해당) */
  const totalClosingMonth = totalJanuary

  return rows.map((row) => {
    if (row.label === '합 계') {
      return {
        ...row,
        november: totalNovember,
        december: totalDecember,
        january: totalJanuary,
        share: null,
      }
    }

    if (row.label === '순이익') {
      const beanCost = rows.find((item) => item.label === '생두비용')
      return {
        ...row,
        november: totalNovember - (beanCost?.november ?? 0),
        december: totalDecember - (beanCost?.december ?? 0),
        january: totalJanuary - (beanCost?.january ?? 0),
        share: null,
      }
    }

    if (row.label === '생두비용') {
      return {
        ...row,
        share: null,
      }
    }

    const currentValue = row.january

    return {
      ...row,
      share:
        totalClosingMonth > 0 && currentValue !== null ? currentValue / totalClosingMonth : null,
    }
  })
}

/** 출금 요약: 비용현황 ①②는 세부와 중복이므로 제외, ⑨는 합계 행으로만 사용 */
const MEETING_OUTBOUND_COST_FOR_DETAIL_SKIP = new Set(['①재료비', '②기타', '⑨비용계'])

type MeetingCashflowAmountLine = {
  label: string
  amount: number | null
  share: number | null
}

/** 구간 안에서만 점유비(해당 블록 금액 합계 = 100%) */
const applyCashflowSectionShares = (rows: MeetingCashflowAmountLine[]): MeetingCashflowAmountLine[] => {
  const sectionTotal = sumValues(rows.map((r) => r.amount))
  if (sectionTotal <= 0) {
    return rows.map((r) => ({ ...r, share: null }))
  }
  return rows.map((r) => {
    const a = r.amount
    const n = typeof a === 'number' && Number.isFinite(a) ? a : 0
    return {
      ...r,
      share: n > 0 ? n / sectionTotal : null,
    }
  })
}

/** 당월 결제 매출 + 로스팅 집계월 매출(거래처별) + 매장 판매(홀·배달·간편) */
const buildMeetingInboundCashflowParts = (
  computedSales: MeetingValueRow[],
  roastingComputed: ReturnType<typeof computeRoastingSales>,
  storeComputed: ReturnType<typeof computeStoreSales>,
) => {
  const channelPart: MeetingCashflowAmountLine[] = computedSales
    .filter((r) => !isComputedSalesRow(r.label))
    .map((r) => ({ label: r.label, amount: r.amount, share: null }))

  const roastingLines: MeetingCashflowAmountLine[] = roastingComputed
    .filter((r) => !['합 계', '생두비용', '순이익'].includes(r.label))
    .filter((r) => (r.january ?? 0) !== 0)
    .map((r) => ({
      label: `로스팅 · ${r.label}`,
      amount: r.january,
      share: null,
    }))

  const storeLines: MeetingCashflowAmountLine[] = []
  const hall = storeComputed.hall
  if (typeof hall === 'number' && Number.isFinite(hall) && hall !== 0) {
    storeLines.push({ label: '매장 · 홀 매출', amount: hall, share: null })
  }
  const delivery = storeComputed.delivery
  if (typeof delivery === 'number' && Number.isFinite(delivery) && delivery !== 0) {
    storeLines.push({ label: '매장 · 배달 채널', amount: delivery, share: null })
  }
  const quick = storeComputed.quick
  if (typeof quick === 'number' && Number.isFinite(quick) && quick !== 0) {
    storeLines.push({ label: '매장 · 간편배달', amount: quick, share: null })
  }

  const merged = [...channelPart, ...roastingLines, ...storeLines]
  const totalIn = sumValues(merged.map((r) => r.amount))
  return {
    channelPart: applyCashflowSectionShares(channelPart),
    roastingLines: applyCashflowSectionShares(roastingLines),
    storeLines: applyCashflowSectionShares(storeLines),
    totalIn,
  }
}

const getMeetingOutboundCashflow = (
  computedCosts: MeetingValueRow[],
  materialDetails: MeetingValueRow[],
  otherDetails: MeetingValueRow[],
  roastingComputed: ReturnType<typeof computeRoastingSales>,
) => {
  const materialLines = materialDetails.filter((r) => !isComputedDetailRow(r.label))
  const otherLines = otherDetails.filter((r) => !isComputedDetailRow(r.label))
  const beanRaw = roastingComputed.find((r) => r.label === '생두비용')?.january
  const beanN = typeof beanRaw === 'number' && Number.isFinite(beanRaw) ? beanRaw : 0
  const hasRoastingBean = beanN !== 0
  const roastingBeanCost: MeetingCashflowAmountLine | null = hasRoastingBean
    ? { label: '로스팅실 생두비용', amount: Math.round(beanRaw!), share: null }
    : null

  const extraCostLines = computedCosts.filter((r) => {
    if (MEETING_OUTBOUND_COST_FOR_DETAIL_SKIP.has(r.label)) {
      return false
    }
    if (hasRoastingBean && r.label === '⑨로스팅실원두') {
      return false
    }
    return true
  })
  /** 표에 나열한 줄과 동일하게 맞춤(로스팅 생두비용이 비용표 ⑨에 없을 때도 포함) */
  const totalOut =
    sumValues(materialLines.map((r) => r.amount)) +
    sumValues(otherLines.map((r) => r.amount)) +
    (roastingBeanCost?.amount ?? 0) +
    sumValues(extraCostLines.map((r) => r.amount))
  return { materialLines, otherLines, roastingBeanCost, extraCostLines, totalOut }
}

const getMeetingCashflowPl = (extendedTotalIn: number, extendedTotalOut: number) => ({
  totalIn: extendedTotalIn,
  totalOut: extendedTotalOut,
  net: extendedTotalIn - extendedTotalOut,
})

type MeetingInboundCashflowParts = ReturnType<typeof buildMeetingInboundCashflowParts>
type MeetingOutboundCashflowParts = ReturnType<typeof getMeetingOutboundCashflow>

const buildInboundCashflowExcelRows = (parts: MeetingInboundCashflowParts): (string | number)[][] => {
  const rows: (string | number)[][] = [
    ['1-4. 입금액 요약', '', '', ''],
    ['항목', '금액', '점유비', ''],
  ]
  if (parts.channelPart.length > 0) {
    rows.push(['〈당월 매출(결제)〉', '', '', ''])
    for (const row of parts.channelPart) {
      rows.push([row.label, excelCellAmount(row.amount), excelCellShare(row.share), ''])
    }
  }
  if (parts.roastingLines.length > 0) {
    rows.push(['〈로스팅실 매출〉', '', '', ''])
    for (const row of parts.roastingLines) {
      rows.push([row.label, excelCellAmount(row.amount), excelCellShare(row.share), ''])
    }
  }
  if (parts.storeLines.length > 0) {
    rows.push(['〈매장 전체 판매〉', '', '', ''])
    for (const row of parts.storeLines) {
      rows.push([row.label, excelCellAmount(row.amount), excelCellShare(row.share), ''])
    }
  }
  rows.push(['입금 합계', excelCellAmount(parts.totalIn), '', ''])
  return rows
}

const buildOutboundCashflowExcelRows = (parts: MeetingOutboundCashflowParts): (string | number)[][] => {
  const rows: (string | number)[][] = [
    ['1-5. 출금액 요약', '', '', ''],
    ['항목', '금액', '', ''],
  ]
  if (parts.materialLines.length > 0) {
    rows.push(['〈재료비 세부〉', '', '', ''])
    for (const row of parts.materialLines) {
      rows.push([row.label, excelCellAmount(row.amount), '', ''])
    }
  }
  if (parts.otherLines.length > 0) {
    rows.push(['〈기타 세부〉', '', '', ''])
    for (const row of parts.otherLines) {
      rows.push([row.label, excelCellAmount(row.amount), '', ''])
    }
  }
  if (parts.roastingBeanCost) {
    rows.push(['〈로스팅실 생두비용〉', '', '', ''])
    rows.push([
      parts.roastingBeanCost.label,
      excelCellAmount(parts.roastingBeanCost.amount),
      '',
      '',
    ])
  }
  rows.push(['〈비용현황(①② 제외)〉', '', '', ''])
  for (const row of parts.extraCostLines) {
    rows.push([row.label, excelCellAmount(row.amount), '', ''])
  }
  rows.push(['출금 합계', excelCellAmount(parts.totalOut), '', ''])
  return rows
}

const cloneValueRows = (rows: MeetingValueRow[]) => rows.map((row) => ({ ...row }))
const cloneProductionRow = (row: MeetingProductionRow): MeetingProductionRow => ({
  ...row,
  values: [...row.values],
})
const cloneStoreRow = (row: MeetingStoreSalesRow): MeetingStoreSalesRow => ({ ...row })
const createEmptyValueRow = (label: string): MeetingValueRow => ({
  label,
  amount: null,
  share: null,
})
const createEmptyRoastingRow = (label: string): MonthlyMeetingData['roastingSales'][number] => ({
  label,
  november: null,
  december: null,
  january: null,
  share: null,
})

const createEmptyStoreRow = (month: string): MeetingStoreSalesRow => ({
  month,
  hall: null,
  hallShare: null,
  delivery: null,
  deliveryShare: null,
  quick: null,
  quickShare: null,
  total: null,
})

const createEmptyProductionRow = (
  month: string,
  columns: string[],
): MeetingProductionRow => ({
  label: month,
  values: Array.from({ length: columns.length }, () => null),
})

const createMonthStates = (data: MonthlyMeetingData) =>
  data.months.reduce<Record<string, MonthlyMeetingMonthState>>((result, month) => {
    result[month] = {
      currentMonthSales: cloneValueRows(data.currentMonthSales),
      currentMonthCosts: cloneValueRows(data.currentMonthCosts),
      materialCostDetails: cloneValueRows(data.materialCostDetails),
      otherCostDetails: cloneValueRows(data.otherCostDetails),
      storeSales: cloneStoreRow(
        data.storeSales.find((row) => row.month === month) ?? createEmptyStoreRow(month),
      ),
      productionRow: cloneProductionRow(
        data.productionRows.find((row) => row.label === month) ??
          createEmptyProductionRow(month, data.productionColumns),
      ),
      inventoryRow: cloneProductionRow(
        data.inventoryRows.find((row) => row.label === month) ??
          createEmptyProductionRow(month, data.inventoryColumns),
      ),
    }
    return result
  }, {})

const createDefaultNotesByMonth = (months: string[]) =>
  months.reduce<Record<string, MonthlyMeetingNotes>>((result, month) => {
    result[month] = { summary: '', actions: '' }
    return result
  }, {})

const createDefaultState = (): MonthlyMeetingPageState => ({
  data: monthlyMeetingData,
  activeMonth: monthlyMeetingData.monthLabel,
  notesByMonth: createDefaultNotesByMonth(monthlyMeetingData.months),
  monthStatesByMonth: createMonthStates(monthlyMeetingData),
})

const normalizeMonthlyMeetingPageState = (raw: unknown): MonthlyMeetingPageState => {
  const parsed = (raw && typeof raw === 'object' ? raw : null) as Partial<MonthlyMeetingPageState> | null
  const parsedData = (parsed?.data as MonthlyMeetingData | undefined) ?? monthlyMeetingData
  const data = {
    ...parsedData,
    title: normalizeMeetingTitle(parsedData.title ?? monthlyMeetingData.title, parsedData.months),
  }

  return migrateProductionHeaderToOutbound(
    stripInventoryTotalAmountColumn({
      data,
      activeMonth: String(parsed?.activeMonth ?? data.monthLabel),
      notesByMonth: {
        ...createDefaultNotesByMonth(data.months),
        ...(parsed?.notesByMonth ?? {}),
      },
      monthStatesByMonth: {
        ...createMonthStates(data),
        ...(parsed?.monthStatesByMonth ?? {}),
      },
    }),
  )
}

const readMonthlyMeetingPageStateFromStorage = (): MonthlyMeetingPageState => {
  const saved = window.localStorage.getItem(MONTHLY_MEETING_DATA_KEY)
  if (!saved) {
    return createDefaultState()
  }

  try {
    return normalizeMonthlyMeetingPageState(JSON.parse(saved))
  } catch (error) {
    console.error('회의 데이터를 읽지 못했습니다.', error)
    return createDefaultState()
  }
}

const normalizeMeetingTitle = (title: string, months: string[]) => {
  const trimmed = title.trim()
  if (!trimmed) {
    return monthlyMeetingData.title
  }

  if (months.some((month) => trimmed === `${month} 마감 보고회의`)) {
    return '월 마감 보고회의'
  }

  return trimmed
}

/** 예전 저장본 재고 표 맨끝 `총액` 열 제거 */
const stripInventoryTotalAmountColumn = (state: MonthlyMeetingPageState): MonthlyMeetingPageState => {
  const idx = state.data.inventoryColumns.findIndex((label) => label.trim() === '총액')
  if (idx < 0) {
    return state
  }
  const inventoryColumns = state.data.inventoryColumns.filter((_, i) => i !== idx)
  const inventoryRows = state.data.inventoryRows.map((row) => ({
    ...row,
    values: row.values.filter((_, i) => i !== idx),
  }))
  const monthStatesByMonth = Object.fromEntries(
    Object.entries(state.monthStatesByMonth).map(([month, ms]) => [
      month,
      {
        ...ms,
        inventoryRow: {
          ...ms.inventoryRow,
          values: ms.inventoryRow.values.filter((_, i) => i !== idx),
        },
      },
    ]),
  ) as Record<string, MonthlyMeetingMonthState>

  return {
    ...state,
    data: {
      ...state.data,
      inventoryColumns,
      inventoryRows,
    },
    monthStatesByMonth,
  }
}

/** 예전 기본 헤더 `원두(KG)`(로스팅 합) → 출고 합계 열 명칭 */
const migrateProductionHeaderToOutbound = (state: MonthlyMeetingPageState): MonthlyMeetingPageState => {
  if (state.data.productionColumns[0]?.trim() !== '원두(KG)') {
    return state
  }
  const productionColumns = [...state.data.productionColumns]
  productionColumns[0] = '출고 합계(KG)'
  return {
    ...state,
    data: {
      ...state.data,
      productionColumns,
    },
  }
}

function MonthlyMeetingPage() {
  const { mode, activeCompanyId, user } = useAppRuntime()
  const [pageState, setPageState] = useState<MonthlyMeetingPageState>(createDefaultState)
  const [sectionEditModes, setSectionEditModes] = useState<Record<MeetingSectionEditKey, boolean>>(
    readStoredSectionEditModes,
  )
  const [isStorageReady, setIsStorageReady] = useState(false)
  const [isCloudReady, setIsCloudReady] = useState(mode === 'local')
  const {
    lastSavedAt,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    resetDocumentSaveUi,
    saveState,
    skipInitialDocumentSave,
  } = useDocumentSaveUi(mode)
  const [copyTargetMonth, setCopyTargetMonth] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<Record<MeetingSectionKey, boolean>>(
    readStoredCollapsedSections,
  )
  const [roastingSalesReferenceYm, setRoastingSalesReferenceYm] = useState(() => {
    try {
      const raw = window.localStorage.getItem(ROASTING_REF_YM_STORAGE_KEY)
      if (raw && parseYm(raw)) {
        return raw
      }
    } catch {
      /* ignore */
    }
    return todayYm()
  })
  const [greenBeanOrderSyncHint, setGreenBeanOrderSyncHint] = useState('')
  const [greenBeanOrderStorageRev, setGreenBeanOrderStorageRev] = useState(0)
  const [statementRecordsStorageRev, setStatementRecordsStorageRev] = useState(0)
  const [expensePageStorageRev, setExpensePageStorageRev] = useState(0)
  const [outboundShareChartOpen, setOutboundShareChartOpen] = useState(true)
  const [outboundPieHoveredSliceIndex, setOutboundPieHoveredSliceIndex] = useState<number | null>(null)
  const outboundPieGfxId = useId().replace(/:/g, '')
  const outboundPieFilterId = `meetingOutboundPieDepth-${outboundPieGfxId}`
  const outboundPieGradId = (index: number) => `meetingOutboundPieGrad-${outboundPieGfxId}-${index}`

  const applyGreenBeanOrderToRoastingBeanCost = () => {
    const ref = parseYm(roastingSalesReferenceYm)
    if (!ref) {
      setGreenBeanOrderSyncHint('집계할 연·월(위쪽「거래명세 집계 월」)을 선택해 주세요.')
      return
    }
    const ym = roastingSalesReferenceYm.trim()
    const agg = getGreenBeanOrderMonthAggregate(ym)
    if (!agg) {
      setGreenBeanOrderSyncHint('월 형식이 올바르지 않습니다.')
      return
    }
    if (!agg.hasMonth) {
      setPageState((current) => ({
        ...current,
        data: {
          ...current.data,
          roastingSales: current.data.roastingSales.map((row) =>
            row.label === '생두비용' ? { ...row, january: null } : row,
          ),
        },
      }))
      setGreenBeanOrderSyncHint(
        `${formatYmKorean(ym)} 생두 주문 일자 기록이 없어 생두비용(집계 월 열)을 비웠습니다.`,
      )
      return
    }
    setPageState((current) => ({
      ...current,
      data: {
        ...current.data,
        roastingSales: current.data.roastingSales.map((row) =>
          row.label === '생두비용' ? { ...row, january: agg.sumMoney } : row,
        ),
      },
    }))
    const slotLabel = formatYmKorean(ym)
    setGreenBeanOrderSyncHint(
      `${slotLabel} 생두 주문 ${agg.snapshotCount}건 합계(감면 반영) ${formatMoney(agg.sumMoney)}원을 생두비용에 반영했습니다. 순이익은 자동 재계산됩니다.`,
    )
  }

  useEffect(() => {
    const bumpGreenBean = () => setGreenBeanOrderStorageRev((n) => n + 1)
    const bumpStatements = () => setStatementRecordsStorageRev((n) => n + 1)
    const bumpExpense = () => setExpensePageStorageRev((n) => n + 1)
    window.addEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bumpGreenBean)
    window.addEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpStatements)
    window.addEventListener(EXPENSE_PAGE_SAVED_EVENT, bumpExpense)
    const onStorage = (event: StorageEvent) => {
      if (event.key === GREEN_BEAN_ORDER_STORAGE_KEY) {
        bumpGreenBean()
      }
      if (event.key === STATEMENT_RECORDS_STORAGE_KEY) {
        bumpStatements()
      }
      if (event.key === EXPENSE_PAGE_STORAGE_KEY) {
        bumpExpense()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bumpGreenBean)
      window.removeEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpStatements)
      window.removeEventListener(EXPENSE_PAGE_SAVED_EVENT, bumpExpense)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  /** 거래명세 납품일(집계 월) 기준으로 2번 표 거래처명 행의 매출 열을 자동 반영 */
  useEffect(() => {
    if (!isStorageReady || sectionEditModes.roasting) {
      return
    }
    const ref = parseYm(roastingSalesReferenceYm.trim())
    if (!ref) {
      return
    }
    const raw = window.localStorage.getItem(STATEMENT_RECORDS_STORAGE_KEY)
    const records = raw ? parseStatementRecordsForRoasting(raw) : []
    const aggregates = aggregateRoastingSalesForYm(records, ref.y, ref.m)
    setPageState((current) => {
      const merged = mergeRoastingSalesWithStatementAggregates(current.data.roastingSales, aggregates)
      if (
        roastingSalesStatementSyncSignature(current.data.roastingSales) ===
        roastingSalesStatementSyncSignature(merged)
      ) {
        return current
      }
      return {
        ...current,
        data: {
          ...current.data,
          roastingSales: merged,
        },
      }
    })
  }, [isStorageReady, sectionEditModes.roasting, roastingSalesReferenceYm, statementRecordsStorageRev])

  useEffect(() => {
    if (!isStorageReady || sectionEditModes.roasting) {
      return
    }
    const ym = roastingSalesReferenceYm.trim()
    if (!parseYm(ym)) {
      return
    }
    const agg = getGreenBeanOrderMonthAggregate(ym)
    if (!agg?.hasMonth) {
      return
    }
    const next = agg.sumMoney
    setPageState((current) => {
      const rows = current.data.roastingSales
      const idx = rows.findIndex((r) => r.label === '생두비용')
      if (idx === -1) {
        return current
      }
      if (rows[idx]!.january === next) {
        return current
      }
      return {
        ...current,
        data: {
          ...current.data,
          roastingSales: rows.map((r, i) => (i === idx ? { ...r, january: next } : r)),
        },
      }
    })
  }, [isStorageReady, sectionEditModes.roasting, roastingSalesReferenceYm, greenBeanOrderStorageRev])

  /** 지출표 → 재료비·기타 세부, 비용현황 ①②, 매출 채널(키워드) 자동 연동 */
  useEffect(() => {
    if (!isStorageReady || sectionEditModes.summary) {
      return
    }
    const { records } = readExpensePageStateFromStorage()
    setPageState((current) => {
      const fallbackStates = createMonthStates(current.data)
      let nextMonthStates = { ...current.monthStatesByMonth }
      let changed = false
      const valueRowsSignature = (rows: MeetingValueRow[]) =>
        JSON.stringify(rows.map((r) => ({ label: r.label, amount: r.amount })))

      for (const monthLabel of current.data.months) {
        const ym = meetingMonthLabelToExpenseYm(monthLabel, records)
        if (!ym) {
          continue
        }
        const base = nextMonthStates[monthLabel] ?? fallbackStates[monthLabel]!
        const nextCosts = computeCurrentMonthCosts(buildMeetingCostsFromExpenses(records, ym, base.currentMonthCosts))
        const salesPatchMap = mergeSalesPatchMaps(
          aggregateExpenseSalesPatches(records, ym),
          aggregateDetailLabelSalesPatches(base.materialCostDetails, base.otherCostDetails),
        )
        const nextSalesRaw = applySalesPatchesFromMap(base.currentMonthSales, salesPatchMap)

        const costsUnchanged =
          valueRowsSignature(nextCosts) ===
          valueRowsSignature(computeCurrentMonthCosts(base.currentMonthCosts))
        const salesUnchanged = valueRowsSignature(nextSalesRaw) === valueRowsSignature(base.currentMonthSales)

        if (costsUnchanged && salesUnchanged) {
          continue
        }

        nextMonthStates = {
          ...nextMonthStates,
          [monthLabel]: {
            ...base,
            currentMonthCosts: nextCosts,
            currentMonthSales: nextSalesRaw,
          },
        }
        changed = true
      }
      if (!changed) {
        return current
      }
      return { ...current, monthStatesByMonth: nextMonthStates }
    })
  }, [isStorageReady, sectionEditModes.summary, expensePageStorageRev])

  useEffect(() => {
    let cancelled = false

    setIsStorageReady(false)
    setIsCloudReady(mode === 'local')
    resetDocumentSaveUi()

    const applyState = (nextState: MonthlyMeetingPageState) => {
      if (cancelled) {
        return
      }
      setPageState(nextState)
      setIsStorageReady(true)
      setIsCloudReady(true)
    }

    const loadState = async () => {
      const localState = readMonthlyMeetingPageStateFromStorage()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyState(localState)
        return
      }

      try {
        const remoteState = await loadCompanyDocument<MonthlyMeetingPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.monthlyMeetingPage,
        )
        applyState(remoteState ? normalizeMonthlyMeetingPageState(remoteState) : localState)
      } catch (error) {
        console.error('월 마감회의 클라우드 문서를 읽지 못했습니다.', error)
        applyState(localState)
      }
    }

    void loadState()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode, resetDocumentSaveUi])

  useEffect(() => {
    setCopyTargetMonth((current) => {
      if (current && current !== pageState.activeMonth) {
        return current
      }

      return pageState.data.months.find((month) => month !== pageState.activeMonth) ?? pageState.activeMonth
    })
  }, [pageState.activeMonth, pageState.data.months])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(MONTHLY_MEETING_DATA_KEY, JSON.stringify(pageState))
  }, [isStorageReady, pageState])

  useEffect(() => {
    if (!isStorageReady || !isCloudReady) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    if (skipInitialDocumentSave()) {
      return
    }

    markDocumentDirty()

    const timeoutId = window.setTimeout(() => {
      markDocumentSaving()
      void saveCompanyDocument(
        activeCompanyId,
        COMPANY_DOCUMENT_KEYS.monthlyMeetingPage,
        pageState,
        user?.id,
      )
        .then(() => {
          markDocumentSaved()
        })
        .catch((error) => {
          console.error('월 마감회의 클라우드 저장에 실패했습니다.', error)
          markDocumentError()
        })
    }, 600)

    return () => window.clearTimeout(timeoutId)
  }, [
    activeCompanyId,
    isCloudReady,
    isStorageReady,
    mode,
    pageState,
    user?.id,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    skipInitialDocumentSave,
  ])

  useEffect(() => {
    if (parseYm(roastingSalesReferenceYm)) {
      window.localStorage.setItem(ROASTING_REF_YM_STORAGE_KEY, roastingSalesReferenceYm)
    }
  }, [roastingSalesReferenceYm])

  useEffect(() => {
    try {
      window.localStorage.setItem(MEETING_SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedSections))
    } catch {
      /* ignore */
    }
  }, [collapsedSections])

  useEffect(() => {
    try {
      window.localStorage.setItem(MEETING_SECTION_EDIT_MODE_STORAGE_KEY, JSON.stringify(sectionEditModes))
    } catch {
      /* ignore */
    }
  }, [sectionEditModes])

  useEffect(() => {
    const inventoryRaw = window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY)
    if (!inventoryRaw) {
      return
    }

    try {
      const parsed = JSON.parse(inventoryRaw) as InventoryStorageState
      const inventoryMonth = parseMonthLabel(parsed.referenceDate)
      if (!inventoryMonth || inventoryMonth !== pageState.activeMonth) {
        return
      }

      const refDate = typeof parsed.referenceDate === 'string' ? parsed.referenceDate : ''
      const beanSummaries = getInventoryBeanOutboundSummaries(parsed.beanRows)
      const totalOutboundAllBeans = Math.round(
        beanSummaries.reduce((s, b) => {
          if (MEETING_OUTBOUND_TOTAL_EXCLUDED_BEAN_NAMES.has(b.name.trim())) {
            return s
          }
          return s + b.totalOutbound
        }, 0) * 1000,
      ) / 1000
      const beanStockSummaries = getInventoryBeanStockSummaries(parsed.beanRows, parsed.days, refDate)
      const orderedStockBeanNames = beanStockSummaries.map((b) => b.name.trim())
      const orderedOutboundBeanNames = beanSummaries.map((b) => b.name.trim())

      setPageState((current) => {
        const monthState = current.monthStatesByMonth[current.activeMonth]
        if (!monthState) {
          return current
        }

        const rawBeanColumnIndex = findOutboundAggregateColumnIndex(current.data.productionColumns)
        const outboundMerge = rawBeanColumnIndex >= 0
        const productionTailCols = current.data.productionColumns.slice(rawBeanColumnIndex + 1)
        const productionTailColsDeduped = stripTrailingBeanColumnSuffix(
          productionTailCols,
          orderedOutboundBeanNames,
        )
        const nextProductionColumns = outboundMerge
          ? [
              ...current.data.productionColumns.slice(0, rawBeanColumnIndex + 1),
              ...productionTailColsDeduped,
              ...beanSummaries.map((item) => item.name),
            ]
          : current.data.productionColumns

        const totalIdxInCols = current.data.inventoryColumns.findIndex((label) => label.trim() === '총액')
        const inventoryWithoutTotal =
          totalIdxInCols >= 0
            ? current.data.inventoryColumns.filter((_, i) => i !== totalIdxInCols)
            : [...current.data.inventoryColumns]

        const strippedTotal = totalIdxInCols >= 0
        const shouldMergeBeans = beanStockSummaries.length > 0

        const invHeadColumnLabels = shouldMergeBeans
          ? stripTrailingBeanColumnSuffix(inventoryWithoutTotal, orderedStockBeanNames)
          : inventoryWithoutTotal

        let nextInventoryColumns = current.data.inventoryColumns
        let invHeadLen = 0
        if (shouldMergeBeans) {
          nextInventoryColumns = [...invHeadColumnLabels, ...beanStockSummaries.map((b) => b.name)]
          invHeadLen = invHeadColumnLabels.length
        } else if (strippedTotal) {
          nextInventoryColumns = inventoryWithoutTotal
        }

        const inventoryChanged = shouldMergeBeans || strippedTotal

        if (!outboundMerge && !inventoryChanged) {
          return current
        }

        const outboundBlockLen = orderedOutboundBeanNames.length

        const nextMonthStates = Object.fromEntries(
          Object.entries(current.monthStatesByMonth).map(([month, state]) => {
            let mergedProdValues = state.productionRow.values
            if (outboundMerge) {
              const headValues = state.productionRow.values.slice(0, rawBeanColumnIndex + 1)
              let tailValues = state.productionRow.values.slice(rawBeanColumnIndex + 1)
              while (
                outboundBlockLen > 0 &&
                tailValues.length > productionTailColsDeduped.length &&
                tailValues.length >= outboundBlockLen
              ) {
                tailValues = tailValues.slice(0, -outboundBlockLen)
              }
              tailValues = tailValues.slice(0, productionTailColsDeduped.length)
              while (tailValues.length < productionTailColsDeduped.length) {
                tailValues.push(null)
              }
              const beanTailValues = beanSummaries.map(() => null as number | null)
              mergedProdValues = [...headValues, ...tailValues, ...beanTailValues]
              if (month === current.activeMonth) {
                mergedProdValues[rawBeanColumnIndex] = totalOutboundAllBeans
                beanSummaries.forEach((item, index) => {
                  mergedProdValues[rawBeanColumnIndex + 1 + productionTailColsDeduped.length + index] =
                    item.totalOutbound
                })
              }
            }

            let oldInv = [...state.inventoryRow.values]
            if (strippedTotal && totalIdxInCols < oldInv.length) {
              oldInv.splice(totalIdxInCols, 1)
            }

            let nextInvValues = state.inventoryRow.values
            if (inventoryChanged) {
              if (shouldMergeBeans) {
                const width = nextInventoryColumns.length
                nextInvValues = Array.from({ length: width }, () => null as number | null)
                const stockBlockLen = orderedStockBeanNames.length
                const invHeadVals = stripTrailingBeanValueSuffix(oldInv, invHeadLen, stockBlockLen)
                for (let i = 0; i < invHeadLen; i++) {
                  nextInvValues[i] = invHeadVals[i] ?? null
                }
                if (month === current.activeMonth) {
                  beanStockSummaries.forEach((b, j) => {
                    nextInvValues[invHeadLen + j] = b.stockAtReference
                  })
                }
              } else {
                nextInvValues = oldInv.slice(0, nextInventoryColumns.length)
                while (nextInvValues.length < nextInventoryColumns.length) {
                  nextInvValues.push(null)
                }
              }
            }

            return [
              month,
              {
                ...state,
                productionRow: {
                  ...state.productionRow,
                  values: mergedProdValues,
                },
                inventoryRow: {
                  ...state.inventoryRow,
                  values: nextInvValues,
                },
              },
            ]
          }),
        ) as Record<string, MonthlyMeetingMonthState>

        return {
          ...current,
          data: {
            ...current.data,
            productionColumns: nextProductionColumns,
            inventoryColumns: nextInventoryColumns,
          },
          monthStatesByMonth: {
            ...nextMonthStates,
          },
        }
      })
    } catch {
      // Ignore malformed storage payloads.
    }
  }, [pageState.activeMonth])

  const { data, activeMonth, notesByMonth, monthStatesByMonth } = pageState
  const roastingSalesMonthHeaderLabel = formatYmKorean(roastingSalesReferenceYm)
  const activeNotes = notesByMonth[activeMonth] ?? { summary: '', actions: '' }
  const activeMonthState = monthStatesByMonth[activeMonth] ?? createMonthStates(data)[activeMonth]

  const updateActiveNotes = (field: keyof MonthlyMeetingNotes, value: string) => {
    setPageState((current) => ({
      ...current,
      notesByMonth: {
        ...current.notesByMonth,
        [current.activeMonth]: {
          ...(current.notesByMonth[current.activeMonth] ?? { summary: '', actions: '' }),
          [field]: value,
        },
      },
    }))
  }

  const updateMonthState = (
    updater: (current: MonthlyMeetingMonthState) => MonthlyMeetingMonthState,
  ) => {
    setPageState((current) => ({
      ...current,
      monthStatesByMonth: {
        ...current.monthStatesByMonth,
        [current.activeMonth]: updater(
          current.monthStatesByMonth[current.activeMonth] ??
            createMonthStates(current.data)[current.activeMonth],
        ),
      },
    }))
  }

  const computedCurrentMonthCosts = useMemo(
    () => computeCurrentMonthCosts(activeMonthState.currentMonthCosts),
    [activeMonthState.currentMonthCosts],
  )

  const computedCurrentMonthSales = useMemo(
    () => computeCurrentMonthSales(activeMonthState.currentMonthSales, computedCurrentMonthCosts),
    [activeMonthState.currentMonthSales, computedCurrentMonthCosts],
  )

  const computedMaterialCostDetails = useMemo(
    () => computeDetailRows(activeMonthState.materialCostDetails),
    [activeMonthState.materialCostDetails],
  )

  const computedOtherCostDetails = useMemo(
    () => computeOtherDetailRows(activeMonthState.otherCostDetails),
    [activeMonthState.otherCostDetails],
  )

  const computedStoreSales = useMemo(
    () => computeStoreSales(activeMonthState.storeSales),
    [activeMonthState.storeSales],
  )

  const computedRoastingSales = useMemo(
    () => computeRoastingSales(data.roastingSales),
    [data.roastingSales],
  )

  const inboundCashflow = useMemo(
    () =>
      buildMeetingInboundCashflowParts(
        computedCurrentMonthSales,
        computedRoastingSales,
        computedStoreSales,
      ),
    [computedCurrentMonthSales, computedRoastingSales, computedStoreSales],
  )

  const outboundCashflow = useMemo(
    () =>
      getMeetingOutboundCashflow(
        computedCurrentMonthCosts,
        computedMaterialCostDetails,
        computedOtherCostDetails,
        computedRoastingSales,
      ),
    [
      computedCurrentMonthCosts,
      computedMaterialCostDetails,
      computedOtherCostDetails,
      computedRoastingSales,
    ],
  )

  const cashflowPl = useMemo(
    () => getMeetingCashflowPl(inboundCashflow.totalIn, outboundCashflow.totalOut),
    [inboundCashflow.totalIn, outboundCashflow.totalOut],
  )

  const computedInventoryRow = useMemo(
    () => computeInventoryRow(activeMonthState.inventoryRow),
    [activeMonthState.inventoryRow],
  )

  const outboundAggregateColumnIndex = useMemo(
    () => findOutboundAggregateColumnIndex(data.productionColumns),
    [data.productionColumns],
  )

  /** 추이는 표의 「출고 합계」 한 칸만 사용(생두별 열은 합계에 이미 포함되므로 전체 합산 시 이중 계산됨). */
  const productionTrendSeries = useMemo(
    () =>
      data.months.map((m) => {
        const row = monthStatesByMonth[m]?.productionRow
        if (!row) {
          return { month: m, total: 0 }
        }
        if (outboundAggregateColumnIndex >= 0) {
          const v = row.values[outboundAggregateColumnIndex]
          const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
          return { month: m, total: n }
        }
        return { month: m, total: sumValues(row.values) }
      }),
    [data.months, monthStatesByMonth, outboundAggregateColumnIndex],
  )

  /** 활성 월·출고 표에서 생두(및 기타 비수동) 열만 모아 도넛 비율용 */
  const activeMonthBeanOutboundSharePie = useMemo(() => {
    const aggIdx = outboundAggregateColumnIndex
    if (aggIdx < 0) {
      return [] as Array<{ name: string; value: number }>
    }
    const items: Array<{ name: string; value: number }> = []
    for (let i = aggIdx + 1; i < data.productionColumns.length; i++) {
      const label = data.productionColumns[i].trim()
      if (MEETING_OUTBOUND_MANUAL_COLUMN_LABELS.has(label)) {
        continue
      }
      const raw = activeMonthState.productionRow.values[i]
      const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      if (v > 0) {
        items.push({ name: label, value: v })
      }
    }
    return items
  }, [
    activeMonthState.productionRow.values,
    data.productionColumns,
    outboundAggregateColumnIndex,
  ])

  const activeMonthBeanOutboundPieTotal = useMemo(
    () => activeMonthBeanOutboundSharePie.reduce((sum, row) => sum + row.value, 0),
    [activeMonthBeanOutboundSharePie],
  )

  /** 범례: 퍼센트 높은 순 — sliceIndex로 도넛 조각·색과 대응 */
  const outboundDonutLegendRows = useMemo(() => {
    const total = activeMonthBeanOutboundPieTotal
    if (total <= 0 || activeMonthBeanOutboundSharePie.length === 0) {
      return [] as Array<{
        name: string
        value: number
        sliceIndex: number
        pct: number
        fill: string
      }>
    }
    return activeMonthBeanOutboundSharePie
      .map((row, sliceIndex) => ({
        name: row.name,
        value: row.value,
        sliceIndex,
        pct: (row.value / total) * 100,
        fill: OUTBOUND_SHARE_PIE_COLORS[sliceIndex % OUTBOUND_SHARE_PIE_COLORS.length],
      }))
      .sort((a, b) => b.pct - a.pct || b.value - a.value)
  }, [activeMonthBeanOutboundPieTotal, activeMonthBeanOutboundSharePie])

  /** 보기 모드에서는 집계 월 매출이 없는(0·미입력) 거래처 행만 숨김. 합계·생두비용·순이익은 유지. */
  const roastingSalesDisplayRows = useMemo(() => {
    const indexed = computedRoastingSales.map((row, rowIndex) => ({ row, rowIndex }))
    if (sectionEditModes.roasting) {
      return indexed
    }
    return indexed.filter(({ row }) => {
      if (isComputedRoastingRow(row.label) || row.label === '생두비용') {
        return true
      }
      const v = row.january
      return v !== null && v !== 0 && Number.isFinite(v)
    })
  }, [computedRoastingSales, sectionEditModes.roasting])

  const activeOverview = useMemo(
    () => [
      {
        label: `${activeMonth} 입금 합계`,
        value: inboundCashflow.totalIn,
        unit: 'won' as const,
      },
      {
        label: `${activeMonth} 입출금 순손익`,
        value: cashflowPl.net,
        unit: 'won' as const,
      },
      {
        label: `${activeMonth} 비용계`,
        value: computedCurrentMonthCosts.find((row) => row.label === '⑨비용계')?.amount ?? 0,
        unit: 'won' as const,
      },
      {
        label: `${activeMonth} 재료비`,
        value: computedCurrentMonthCosts.find((row) => row.label === '①재료비')?.amount ?? 0,
        unit: 'won' as const,
      },
      {
        label: `${activeMonth} 인건비`,
        value: computedCurrentMonthCosts.find((row) => row.label === '⑧인건비')?.amount ?? 0,
        unit: 'won' as const,
      },
      {
        label: `${activeMonth} 재고 합계`,
        value: sumValues(computedInventoryRow.values),
        unit: 'kg' as const,
      },
    ],
    [
      activeMonth,
      cashflowPl.net,
      computedCurrentMonthCosts,
      computedInventoryRow,
      inboundCashflow.totalIn,
    ],
  )

  const updateData = (updater: (current: MonthlyMeetingData) => MonthlyMeetingData) => {
    setPageState((current) => ({
      ...current,
      data: updater(current.data),
    }))
  }

  const updateValueRow = (
    section:
      | 'currentMonthSales'
      | 'currentMonthCosts'
      | 'materialCostDetails'
      | 'otherCostDetails',
    rowIndex: number,
    value: string,
  ) => {
    updateMonthState((current) => ({
      ...current,
      [section]: current[section].map((row, index) =>
        index === rowIndex ? { ...row, amount: parseNullableNumber(value) } : row,
      ),
    }))
  }

  const updateRoastingSales = (
    rowIndex: number,
    field: 'november' | 'december' | 'january',
    value: string,
  ) => {
    updateData((current) => ({
      ...current,
      roastingSales: current.roastingSales.map((row, index) =>
        index === rowIndex ? { ...row, [field]: parseNullableNumber(value) } : row,
      ),
    }))
  }

  const updateStoreSales = (
    field: 'hall' | 'delivery' | 'quick',
    value: string,
  ) => {
    updateMonthState((current) => ({
      ...current,
      storeSales: {
        ...current.storeSales,
        [field]: parseNullableNumber(value),
      },
    }))
  }

  const updateProductionRow = (
    section: 'productionRow' | 'inventoryRow',
    valueIndex: number,
    value: string,
  ) => {
    updateMonthState((current) => ({
      ...current,
      [section]: {
        ...current[section],
        values: current[section].values.map((cell, cellIndex) =>
          cellIndex === valueIndex ? parseNullableNumber(value) : cell,
        ),
      },
    }))
  }

  const updateColumnLabel = (
    section: 'productionColumns' | 'inventoryColumns',
    columnIndex: number,
    value: string,
  ) => {
    updateData((current) => ({
      ...current,
      [section]: current[section].map((column, index) => (index === columnIndex ? value : column)),
    }))
  }

  const updateMonthStateLabel = (
    section:
      | 'currentMonthSales'
      | 'currentMonthCosts'
      | 'materialCostDetails'
      | 'otherCostDetails',
    rowIndex: number,
    value: string,
  ) => {
    updateMonthState((current) => ({
      ...current,
      [section]: current[section].map((row, index) =>
        index === rowIndex ? { ...row, label: value } : row,
      ),
    }))
  }

  const updateRowLabel = (
    section: 'roastingSales',
    rowIndex: number,
    value: string,
  ) => {
    updateData((current) => ({
      ...current,
      [section]: current[section].map((row, index) =>
        index === rowIndex ? { ...row, label: value } : row,
      ),
    }))
  }

  const addMonthStateRow = (
    section:
      | 'currentMonthSales'
      | 'currentMonthCosts'
      | 'materialCostDetails'
      | 'otherCostDetails',
    label: string,
  ) => {
    updateMonthState((current) => {
      const rows = current[section]
      const insertIndex =
        section === 'currentMonthSales'
          ? rows.findIndex((row) => isComputedSalesRow(row.label))
          : section === 'currentMonthCosts'
            ? rows.findIndex((row) => isComputedCostRow(row.label))
            : rows.findIndex((row) => isComputedDetailRow(row.label))

      const nextRows = [...rows]
      nextRows.splice(insertIndex === -1 ? nextRows.length : insertIndex, 0, createEmptyValueRow(label))

      return {
        ...current,
        [section]: nextRows,
      }
    })
  }

  const removeMonthStateRow = (
    section:
      | 'currentMonthSales'
      | 'currentMonthCosts'
      | 'materialCostDetails'
      | 'otherCostDetails',
    rowIndex: number,
  ) => {
    updateMonthState((current) => ({
      ...current,
      [section]: current[section].filter((_, index) => index !== rowIndex),
    }))
  }

  const addRoastingSalesRow = () => {
    updateData((current) => {
      const insertIndex = current.roastingSales.findIndex((row) => row.label === '합 계')
      const nextRows = [...current.roastingSales]
      nextRows.splice(insertIndex === -1 ? nextRows.length : insertIndex, 0, createEmptyRoastingRow('새 거래처'))
      return {
        ...current,
        roastingSales: nextRows,
      }
    })
  }

  const removeRoastingSalesRow = (rowIndex: number) => {
    updateData((current) => ({
      ...current,
      roastingSales: current.roastingSales.filter((_, index) => index !== rowIndex),
    }))
  }

  const addStructuredColumn = (section: 'productionColumns' | 'inventoryColumns') => {
    const nextLabel = section === 'productionColumns' ? '새 출고 품목' : '새 재고 항목'

    setPageState((current) => {
      const isInventory = section === 'inventoryColumns'
      const nextColumns = [...current.data[section]]
      const insertIndex = nextColumns.length
      nextColumns.splice(insertIndex, 0, nextLabel)

      const nextMonthStates = Object.fromEntries(
        Object.entries(current.monthStatesByMonth).map(([month, monthState]) => {
          const rowKey = isInventory ? 'inventoryRow' : 'productionRow'
          const row = monthState[rowKey]
          const nextValues = [...row.values]
          nextValues.splice(insertIndex, 0, null)

          return [
            month,
            {
              ...monthState,
              [rowKey]: {
                ...row,
                values: nextValues,
              },
            },
          ]
        }),
      ) as Record<string, MonthlyMeetingMonthState>

      return {
        ...current,
        data: {
          ...current.data,
          [section]: nextColumns,
        },
        monthStatesByMonth: nextMonthStates,
      }
    })
  }

  const removeStructuredColumn = (section: 'productionColumns' | 'inventoryColumns', columnIndex: number) => {
    setPageState((current) => {
      const isInventory = section === 'inventoryColumns'
      const nextColumns = current.data[section].filter((_, index) => index !== columnIndex)
      const rowKey = isInventory ? 'inventoryRow' : 'productionRow'

      const nextMonthStates = Object.fromEntries(
        Object.entries(current.monthStatesByMonth).map(([month, monthState]) => {
          const row = monthState[rowKey]
          return [
            month,
            {
              ...monthState,
              [rowKey]: {
                ...row,
                values: row.values.filter((_, index) => index !== columnIndex),
              },
            },
          ]
        }),
      ) as Record<string, MonthlyMeetingMonthState>

      return {
        ...current,
        data: {
          ...current.data,
          [section]: nextColumns,
        },
        monthStatesByMonth: nextMonthStates,
      }
    })
  }

  const buildMonthExportMatrix = useCallback(
    (month: string): (string | number)[][] => {
      const monthState = monthStatesByMonth[month] ?? createMonthStates(data)[month]
      const monthCosts = computeCurrentMonthCosts(monthState.currentMonthCosts)
      const monthSales = computeCurrentMonthSales(monthState.currentMonthSales, monthCosts)
      const materialDetails = computeDetailRows(monthState.materialCostDetails)
      const otherDetails = computeOtherDetailRows(monthState.otherCostDetails)
      const storeSales = computeStoreSales(monthState.storeSales)
      const roastingComputedExport = computeRoastingSales(data.roastingSales)
      const inboundParts = buildMeetingInboundCashflowParts(
        monthSales,
        roastingComputedExport,
        storeSales,
      )
      const outboundCf = getMeetingOutboundCashflow(
        monthCosts,
        materialDetails,
        otherDetails,
        roastingComputedExport,
      )
      const plCf = getMeetingCashflowPl(inboundParts.totalIn, outboundCf.totalOut)
      const inventoryRow = computeInventoryRow(monthState.inventoryRow)
      const notes = notesByMonth[month] ?? { summary: '', actions: '' }

      return [
        [`[${month} 마감회의]`, '', '', ''],
        ['매장명', data.storeName, '회의 제목', data.title],
        ['월', month, '', ''],
        [],
        ['1. 당월 매출', '', '', ''],
        ['항목', '금액', '점유비', ''],
        ...monthSales.map((row) => [
          row.label,
          excelCellAmount(row.amount),
          excelCellShare(row.share),
          '',
        ]),
        [],
        ['1-1. 당월 비용현황', '', '', ''],
        ['항목', '금액', '점유비', ''],
        ...monthCosts.map((row) => [
          row.label,
          excelCellAmount(row.amount),
          excelCellShare(row.share),
          '',
        ]),
        [],
        ['1-2. 재료비 세부사항', '', '', ''],
        ['항목', '금액', '점유비', ''],
        ...materialDetails.map((row) => [
          row.label,
          excelCellAmount(row.amount),
          excelCellShare(row.share),
          '',
        ]),
        [],
        ['1-3. 기타 세부사항', '', '', ''],
        ['항목', '금액', '', ''],
        ...otherDetails.map((row) => [row.label, excelCellAmount(row.amount), '', '']),
        [],
        ...buildInboundCashflowExcelRows(inboundParts),
        [],
        ...buildOutboundCashflowExcelRows(outboundCf),
        [],
        ['1-6. 입출금·손익 요약', '', '', ''],
        ['구분', '금액', '', ''],
        ['입금 합계', excelCellAmount(plCf.totalIn), '', ''],
        ['출금 합계', excelCellAmount(plCf.totalOut), '', ''],
        ['입출금 순손익 (입금 합계 − 출금 합계)', excelCellAmount(plCf.net), '', ''],
        [],
        ['2. 로스팅실 매출 및 생두비용현황', '', '', ''],
        ['거래처명', roastingSalesMonthHeaderLabel, '점유비'],
        ...computeRoastingSales(data.roastingSales).map((row) => [
          row.label,
          excelCellAmount(row.january),
          excelCellShare(row.share),
        ]),
        [],
        ['3. 매장 전체 판매 현황', '', '', ''],
        ['기준 월', month, '', ''],
        ['항목', '금액', '점유비', ''],
        ['홀판매', excelCellAmount(storeSales.hall), excelCellShare(storeSales.hallShare), ''],
        ['배달의 민족', excelCellAmount(storeSales.delivery), excelCellShare(storeSales.deliveryShare), ''],
        ['쿠팡/땡겨요', excelCellAmount(storeSales.quick), excelCellShare(storeSales.quickShare), ''],
        ['총액', excelCellAmount(storeSales.total), '', ''],
        [],
        ['4. 출고현황', '', '', ''],
        ['월', ...data.productionColumns],
        [month, ...monthState.productionRow.values.map((value) => excelCellAmount(value))],
        [],
        ['5. 재고현황', '', '', ''],
        ['월', ...data.inventoryColumns],
        [month, ...inventoryRow.values.map((value) => excelCellAmount(value))],
        [],
        ['회의 요약', notes.summary || ''],
        ['다음 액션', notes.actions || ''],
      ]
    },
    [data, monthStatesByMonth, notesByMonth, roastingSalesMonthHeaderLabel],
  )

  const handleExportMeetingExcel = async () => {
    try {
      const matrix = buildMonthExportMatrix(activeMonth)
      const sheetName = activeMonth.replace(/\//g, '-')
      const safeStore = sanitizeExcelFileBaseName(data.storeName || '회의')
      const date = new Date().toISOString().slice(0, 10)
      const fileName = `월마감회의_${sheetName}_${safeStore}_${date}.xlsx`
      await exportStyledMeetingMonthExcel(sheetName, matrix, fileName)
    } catch {
      window.alert('엑셀 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.')
    }
  }

  const handleCopyMonth = () => {
    if (!copyTargetMonth || copyTargetMonth === activeMonth) {
      return
    }

    const shouldCopy = window.confirm(
      `${activeMonth} 내용을 ${copyTargetMonth}로 복사할까요?\n기존 ${copyTargetMonth} 입력값은 덮어써집니다.`,
    )

    if (!shouldCopy) {
      return
    }

    setPageState((current) => {
      const sourceState = current.monthStatesByMonth[current.activeMonth]
      const sourceNotes = current.notesByMonth[current.activeMonth] ?? { summary: '', actions: '' }

      if (!sourceState) {
        return current
      }

      return {
        ...current,
        notesByMonth: {
          ...current.notesByMonth,
          [copyTargetMonth]: { ...sourceNotes },
        },
        monthStatesByMonth: {
          ...current.monthStatesByMonth,
          [copyTargetMonth]: {
            currentMonthSales: cloneValueRows(sourceState.currentMonthSales),
            currentMonthCosts: cloneValueRows(sourceState.currentMonthCosts),
            materialCostDetails: cloneValueRows(sourceState.materialCostDetails),
            otherCostDetails: cloneValueRows(sourceState.otherCostDetails),
            storeSales: {
              ...cloneStoreRow(sourceState.storeSales),
              month: copyTargetMonth,
            },
            productionRow: {
              ...cloneProductionRow(sourceState.productionRow),
              label: copyTargetMonth,
            },
            inventoryRow: {
              ...cloneProductionRow(sourceState.inventoryRow),
              label: copyTargetMonth,
            },
          },
        },
      }
    })
  }

  const renderItemEditToggleButton = (section: MeetingSectionEditKey) => (
    <button
      type="button"
      className={
        sectionEditModes[section]
          ? 'ghost-button meeting-edit-toggle-button active'
          : 'ghost-button meeting-edit-toggle-button'
      }
      onClick={() =>
        setSectionEditModes((current) => ({
          ...current,
          [section]: !current[section],
        }))
      }
      aria-pressed={sectionEditModes[section]}
    >
      {sectionEditModes[section] ? '완료' : '수정'}
    </button>
  )

  const toggleSection = (section: MeetingSectionKey) => {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }))
  }
  const summaryEditMode = sectionEditModes.summary
  const roastingEditMode = sectionEditModes.roasting
  const storeSalesEditMode = sectionEditModes.storeSales
  const productionInventoryEditMode = sectionEditModes.productionInventory
  const visibleOutboundColumnIndices = useMemo(
    () =>
      productionInventoryEditMode
        ? data.productionColumns.map((_, index) => index)
        : data.productionColumns
            .map((_, index) => index)
            .filter((index) => (activeMonthState.productionRow.values[index] ?? 0) !== 0),
    [activeMonthState.productionRow.values, data.productionColumns, productionInventoryEditMode],
  )

  return (
    <>
      <header className="hero-panel">
        <div>
          <p className="eyebrow">월 마감회의</p>
          <h1>{data.title}</h1>
          <p className="hero-copy">
            월별 회의 내용을 입력하면 합계와 점유비가 자동 계산되도록 정리했습니다. 상단 두 번째 숫자는 입금
            합계에서 출금 합계를 뺀 입출금 순손익으로, 1번 요약 맨 아래 표와 같습니다.
          </p>
          <div className="hero-meta-row no-print">
            <span className="page-hero-pill">{mode === 'cloud' ? '회사 공용 회의 문서' : '이 브라우저 회의 문서'}</span>
            <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
          </div>
        </div>
        <div className="hero-metrics meeting-hero-metrics">
          {activeOverview.map((metric) => (
            <div key={metric.label} className="metric-card">
              <span>{metric.label}</span>
              <strong>
                {metric.value === null
                  ? '-'
                  : metric.unit === 'kg'
                    ? `${meetingAmountDisplayFormatter.format(metric.value)} kg`
                    : formatMoney(metric.value)}
              </strong>
            </div>
          ))}
        </div>
      </header>

      <main className="meeting-layout">
        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2>회의 기본 설정</h2>
              <p className="meeting-section-description">기준 월, 제목, 엑셀 내보내기 같은 전체 회의 설정을 먼저 정리합니다.</p>
            </div>
          </div>

          <div className="meeting-config-row">
            <label className="meeting-inline-field">
              매장명
              <input
                type="text"
                value={data.storeName}
                onChange={(event) =>
                  updateData((current) => ({
                    ...current,
                    storeName: event.target.value,
                  }))
                }
              />
            </label>
            <label className="meeting-inline-field">
              회의 제목
              <input
                type="text"
                value={data.title}
                onChange={(event) =>
                  updateData((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
              />
            </label>
            <label className="meeting-inline-field">
              현재 선택 월
              <input type="text" value={activeMonth} readOnly />
            </label>
          </div>

          <div className="meeting-actions">
            <button type="button" className="ghost-button" onClick={handleExportMeetingExcel}>
              현재 월 엑셀 저장
            </button>
            <select value={copyTargetMonth} onChange={(event) => setCopyTargetMonth(event.target.value)}>
              {data.months
                .filter((month) => month !== activeMonth)
                .map((month) => (
                  <option key={month} value={month}>
                    {month}로 복사
                  </option>
                ))}
            </select>
            <button type="button" className="ghost-button" onClick={handleCopyMonth}>
              현재 월 복사
            </button>
          </div>

          <p className="meeting-excel-export-hint">
            「현재 월」탭에 보이는 내용만 엑셀 한 장으로 받습니다. 구역별로 색·테두리·머리글이 자동으로
            들어갑니다.
          </p>

          <div className="segmented meeting-month-tabs">
            {data.months.map((month) => (
              <button
                key={month}
                type="button"
                className={activeMonth === month ? 'active' : ''}
                onClick={() =>
                  setPageState((current) => ({
                    ...current,
                    activeMonth: month,
                  }))
                }
              >
                {month}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2 className="meeting-section-title">
                <button
                  type="button"
                  className="meeting-title-collapse-button"
                  onClick={() => toggleSection('summary')}
                  aria-expanded={!collapsedSections.summary}
                  aria-label={collapsedSections.summary ? '1번 섹션 펼치기' : '1번 섹션 접기'}
                >
                  {collapsedSections.summary ? '+' : '-'}
                </button>
                <span>1. {activeMonth} 요약</span>
              </h2>
              <p className="meeting-section-description">월 매출, 비용, 손익 흐름을 한 번에 비교하는 핵심 요약 영역입니다.</p>
            </div>
            <div className="meeting-actions meeting-section-actions">
              {renderItemEditToggleButton('summary')}
            </div>
          </div>

          {!collapsedSections.summary ? (
            <>
              <div className="meeting-grid meeting-grid-2">
            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>매출</h3>
                {summaryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addMonthStateRow('currentMonthSales', '새 매출 항목')}
                  >
                    항목 추가
                  </button>
                ) : null}
              </div>
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>금액</th>
                    <th>점유비</th>
                  </tr>
                </thead>
                <tbody>
                  {computedCurrentMonthSales.map((row, rowIndex) => (
                    <tr key={`current-month-sales-${rowIndex}`}>
                      <td>
                        {summaryEditMode ? (
                          <div className="meeting-header-edit-row">
                            <input
                              className="meeting-header-input"
                              type="text"
                              value={row.label}
                              onChange={(event) =>
                                updateMonthStateLabel('currentMonthSales', rowIndex, event.target.value)
                              }
                            />
                            {!isComputedSalesRow(row.label) ? (
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeMonthStateRow('currentMonthSales', rowIndex)}
                              >
                                -
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td>
                        <input
                          className={
                            isComputedSalesRow(row.label)
                              ? 'meeting-cell-input meeting-cell-input-readonly'
                              : 'meeting-cell-input'
                          }
                          type="text"
                          inputMode="numeric"
                          value={formatAmountForInput(row.amount)}
                          readOnly={isComputedSalesRow(row.label)}
                          onChange={(event) =>
                            updateValueRow('currentMonthSales', rowIndex, event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="meeting-cell-input meeting-cell-input-readonly"
                          type="text"
                          inputMode="decimal"
                          value={formatSharePercent(row.share)}
                          readOnly
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>비용 현황</h3>
                {summaryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addMonthStateRow('currentMonthCosts', '새 비용 항목')}
                  >
                    항목 추가
                  </button>
                ) : null}
              </div>
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>금액</th>
                    <th>점유비</th>
                  </tr>
                </thead>
                <tbody>
                  {computedCurrentMonthCosts.map((row, rowIndex) => (
                    <tr key={`current-month-costs-${rowIndex}`}>
                      <td>
                        {summaryEditMode ? (
                          <div className="meeting-header-edit-row">
                            <input
                              className="meeting-header-input"
                              type="text"
                              value={row.label}
                              onChange={(event) =>
                                updateMonthStateLabel('currentMonthCosts', rowIndex, event.target.value)
                              }
                            />
                            {!isComputedCostRow(row.label) ? (
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeMonthStateRow('currentMonthCosts', rowIndex)}
                              >
                                -
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td>
                        <input
                          className={
                            isComputedCostRow(row.label)
                              ? 'meeting-cell-input meeting-cell-input-readonly'
                              : 'meeting-cell-input'
                          }
                          type="text"
                          inputMode="numeric"
                          value={formatAmountForInput(row.amount)}
                          readOnly={isComputedCostRow(row.label)}
                          onChange={(event) =>
                            updateValueRow('currentMonthCosts', rowIndex, event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="meeting-cell-input meeting-cell-input-readonly"
                          type="text"
                          inputMode="decimal"
                          value={formatSharePercent(row.share)}
                          readOnly
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>재료비 세부사항</h3>
                {summaryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addMonthStateRow('materialCostDetails', '새 재료비 항목')}
                  >
                    항목 추가
                  </button>
                ) : null}
              </div>
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>금액</th>
                    <th>점유비</th>
                  </tr>
                </thead>
                <tbody>
                  {computedMaterialCostDetails.map((row, rowIndex) => (
                    <tr key={`material-cost-details-${rowIndex}`}>
                      <td>
                        {summaryEditMode ? (
                          <div className="meeting-header-edit-row">
                            <input
                              className="meeting-header-input"
                              type="text"
                              value={row.label}
                              onChange={(event) =>
                                updateMonthStateLabel('materialCostDetails', rowIndex, event.target.value)
                              }
                            />
                            {!isComputedDetailRow(row.label) ? (
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeMonthStateRow('materialCostDetails', rowIndex)}
                              >
                                -
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td>
                        <input
                          className={
                            isComputedDetailRow(row.label)
                              ? 'meeting-cell-input meeting-cell-input-readonly'
                              : 'meeting-cell-input'
                          }
                          type="text"
                          inputMode="numeric"
                          value={formatAmountForInput(row.amount)}
                          readOnly={isComputedDetailRow(row.label)}
                          onChange={(event) =>
                            updateValueRow('materialCostDetails', rowIndex, event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="meeting-cell-input meeting-cell-input-readonly"
                          type="text"
                          inputMode="decimal"
                          value={formatSharePercent(row.share)}
                          readOnly
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>기타 세부사항</h3>
                {summaryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addMonthStateRow('otherCostDetails', '새 기타 항목')}
                  >
                    항목 추가
                  </button>
                ) : null}
              </div>
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>금액</th>
                  </tr>
                </thead>
                <tbody>
                  {computedOtherCostDetails.map((row, rowIndex) => (
                    <tr key={`other-cost-details-${rowIndex}`}>
                      <td>
                        {summaryEditMode ? (
                          <div className="meeting-header-edit-row">
                            <input
                              className="meeting-header-input"
                              type="text"
                              value={row.label}
                              onChange={(event) =>
                                updateMonthStateLabel('otherCostDetails', rowIndex, event.target.value)
                              }
                            />
                            {!isComputedDetailRow(row.label) ? (
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeMonthStateRow('otherCostDetails', rowIndex)}
                              >
                                -
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td>
                        <input
                          className={
                            isComputedDetailRow(row.label)
                              ? 'meeting-cell-input meeting-cell-input-readonly'
                              : 'meeting-cell-input'
                          }
                          type="text"
                          inputMode="numeric"
                          value={formatAmountForInput(row.amount)}
                          readOnly={isComputedDetailRow(row.label)}
                          onChange={(event) =>
                            updateValueRow('otherCostDetails', rowIndex, event.target.value)
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
              </div>

              <div className="meeting-summary-cashflow">
                <p className="meeting-cashflow-hint">
                  당월 매출(결제), 로스팅실 집계 월 거래처 매출, 매장 전체 판매(홀·배달·간편배달)을 합산한 입금
                  합계입니다. 점유비는 각 구간 안에서만 나눈 비율입니다(당월 결제끼리, 로스팅 거래처끼리, 매장 채널끼리 합이
                  100%). 출금에는 재료비·기타 세부, 로스팅실 생두비용, 비용현황(①·② 제외)이 반영되며, 맨 아래 출금
                  합계는 위 표에 나온 금액을 모두 더한 값입니다(생두비용이 비용 표 ⑨와 별도일 때도 포함).
                </p>
                <div className="meeting-cashflow-columns">
                  <article className="meeting-card meeting-cashflow-card">
                    <div className="meeting-card-header">
                      <h3>입금액 요약</h3>
                    </div>
                    <table className="meeting-table meeting-table-compact">
                      <thead>
                        <tr>
                          <th>항목</th>
                          <th>금액</th>
                          <th>점유비</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inboundCashflow.channelPart.length > 0 ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={3}>당월 매출 (결제)</td>
                            </tr>
                            {inboundCashflow.channelPart.map((row, idx) => (
                              <tr key={`inbound-ch-${idx}-${row.label}`}>
                                <td>{row.label}</td>
                                <td>{formatMoney(row.amount)}</td>
                                <td>{formatSharePercent(row.share)}</td>
                              </tr>
                            ))}
                          </>
                        ) : null}
                        {inboundCashflow.roastingLines.length > 0 ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={3}>로스팅실 매출 ({roastingSalesMonthHeaderLabel})</td>
                            </tr>
                            {inboundCashflow.roastingLines.map((row, idx) => (
                              <tr key={`inbound-rs-${idx}-${row.label}`}>
                                <td>{row.label}</td>
                                <td>{formatMoney(row.amount)}</td>
                                <td>{formatSharePercent(row.share)}</td>
                              </tr>
                            ))}
                          </>
                        ) : null}
                        {inboundCashflow.storeLines.length > 0 ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={3}>매장 전체 판매 ({activeMonth})</td>
                            </tr>
                            {inboundCashflow.storeLines.map((row, idx) => (
                              <tr key={`inbound-st-${idx}-${row.label}`}>
                                <td>{row.label}</td>
                                <td>{formatMoney(row.amount)}</td>
                                <td>{formatSharePercent(row.share)}</td>
                              </tr>
                            ))}
                          </>
                        ) : null}
                        <tr className="meeting-cashflow-total-row">
                          <td>입금 합계</td>
                          <td>{formatMoney(inboundCashflow.totalIn)}</td>
                          <td>—</td>
                        </tr>
                      </tbody>
                    </table>
                  </article>

                  <article className="meeting-card meeting-cashflow-card">
                    <div className="meeting-card-header">
                      <h3>출금액 요약</h3>
                    </div>
                    <table className="meeting-table meeting-table-compact">
                      <thead>
                        <tr>
                          <th>항목</th>
                          <th>금액</th>
                        </tr>
                      </thead>
                      <tbody>
                        {outboundCashflow.materialLines.length > 0 ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={2}>재료비 세부</td>
                            </tr>
                            {outboundCashflow.materialLines.map((row, idx) => (
                              <tr key={`out-m-${idx}-${row.label}`}>
                                <td>{row.label}</td>
                                <td>{formatMoney(row.amount)}</td>
                              </tr>
                            ))}
                          </>
                        ) : null}
                        {outboundCashflow.otherLines.length > 0 ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={2}>기타 세부</td>
                            </tr>
                            {outboundCashflow.otherLines.map((row, idx) => (
                              <tr key={`out-o-${idx}-${row.label}`}>
                                <td>{row.label}</td>
                                <td>{formatMoney(row.amount)}</td>
                              </tr>
                            ))}
                          </>
                        ) : null}
                        {outboundCashflow.roastingBeanCost ? (
                          <>
                            <tr className="meeting-cashflow-section-row">
                              <td colSpan={2}>로스팅실 생두비용</td>
                            </tr>
                            <tr>
                              <td>{outboundCashflow.roastingBeanCost.label}</td>
                              <td>{formatMoney(outboundCashflow.roastingBeanCost.amount)}</td>
                            </tr>
                          </>
                        ) : null}
                        <tr className="meeting-cashflow-section-row">
                          <td colSpan={2}>비용현황 (①재료비·②기타 제외)</td>
                        </tr>
                        {outboundCashflow.extraCostLines.map((row, idx) => (
                          <tr key={`out-c-${idx}-${row.label}`}>
                            <td>{row.label}</td>
                            <td>{formatMoney(row.amount)}</td>
                          </tr>
                        ))}
                        <tr className="meeting-cashflow-total-row">
                          <td>출금 합계</td>
                          <td>{formatMoney(outboundCashflow.totalOut)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </article>
                </div>

                <article className="meeting-card meeting-cashflow-card meeting-cashflow-pl-card">
                  <div className="meeting-card-header">
                    <h3>입출금·손익 요약</h3>
                  </div>
                  <table className="meeting-table meeting-table-compact meeting-cashflow-pl-table">
                    <tbody>
                      <tr>
                        <th scope="row">입금 합계</th>
                        <td>{formatMoney(cashflowPl.totalIn)}</td>
                      </tr>
                      <tr>
                        <th scope="row">출금 합계</th>
                        <td>{formatMoney(cashflowPl.totalOut)}</td>
                      </tr>
                      <tr className="meeting-cashflow-total-row">
                        <th scope="row">입출금 순손익 (입금 합계 − 출금 합계)</th>
                        <td>{formatMoney(cashflowPl.net)}</td>
                      </tr>
                    </tbody>
                  </table>
                </article>
              </div>
            </>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2 className="meeting-section-title">
                <button
                  type="button"
                  className="meeting-title-collapse-button"
                  onClick={() => toggleSection('roasting')}
                  aria-expanded={!collapsedSections.roasting}
                  aria-label={collapsedSections.roasting ? '2번 섹션 펼치기' : '2번 섹션 접기'}
                >
                  {collapsedSections.roasting ? '+' : '-'}
                </button>
                <span>2. 로스팅실 매출 및 생두비용현황</span>
              </h2>
              <p className="meeting-section-description">거래명세와 생두 주문 데이터를 기준으로 로스팅 관련 손익을 확인합니다.</p>
            </div>
            <div className="meeting-actions meeting-section-actions">
              {renderItemEditToggleButton('roasting')}
            </div>
          </div>

          {!collapsedSections.roasting ? <div className="meeting-grid">
            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>거래처 매출·생두비용·순이익</h3>
                <div className="meeting-roasting-header-actions">
                  <label className="meeting-inline-field meeting-roasting-month-field">
                    <span className="meeting-roasting-year-label">거래명세 집계 월</span>
                    <input
                      type="month"
                      className="meeting-roasting-month-input"
                      value={roastingSalesReferenceYm}
                      onChange={(event) => {
                        const v = event.target.value
                        if (v && parseYm(v)) {
                          setRoastingSalesReferenceYm(v)
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={applyGreenBeanOrderToRoastingBeanCost}
                  >
                    생두 주문 합계 반영
                  </button>
                  {roastingEditMode ? (
                    <button
                      type="button"
                      className="ghost-button meeting-mini-button"
                      onClick={addRoastingSalesRow}
                    >
                      거래처 추가
                    </button>
                  ) : null}
                </div>
              </div>
              {greenBeanOrderSyncHint ? (
                <p className="muted tiny meeting-roasting-statement-sync-msg">{greenBeanOrderSyncHint}</p>
              ) : null}
              <div className="table-wrapper">
                <table className="meeting-table meeting-table-compact">
                  <thead>
                    <tr>
                      <th>거래처명</th>
                      <th>{roastingSalesMonthHeaderLabel}</th>
                      <th>점유비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roastingSalesDisplayRows.map(({ row, rowIndex }, displayIdx) => (
                      <Fragment key={`roasting-sales-block-${rowIndex}`}>
                        {displayIdx > 0 &&
                        ROASTING_SUMMARY_BLOCK_LABELS.has(row.label) &&
                        !ROASTING_SUMMARY_BLOCK_LABELS.has(roastingSalesDisplayRows[displayIdx - 1]!.row.label) ? (
                          <tr className="meeting-cashflow-section-row">
                            <td colSpan={3}>집계 · 생두 · 손익</td>
                          </tr>
                        ) : null}
                        <tr>
                        <td>
                          {roastingEditMode ? (
                            <div className="meeting-header-edit-row">
                              <input
                                className="meeting-header-input"
                                type="text"
                                value={row.label}
                                onChange={(event) =>
                                  updateRowLabel('roastingSales', rowIndex, event.target.value)
                                }
                              />
                              {!isComputedRoastingRow(row.label) && row.label !== '생두비용' ? (
                                <button
                                  type="button"
                                  className="meeting-icon-button"
                                  onClick={() => removeRoastingSalesRow(rowIndex)}
                                >
                                  -
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            row.label
                          )}
                        </td>
                        <td>
                          <input
                            className={
                              isComputedRoastingRow(row.label)
                                ? 'meeting-cell-input meeting-cell-input-readonly'
                                : 'meeting-cell-input'
                            }
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(row.january)}
                            readOnly={isComputedRoastingRow(row.label)}
                            onChange={(event) =>
                              updateRoastingSales(rowIndex, 'january', event.target.value)
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="decimal"
                            value={formatSharePercent(row.share)}
                            readOnly
                          />
                        </td>
                      </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </div> : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2 className="meeting-section-title">
                <button
                  type="button"
                  className="meeting-title-collapse-button"
                  onClick={() => toggleSection('storeSales')}
                  aria-expanded={!collapsedSections.storeSales}
                  aria-label={collapsedSections.storeSales ? '3번 섹션 펼치기' : '3번 섹션 접기'}
                >
                  {collapsedSections.storeSales ? '+' : '-'}
                </button>
                <span>3. {activeMonth} 매장 판매 현황</span>
              </h2>
              <p className="meeting-section-description">홀/배달/납품 등 판매 채널별 비중과 월 판매 구성을 정리합니다.</p>
            </div>
            <div className="meeting-actions meeting-section-actions">
              {renderItemEditToggleButton('storeSales')}
            </div>
          </div>

          {!collapsedSections.storeSales ? (
            <div className="meeting-grid">
              <article className="meeting-card meeting-store-sales-vertical">
                <h3>{activeMonth} 매장 전체 판매</h3>
                <p className="muted tiny meeting-store-sales-month-caption">기준 월: {activeMonth}</p>
                <div className="table-wrapper">
                  <table className="meeting-table meeting-table-compact meeting-store-sales-stack">
                    <thead>
                      <tr>
                        <th>항목</th>
                        <th>금액</th>
                        <th>점유비</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>홀판매</td>
                        <td>
                          <input
                            className="meeting-cell-input"
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(computedStoreSales.hall)}
                            readOnly={!storeSalesEditMode}
                            onChange={(event) => updateStoreSales('hall', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="decimal"
                            value={formatSharePercent(computedStoreSales.hallShare)}
                            readOnly
                          />
                        </td>
                      </tr>
                      <tr>
                        <td>배달의 민족</td>
                        <td>
                          <input
                            className="meeting-cell-input"
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(computedStoreSales.delivery)}
                            readOnly={!storeSalesEditMode}
                            onChange={(event) => updateStoreSales('delivery', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="decimal"
                            value={formatSharePercent(computedStoreSales.deliveryShare)}
                            readOnly
                          />
                        </td>
                      </tr>
                      <tr>
                        <td>쿠팡/땡겨요</td>
                        <td>
                          <input
                            className="meeting-cell-input"
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(computedStoreSales.quick)}
                            readOnly={!storeSalesEditMode}
                            onChange={(event) => updateStoreSales('quick', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="decimal"
                            value={formatSharePercent(computedStoreSales.quickShare)}
                            readOnly
                          />
                        </td>
                      </tr>
                      <tr className="meeting-store-sales-total-row">
                        <td>총액</td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(computedStoreSales.total)}
                            readOnly
                          />
                        </td>
                        <td>
                          <input
                            className="meeting-cell-input meeting-cell-input-readonly"
                            type="text"
                            inputMode="decimal"
                            value={formatSharePercent(
                              computedStoreSales.total !== null &&
                                computedStoreSales.total > 0
                                ? 1
                                : null,
                            )}
                            readOnly
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2 className="meeting-section-title">
                <button
                  type="button"
                  className="meeting-title-collapse-button"
                  onClick={() => toggleSection('productionInventory')}
                  aria-expanded={!collapsedSections.productionInventory}
                  aria-label={
                    collapsedSections.productionInventory ? '4번 섹션 펼치기' : '4번 섹션 접기'
                  }
                >
                  {collapsedSections.productionInventory ? '+' : '-'}
                </button>
                <span>4. {activeMonth} 출고 및 재고 현황</span>
              </h2>
              <p className="meeting-section-description">출고량과 기준일 재고를 함께 보며 생산·재고 흐름을 체크하는 영역입니다.</p>
            </div>
            <div className="meeting-actions meeting-section-actions">
              {renderItemEditToggleButton('productionInventory')}
            </div>
          </div>

          {!collapsedSections.productionInventory ? <div className="meeting-grid">
            <p className="muted tiny meeting-roasting-statement-hint meeting-production-inventory-sync-hint">
              입출고 현황의 <strong>기준일</strong> 월이 위에서 고른 <strong>{activeMonth}</strong>와 같으면 출고·재고
              표가 자동으로 맞춰집니다. 출고 표 첫 열은 생두별 출고 합, 이어서 품목(생두)별 출고 합이 붙고, 재고 표 끝에는
              품목(생두)별 기준일 재고 열이 붙습니다.
            </p>
            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>{activeMonth} 출고현황</h3>
                {productionInventoryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addStructuredColumn('productionColumns')}
                  >
                    품목 추가
                  </button>
                ) : null}
              </div>
              <div className="table-wrapper">
                <table className="meeting-table meeting-table-compact">
                  <thead>
                    <tr>
                      <th>월</th>
                      {visibleOutboundColumnIndices.map((index) => {
                        const column = data.productionColumns[index]
                        return (
                        <th key={`production-column-${index}`}>
                          {productionInventoryEditMode ? (
                            <div className="meeting-header-edit-column">
                              <input
                                className="meeting-header-input"
                                type="text"
                                value={column}
                                onChange={(event) =>
                                  updateColumnLabel('productionColumns', index, event.target.value)
                                }
                              />
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeStructuredColumn('productionColumns', index)}
                              >
                                -
                              </button>
                            </div>
                          ) : (
                            column
                          )}
                        </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{activeMonth}</td>
                      {visibleOutboundColumnIndices.map((index) => {
                        const value = activeMonthState.productionRow.values[index]
                        return (
                        <td key={`${activeMonth}-production-${index}`}>
                          <input
                            className="meeting-cell-input"
                            type="text"
                            inputMode="numeric"
                            value={formatOutboundAmountForInput(value)}
                            onChange={(event) =>
                              updateProductionRow('productionRow', index, event.target.value)
                            }
                          />
                        </td>
                        )
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="meeting-production-inventory-charts">
                <p className="meeting-mini-chart-caption meeting-mini-chart-caption--trend">
                  월별 출고 합계 열 값 추이(표 첫 출고 합계 칸과 동일)
                </p>
                <div className="meeting-outbound-trend-stack">
                  <div
                    className="meeting-trend-line-chart meeting-outbound-trend-line-full"
                    role="img"
                    aria-label="월별 출고 합계 열 추이"
                  >
                    <div className="meeting-outbound-line-plot">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={productionTrendSeries} margin={{ left: 4, right: 12, top: 10, bottom: 10 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="month" tick={{ fontSize: 10 }} interval={0} height={34} />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={44}
                            tickFormatter={(v) => meetingAmountDisplayFormatter.format(Number(v))}
                          />
                          <Tooltip
                            formatter={(value) => [
                              meetingAmountDisplayFormatter.format(Number(value ?? 0)),
                              '출고 합계',
                            ]}
                          />
                          <Line
                            type="monotone"
                            dataKey="total"
                            stroke="#2563eb"
                            strokeWidth={2}
                            dot={{ r: 3, fill: '#2563eb' }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="meeting-outbound-share-block">
                    <div className="meeting-outbound-share-toggle-row">
                      <button
                        type="button"
                        className="meeting-title-collapse-button"
                        onClick={() => setOutboundShareChartOpen((open) => !open)}
                        aria-expanded={outboundShareChartOpen}
                        aria-controls="meeting-outbound-share-panel"
                        aria-label={
                          outboundShareChartOpen
                            ? `${activeMonth} 생두별 출고 비율 그래프 접기`
                            : `${activeMonth} 생두별 출고 비율 그래프 펼치기`
                        }
                      >
                        {outboundShareChartOpen ? '−' : '+'}
                      </button>
                      <span className="meeting-mini-chart-caption meeting-outbound-share-toggle-label" id="meeting-outbound-share-heading">
                        {activeMonth} 생두별 출고 비율
                      </span>
                    </div>

                    {outboundShareChartOpen ? (
                      <div
                        className="meeting-outbound-share-panel"
                        id="meeting-outbound-share-panel"
                        role="img"
                        aria-labelledby="meeting-outbound-share-heading"
                      >
                        <p className="muted tiny meeting-outbound-share-sub">
                          표의 생두 열 합을 100%로 둔 비율입니다.
                        </p>
                        {activeMonthBeanOutboundSharePie.length > 0 && activeMonthBeanOutboundPieTotal > 0 ? (
                          <div
                            className="meeting-outbound-share-donut-frame"
                            onMouseLeave={(e) => {
                              const next = e.relatedTarget as HTMLElement | null
                              if (next?.closest?.('.recharts-tooltip-wrapper')) {
                                return
                              }
                              if (next && e.currentTarget.contains(next)) {
                                return
                              }
                              setOutboundPieHoveredSliceIndex(null)
                            }}
                          >
                            <div className="meeting-outbound-share-chart-area">
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                                  <defs>
                                    <filter
                                      id={outboundPieFilterId}
                                      x="-45%"
                                      y="-45%"
                                      width="190%"
                                      height="190%"
                                    >
                                      <feDropShadow
                                        dx="0"
                                        dy="5"
                                        stdDeviation="6"
                                        floodColor="#14110f"
                                        floodOpacity="0.2"
                                        result="pieDrop"
                                      />
                                      <feMerge>
                                        <feMergeNode in="pieDrop" />
                                        <feMergeNode in="SourceGraphic" />
                                      </feMerge>
                                    </filter>
                                    {activeMonthBeanOutboundSharePie.map((_, index) => {
                                      const base =
                                        OUTBOUND_SHARE_PIE_COLORS[index % OUTBOUND_SHARE_PIE_COLORS.length]
                                      const { hi, lo } = pieShadeStops(base)
                                      return (
                                        <radialGradient
                                          key={`pie-grad-${index}`}
                                          id={outboundPieGradId(index)}
                                          cx="32%"
                                          cy="28%"
                                          r="92%"
                                          fx="28%"
                                          fy="22%"
                                        >
                                          <stop offset="0%" stopColor={hi} />
                                          <stop offset="45%" stopColor={base} />
                                          <stop offset="100%" stopColor={lo} />
                                        </radialGradient>
                                      )
                                    })}
                                  </defs>
                                  <Pie
                                    data={activeMonthBeanOutboundSharePie}
                                    dataKey="value"
                                    nameKey="name"
                                    cx="50%"
                                    cy="50%"
                                    innerRadius="38%"
                                    outerRadius="72%"
                                    paddingAngle={0.4}
                                    cornerRadius={3}
                                    stroke="#f4f2f0"
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                    style={{ filter: `url(#${outboundPieFilterId})` }}
                                    onMouseEnter={(_entry, index) => {
                                      setOutboundPieHoveredSliceIndex(index)
                                    }}
                                  >
                                    {activeMonthBeanOutboundSharePie.map((_, index) => (
                                      <Cell
                                        key={`${activeMonth}-pie-${index}`}
                                        fill={`url(#${outboundPieGradId(index)})`}
                                      />
                                    ))}
                                  </Pie>
                                  <Tooltip
                                    content={({ active: tipActive, payload }) => {
                                      if (!tipActive || !payload?.length) {
                                        return null
                                      }
                                      const row = payload[0]
                                      const name = String(row.name ?? '')
                                      const value = Number(row.value ?? 0)
                                      const pct =
                                        activeMonthBeanOutboundPieTotal > 0
                                          ? (value / activeMonthBeanOutboundPieTotal) * 100
                                          : 0
                                      return (
                                        <div className="meeting-chart-tooltip meeting-outbound-share-tooltip">
                                          <div className="meeting-outbound-share-tooltip-name">{name}</div>
                                          <div className="meeting-outbound-share-tooltip-meta">
                                            <span className="meeting-outbound-share-tooltip-pct">
                                              {pct.toFixed(1)}%
                                            </span>
                                            <span className="meeting-outbound-share-tooltip-kg">
                                              {meetingAmountDisplayFormatter.format(value)} kg
                                            </span>
                                          </div>
                                        </div>
                                      )
                                    }}
                                  />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                            <ul className="meeting-outbound-donut-legend">
                              {outboundDonutLegendRows.map((row) => {
                                const isHovered = outboundPieHoveredSliceIndex === row.sliceIndex
                                return (
                                  <li
                                    key={`${row.name}-${row.sliceIndex}`}
                                    className={`meeting-outbound-donut-legend-item${isHovered ? ' is-pie-hovered' : ''}`}
                                    onMouseEnter={() => setOutboundPieHoveredSliceIndex(row.sliceIndex)}
                                  >
                                    <span
                                      className="meeting-outbound-donut-legend-swatch"
                                      style={{ backgroundColor: row.fill }}
                                      aria-hidden
                                    />
                                    <span className="meeting-outbound-donut-legend-name">{row.name}</span>
                                    <span className="meeting-outbound-donut-legend-pct">
                                      {row.pct.toFixed(1)}%
                                    </span>
                                    <span className="meeting-outbound-donut-legend-kg">
                                      {meetingAmountDisplayFormatter.format(row.value)} kg
                                    </span>
                                  </li>
                                )
                              })}
                            </ul>
                          </div>
                        ) : (
                          <p className="muted tiny meeting-outbound-share-empty">
                            생두별 출고 열·값이 없으면 비율을 표시할 수 없습니다.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>

            <article className="meeting-card">
              <div className="meeting-card-header">
                <h3>{activeMonth} 재고현황</h3>
                {productionInventoryEditMode ? (
                  <button
                    type="button"
                    className="ghost-button meeting-mini-button"
                    onClick={() => addStructuredColumn('inventoryColumns')}
                  >
                    항목 추가
                  </button>
                ) : null}
              </div>
              <div className="table-wrapper">
                <table className="meeting-table meeting-table-compact">
                  <thead>
                    <tr>
                      <th>월</th>
                      {data.inventoryColumns.map((column, index) => (
                        <th key={`inventory-column-${index}`}>
                          {productionInventoryEditMode ? (
                            <div className="meeting-header-edit-column">
                              <input
                                className="meeting-header-input"
                                type="text"
                                value={column}
                                onChange={(event) =>
                                  updateColumnLabel('inventoryColumns', index, event.target.value)
                                }
                              />
                              <button
                                type="button"
                                className="meeting-icon-button"
                                onClick={() => removeStructuredColumn('inventoryColumns', index)}
                              >
                                -
                              </button>
                            </div>
                          ) : (
                            column
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{activeMonth}</td>
                      {computedInventoryRow.values.map((value, index) => (
                        <td key={`${activeMonth}-inventory-${index}`}>
                          <input
                            className="meeting-cell-input"
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(value)}
                            onChange={(event) =>
                              updateProductionRow('inventoryRow', index, event.target.value)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
          </div> : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="meeting-section-heading">
              <h2 className="meeting-section-title">
                <button
                  type="button"
                  className="meeting-title-collapse-button"
                  onClick={() => toggleSection('notes')}
                  aria-expanded={!collapsedSections.notes}
                  aria-label={collapsedSections.notes ? '5번 섹션 펼치기' : '5번 섹션 접기'}
                >
                  {collapsedSections.notes ? '+' : '-'}
                </button>
                <span>5. {activeMonth} 회의 메모</span>
              </h2>
              <p className="meeting-section-description">이번 달 주요 이슈, 결론, 후속 액션을 텍스트로 남기는 메모 영역입니다.</p>
            </div>
          </div>

          {!collapsedSections.notes ? <div className="meeting-notes-grid">
            <label className="meeting-note-field">
              회의 요약
              <textarea
                value={activeNotes.summary}
                onChange={(event) => updateActiveNotes('summary', event.target.value)}
                placeholder={`${activeMonth} 회의 요약, 이슈, 결론 등을 적어두세요.`}
              />
            </label>

            <label className="meeting-note-field">
              다음 액션
              <textarea
                value={activeNotes.actions}
                onChange={(event) => updateActiveNotes('actions', event.target.value)}
                placeholder={`${activeMonth} 회의 후 다음 액션, 담당자, 체크 포인트 등을 적어두세요.`}
              />
            </label>
          </div> : null}
        </section>
      </main>
    </>
  )
}

export default MonthlyMeetingPage
