import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import PageSaveStatus from './components/PageSaveStatus'
import * as XLSX from 'xlsx'
import { exportStyledExpenseWorkbook } from './expenseExcelStyledExport'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export const EXPENSE_PAGE_STORAGE_KEY = 'expense-page-data-v1'
/** 월 마감 회의 등에서 지출 저장 후 동기화할 때 */
export const EXPENSE_PAGE_SAVED_EVENT = 'expense-page-saved'

const currencyFormatter = new Intl.NumberFormat('ko-KR')
const today = new Date().toISOString().slice(0, 10)
const currentMonth = today.slice(0, 7)
/** 신규 행 기본. 레거시 `기타운영비`는 데이터·월마감 연동에서 그대로 읽으며, 필요 시 「용도」로 나눕니다. */
const DEFAULT_CATEGORY = '운영경비'
const DEFAULT_PAYMENT_METHOD = '계좌이체'
const DEFAULT_PAYMENT_STATUS = '지급완료'
const TAX_TYPE_OPTIONS = ['과세', '면세'] as const
const PAYMENT_STATUS_OPTIONS = ['지급완료', '미지급'] as const
const PAYMENT_METHOD_OPTIONS = ['계좌이체', '카드', '현금', '자동이체', '기타'] as const
const EXPENSE_CATEGORY_OPTIONS = [
  '원재료비',
  '소모품비',
  '인건비',
  '임차료',
  '전기/수도/가스',
  '배달/물류/택배',
  '광고/마케팅',
  '수수료',
  '장비/수리비',
  '기타경비',
  '운영경비',
] as const

type TaxType = (typeof TAX_TYPE_OPTIONS)[number]
type PaymentStatus = (typeof PAYMENT_STATUS_OPTIONS)[number]
type PaymentMethod = (typeof PAYMENT_METHOD_OPTIONS)[number]

export type ExpenseRecord = {
  id: string
  expenseDate: string
  dueDate: string
  vendorName: string
  category: string
  /** 비용 「용도」 구분·엑셀 연동용(예: 기타경비/운영경비). 카테고리와 별개로 적을 수 있습니다. */
  purpose: string
  detail: string
  totalAmount: number
  taxType: TaxType
  paymentMethod: PaymentMethod
  paymentStatus: PaymentStatus
  isRecurring: boolean
  /** 증빙값은 원본 텍스트(Y/N, 현금영수증 등) 그대로 유지 */
  hasReceipt: string
  memo: string
  /** 엑셀 원본의 추가 커스텀 열 값들 (extra:* id 기준) */
  extraValues?: Record<string, string>
}

type ExpenseColumnKey = keyof ParsedExpenseColumns
type ExpenseTableColumn = {
  id: string
  label: string
  kind: 'mapped' | 'extra'
  mappedKey?: ExpenseColumnKey
}

export type ExpensePageState = {
  activeMonth: string
  records: ExpenseRecord[]
  /** 월별 카테고리 예산(원) */
  categoryBudgetsByMonth?: Record<string, Record<string, number>>
  /** 엑셀 업로드 시트 헤더 순서/이름을 그대로 유지 */
  tableColumns?: ExpenseTableColumn[]
}

type ParsedExpenseColumns = {
  expenseDate: number
  dueDate: number
  vendorName: number
  category: number
  purpose: number
  detail: number
  totalAmount: number
  supplyAmount: number
  taxAmount: number
  taxType: number
  paymentMethod: number
  paymentStatus: number
  isRecurring: number
  hasReceipt: number
  memo: number
}

const EXPENSE_COLUMN_KEYS: ExpenseColumnKey[] = [
  'expenseDate',
  'dueDate',
  'vendorName',
  'category',
  'purpose',
  'detail',
  'taxType',
  'totalAmount',
  'supplyAmount',
  'taxAmount',
  'paymentMethod',
  'paymentStatus',
  'isRecurring',
  'hasReceipt',
  'memo',
]

const DEFAULT_EXPENSE_COLUMN_ORDER: ExpenseColumnKey[] = [...EXPENSE_COLUMN_KEYS]

const DEFAULT_EXPENSE_COLUMN_LABELS: Record<ExpenseColumnKey, string> = {
  expenseDate: '지출일',
  dueDate: '지급예정일',
  vendorName: '거래처',
  category: '카테고리',
  purpose: '용도',
  detail: '세부항목',
  taxType: '과세구분',
  totalAmount: '결제금액',
  supplyAmount: '공급가액',
  taxAmount: '부가세',
  paymentMethod: '지급수단',
  paymentStatus: '상태',
  isRecurring: '반복',
  hasReceipt: '증빙',
  memo: '메모',
}

const DEFAULT_EXPENSE_TABLE_COLUMNS: ExpenseTableColumn[] = DEFAULT_EXPENSE_COLUMN_ORDER.map((key) => ({
  id: `mapped:${key}`,
  label: DEFAULT_EXPENSE_COLUMN_LABELS[key],
  kind: 'mapped',
  mappedKey: key,
}))

/**
 * 엑셀 업로드로 `tableColumns`가 짧을 때(시트에 지급수단 열이 없을 때) 입력란이 빠지는 것을 막기 위해
 * 화면·내보내기에 반드시 넣는 매핑 열. 기본 열 순서에 맞춰 끼워 넣음.
 */
const GRID_REQUIRED_MAPPED_KEYS: ExpenseColumnKey[] = ['paymentMethod']

const defaultColumnOrder = (key: ExpenseColumnKey) => DEFAULT_EXPENSE_COLUMN_ORDER.indexOf(key)

const columnSortOrder = (c: ExpenseTableColumn) => {
  if (c.kind === 'mapped' && c.mappedKey) {
    return defaultColumnOrder(c.mappedKey)
  }
  return 1_000
}

const mergeVisibleExpenseColumns = (tableColumns: ExpenseTableColumn[] | undefined): ExpenseTableColumn[] => {
  const base =
    tableColumns && tableColumns.length > 0 ? tableColumns : DEFAULT_EXPENSE_TABLE_COLUMNS
  if (!tableColumns || tableColumns.length === 0) {
    return base
  }
  const present = new Set(
    base
      .filter(
        (col): col is ExpenseTableColumn & { mappedKey: ExpenseColumnKey } =>
          col.kind === 'mapped' && Boolean(col.mappedKey),
      )
      .map((col) => col.mappedKey),
  )
  const missing = GRID_REQUIRED_MAPPED_KEYS.filter((k) => !present.has(k))
  if (missing.length === 0) {
    return base
  }
  const toAdd = missing
    .map((k) => DEFAULT_EXPENSE_TABLE_COLUMNS.find((col) => col.kind === 'mapped' && col.mappedKey === k))
    .filter((col): col is ExpenseTableColumn => Boolean(col))
    .sort((a, b) => defaultColumnOrder(a.mappedKey!) - defaultColumnOrder(b.mappedKey!))

  const merged: ExpenseTableColumn[] = [...base]
  for (const col of toAdd) {
    const o = defaultColumnOrder(col.mappedKey!)
    const insertAt = merged.findIndex((c) => columnSortOrder(c) > o)
    if (insertAt === -1) {
      merged.push(col)
    } else {
      merged.splice(insertAt, 0, col)
    }
  }
  return merged
}

const expenseHeaderAliases = {
  expenseDate: ['날짜', '지출일', '거래일자', '사용일자'],
  dueDate: ['지급예정일', '지급일', '결제예정일', '예정일'],
  vendorName: ['거래처', '업체명', '거래처명', '가맹점명', '사용처'],
  category: ['카테고리', '분류', '비용분류'],
  purpose: ['용도', '비용용도', '경비용도', '경비구분', '세부구분'],
  detail: ['세부항목', '항목', '내용', '적요'],
  totalAmount: ['금액', '합계금액', '총액', '결제금액', '사용금액'],
  supplyAmount: ['공급가액', '공급가', '공급금액'],
  taxAmount: ['부가세', '세액', 'vat'],
  taxType: ['과세구분', '부가세구분', '증빙구분'],
  paymentMethod: ['지급수단', '결제수단', '수단'],
  paymentStatus: ['지급상태', '상태', '결제상태'],
  isRecurring: ['반복지출', '반복', '정기반복', '매월반복'],
  hasReceipt: ['증빙여부', '영수증', '증빙'],
  memo: ['비고', '메모', '참고'],
} as const

const formatMoney = (value: number) => `${currencyFormatter.format(value)}원`
const formatMonthLabel = (value: string) => {
  const [year, month] = value.split('-')
  return `${year}년 ${Number(month)}월`
}
const formatDateLabel = (value: string) => (value ? value.replaceAll('-', '.') : '-')
const normalizeHeader = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\r?\n/g, '')
const normalizeText = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ')
const parseNumber = (value: unknown) => {
  const normalized = String(value ?? '')
    .replaceAll(',', '')
    .replace(/원/g, '')
    .trim()
  return normalized ? Number(normalized) : 0
}
const formatIsoDate = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
const formatLocalDate = (value: Date) =>
  formatIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate())
const sumValues = (values: number[]) => values.reduce((total, value) => total + value, 0)

const parseSpreadsheetDate = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) {
      return formatIsoDate(parsed.y, parsed.m, parsed.d)
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value)
  }

  const text = String(value).trim()
  if (!text) {
    return ''
  }

  if (text.toUpperCase() === '=TODAY()') {
    return today
  }

  const normalized = text
    .replace(/[년.]/g, '-')
    .replace(/[월/]/g, '-')
    .replace(/일/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const directMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D.*)?$/)
  if (directMatch) {
    return formatIsoDate(Number(directMatch[1]), Number(directMatch[2]), Number(directMatch[3]))
  }

  const monthFirstMatch = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})(?:\D.*)?$/)
  if (monthFirstMatch) {
    const year =
      monthFirstMatch[3].length === 2 ? 2000 + Number(monthFirstMatch[3]) : Number(monthFirstMatch[3])
    return formatIsoDate(year, Number(monthFirstMatch[1]), Number(monthFirstMatch[2]))
  }

  const parsedTimestamp = Date.parse(text)
  if (!Number.isNaN(parsedTimestamp)) {
    return formatLocalDate(new Date(parsedTimestamp))
  }

  return ''
}

const parseTaxType = (value: unknown): TaxType => {
  const text = normalizeText(value)
  if (text.includes('면세') || text.includes('영세')) {
    return '면세'
  }
  return '과세'
}

const parsePaymentStatus = (value: unknown): PaymentStatus => {
  const text = normalizeText(value)
  return text.includes('미지급') || text.includes('대기') ? '미지급' : '지급완료'
}

const parsePaymentMethod = (value: unknown): PaymentMethod => {
  const text = normalizeText(value)
  if (!text) {
    return DEFAULT_PAYMENT_METHOD
  }

  const matched = PAYMENT_METHOD_OPTIONS.find((option) => option === text)
  return matched ?? '기타'
}

const parseBooleanCell = (value: unknown) => {
  const text = normalizeText(value).toLowerCase()
  return ['y', 'yes', 'true', '1', 'o', '고정', '있음', '예'].includes(text)
}

/** 엑셀 「용도」 또는 메모 성격의 값으로 기타경비/운영경비만 구분합니다. */
const classifyPurposeExpenseBucket = (text: unknown): '기타경비' | '운영경비' | null => {
  const raw = normalizeText(text)
  const compact = raw.replace(/\s+/g, '')
  if (!compact.length) {
    return null
  }
  const hasStandaloneOther = /기타\s*경비/.test(raw) || /^기타경비$/u.test(compact) || /^기타비$/u.test(compact)
  const hasStandaloneOps = /운영\s*경비/u.test(raw) || /운영경비$/u.test(compact) || /^운영비$/u.test(compact)
  if (hasStandaloneOther && !hasStandaloneOps) {
    return '기타경비'
  }
  if (hasStandaloneOps) {
    return '운영경비'
  }
  const legacyLoose =
    /^기타\s*운영(?:\s*비)?$/u.test(raw) ||
    compact === '기타운영' ||
    /기타운영비/u.test(compact)
  return legacyLoose ? '운영경비' : null
}

const mergeImportedExpenseCategory = (categoryCell: string, purposeCell: string): string => {
  const bucket = classifyPurposeExpenseBucket(purposeCell)
  const cat = categoryCell.trim()
  /** 카테고리가 기본 '운영경비' 등으로만 잡히고 「용도」에서만 나눈 경우 월 마감·엑셀 불러오기 결과를 맞춤 */
  if (bucket === '기타경비' && cat === '운영경비') {
    return '기타경비'
  }
  if (bucket === '운영경비' && cat === '기타경비') {
    return '운영경비'
  }
  if (bucket && (!cat || cat === '기타운영비')) {
    return bucket
  }
  if (!cat.length) {
    return DEFAULT_CATEGORY
  }
  return cat
}

/** 월 마감 회의 비용 연동 등 — 화면의 카테고리·용도와 동일 규칙으로 실질 분류 */
export function resolveExpenseCategoryForMeetingSync(record: Pick<ExpenseRecord, 'category' | 'purpose'>): string {
  return mergeImportedExpenseCategory(String(record.category ?? '').trim(), String(record.purpose ?? ''))
}

/**
 * 월 마감 「비용 현황」줄별 합산 전용.
 * 카테고리·용도가 모두 분류 불가하면 `미분류`로 두어 **운영경비 줄에 합산되지 않게** 한다(그 외 비용 쪽만).
 */
export function resolveExpenseCategoryForMeetingBucket(record: Pick<ExpenseRecord, 'category' | 'purpose'>): string {
  const trimmed = String(record.category ?? '').trim()
  const purpose = String(record.purpose ?? '')
  if (!trimmed.length) {
    const pb = classifyPurposeExpenseBucket(purpose)
    if (pb) {
      return pb
    }
    return '미분류'
  }
  return mergeImportedExpenseCategory(trimmed, purpose)
}

const splitAmount = (totalAmount: number, taxType: TaxType) => {
  if (taxType === '면세') {
    return {
      supplyAmount: totalAmount,
      taxAmount: 0,
    }
  }

  const supplyAmount = Math.round((totalAmount / 11) * 10)
  return {
    supplyAmount,
    taxAmount: totalAmount - supplyAmount,
  }
}

/** 지급(체크) 열 전용 — `visibleExpenseColumns`에 없는 가상 id */
const EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID = '__expense_list_sort_payment__'

type ExpenseListSortState = {
  columnId: string
  direction: 'asc' | 'desc'
}

const expenseDefaultRowTiebreak = (left: ExpenseRecord, right: ExpenseRecord): number =>
  left.dueDate.localeCompare(right.dueDate) ||
  left.expenseDate.localeCompare(right.expenseDate) ||
  left.id.localeCompare(right.id)

const compareExpenseSortPrimaries = (a: string | number, b: string | number, direction: 'asc' | 'desc'): number => {
  const factor = direction === 'asc' ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') {
    const na = Number.isFinite(a) ? a : 0
    const nb = Number.isFinite(b) ? b : 0
    if (na !== nb) {
      return (na - nb) * factor
    }
    return 0
  }
  const sa = String(a ?? '').trim()
  const sb = String(b ?? '').trim()
  const c = sa.localeCompare(sb, 'ko', { numeric: true, sensitivity: 'base' })
  return c !== 0 ? c * factor : 0
}

const getExpenseColumnSortComparable = (record: ExpenseRecord, column: ExpenseTableColumn): string | number => {
  if (column.kind === 'extra') {
    return (record.extraValues?.[column.id] ?? '').trim().toLowerCase()
  }
  const mk = column.mappedKey
  if (!mk) {
    return ''
  }
  switch (mk) {
    case 'expenseDate':
    case 'dueDate':
      return record[mk]
    case 'vendorName':
    case 'category':
    case 'purpose':
    case 'detail':
    case 'taxType':
    case 'paymentMethod':
    case 'paymentStatus':
    case 'hasReceipt':
    case 'memo':
      return String(record[mk] ?? '').trim().toLowerCase()
    case 'totalAmount':
      return record.totalAmount
    case 'supplyAmount':
      return splitAmount(record.totalAmount, record.taxType).supplyAmount
    case 'taxAmount':
      return splitAmount(record.totalAmount, record.taxType).taxAmount
    case 'isRecurring':
      return record.isRecurring ? 1 : 0
    default:
      return ''
  }
}

const sortExpenseFilteredRecords = (
  filtered: ExpenseRecord[],
  visibleColumns: ExpenseTableColumn[],
  sort: ExpenseListSortState | null,
): ExpenseRecord[] => {
  const list = [...filtered]
  if (!sort) {
    list.sort((a, b) => expenseDefaultRowTiebreak(a, b))
    return list
  }

  const { columnId, direction } = sort

  if (columnId === EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID) {
    list.sort((left, right) => {
      const va = left.paymentStatus === '지급완료' ? 1 : 0
      const vb = right.paymentStatus === '지급완료' ? 1 : 0
      const p = compareExpenseSortPrimaries(va, vb, direction)
      if (p !== 0) {
        return p
      }
      return expenseDefaultRowTiebreak(left, right)
    })
    return list
  }

  const col = visibleColumns.find((c) => c.id === columnId)
  if (!col) {
    list.sort((a, b) => expenseDefaultRowTiebreak(a, b))
    return list
  }

  list.sort((left, right) => {
    const va = getExpenseColumnSortComparable(left, col)
    const vb = getExpenseColumnSortComparable(right, col)
    const p = compareExpenseSortPrimaries(va, vb, direction)
    if (p !== 0) {
      return p
    }
    return expenseDefaultRowTiebreak(left, right)
  })
  return list
}

type ExpenseCategorySummaryRow = {
  category: string
  totalAmount: number
  count: number
}

type ExpensePaymentSummaryRow = { paymentMethod: string; totalAmount: number }

const summarizeExpenseByCategory = (
  records: ExpenseRecord[],
  allCategories: string[],
): ExpenseCategorySummaryRow[] => {
  const grouped = new Map<string, { totalAmount: number; count: number }>()
  records.forEach((record) => {
    const current = grouped.get(record.category) ?? { totalAmount: 0, count: 0 }
    current.totalAmount += record.totalAmount
    current.count += 1
    grouped.set(record.category, current)
  })
  for (const category of allCategories) {
    if (!grouped.has(category)) {
      grouped.set(category, { totalAmount: 0, count: 0 })
    }
  }
  return Array.from(grouped.entries())
    .map(([category, value]) => ({ category, ...value }))
    .sort((left, right) => right.totalAmount - left.totalAmount)
}

const summarizeExpenseByPaymentMethod = (records: ExpenseRecord[]): ExpensePaymentSummaryRow[] => {
  const grouped = new Map<string, number>()
  for (const method of PAYMENT_METHOD_OPTIONS) {
    grouped.set(method, 0)
  }
  records.forEach((record) => {
    grouped.set(record.paymentMethod, (grouped.get(record.paymentMethod) ?? 0) + record.totalAmount)
  })
  return Array.from(grouped.entries())
    .map(([paymentMethod, totalAmount]) => ({ paymentMethod, totalAmount }))
    .sort((left, right) => right.totalAmount - left.totalAmount)
}

const parseQuickMmDd = (digits: string, year: number) => {
  if (!/^\d{4}$/.test(digits)) {
    return null
  }
  const month = Number(digits.slice(0, 2))
  const day = Number(digits.slice(2, 4))
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return formatIsoDate(year, month, day)
}

const createRecordForMonth = (month: string): ExpenseRecord => {
  const defaultDate = month === currentMonth ? today : `${month}-01`
  return {
    id: crypto.randomUUID(),
    expenseDate: defaultDate,
    dueDate: defaultDate,
    vendorName: '',
    category: DEFAULT_CATEGORY,
    purpose: '',
    detail: '',
    totalAmount: 0,
    taxType: '과세',
    paymentMethod: DEFAULT_PAYMENT_METHOD,
    paymentStatus: DEFAULT_PAYMENT_STATUS,
    isRecurring: false,
    hasReceipt: '',
    memo: '',
  }
}

const createDefaultState = (): ExpensePageState => ({
  activeMonth: currentMonth,
  records: [],
  categoryBudgetsByMonth: {},
})

const buildExpenseExportRow = (record: ExpenseRecord, columns: ExpenseTableColumn[]): (string | number)[] => {
  const { supplyAmount, taxAmount } = splitAmount(record.totalAmount, record.taxType)
  const cells: Record<ExpenseColumnKey, string | number> = {
    expenseDate: record.expenseDate,
    dueDate: record.dueDate,
    vendorName: record.vendorName,
    category: record.category,
    purpose: record.purpose ?? '',
    detail: record.detail,
    taxType: record.taxType,
    totalAmount: record.totalAmount,
    supplyAmount,
    taxAmount,
    paymentMethod: record.paymentMethod,
    paymentStatus: record.paymentStatus,
    isRecurring: record.isRecurring ? 'Y' : '',
    hasReceipt: record.hasReceipt,
    memo: record.memo,
  }
  return columns.map((column) => {
    if (column.kind === 'mapped' && column.mappedKey) {
      return cells[column.mappedKey]
    }
    return record.extraValues?.[column.id] ?? ''
  })
}

const normalizeRecord = (value: unknown): ExpenseRecord | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const source = value as Partial<ExpenseRecord>
  const expenseDate = parseSpreadsheetDate(source.expenseDate)
  const dueDate = parseSpreadsheetDate(source.dueDate) || expenseDate
  const vendorName = normalizeText(source.vendorName)
  const category = normalizeText(source.category) || DEFAULT_CATEGORY
  const purpose = normalizeText(source.purpose)
  const totalAmount = Number(source.totalAmount ?? 0)

  return {
    id: String(source.id ?? crypto.randomUUID()),
    expenseDate: expenseDate || today,
    dueDate: dueDate || expenseDate || today,
    vendorName,
    category,
    purpose,
    detail: normalizeText(source.detail),
    totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
    taxType: source.taxType === '면세' ? '면세' : '과세',
    paymentMethod: parsePaymentMethod(source.paymentMethod),
    paymentStatus: parsePaymentStatus(source.paymentStatus),
    isRecurring: source.isRecurring === true,
    hasReceipt:
      typeof source.hasReceipt === 'string'
        ? normalizeText(source.hasReceipt)
        : source.hasReceipt === true
          ? 'Y'
          : source.hasReceipt === false
            ? ''
            : '',
    memo: normalizeText(source.memo),
    extraValues:
      source.extraValues && typeof source.extraValues === 'object'
        ? Object.fromEntries(
            Object.entries(source.extraValues as Record<string, unknown>)
              .filter(([k, v]) => k && typeof v === 'string')
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined,
  }
}

export function normalizeExpensePageState(value: unknown): ExpensePageState {
  if (!value || typeof value !== 'object') {
    return createDefaultState()
  }

  const source = value as Partial<ExpensePageState>
  const records = Array.isArray(source.records) ? source.records.map(normalizeRecord).filter(Boolean) : []
  const activeMonth = typeof source.activeMonth === 'string' && /^\d{4}-\d{2}$/.test(source.activeMonth)
    ? source.activeMonth
    : currentMonth

  const tableColumns = sanitizeExpenseTableColumns(source.tableColumns)
  const categoryBudgetsByMonth =
    source.categoryBudgetsByMonth && typeof source.categoryBudgetsByMonth === 'object'
      ? Object.fromEntries(
          Object.entries(source.categoryBudgetsByMonth as Record<string, unknown>).map(([month, rawMap]) => {
            const rows = rawMap && typeof rawMap === 'object' ? (rawMap as Record<string, unknown>) : {}
            const cleaned = Object.fromEntries(
              Object.entries(rows)
                .map(([category, amount]) => [String(category).trim(), Math.max(0, parseNumber(amount))] as const)
                .filter(([category]) => category.length > 0),
            )
            return [month, cleaned]
          }),
        )
      : {}

  return {
    activeMonth,
    records: records as ExpenseRecord[],
    categoryBudgetsByMonth,
    ...(tableColumns ? { tableColumns } : {}),
  }
}

/** 월 마감 회의 등 — 브라우저에 저장된 지출표 전체를 읽어 정규화 */
export function readExpensePageStateFromStorage(): ExpensePageState {
  if (typeof window === 'undefined') {
    return createDefaultState()
  }
  try {
    const raw = window.localStorage.getItem(EXPENSE_PAGE_STORAGE_KEY)
    if (!raw) {
      return createDefaultState()
    }
    return normalizeExpensePageState(JSON.parse(raw))
  } catch {
    return createDefaultState()
  }
}

const sanitizeExpenseTableColumns = (value: unknown): ExpenseTableColumn[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const seen = new Set<string>()
  const out: ExpenseTableColumn[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const row = item as Partial<ExpenseTableColumn>
    const id = String(row.id ?? '').trim()
    const label = String(row.label ?? '').trim()
    const kind = row.kind === 'extra' ? 'extra' : row.kind === 'mapped' ? 'mapped' : null
    if (!id || !label || !kind) {
      continue
    }
    if (seen.has(id)) {
      continue
    }
    if (kind === 'mapped') {
      const mappedKey = row.mappedKey
      if (!mappedKey || !EXPENSE_COLUMN_KEYS.includes(mappedKey)) {
        continue
      }
      out.push({ id, label, kind, mappedKey })
    } else {
      out.push({ id, label, kind })
    }
    seen.add(id)
  }
  return out.length > 0 ? out : undefined
}

const extractImportLayout = (rawHeaderRow: unknown[], columns: ParsedExpenseColumns): ExpenseTableColumn[] => {
  const mappedByIndex = new Map<number, ExpenseColumnKey>()
  for (const key of EXPENSE_COLUMN_KEYS) {
    const idx = columns[key]
    if (idx >= 0 && !mappedByIndex.has(idx)) {
      mappedByIndex.set(idx, key)
    }
  }
  const layout: ExpenseTableColumn[] = []
  for (let idx = 0; idx < rawHeaderRow.length; idx++) {
    const label = String(rawHeaderRow[idx] ?? '').trim()
    if (!label) {
      continue
    }
    const mappedKey = mappedByIndex.get(idx)
    if (mappedKey) {
      layout.push({
        id: `mapped:${mappedKey}`,
        label,
        kind: 'mapped',
        mappedKey,
      })
    } else {
      layout.push({
        id: `extra:${idx}`,
        label,
        kind: 'extra',
      })
    }
  }
  if (layout.length === 0) {
    return [...DEFAULT_EXPENSE_TABLE_COLUMNS]
  }
  return layout
}

const findHeaderIndex = (headers: string[], aliases: readonly string[]) =>
  headers.findIndex((cell) => aliases.map(normalizeHeader).includes(cell))

const findFirstNonEmptyHeaderRowIndex = (rows: unknown[][]): number => {
  return rows.findIndex((row) => row.some((cell) => normalizeText(cell).length > 0))
}

/**
 * 엄격 매칭 실패 시 헤더 후보를 고름.
 * - 보통 A2:I2처럼 2행에 헤더가 있는 파일을 우선 반영
 * - 상단 40행에서 "채워진 칸 수"가 가장 많은 행을 선택
 */
const findBestFallbackHeaderRowIndex = (rows: unknown[][]): number => {
  const scanLimit = Math.min(rows.length, 40)
  let bestIndex = -1
  let bestScore = -1
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i] ?? []
    const filled = row.reduce<number>(
      (count, cell) => (normalizeText(cell).length > 0 ? count + 1 : count),
      0,
    )
    if (filled > bestScore) {
      bestScore = filled
      bestIndex = i
    }
  }
  return bestIndex
}

const parseExpenseWorkbook = (
  workbook: XLSX.WorkBook,
): { records: ExpenseRecord[]; layout: ExpenseTableColumn[]; warnings: string[] } => {
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    return { records: [], layout: [], warnings: [] }
  }

  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd',
  })

  const strictHeaderRowIndex = rows.findIndex((row) => {
    const normalizedCells = row.map(normalizeHeader)
    return (
      normalizedCells.some((cell) => expenseHeaderAliases.expenseDate.map(normalizeHeader).includes(cell)) &&
      normalizedCells.some((cell) => expenseHeaderAliases.vendorName.map(normalizeHeader).includes(cell)) &&
      (normalizedCells.some((cell) => expenseHeaderAliases.totalAmount.map(normalizeHeader).includes(cell)) ||
        normalizedCells.some((cell) => expenseHeaderAliases.supplyAmount.map(normalizeHeader).includes(cell)))
    )
  })
  const fallbackHeaderRowIndex = findBestFallbackHeaderRowIndex(rows)
  const headerRowIndex =
    strictHeaderRowIndex >= 0
      ? strictHeaderRowIndex
      : fallbackHeaderRowIndex >= 0
        ? fallbackHeaderRowIndex
        : findFirstNonEmptyHeaderRowIndex(rows)
  if (headerRowIndex < 0) {
    return { records: [], layout: [], warnings: [] }
  }

  const rawHeaderRow = rows[headerRowIndex]
  const headers = rawHeaderRow.map(normalizeHeader)
  const columns: ParsedExpenseColumns = {
    expenseDate: findHeaderIndex(headers, expenseHeaderAliases.expenseDate),
    dueDate: findHeaderIndex(headers, expenseHeaderAliases.dueDate),
    vendorName: findHeaderIndex(headers, expenseHeaderAliases.vendorName),
    category: findHeaderIndex(headers, expenseHeaderAliases.category),
    purpose: findHeaderIndex(headers, expenseHeaderAliases.purpose),
    detail: findHeaderIndex(headers, expenseHeaderAliases.detail),
    totalAmount: findHeaderIndex(headers, expenseHeaderAliases.totalAmount),
    supplyAmount: findHeaderIndex(headers, expenseHeaderAliases.supplyAmount),
    taxAmount: findHeaderIndex(headers, expenseHeaderAliases.taxAmount),
    taxType: findHeaderIndex(headers, expenseHeaderAliases.taxType),
    paymentMethod: findHeaderIndex(headers, expenseHeaderAliases.paymentMethod),
    paymentStatus: findHeaderIndex(headers, expenseHeaderAliases.paymentStatus),
    isRecurring: findHeaderIndex(headers, expenseHeaderAliases.isRecurring),
    hasReceipt: findHeaderIndex(headers, expenseHeaderAliases.hasReceipt),
    memo: findHeaderIndex(headers, expenseHeaderAliases.memo),
  }

  const warnings: string[] = []
  if (strictHeaderRowIndex === -1) {
    warnings.push('시트 헤더를 완전히 매칭하지 못해 첫 행을 기준으로 불러왔습니다.')
  }
  if (columns.expenseDate === -1) {
    warnings.push('지출일 컬럼을 찾지 못해 오늘 날짜로 채웠습니다.')
  }
  if (columns.vendorName === -1) {
    warnings.push('거래처 컬럼을 찾지 못해 비어있는 값으로 불러왔습니다.')
  }
  if (columns.totalAmount === -1 && columns.supplyAmount === -1 && columns.taxAmount === -1) {
    warnings.push('금액 컬럼을 찾지 못해 결제금액을 0원으로 불러왔습니다.')
  }

  const layout = extractImportLayout(rawHeaderRow, columns)

  const records = rows
    .slice(headerRowIndex + 1)
    .flatMap((row) => {
      const expenseDate =
        columns.expenseDate === -1 ? today : parseSpreadsheetDate(row[columns.expenseDate]) || today
      const dueDate =
        columns.dueDate === -1 ? expenseDate : parseSpreadsheetDate(row[columns.dueDate]) || expenseDate
      const vendorName =
        columns.vendorName === -1 ? '' : normalizeText(row[columns.vendorName])
      const purposeRaw = columns.purpose === -1 ? '' : normalizeText(row[columns.purpose])
      const categoryCell = columns.category === -1 ? '' : normalizeText(row[columns.category])
      const category = mergeImportedExpenseCategory(categoryCell, purposeRaw)
      const detail = columns.detail === -1 ? '' : normalizeText(row[columns.detail])
      const supplyAmount = columns.supplyAmount === -1 ? 0 : parseNumber(row[columns.supplyAmount])
      const taxAmount = columns.taxAmount === -1 ? 0 : parseNumber(row[columns.taxAmount])
      const totalFromAmount = columns.totalAmount === -1 ? 0 : parseNumber(row[columns.totalAmount])
      const totalAmount = totalFromAmount > 0 ? totalFromAmount : supplyAmount + taxAmount
      const taxType =
        columns.taxType === -1 ? (taxAmount > 0 ? '과세' : '면세') : parseTaxType(row[columns.taxType])
      const extraValues = Object.fromEntries(
        layout
          .filter((col) => col.kind === 'extra')
          .map((col) => {
            const idx = Number(col.id.replace('extra:', ''))
            return [col.id, normalizeText(row[idx])]
          }),
      )

      const hasAnyExtraValue = Object.values(extraValues).some((v) => String(v).trim().length > 0)
      if (!vendorName && !detail && totalAmount <= 0 && !hasAnyExtraValue) {
        return []
      }

      return [
        {
          id: crypto.randomUUID(),
          expenseDate,
          dueDate: dueDate || expenseDate,
          vendorName,
          category,
          detail,
          totalAmount,
          taxType,
          paymentMethod:
            columns.paymentMethod === -1 ? DEFAULT_PAYMENT_METHOD : parsePaymentMethod(row[columns.paymentMethod]),
          paymentStatus:
            columns.paymentStatus === -1
              ? DEFAULT_PAYMENT_STATUS
              : parsePaymentStatus(row[columns.paymentStatus]),
          isRecurring:
            columns.isRecurring === -1 ? false : parseBooleanCell(row[columns.isRecurring]),
          hasReceipt:
            columns.hasReceipt === -1 ? '' : normalizeText(row[columns.hasReceipt]),
          memo: columns.memo === -1 ? '' : normalizeText(row[columns.memo]),
          purpose: purposeRaw,
          extraValues,
        },
      ]
    })
    .sort((left, right) => right.expenseDate.localeCompare(left.expenseDate))

  return { records, layout, warnings }
}

function ExpensePage() {
  const { mode, activeCompanyId, user } = useAppRuntime()
  const [pageState, setPageState] = useState<ExpensePageState>(createDefaultState)
  const [categoryFilter, setCategoryFilter] = useState('전체')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('전체')
  const [vendorSearch, setVendorSearch] = useState('')
  const [showUnpaidOnly, setShowUnpaidOnly] = useState(false)
  const [expenseListSort, setExpenseListSort] = useState<ExpenseListSortState | null>(null)
  const [pinnedRecordId, setPinnedRecordId] = useState('')
  const [statusMessage, setStatusMessage] = useState('브라우저에 자동 저장됩니다.')
  const [isStorageReady, setIsStorageReady] = useState(false)
  const {
    lastSavedAt,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    resetDocumentSaveUi,
    saveState,
  } = useDocumentSaveUi(mode)
  const quickDateDigitsRef = useRef<Record<string, string>>({})
  const pageStateRef = useRef(pageState)
  pageStateRef.current = pageState
  /** 클라우드에 마지막으로 맞춘 JSON(초기 로드·수동 저장·원격이 덮어쓸 때만 갱신) */
  const lastCloudSyncedJsonRef = useRef('')
  const lastCloudPollJsonRef = useRef('')
  const [dateDrafts, setDateDrafts] = useState<Record<string, string>>({})

  const syncLastCloudRefFromState = useCallback((state: ExpensePageState) => {
    const j = JSON.stringify(state)
    lastCloudSyncedJsonRef.current = j
    lastCloudPollJsonRef.current = j
  }, [])

  useEffect(() => {
    let cancelled = false
    resetDocumentSaveUi()

    const loadLocal = (markAsCloudSynced: boolean) => {
      const localState = readExpensePageStateFromStorage()
      if (cancelled) {
        return
      }
      const normalized = normalizeExpensePageState(localState)
      if (markAsCloudSynced) {
        syncLastCloudRefFromState(normalized)
      }
      setPageState(normalized)
      setStatusMessage(
        normalized.records.length > 0 ? '이전에 편집한 지출표를 불러왔습니다.' : '브라우저에 자동 저장됩니다.',
      )
      setIsStorageReady(true)
    }

    const loadRemote = async () => {
      if (mode !== 'cloud' || !activeCompanyId) {
        loadLocal(true)
        return
      }

      try {
        const remoteState = await loadCompanyDocument<ExpensePageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.expensePage,
        )
        if (cancelled) {
          return
        }
        if (remoteState) {
          const normalized = normalizeExpensePageState(remoteState)
          syncLastCloudRefFromState(normalized)
          setPageState(normalized)
          setStatusMessage('클라우드에서 지출표를 불러왔습니다.')
        } else {
          const localState = readExpensePageStateFromStorage()
          const normalized = normalizeExpensePageState(localState)
          setPageState(normalized)
          setStatusMessage(
            localState.records.length > 0
              ? '브라우저 지출표를 불러왔습니다. 아직 클라우드 문서가 없어 저장 버튼으로 업로드해 주세요.'
              : '클라우드 지출표가 없어 새 문서로 시작합니다.',
          )
        }
      } catch (error) {
        console.error('지출표 클라우드 문서를 읽지 못했습니다.', error)
        // 클라우드 읽기 실패 시 로컬은 보여주되, "동기화 완료"로 간주하지는 않음
        loadLocal(false)
        return
      }
      setIsStorageReady(true)
    }

    void loadRemote()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode, resetDocumentSaveUi, syncLastCloudRefFromState])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }
    window.localStorage.setItem(EXPENSE_PAGE_STORAGE_KEY, JSON.stringify(pageState))
    window.dispatchEvent(new Event(EXPENSE_PAGE_SAVED_EVENT))
  }, [isStorageReady, pageState])

  /** 클라우드: 수동 저장 전까지 '저장 필요' — 자동 클라우드 동기화는 하지 않음(입력 중 덮어쓰기 방지) */
  useEffect(() => {
    if (!isStorageReady || mode !== 'cloud') {
      return
    }
    if (JSON.stringify(pageState) !== lastCloudSyncedJsonRef.current) {
      markDocumentDirty()
    } else {
      markDocumentSaved()
    }
  }, [pageState, isStorageReady, mode, markDocumentDirty, markDocumentSaved])

  const commitExpenseStateToCloud = useCallback(
    async (state: ExpensePageState) => {
      if (mode !== 'cloud' || !activeCompanyId) {
        return
      }
      markDocumentSaving()
      try {
        await saveCompanyDocument(activeCompanyId, COMPANY_DOCUMENT_KEYS.expensePage, state, user?.id)
        syncLastCloudRefFromState(state)
        markDocumentSaved()
      } catch (error) {
        console.error('지출표 클라우드 저장에 실패했습니다.', error)
        markDocumentError()
        throw error
      }
    },
    [activeCompanyId, mode, markDocumentError, markDocumentSaved, markDocumentSaving, syncLastCloudRefFromState, user?.id],
  )

  const handleSaveToCloud = useCallback(async () => {
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    try {
      await commitExpenseStateToCloud(pageState)
      setStatusMessage('클라우드에 저장했습니다.')
    } catch {
      setStatusMessage('클라우드 저장에 실패했습니다.')
    }
  }, [activeCompanyId, mode, pageState, commitExpenseStateToCloud])

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    let cancelled = false
    let inFlight = false
    let lastJson = ''

    const poll = async () => {
      if (cancelled || inFlight) {
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      inFlight = true
      try {
        const remote = await loadCompanyDocument<ExpensePageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.expensePage,
        )
        if (cancelled || !remote) {
          return
        }
        const normalized = normalizeExpensePageState(remote)
        const nextJson = JSON.stringify(normalized)
        if (nextJson === lastJson) {
          return
        }
        if (JSON.stringify(pageStateRef.current) !== lastCloudSyncedJsonRef.current) {
          return
        }
        lastJson = nextJson
        syncLastCloudRefFromState(normalized)
        setPageState(normalized)
      } catch {
        /* retry next cycle */
      } finally {
        inFlight = false
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), 8_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [mode, activeCompanyId])

  const monthOptions = useMemo(() => {
    const months = new Set<string>([currentMonth, pageState.activeMonth])
    pageState.records.forEach((record) => {
      if (record.expenseDate) {
        months.add(record.expenseDate.slice(0, 7))
      }
    })
    return Array.from(months).sort((a, b) => b.localeCompare(a))
  }, [pageState.activeMonth, pageState.records])

  const monthRecords = useMemo(
    () => pageState.records.filter((record) => record.expenseDate.startsWith(pageState.activeMonth)),
    [pageState.activeMonth, pageState.records],
  )

  const availableCategoryOptions = useMemo(() => {
    const categories = new Set<string>(EXPENSE_CATEGORY_OPTIONS)
    pageState.records.forEach((record) => {
      if (record.category.trim()) {
        categories.add(record.category.trim())
      }
    })
    return Array.from(categories).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [pageState.records])

  const visibleExpenseColumns = useMemo(
    () => mergeVisibleExpenseColumns(pageState.tableColumns),
    [pageState.tableColumns],
  )

  const filteredRecords = useMemo(() => {
    const normalizedSearch = vendorSearch.trim().toLowerCase()
    return monthRecords.filter((record) => {
      if (record.id === pinnedRecordId) {
        return true
      }
      if (categoryFilter !== '전체' && record.category !== categoryFilter) {
        return false
      }
      if (paymentStatusFilter !== '전체' && record.paymentStatus !== paymentStatusFilter) {
        return false
      }
      if (showUnpaidOnly && record.paymentStatus !== '미지급') {
        return false
      }
      if (
        normalizedSearch &&
        !`${record.vendorName} ${record.detail} ${record.memo} ${record.purpose ?? ''}`
          .toLowerCase()
          .includes(normalizedSearch)
      ) {
        return false
      }
      return true
    })
  }, [
    categoryFilter,
    monthRecords,
    paymentStatusFilter,
    pinnedRecordId,
    showUnpaidOnly,
    vendorSearch,
  ])

  const sortedFilteredRecords = useMemo(
    () => sortExpenseFilteredRecords(filteredRecords, visibleExpenseColumns, expenseListSort),
    [filteredRecords, visibleExpenseColumns, expenseListSort],
  )

  const toggleExpenseListSort = useCallback((columnId: string) => {
    setExpenseListSort((prev) =>
      prev?.columnId === columnId
        ? { columnId, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId, direction: 'asc' },
    )
  }, [])

  const hasActiveFilters = useMemo(
    () =>
      categoryFilter !== '전체' ||
      paymentStatusFilter !== '전체' ||
      showUnpaidOnly ||
      vendorSearch.trim().length > 0,
    [categoryFilter, paymentStatusFilter, showUnpaidOnly, vendorSearch],
  )

  const recordsForAggregates = useMemo(
    () => (hasActiveFilters ? filteredRecords : monthRecords),
    [filteredRecords, hasActiveFilters, monthRecords],
  )

  const totalExpenses = useMemo(
    () => sumValues(recordsForAggregates.map((record) => record.totalAmount)),
    [recordsForAggregates],
  )
  const unpaidTotal = useMemo(
    () =>
      sumValues(
        recordsForAggregates
          .filter((record) => record.paymentStatus === '미지급')
          .map((record) => record.totalAmount),
      ),
    [recordsForAggregates],
  )
  const unpaidCount = useMemo(
    () => recordsForAggregates.filter((record) => record.paymentStatus === '미지급').length,
    [recordsForAggregates],
  )
  const categorySummaryRows = useMemo(
    () => summarizeExpenseByCategory(recordsForAggregates, availableCategoryOptions),
    [availableCategoryOptions, recordsForAggregates],
  )

  const paymentMethodSummaryRows = useMemo(
    () => summarizeExpenseByPaymentMethod(recordsForAggregates),
    [recordsForAggregates],
  )

  const summaryTablesEmptyMessage = useMemo(() => {
    if (monthRecords.length === 0) {
      return '이번 달에 등록된 지출이 없습니다.'
    }
    if (hasActiveFilters && recordsForAggregates.length === 0) {
      return '필터에 맞는 지출이 없어 집계할 수 없습니다.'
    }
    return '집계할 지출이 없습니다.'
  }, [hasActiveFilters, monthRecords.length, recordsForAggregates.length])

  const updateRecord = <Key extends keyof ExpenseRecord>(
    recordId: string,
    field: Key,
    nextValue: ExpenseRecord[Key],
  ) => {
    setPinnedRecordId(recordId)
    setPageState((current) => ({
      ...current,
      records: current.records.map((record) =>
        record.id === recordId
          ? {
              ...record,
              [field]: nextValue,
            }
          : record,
      ),
    }))
  }

  const handleRowInputChange =
    <Key extends keyof ExpenseRecord>(recordId: string, field: Key) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const target = event.target
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        updateRecord(recordId, field, target.checked as ExpenseRecord[Key])
        return
      }

      if (field === 'totalAmount') {
        updateRecord(recordId, field, Math.max(0, parseNumber(target.value)) as ExpenseRecord[Key])
        return
      }

      if (field === 'expenseDate') {
        updateExpenseDateAndKeepVisible(recordId, String(target.value ?? ''))
        return
      }

      updateRecord(recordId, field, target.value as ExpenseRecord[Key])
    }

  const handleAddExpenseRow = (source: 'button' | 'shortcut' = 'button') => {
    const nextRecord = createRecordForMonth(pageState.activeMonth)
    setPinnedRecordId(nextRecord.id)
    setPageState((current) => ({
      ...current,
      records: [nextRecord, ...current.records],
    }))
    setStatusMessage(
      source === 'shortcut' ? '새 지출 행을 추가했습니다. (Ctrl+Enter)' : '선택 월에 새 지출 행을 추가했습니다.',
    )
  }

  const handleDeleteExpenseRow = (recordId: string) => {
    const target = pageState.records.find((record) => record.id === recordId)
    const label = target?.vendorName?.trim() || target?.detail?.trim() || '선택한 행'
    if (!window.confirm(`${label} 행을 삭제할까요?`)) {
      return
    }
    if (pinnedRecordId === recordId) {
      setPinnedRecordId('')
    }
    const nextState: ExpensePageState = {
      ...pageState,
      records: pageState.records.filter((record) => record.id !== recordId),
    }
    setPageState(nextState)
    if (mode === 'cloud' && activeCompanyId) {
      void (async () => {
        try {
          await commitExpenseStateToCloud(nextState)
          setStatusMessage('해당 지출을 삭제하고 클라우드에 반영했습니다.')
        } catch {
          setStatusMessage('이 브라우저에서만 삭제되었고, 클라우드 동기화에 실패했습니다. 나중에 다시 저장해 주세요.')
        }
      })()
    }
  }

  const getDateDraftKey = (recordId: string, field: 'expenseDate' | 'dueDate') => `${recordId}:${field}`

  const focusVendorInput = (recordId: string) => {
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-vendor-input="${recordId}"]`)
      input?.focus()
      input?.select()
    }, 0)
  }

  const commitDateDraft = (recordId: string, field: 'expenseDate' | 'dueDate') => {
    const key = getDateDraftKey(recordId, field)
    const draft = (dateDrafts[key] ?? '').trim()
    if (!draft) {
      return
    }
    const parsed =
      /^\d{4}$/.test(draft)
        ? parseQuickMmDd(draft, Number(pageState.activeMonth.slice(0, 4)) || new Date().getFullYear())
        : parseSpreadsheetDate(draft)
    if (!parsed) {
      return
    }
    if (field === 'expenseDate') {
      updateExpenseDateAndKeepVisible(recordId, parsed)
    } else {
      updateRecord(recordId, field, parsed as ExpenseRecord[typeof field])
    }
    setDateDrafts((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const updateExpenseDateAndKeepVisible = (recordId: string, nextExpenseDate: string) => {
    setPinnedRecordId(recordId)
    setPageState((current) => {
      const nextMonth = /^\d{4}-\d{2}-\d{2}$/.test(nextExpenseDate)
        ? nextExpenseDate.slice(0, 7)
        : current.activeMonth
      return {
        ...current,
        activeMonth: nextMonth,
        records: current.records.map((record) => {
          if (record.id !== recordId) {
            return record
          }
          const shouldSyncDueDate =
            !record.dueDate || record.dueDate === record.expenseDate || record.dueDate < record.expenseDate
          return {
            ...record,
            expenseDate: nextExpenseDate,
            dueDate: shouldSyncDueDate ? nextExpenseDate : record.dueDate,
          }
        }),
      }
    })
  }

  const handleQuickDateKeyDown =
    (recordId: string, field: 'expenseDate' | 'dueDate') => (event: KeyboardEvent<HTMLInputElement>) => {
      const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { isComposing?: boolean }
      if (nativeEvent.isComposing || event.keyCode === 229) {
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        handleAddExpenseRow('shortcut')
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return
      }

      const bufferKey = `${recordId}:${field}`
      if (event.key === 'Enter') {
        event.preventDefault()
        commitDateDraft(recordId, field)
        if (field === 'expenseDate') {
          setPageState((current) => ({
            ...current,
            records: current.records.map((record) =>
              record.id === recordId
                ? {
                    ...record,
                    dueDate: record.expenseDate,
                  }
                : record,
            ),
          }))
        }
        focusVendorInput(recordId)
        return
      }
      if (/^\d$/.test(event.key)) {
        event.preventDefault()
        const nextDigits = `${quickDateDigitsRef.current[bufferKey] ?? ''}${event.key}`.slice(-4)
        quickDateDigitsRef.current[bufferKey] = nextDigits
        if (nextDigits.length === 4) {
          const fallbackYear = Number(pageState.activeMonth.slice(0, 4)) || new Date().getFullYear()
          const parsed = parseQuickMmDd(nextDigits, fallbackYear)
          if (parsed) {
            if (field === 'expenseDate') {
              updateExpenseDateAndKeepVisible(recordId, parsed)
            } else {
              updateRecord(recordId, field, parsed as ExpenseRecord[typeof field])
            }
          }
          quickDateDigitsRef.current[bufferKey] = ''
        }
        return
      }

      if (event.key === 'Backspace') {
        quickDateDigitsRef.current[bufferKey] = ''
      }
    }

  const handleExpenseGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { isComposing?: boolean }
    if (nativeEvent.isComposing || event.keyCode === 229) {
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      handleAddExpenseRow('shortcut')
    }
  }

  const handleImportWorkbook = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const { records: importedRecords, layout, warnings } = parseExpenseWorkbook(workbook)

      if (importedRecords.length === 0) {
        setStatusMessage('불러온 지출 데이터가 없습니다.')
        return
      }

      setPageState((current) => ({
        ...current,
        activeMonth: importedRecords[0].expenseDate.slice(0, 7),
        records: [...importedRecords, ...current.records],
        tableColumns: layout,
      }))
      const warningText = warnings.length > 0 ? ` (참고: ${warnings.join(' / ')})` : ''
      setStatusMessage(
        `${importedRecords.length}건 추가했습니다. 표 열을 시트 원본(${layout.length}열) 그대로 맞췄습니다.${warningText}`,
      )
    } catch (error) {
      console.error('지출 엑셀을 읽지 못했습니다.', error)
      setStatusMessage(error instanceof Error ? error.message : '지출 엑셀 업로드에 실패했습니다.')
    } finally {
      event.target.value = ''
    }
  }

  const handleExportWorkbook = async () => {
    try {
      const exportColumns = mergeVisibleExpenseColumns(pageState.tableColumns)
      const headerCells = exportColumns.map((col) => col.label)

      const detailRows: Array<Array<string | number>> = [
        headerCells,
        ...monthRecords.map((record) => buildExpenseExportRow(record, exportColumns)),
      ]

      const categoryExportRows = summarizeExpenseByCategory(monthRecords, availableCategoryOptions)
      const paymentExportRows = summarizeExpenseByPaymentMethod(monthRecords)

      const categoryRows: Array<Array<string | number>> = [
        ['카테고리', '건수', '총액'],
        ...categoryExportRows.map((row) => [row.category, row.count, row.totalAmount]),
      ]

      const paymentRows: Array<Array<string | number>> = [
        ['지급수단', '총액'],
        ...paymentExportRows.map((row) => [row.paymentMethod, row.totalAmount]),
      ]

      await exportStyledExpenseWorkbook({
        downloadFileName: `지출표_${pageState.activeMonth}.xlsx`,
        monthLabel: formatMonthLabel(pageState.activeMonth),
        detailRows,
        categoryRows,
        paymentRows,
      })
      setStatusMessage(`${formatMonthLabel(pageState.activeMonth)} 지출표를 저장했습니다.`)
    } catch (error) {
      console.error(error)
      setStatusMessage(error instanceof Error ? error.message : '지출 엑셀 저장에 실패했습니다.')
    }
  }

  const handleResetExpenseColumnLayout = () => {
    if (!window.confirm('표 열을 기본(전체 열)로 되돌릴까요? 현재 엑셀 양식 맞춤 보기는 해제됩니다.')) {
      return
    }
    setPageState((current) => {
      const { tableColumns: _removedLayout, ...rest } = current
      return rest
    })
    setStatusMessage('표 열을 기본(전체 열)로 되돌렸습니다.')
  }

  const updateExtraCell = (recordId: string, columnId: string, value: string) => {
    setPinnedRecordId(recordId)
    setPageState((current) => ({
      ...current,
      records: current.records.map((record) =>
        record.id === recordId
          ? {
              ...record,
              extraValues: {
                ...(record.extraValues ?? {}),
                [columnId]: value,
              },
            }
          : record,
      ),
    }))
  }

  const renderExpenseColumnCell = (record: ExpenseRecord, column: ExpenseTableColumn): ReactNode => {
    if (column.kind === 'extra') {
      return (
        <input
          className="expense-cell-input"
          value={record.extraValues?.[column.id] ?? ''}
          onChange={(event) => updateExtraCell(record.id, column.id, event.target.value)}
        />
      )
    }
    const columnKey = column.mappedKey
    if (!columnKey) {
      return null
    }
    const { supplyAmount, taxAmount } = splitAmount(record.totalAmount, record.taxType)
    switch (columnKey) {
      case 'expenseDate':
        return (
          <input
            type="text"
            className="expense-cell-input"
            inputMode="numeric"
            placeholder="0407 또는 2026.04.07"
            value={dateDrafts[getDateDraftKey(record.id, 'expenseDate')] ?? formatDateLabel(record.expenseDate)}
            onChange={(event) =>
              setDateDrafts((current) => ({
                ...current,
                [getDateDraftKey(record.id, 'expenseDate')]: event.target.value,
              }))
            }
            onKeyDown={handleQuickDateKeyDown(record.id, 'expenseDate')}
            onBlur={() => {
              commitDateDraft(record.id, 'expenseDate')
              quickDateDigitsRef.current[`${record.id}:expenseDate`] = ''
            }}
          />
        )
      case 'dueDate':
        return (
          <input
            type="text"
            className="expense-cell-input"
            inputMode="numeric"
            placeholder="0407 또는 2026.04.07"
            value={dateDrafts[getDateDraftKey(record.id, 'dueDate')] ?? formatDateLabel(record.dueDate)}
            onChange={(event) =>
              setDateDrafts((current) => ({
                ...current,
                [getDateDraftKey(record.id, 'dueDate')]: event.target.value,
              }))
            }
            onKeyDown={handleQuickDateKeyDown(record.id, 'dueDate')}
            onBlur={() => {
              commitDateDraft(record.id, 'dueDate')
              quickDateDigitsRef.current[`${record.id}:dueDate`] = ''
            }}
          />
        )
      case 'vendorName':
        return (
          <input
            className="expense-cell-input"
            data-vendor-input={record.id}
            value={record.vendorName}
            onChange={handleRowInputChange(record.id, 'vendorName')}
          />
        )
      case 'category':
        return (
          <select className="expense-cell-input" value={record.category} onChange={handleRowInputChange(record.id, 'category')}>
            {availableCategoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        )
      case 'purpose':
        return (
          <input
            className="expense-cell-input"
            placeholder="예: 기타경비, 운영경비"
            value={record.purpose ?? ''}
            onChange={handleRowInputChange(record.id, 'purpose')}
          />
        )
      case 'detail':
        return <input className="expense-cell-input" value={record.detail} onChange={handleRowInputChange(record.id, 'detail')} />
      case 'taxType':
        return (
          <select className="expense-cell-input" value={record.taxType} onChange={handleRowInputChange(record.id, 'taxType')}>
            {TAX_TYPE_OPTIONS.map((taxType) => (
              <option key={taxType} value={taxType}>
                {taxType}
              </option>
            ))}
          </select>
        )
      case 'totalAmount':
        return (
          <input
            type="number"
            min="0"
            className="expense-cell-input"
            value={record.totalAmount === 0 ? '' : record.totalAmount}
            onChange={handleRowInputChange(record.id, 'totalAmount')}
            placeholder="금액 입력"
          />
        )
      case 'supplyAmount':
        return formatMoney(supplyAmount)
      case 'taxAmount':
        return formatMoney(taxAmount)
      case 'paymentMethod':
        return (
          <select
            className="expense-cell-input"
            value={record.paymentMethod}
            onChange={handleRowInputChange(record.id, 'paymentMethod')}
          >
            {PAYMENT_METHOD_OPTIONS.map((paymentMethod) => (
              <option key={paymentMethod} value={paymentMethod}>
                {paymentMethod}
              </option>
            ))}
          </select>
        )
      case 'paymentStatus':
        return (
          <select
            className="expense-cell-input"
            value={record.paymentStatus}
            onChange={handleRowInputChange(record.id, 'paymentStatus')}
          >
            {PAYMENT_STATUS_OPTIONS.map((paymentStatus) => (
              <option key={paymentStatus} value={paymentStatus}>
                {paymentStatus}
              </option>
            ))}
          </select>
        )
      case 'isRecurring':
        return (
          <input
            type="checkbox"
            className="expense-checkbox"
            checked={record.isRecurring}
            onChange={handleRowInputChange(record.id, 'isRecurring')}
          />
        )
      case 'hasReceipt':
        return (
          <input
            className="expense-cell-input"
            value={record.hasReceipt}
            onChange={handleRowInputChange(record.id, 'hasReceipt')}
          />
        )
      case 'memo':
        return <input className="expense-cell-input" value={record.memo} onChange={handleRowInputChange(record.id, 'memo')} />
      default:
        return null
    }
  }

  const expenseTableAmountKeys: ExpenseColumnKey[] = ['totalAmount', 'supplyAmount', 'taxAmount']
  const expenseFooterFirstAmountIndex = visibleExpenseColumns.findIndex(
    (col) => col.kind === 'mapped' && !!col.mappedKey && expenseTableAmountKeys.includes(col.mappedKey),
  )
  const footerSumTotal = sumValues(filteredRecords.map((r) => r.totalAmount))
  const footerSumSupply = sumValues(
    filteredRecords.map((r) => splitAmount(r.totalAmount, r.taxType).supplyAmount),
  )
  const footerSumTax = sumValues(filteredRecords.map((r) => splitAmount(r.totalAmount, r.taxType).taxAmount))

  return (
    <div className="meeting-layout">
      <section className="panel expense-work-section">
        <div className="expense-page-snapshot-metrics no-print" aria-label="이번 달 요약">
          <div className="metric-card">
            <span>{hasActiveFilters ? '표시 중 총액' : `${formatMonthLabel(pageState.activeMonth)} 총 지출`}</span>
            <strong>{formatMoney(totalExpenses)}</strong>
          </div>
          <div className="metric-card">
            <span>{hasActiveFilters ? '표시 중 미지급' : '미지급 합계'}</span>
            <strong>{formatMoney(unpaidTotal)}</strong>
            {unpaidCount > 0 ? <em className="expense-unpaid-badge">{unpaidCount}건</em> : null}
          </div>
        </div>
        <div className="panel-header">
          <div>
            <h2>사업 지출 입력</h2>
            <p className="muted">
              지출 엑셀을 올리면 시트에 있는 열 순서·제목에 맞춰 아래 목록 칸이 바뀝니다. 「표 열 기본으로」로 전체
              열을 다시 켤 수 있습니다. 엑셀 또는 아래 목록에서 「용도」에 기타경비·운영경비를 적거나, 카테고리를 해당
              값으로 선택하면 해당 월의 월 마감 회의 「비용 현황」에도 나누어 자동 반영됩니다.
            </p>
          </div>
        </div>

        <div className="inventory-actions">
          <label className="upload-button secondary expense-toolbar-btn">
            지출 엑셀 업로드
            <input type="file" accept=".xlsx,.xls" onChange={handleImportWorkbook} />
          </label>
          <button type="button" className="ghost-button expense-toolbar-btn" onClick={handleExportWorkbook}>
            현재 월 엑셀 저장
          </button>
          {(pageState.tableColumns?.length ?? 0) > 0 ? (
            <button type="button" className="ghost-button expense-toolbar-btn" onClick={handleResetExpenseColumnLayout}>
              표 열 기본으로
            </button>
          ) : null}
        </div>

        <div className="page-status-bar">
          <p className="page-status-message" role="status" aria-live="polite">
            {statusMessage}
          </p>
          <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
        </div>

        <div className="meeting-config-row expense-filter-row">
          <label className="meeting-inline-field expense-filter-field expense-filter-field--month">
            기준 월
            <select
              className="expense-input"
              value={pageState.activeMonth}
              onChange={(event) =>
                setPageState((current) => ({
                  ...current,
                  activeMonth: event.target.value,
                }))
              }
            >
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {formatMonthLabel(month)}
                </option>
              ))}
            </select>
          </label>
          <label className="meeting-inline-field expense-filter-field expense-filter-field--category">
            카테고리
            <select className="expense-input" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="전체">전체</option>
              {availableCategoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="meeting-inline-field expense-filter-field expense-filter-field--status">
            지급 상태
            <select
              className="expense-input"
              value={paymentStatusFilter}
              onChange={(event) => setPaymentStatusFilter(event.target.value)}
            >
              <option value="전체">전체</option>
              {PAYMENT_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="meeting-inline-field expense-filter-field expense-filter-field--search">
            거래처 검색
            <input
              className="expense-input"
              value={vendorSearch}
              onChange={(event) => setVendorSearch(event.target.value)}
              placeholder="거래처, 항목, 메모 검색"
            />
          </label>
        </div>

        <div className="meeting-grid expense-work-grid">
        <div className="meeting-card">
          <div className="meeting-card-header">
            <div className="expense-list-heading">
              <h3>{formatMonthLabel(pageState.activeMonth)} 지출 목록</h3>
            </div>
            <div className="expense-list-header-actions">
              <span className="inventory-filter-summary">
                {filteredRecords.length} / {monthRecords.length}건 표시
              </span>
              <button
                type="button"
                className="ghost-button expense-add-row-mini"
                onClick={() => handleAddExpenseRow('button')}
                title="새 지출 행 추가"
                aria-label="새 지출 행 추가"
              >
                +
              </button>
              {mode === 'cloud' && activeCompanyId ? (
                <button
                  type="button"
                  className={
                    saveState === 'saving'
                      ? 'ghost-button expense-add-row-mini expense-cloud-save-mini expense-cloud-save-mini--synced'
                      : saveState === 'saved'
                        ? 'ghost-button expense-add-row-mini expense-cloud-save-mini expense-cloud-save-mini--synced'
                        : 'ghost-button expense-add-row-mini expense-cloud-save-mini expense-cloud-save-mini--pending'
                  }
                  onClick={() => void handleSaveToCloud()}
                  disabled={saveState === 'saving'}
                  title={
                    saveState === 'saving'
                      ? '클라우드 저장 중'
                      : saveState === 'saved'
                        ? '클라우드에 반영됨 (수정 시 다시 누르세요)'
                        : '클라우드에 저장 (지출 목록 반영)'
                  }
                  aria-label="클라우드에 저장"
                >
                  {saveState === 'saving' ? '…' : '☁'}
                </button>
              ) : null}
              <button
                type="button"
                className={
                  showUnpaidOnly
                    ? 'inventory-toggle-button active expense-unpaid-mini'
                    : 'inventory-toggle-button expense-unpaid-mini'
                }
                onClick={() => setShowUnpaidOnly((current) => !current)}
                title={showUnpaidOnly ? '미지급만 보기 해제' : '미지급만 보기'}
              >
                미지급
                {unpaidCount > 0 ? <span className="expense-unpaid-mini-badge">{unpaidCount}</span> : null}
              </button>
            </div>
          </div>
          <div className="table-wrapper">
            <table className="meeting-table expense-table" onKeyDown={handleExpenseGridKeyDown}>
              <thead>
                <tr>
                  {visibleExpenseColumns.map((column) => {
                    const active = expenseListSort?.columnId === column.id
                    const dir = active ? expenseListSort.direction : null
                    return (
                      <th key={column.id}>
                        <button
                          type="button"
                          className={`expense-th-sort-btn${active ? ' expense-th-sort-btn--active' : ''}`}
                          onClick={() => toggleExpenseListSort(column.id)}
                          aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          title={
                            active
                              ? dir === 'asc'
                                ? '오름차순 — 클릭하면 내림차순'
                                : '내림차순 — 클릭하면 오름차순'
                              : '클릭하면 이 열 기준 오름차순 정렬'
                          }
                        >
                          <span>{column.label}</span>
                          <span className="expense-th-sort-indicator">
                            {!active ? ' ⇅' : dir === 'asc' ? ' ▲' : ' ▼'}
                          </span>
                        </button>
                      </th>
                    )
                  })}
                  <th>
                    <button
                      type="button"
                      className={`expense-th-sort-btn expense-th-sort-btn--narrow${
                        expenseListSort?.columnId === EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID ? ' expense-th-sort-btn--active' : ''
                      }`}
                      onClick={() => toggleExpenseListSort(EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID)}
                      aria-sort={
                        expenseListSort?.columnId === EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID
                          ? expenseListSort.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                      title="지급완료 여부 정렬 · 클릭 시 오름/내림 전환"
                    >
                      지급
                      <span className="expense-th-sort-indicator">
                        {expenseListSort?.columnId !== EXPENSE_LIST_SORT_PAYMENT_COLUMN_ID
                          ? ' ⇅'
                          : expenseListSort.direction === 'asc'
                            ? ' ▲'
                            : ' ▼'}
                      </span>
                    </button>
                  </th>
                  <th>삭제</th>
                </tr>
              </thead>
              <tbody>
                {sortedFilteredRecords.map((record) => (
                  <tr key={record.id}>
                    {visibleExpenseColumns.map((column) => (
                      <td key={column.id}>{renderExpenseColumnCell(record, column)}</td>
                    ))}
                    <td>
                      <input
                        type="checkbox"
                        className="expense-checkbox"
                        checked={record.paymentStatus === '지급완료'}
                        title="체크=지급완료, 해제=미지급"
                        onChange={(event) =>
                          updateRecord(record.id, 'paymentStatus', event.target.checked ? '지급완료' : '미지급')
                        }
                      />
                    </td>
                    <td>
                      <button type="button" className="ghost-button" onClick={() => handleDeleteExpenseRow(record.id)} title="행 삭제">
                        -
                      </button>
                    </td>
                  </tr>
                ))}
                {sortedFilteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={visibleExpenseColumns.length + 2} className="inventory-empty-cell">
                      현재 조건에 맞는 지출 내역이 없습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr>
                  {expenseFooterFirstAmountIndex === -1 ? (
                    <td colSpan={visibleExpenseColumns.length + 2} className="muted">
                      {hasActiveFilters ? '표시 합계' : '합계'}
                    </td>
                  ) : expenseFooterFirstAmountIndex === 0 ? (
                    <>
                      {visibleExpenseColumns.map((column) => (
                        <td key={`foot-${column.id}`}>
                          {column.kind === 'mapped' && column.mappedKey === 'totalAmount' ? (
                            <>
                              <div className="muted tiny">{hasActiveFilters ? '표시 합계' : '합계'}</div>
                              {formatMoney(footerSumTotal)}
                            </>
                          ) : column.kind === 'mapped' && column.mappedKey === 'supplyAmount' ? (
                            formatMoney(footerSumSupply)
                          ) : column.kind === 'mapped' && column.mappedKey === 'taxAmount' ? (
                            formatMoney(footerSumTax)
                          ) : (
                            ''
                          )}
                        </td>
                      ))}
                      <td />
                      <td />
                    </>
                  ) : (
                    <>
                      <td colSpan={expenseFooterFirstAmountIndex}>
                        {hasActiveFilters ? '표시 합계' : '합계'}
                      </td>
                      {visibleExpenseColumns.slice(expenseFooterFirstAmountIndex).map((column) => (
                        <td key={`foot-${column.id}`}>
                          {column.kind === 'mapped' && column.mappedKey === 'totalAmount'
                            ? formatMoney(footerSumTotal)
                            : column.kind === 'mapped' && column.mappedKey === 'supplyAmount'
                              ? formatMoney(footerSumSupply)
                              : column.kind === 'mapped' && column.mappedKey === 'taxAmount'
                                ? formatMoney(footerSumTax)
                                : ''}
                        </td>
                      ))}
                      <td />
                      <td />
                    </>
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="meeting-grid meeting-grid-2 expense-summary-grid">
          <div className="meeting-card">
            <h3>카테고리별 요약</h3>
            <div className="table-wrapper">
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>카테고리</th>
                    <th>건수</th>
                    <th>총액</th>
                  </tr>
                </thead>
                <tbody>
                  {categorySummaryRows.map((row) => (
                    <tr key={row.category}>
                      <td>{row.category}</td>
                      <td>{row.count}건</td>
                      <td>{formatMoney(row.totalAmount)}</td>
                    </tr>
                  ))}
                  {categorySummaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="inventory-empty-cell">
                        {summaryTablesEmptyMessage}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="meeting-card">
            <h3>지급수단별 요약</h3>
            <div className="table-wrapper">
              <table className="meeting-table meeting-table-compact">
                <thead>
                  <tr>
                    <th>지급수단</th>
                    <th>총액</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentMethodSummaryRows.map((row) => (
                    <tr key={row.paymentMethod}>
                      <td>{row.paymentMethod}</td>
                      <td>{formatMoney(row.totalAmount)}</td>
                    </tr>
                  ))}
                  {paymentMethodSummaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="inventory-empty-cell">
                        {summaryTablesEmptyMessage}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </div>
      </section>
    </div>
  )
}

export default ExpensePage
