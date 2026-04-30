import type { FocusEvent, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
  normalizeExpensePageState,
  readExpensePageStateFromStorage,
  resolveExpenseCategoryForMeetingBucket,
  type ExpensePageState,
  type ExpenseRecord,
} from './ExpensePage'
import {
  getGreenBeanOrderMonthAggregate,
  GREEN_BEAN_ORDER_SAVED_EVENT,
  GREEN_BEAN_ORDER_STORAGE_KEY,
} from './GreenBeanOrderPage'
import {
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_STATUS_STORAGE_KEY,
  inventoryPageScopedKey,
} from './InventoryStatusPage'
import { BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT } from './beanStatementManualMappings'
import { BLEND_WON_OVERRIDES_SAVED_EVENT } from './beanBlendWonOverrides'
import {
  computeBeanSalesMaterialCostForYm,
  filterStatementsByYmDelivery,
  type BeanSalesMaterialMeetingLine,
  type BeanSalesMaterialMeetingResult,
  type BeanStatementDeliveryRecord,
} from './beanSalesMeetingMaterialCost'
import { exportStyledMeetingMonthExcel, sanitizeExcelFileBaseName } from './monthlyMeetingExcelStyledExport'
import {
  dayIndexForReferenceDate,
  normalizeInventoryStatusState,
  type InventoryStatusState,
} from './inventoryStatusUtils'
import {
  monthlyMeetingData,
  type MeetingMonthlyRow,
  type MeetingProductionRow,
  type MeetingStoreSalesRow,
  type MeetingValueRow,
  type MonthlyMeetingData,
} from './monthlyMeetingData'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'
import { canonicalBlendDisplayName } from './inventoryBlendRecipes'

/** 출고 표에서 생두 열과 구분하기 위한 기본 수동 품목(더치·디저트 등) 헤더 */
const MEETING_OUTBOUND_MANUAL_COLUMN_LABELS = new Set(
  monthlyMeetingData.productionColumns.slice(1).map((label) => label.trim()),
)
const normalizeMeetingBeanName = (rawName: string) => {
  const canonical = canonicalBlendDisplayName(rawName).trim()
  const withoutPrefix = canonical.replace(/^\d+(?:\.\s*|\s+)/, '').trim()
  const collapsed = withoutPrefix.replace(/\s+/g, ' ')
  if (/^ache\s+gayo\s+mountain$/i.test(collapsed)) {
    return 'Aceh Gayo Mountain'
  }
  return collapsed
}

const meetingBeanMergeKey = (rawName: string) =>
  normalizeMeetingBeanName(rawName)
    .toLowerCase()
    .replace(/[\s\-_./(),[\]{}]+/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')

const isMeetingOutboundExcludedBeanName = (name: string) => {
  const normalized = normalizeMeetingBeanName(name)
  return normalized.length === 0
}

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
const MONTHLY_MEETING_LAST_SYNCED_JSON_KEY = 'monthly-meeting-last-synced-json-v1'
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
/** `label`은 사용자가 바꿀 수 있음 — 집계는 `role` / 구(레거시) `label`로 식별 */
const isSalesTotalRow = (r: Pick<MeetingValueRow, 'label' | 'role'>) =>
  r.role === 'salesTotal' || r.label === '⑧총매출'
const isSalesNetRow = (r: Pick<MeetingValueRow, 'label' | 'role'>) =>
  r.role === 'salesNet' || r.label === '⑨순이익'
const isSalesRoastingTotalRow = (r: Pick<MeetingValueRow, 'label' | 'role'>) =>
  r.role === 'salesRoastingTotal' || r.label === '로스팅실 매출 총 합계'
const isComputedSalesRow = (r: Pick<MeetingValueRow, 'label' | 'role'>) =>
  isSalesTotalRow(r) || isSalesNetRow(r) || isSalesRoastingTotalRow(r)

const isCostGrandRow = (r: Pick<MeetingValueRow, 'label' | 'role'>) =>
  r.role === 'costsGrand' || r.label === '⑨비용계'

const isRoastSubtotalRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  r.roastRole === 'subtotal' || r.label === '합 계' || r.label === '합계'
const isRoastNetRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  r.roastRole === 'net' || r.label === '순이익'
const isRoastBeanCostRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  r.roastRole === 'beanCost' || r.label === '생두비용'
const isRoastFixedBlockRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  isRoastSubtotalRow(r) || isRoastNetRow(r) || isRoastBeanCostRow(r)
const isRoastClientRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  r.roastRole === 'client' || (!r.roastRole && !isRoastFixedBlockRow(r))
/** 집계·순익: 금액 셀 읽기전용(배지와 동일) */
const isRoastReadonlyAmountRow = (r: Pick<MeetingMonthlyRow, 'label' | 'roastRole'>) =>
  isRoastSubtotalRow(r) || isRoastNetRow(r)

const costRowKey = (r: Pick<MeetingValueRow, 'label' | 'expenseKey' | 'role'>) => r.expenseKey ?? r.label

const pickCostLineAmount = (rows: MeetingValueRow[], key: string) =>
  rows.find((row) => costRowKey(row) === key)?.amount ?? 0

const meetingValueRowsSignature = (rows: MeetingValueRow[]) =>
  JSON.stringify(
    rows.map((r) => ({ label: r.label, amount: r.amount, role: r.role, expenseKey: r.expenseKey })),
  )

/** ①…⑳ — 인덱스는 화면/엑셀에만 쓰고, 저장된 `label`에는 넣지 않습니다. */
const CIRCLED_1_20 = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'] as const

const circledOrPlain = (n: number): string => {
  if (n >= 1 && n < CIRCLED_1_20.length) {
    return CIRCLED_1_20[n]!
  }
  if (n > 0) {
    return `${n}.`
  }
  return '—'
}

/** 항목 입력에서 선행 ①…⑳ 또는 `1. ` 형태의 번호를 제거합니다(여러 겹이면 반복). */
const stripLeadingIndexFromLabel = (label: string): string => {
  const orig = label.trim()
  let s = orig
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false
    for (const c of CIRCLED_1_20) {
      if (c && s.startsWith(c)) {
        s = s.slice(c.length).trim()
        changed = true
        break
      }
    }
    if (changed) {
      continue
    }
    const numMatch = s.match(/^\d{1,2}[\s.)-]+/)
    if (numMatch) {
      s = s.slice(numMatch[0]!.length).trim()
      continue
    }
    break
  }
  if (!s) {
    return orig
  }
  return s
}

const isValueRowIndexSkipped = (r: MeetingValueRow, kind: 'sales' | 'costs'): boolean =>
  kind === 'sales' ? isComputedSalesRow(r) : isCostGrandRow(r)

const meetingValueRowIndexText = (rows: MeetingValueRow[], index: number, kind: 'sales' | 'costs'): string => {
  const row = rows[index]!
  if (isValueRowIndexSkipped(row, kind)) {
    return '—'
  }
  let n = 0
  for (let i = 0; i <= index; i += 1) {
    if (!isValueRowIndexSkipped(rows[i]!, kind)) {
      n += 1
    }
  }
  return circledOrPlain(n)
}

const meetingRoastRowIndexText = (rows: MonthlyMeetingData['roastingSales'], index: number): string => {
  const row = rows[index]!
  if (isRoastFixedBlockRow(row)) {
    return '—'
  }
  let n = 0
  for (let i = 0; i <= index; i += 1) {
    if (isRoastClientRow(rows[i]!)) {
      n += 1
    }
  }
  return circledOrPlain(n)
}

/** 보기 모드에서 거래처가 일부만 보일 때도 ①②③이 연속이 되도록 표시 순서 기준으로 번호를 냅니다. */
const meetingRoastDisplayIndexText = (
  display: { row: Pick<MeetingMonthlyRow, 'label' | 'roastRole'> }[],
  displayIndex: number,
): string => {
  const row = display[displayIndex]!.row
  if (!isRoastClientRow(row)) {
    return '—'
  }
  let n = 0
  for (let i = 0; i <= displayIndex; i += 1) {
    if (isRoastClientRow(display[i]!.row)) {
      n += 1
    }
  }
  return circledOrPlain(n)
}

/** 비용 현황 — 지출표와 직접 맞물리는 줄(내역 보기 제공) */
type MeetingCostsExpenseBucketKey = '②기타' | '②기타경비' | '②운영경비'

type MeetingCostDetailModalOpen =
  | { kind: 'expense'; bucket: MeetingCostsExpenseBucketKey }
  | { kind: 'beanMaterial' }

type MeetingCostDetailModalState = MeetingCostDetailModalOpen | null

const MEETING_COST_BREAKDOWN_MODAL_COPY: Record<
  MeetingCostsExpenseBucketKey,
  { caption: string; empty: string; hint: string }
> = {
  '②기타': {
    caption:
      '카테고리가 「기타경비」「운영경비」(및 운영 줄)로 잡히지 않은 거래가 「그 외 비용」(②기타)으로 집계된 내용입니다. 「원재료비」 등 월 마감에 따로 매핑되는 항목은 여기 없을 수 있습니다.',
    empty:
      '이 달에 「그 외 비용」으로 집계된 지출표 내역이 없습니다. 지출표에서 해당 월 거래·분류를 확인해 주세요.',
    hint: '지출표 카테고리·용도가 비용 현황 줄과 같은 규칙으로 반영된 목록입니다.',
  },
  '②기타경비': {
    caption: '카테고리 「기타경비」 또는 용도·규칙상 기타경비로 들어간 지출입니다.',
    empty: '이 달에 「기타경비」 줄로 집계된 지출표 내역이 없습니다.',
    hint: '이 줄 금액은 지출표에서 「기타경비」 등으로만 분류된 항목의 합과 맞춥니다.',
  },
  '②운영경비': {
    caption:
      '카테고리 「운영경비」「기타운영비」 또는 용도·규칙상 운영으로 들어간 지출입니다(기타경비 분류는 제외).',
    empty: '이 달에 「운영경비」 줄로 집계된 지출표 내역이 없습니다.',
    hint: '이 줄에는 운영·기타운영비로 분류된 지출만 포함됩니다.',
  },
}

const MEETING_BEAN_MATERIAL_MODAL_COPY = {
  caption:
    '해당 월 거래명세 납품일이 속한 로스팅 거래를 입출고 생두와 맞춘 뒤, 생두 주문 일자별 기록의 최근 1kg당 단가(원두별 매출 분석과 동일)로 추정한 생두 원가입니다.',
  empty:
    '이 달 납품 건이 없거나, 입출고에 없는 품목만 있으면 여기에 잡히지 않을 수 있습니다. 거래명세·입출고·생두 주문을 확인해 주세요.',
  hint: '단가가 없는 품목은 추정 원가 0으로 표시될 수 있습니다. 생두 주문 스냅샷·원/kg 직접 입력을 맞춰 주세요.',
}

/** 1. 요약 — 매출·비용·재료·기타 4칸(동일 UI, 집계 행·점유비 열 유무만 다름) */
const MeetingSummaryValueCard = (props: {
  tableId: string
  title: string
  newRowButtonLabel: string
  rows: MeetingValueRow[]
  showShareColumn: boolean
  editMode: boolean
  indexKind: 'sales' | 'costs'
  isAmountReadonly: (r: MeetingValueRow) => boolean
  /** 생략 시 `-` 삭제 버튼은 금액이 편집 가능한 행만 표시 */
  shouldShowRemoveRowButton?: (r: MeetingValueRow) => boolean
  /** 금액 입력 툴팁(자동 집계 안내 등) */
  amountInputTitle?: (r: MeetingValueRow) => string | undefined
  /** 지출 「내역 보기」(모달) — 보기 모드에서만 */
  rowExpenseBreakdownModal?: {
    matchesRow: (row: MeetingValueRow, rowIndex: number) => boolean
    onOpenModal: (row: MeetingValueRow, rowIndex: number) => void
  }
  onAddRow: () => void
  onLabelChange: (rowIndex: number, value: string) => void
  onValueChange: (rowIndex: number, value: string) => void
  onRemoveRow: (rowIndex: number) => void
}) => {
  const {
    tableId,
    title,
    newRowButtonLabel,
    rows,
    showShareColumn,
    editMode,
    indexKind,
    isAmountReadonly,
    shouldShowRemoveRowButton,
    amountInputTitle,
    rowExpenseBreakdownModal,
    onAddRow,
    onLabelChange,
    onValueChange,
    onRemoveRow,
  } = props
  const rowCanRemove =
    shouldShowRemoveRowButton ?? ((r: MeetingValueRow) => !isAmountReadonly(r))
  return (
    <article className="meeting-card">
      <div className="meeting-card-header">
        <h3>{title}</h3>
        {editMode ? (
          <button type="button" className="ghost-button meeting-mini-button" onClick={onAddRow}>
            {newRowButtonLabel}
          </button>
        ) : null}
      </div>
      <table className="meeting-table meeting-table-compact">
        <thead>
          <tr>
            <th className="meeting-col-idx">번호</th>
            <th>항목</th>
            <th>금액</th>
            {showShareColumn ? <th>점유비</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const breakdownBtn =
              rowExpenseBreakdownModal && !editMode && rowExpenseBreakdownModal.matchesRow(row, rowIndex)
            return (
              <tr key={`${tableId}-${rowIndex}`}>
                <td className="meeting-col-idx" title="자동">
                  {meetingValueRowIndexText(rows, rowIndex, indexKind)}
                </td>
                <td>
                  {editMode ? (
                    <div className="meeting-header-edit-row">
                      <input
                        className="meeting-header-input"
                        type="text"
                        value={row.label}
                        onChange={(event) => onLabelChange(rowIndex, event.target.value)}
                      />
                      {rowCanRemove(row) ? (
                        <button type="button" className="meeting-icon-button" onClick={() => onRemoveRow(rowIndex)}>
                          -
                        </button>
                      ) : null}
                    </div>
                  ) : breakdownBtn ? (
                    <div className="meeting-summary-label-with-toggle">
                      <span className="meeting-summary-label-text">{row.label}</span>
                      <button
                        type="button"
                        className="meeting-breakdown-toggle"
                        onClick={() => rowExpenseBreakdownModal!.onOpenModal(row, rowIndex)}
                      >
                        내역 보기
                      </button>
                    </div>
                  ) : (
                    row.label
                  )}
                </td>
                <td>
                  <input
                    className={
                      isAmountReadonly(row) ? 'meeting-cell-input meeting-cell-input-readonly' : 'meeting-cell-input'
                    }
                    type="text"
                    inputMode="numeric"
                    value={formatAmountForInput(row.amount)}
                    readOnly={isAmountReadonly(row)}
                    title={amountInputTitle?.(row)}
                    onChange={(event) => onValueChange(rowIndex, event.target.value)}
                  />
                </td>
                {showShareColumn ? (
                  <td>
                    <input
                      className="meeting-cell-input meeting-cell-input-readonly"
                      type="text"
                      inputMode="decimal"
                      value={formatSharePercent(row.share)}
                      readOnly
                    />
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </article>
  )
}

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
  const norm = (label: string) => normalizeClientLabel(label)

  const updated = roastingSales.map((row) => {
    if (isRoastFixedBlockRow(row)) {
      return row
    }
    const agg = aggregates.get(norm(row.label))
    if (!agg) {
      // 거래명세에 해당 집계 월·거래처가 없으면(줄 삭제·금액 삭제 등) 이전 자동 반영액이 입금 합계에 남지 않게 집계 열을 비웁니다.
      return {
        ...row,
        share: null,
        january: null,
      }
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
    updated.filter((row) => isRoastClientRow(row)).map((row) => norm(row.label)),
  )

  const insertIndex = updated.findIndex((row) => isRoastSubtotalRow(row))
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
        roastRole: 'client',
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
  const merged = new Map<string, { name: string; totalOutbound: number }>()
  for (const bean of beanRows) {
    const candidate = bean as InventoryStorageBeanRow | null
    const rawName = typeof candidate?.name === 'string' ? candidate.name : ''
    const name = normalizeMeetingBeanName(rawName)
    if (isMeetingOutboundExcludedBeanName(name)) {
      continue
    }
    const outbound = Array.isArray(candidate?.outbound) ? candidate.outbound : []
    const totalOutbound = outbound.reduce<number>(
      (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
      0,
    )
    const key = meetingBeanMergeKey(name)
    const prev = merged.get(key)
    if (prev) {
      prev.totalOutbound += totalOutbound
    } else {
      merged.set(key, { name, totalOutbound })
    }
  }
  return [...merged.values()].map((row) => ({
    name: row.name,
    totalOutbound: Math.round(row.totalOutbound * 1000) / 1000,
  }))
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
  const merged = new Map<string, { name: string; stockAtReference: number }>()
  for (const bean of beanRows) {
    const candidate = bean as InventoryStorageBeanRow | null
    const rawName = typeof candidate?.name === 'string' ? candidate.name : ''
    const name = normalizeMeetingBeanName(rawName)
    if (isMeetingOutboundExcludedBeanName(name)) {
      continue
    }
    const stock = Array.isArray(candidate?.stock) ? candidate.stock : []
    const raw = stock[dayIdx]
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    const key = meetingBeanMergeKey(name)
    const prev = merged.get(key)
    if (prev) {
      prev.stockAtReference += n
    } else {
      merged.set(key, { name, stockAtReference: n })
    }
  }
  return [...merged.values()].map((row) => ({
    name: row.name,
    stockAtReference: Math.round(row.stockAtReference * 1000) / 1000,
  }))
}

/** 보기 모드: 가로로 긴 한 줄 표를 세로(품목 | kg)로 풀어 읽기 쉽게 함. 동일 품목명이 여러 열에 있으면 kg을 합쳐 한 줄로 표시(입출고 동기화로 생긴 중복 열 정리). */
type MeetingKgReadRow = { displayLabel: string; kg: number; merged: boolean }
const buildMeetingKgReadRows = (
  columnLabels: string[],
  values: Array<number | null | undefined>,
  options: { hideZero: boolean; aggregateColumnIndex: number },
): MeetingKgReadRow[] => {
  const { hideZero, aggregateColumnIndex } = options
  const mergeBuckets = new Map<string, { kg: number; colCount: number }>()
  for (let i = 0; i < columnLabels.length; i++) {
    const v = values[i]
    const kg = typeof v === 'number' && Number.isFinite(v) ? v : 0
    if (hideZero && kg === 0) {
      continue
    }
    const raw = columnLabels[i] ?? ''
    const trimmed = raw.trim()
    const mergeKey = trimmed.length > 0 ? `name:${trimmed}` : `idx:${i}`
    const prev = mergeBuckets.get(mergeKey) ?? { kg: 0, colCount: 0 }
    prev.kg += kg
    prev.colCount += 1
    mergeBuckets.set(mergeKey, prev)
  }
  const rows: MeetingKgReadRow[] = []
  for (const [mergeKey, { kg, colCount }] of mergeBuckets) {
    if (mergeKey.startsWith('idx:')) {
      const i = Number(mergeKey.slice(4))
      const raw = columnLabels[i] ?? ''
      const displayLabel = raw.trim() || `열 ${i + 1}`
      rows.push({ displayLabel, kg, merged: false })
    } else {
      const name = mergeKey.slice('name:'.length)
      rows.push({ displayLabel: name, kg, merged: colCount > 1 })
    }
  }
  const promote =
    aggregateColumnIndex >= 0 ? (columnLabels[aggregateColumnIndex] ?? '').trim() : ''
  if (promote) {
    const pr = rows.find((r) => r.displayLabel === promote)
    const others = rows.filter((r) => r.displayLabel !== promote).sort((a, b) => b.kg - a.kg)
    return pr ? [pr, ...others] : others
  }
  return [...rows].sort((a, b) => b.kg - a.kg)
}

const computeCurrentMonthCosts = (rows: MeetingValueRow[]) => {
  const totalCosts = sumValues(rows.filter((row) => !isCostGrandRow(row)).map((row) => row.amount))

  return rows.map((row) =>
    isCostGrandRow(row)
      ? { ...row, amount: totalCosts, share: null }
      : { ...row, share: totalCosts > 0 && row.amount !== null ? row.amount / totalCosts : null },
  )
}

const computeCurrentMonthSales = (
  sales: MeetingValueRow[],
  costs: MeetingValueRow[],
  roastingComputed: ReturnType<typeof computeRoastingSales>,
) => {
  const manualSalesTotal = sumValues(
    sales
      .filter((row) => !isSalesTotalRow(row) && !isSalesNetRow(row) && !isSalesRoastingTotalRow(row))
      .map((row) => row.amount),
  )
  const roastingSalesTotal = roastingComputed.find((row) => isRoastSubtotalRow(row))?.january ?? 0
  const grandSalesTotal = manualSalesTotal + roastingSalesTotal
  const totalCosts = costs.find((row) => isCostGrandRow(row))?.amount ?? 0

  return sales.map((row) => {
    if (isSalesRoastingTotalRow(row)) {
      return {
        ...row,
        amount: roastingSalesTotal,
        share: grandSalesTotal > 0 && roastingSalesTotal > 0 ? roastingSalesTotal / grandSalesTotal : null,
      }
    }
    if (isSalesTotalRow(row)) {
      return { ...row, amount: grandSalesTotal, share: null }
    }
    if (isSalesNetRow(row)) {
      return { ...row, amount: grandSalesTotal - totalCosts, share: null }
    }

    return {
      ...row,
      share: grandSalesTotal > 0 && row.amount !== null ? row.amount / grandSalesTotal : null,
    }
  })
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

/** 지출 `category` → 비용 현황 expenseKey */
const expenseCategoryToMeetingCostBucketKey = (cat: string): string => {
  const c = cat.trim()
  if (c === '미분류') {
    return '②기타'
  }
  const mapped = EXPENSE_CATEGORY_TO_MEETING_COST_LABEL_MAP.get(c)
  if (mapped) {
    return mapped
  }
  if (c === '기타경비') {
    return '②기타경비'
  }
  if (c === '운영경비' || c === '기타운영비') {
    return '②운영경비'
  }
  return '②기타'
}

const OTHER_COST_BUCKET_PANEL_MAX_ENTRIES = 30

const formatExpenseDateForMeetingBreakdown = (isoDate: string) => {
  const s = isoDate.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s.replaceAll('-', '.')
  }
  return s.length > 0 ? s : '—'
}

type OtherCostBucketExpenseEntry = {
  /** 비교 정렬용 `YYYY-MM-DD` · 파싱 불가면 빈 문자열 */
  sortDateKey: string
  expenseDateLabel: string
  headline: string
  metaLabel: string
  amount: number
}

type MeetingExpenseBreakdownSortKey = 'date' | 'name' | 'amount'

function parseExpenseMeetBreakdownIsoDate(ds: string): string {
  const s = ds.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function sortExpenseBreakdownEntries(
  entries: OtherCostBucketExpenseEntry[],
  key: MeetingExpenseBreakdownSortKey,
  dir: 'asc' | 'desc',
): OtherCostBucketExpenseEntry[] {
  const signPrimary = dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    let cmp = 0
    if (key === 'date') {
      const ha = a.sortDateKey.length > 0
      const hb = b.sortDateKey.length > 0
      if (ha !== hb) {
        return ha ? -1 : 1
      }
      if (ha && hb) {
        cmp = a.sortDateKey.localeCompare(b.sortDateKey) * signPrimary
      }
    } else if (key === 'name') {
      cmp = a.headline.localeCompare(b.headline, 'ko', { sensitivity: 'base' }) * signPrimary
    } else {
      cmp = Math.sign(a.amount - b.amount) * signPrimary
    }

    if (cmp !== 0) {
      return cmp
    }
    const byDate = (() => {
      const ua = a.sortDateKey.length > 0
      const ub = b.sortDateKey.length > 0
      if (ua !== ub) {
        return ua ? -1 : 1
      }
      return ua ? a.sortDateKey.localeCompare(b.sortDateKey) : 0
    })()
    if (byDate !== 0) {
      return byDate
    }
    const byHeadline = a.headline.localeCompare(b.headline, 'ko', { sensitivity: 'base' })
    if (byHeadline !== 0) {
      return byHeadline
    }
    return Math.sign(a.amount - b.amount)
  })
}

/**
 * 월 마감 비용 한 줄(②기타·②기타경비·②운영경비)에 들어간 지출표 행 · 집계와 동일 규칙.
 */
function gatherExpenseMeetingBucketEntries(
  records: ExpenseRecord[],
  ym: string,
  bucketKey: MeetingCostsExpenseBucketKey,
): OtherCostBucketExpenseEntry[] {
  const prefix = ym.trim()
  if (!/^\d{4}-\d{2}$/.test(prefix)) {
    return []
  }

  const gathered: OtherCostBucketExpenseEntry[] = []
  for (const r of records) {
    const ds = typeof r.expenseDate === 'string' ? r.expenseDate.trim() : ''
    if (!ds.startsWith(prefix)) {
      continue
    }
    const amt = typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : 0
    if (amt <= 0) {
      continue
    }
    const resolved = resolveExpenseCategoryForMeetingBucket(r).trim() || '미분류'
    if (expenseCategoryToMeetingCostBucketKey(resolved) !== bucketKey) {
      continue
    }
    const vendor = (r.vendorName ?? '').trim()
    const detail = (r.detail ?? '').trim()
    let headline =
      vendor && detail ? `${vendor} · ${detail}` : vendor || detail || '(거래처·세부항목 미입력)'
    if (headline.length > 90) {
      headline = `${headline.slice(0, 87)}…`
    }
    const cat = (r.category ?? '').trim()
    const purpose = (r.purpose ?? '').trim()
    const metaParts: string[] = []
    if (cat.length > 0) {
      metaParts.push(cat)
    }
    if (purpose.length > 0 && purpose !== cat) {
      metaParts.push(`용도: ${purpose}`)
    }
    const metaLabel = metaParts.join(' · ')
    const sortDateKey = parseExpenseMeetBreakdownIsoDate(ds)
    gathered.push({
      sortDateKey,
      expenseDateLabel: formatExpenseDateForMeetingBreakdown(ds),
      headline,
      metaLabel,
      amount: amt,
    })
  }
  return gathered
}

function renderExpenseBucketLinesList(
  entries: OtherCostBucketExpenseEntry[],
  caption: ReactNode,
  emptyMessage: string,
  overflowExtraHint?: string,
): ReactNode {
  if (entries.length === 0) {
    return <p className="meeting-breakdown-empty">{emptyMessage}</p>
  }
  const visible = entries.slice(0, OTHER_COST_BUCKET_PANEL_MAX_ENTRIES)
  const overflow = entries.length - visible.length
  return (
    <>
      <p className="meeting-breakdown-caption">{caption}</p>
      <ul className="meeting-breakdown-list">
        {visible.map((e, idx) => (
          <li key={`${e.sortDateKey}-${e.headline}-${e.amount}-${idx}`} className="meeting-breakdown-item">
            <div className="meeting-breakdown-item-row">
              <div className="meeting-breakdown-item-text">
                <span className="meeting-breakdown-date">{e.expenseDateLabel}</span>
                <span className="meeting-breakdown-headline">{e.headline}</span>
              </div>
              <span className="meeting-breakdown-amount">{formatMoney(e.amount)}</span>
            </div>
            {e.metaLabel ? <div className="meeting-breakdown-meta">{e.metaLabel}</div> : null}
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        <p className="meeting-breakdown-overflow">
          외 {overflow}건 — {overflowExtraHint ?? '지출표에서 전체를 확인할 수 있습니다.'}
        </p>
      ) : null}
    </>
  )
}

/**
 * 클라우드에서 월 마감만 열어도 지출 연동·내역 패널이 동작하게 회사 문서 지출표를 합친다.
 * 브라우저에 채워진 로컬 지출표는 건수가 같거나 많을 때 그대로 둠(저장 분·미저장 수정 반영 우선).
 */
const pickExpenseRecordsForMeetingLink = (
  cloudMode: boolean,
  lsRecords: ExpenseRecord[],
  cloudRecords: ExpenseRecord[],
): ExpenseRecord[] => {
  if (!cloudMode) {
    return lsRecords
  }
  if (!cloudRecords.length) {
    return lsRecords
  }
  if (!lsRecords.length) {
    return cloudRecords
  }
  return lsRecords.length >= cloudRecords.length ? lsRecords : cloudRecords
}

/** 비용 현황 · 원두별 매출 분석과 같은 추정 생두 원가(거래명세 납품 월×kg×최근 원/kg) */
const MEETING_BEAN_MATERIAL_BUCKET_KEY = '①매출별생두재료'

const MEETING_COST_BUCKET_LABEL_FALLBACK: Record<string, string> = {
  '①재료비': '재료비',
  [MEETING_BEAN_MATERIAL_BUCKET_KEY]: '재료비(매출·생두)',
  '③임대료': '임대료',
  '⑥전기세': '전기세',
  '⑧인건비': '인건비',
  '②기타경비': '기타경비',
  '②운영경비': '운영경비',
  '②기타': '그 외 비용',
}

const MEETING_COST_BUCKET_SORT_ORDER: readonly string[] = [
  '①재료비',
  MEETING_BEAN_MATERIAL_BUCKET_KEY,
  '③임대료',
  '⑥전기세',
  '⑧인건비',
  '②기타경비',
  '②운영경비',
  '②기타',
]

const compareMeetingExpenseBucketKeys = (a: string, b: string): number => {
  const ia = MEETING_COST_BUCKET_SORT_ORDER.indexOf(a)
  const ib = MEETING_COST_BUCKET_SORT_ORDER.indexOf(b)
  if (ia >= 0 && ib >= 0) {
    return ia - ib
  }
  if (ia >= 0) {
    return -1
  }
  if (ib >= 0) {
    return 1
  }
  return a.localeCompare(b, 'ko')
}

const beanMaterialMeetingLinesToBreakdownEntries = (lines: BeanSalesMaterialMeetingLine[]): OtherCostBucketExpenseEntry[] =>
  lines.map((line) => {
    const dk = line.greenOrderDateRef
      ? /^\d{4}-\d{2}-\d{2}/.exec(String(line.greenOrderDateRef).trim())?.[0] ?? ''
      : ''
    const dateLabel = dk ? formatExpenseDateForMeetingBreakdown(dk) : '참고 단가일'
    const metaBits: string[] = []
    if (line.wonPerKg != null && Number.isFinite(line.wonPerKg)) {
      metaBits.push(`${currencyFormatter.format(Math.round(line.wonPerKg))}원/kg`)
    } else {
      metaBits.push('생두 단가 미확보')
    }
    const qtyStr =
      Number.isInteger(line.totalQuantityKg) || line.totalQuantityKg % 1 === 0
        ? String(Math.round(line.totalQuantityKg))
        : line.totalQuantityKg.toFixed(2)
    metaBits.push(`판매량 ${qtyStr}kg · 매출 ${formatMoney(line.totalRevenueWon)}`)
    if (line.greenOrderDateRef && line.greenOrderDateRef !== '직접') {
      metaBits.push(`주문·단가 기준: ${line.greenOrderDateRef}`)
    }
    const cost = line.estimatedCostWon != null && line.estimatedCostWon > 0 ? Math.round(line.estimatedCostWon) : 0
    return {
      sortDateKey: parseExpenseMeetBreakdownIsoDate(dk),
      expenseDateLabel: dateLabel,
      headline: line.beanLabel,
      metaLabel: metaBits.join(' · '),
      amount: cost,
    }
  })

const parseMeetingStatementDeliveryRecords = (): BeanStatementDeliveryRecord[] => {
  try {
    const raw = window.localStorage.getItem(STATEMENT_RECORDS_STORAGE_KEY)
    if (!raw?.trim()) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown[]
    if (!Array.isArray(parsed)) {
      return []
    }
    const out: BeanStatementDeliveryRecord[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') {
        continue
      }
      const r = row as Record<string, unknown>
      const deliveryDate = typeof r.deliveryDate === 'string' ? r.deliveryDate : ''
      const itemName = typeof r.itemName === 'string' ? r.itemName : ''
      const clientName = typeof r.clientName === 'string' ? r.clientName : ''
      const qty = typeof r.quantity === 'number' && Number.isFinite(r.quantity) ? r.quantity : 0
      const totalAmount = typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : 0
      if (!deliveryDate || !itemName) {
        continue
      }
      out.push({ deliveryDate, itemName, quantity: qty, totalAmount, clientName })
    }
    return out
  } catch {
    return []
  }
}

const readMeetingInventoryForBeanMaterial = (mode: 'local' | 'cloud', companyId: string | null): InventoryStatusState | null => {
  try {
    const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, companyId)
    let raw = window.localStorage.getItem(key)
    if (!raw && key !== INVENTORY_STATUS_STORAGE_KEY) {
      raw = window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY)
    }
    if (!raw) {
      return null
    }
    return normalizeInventoryStatusState(JSON.parse(raw))
  } catch {
    return null
  }
}

const mergeBeanSalesMaterialCostIntoMeetingRows = (
  rows: MeetingValueRow[],
  ymPrefix: string | null,
  result: BeanSalesMaterialMeetingResult | null,
): MeetingValueRow[] => {
  const keyBucket = MEETING_BEAN_MATERIAL_BUCKET_KEY
  if (!ymPrefix || !result) {
    return rows
  }

  const hasSalesKg = result.lines.some((l) => l.totalQuantityKg > 0 && l.totalRevenueWon > 0)
  const nextAmt = hasSalesKg ? Math.max(0, Math.round(result.totalEstimatedCostWon)) : null

  return rows.map((row) => {
    if (costRowKey(row) !== keyBucket) {
      return row
    }
    return {
      ...row,
      expenseKey: keyBucket,
      amount: nextAmt,
    }
  })
}

/**
 * 지출표 자동연동 줄(삭제 가능). 없으면 복구해 두어 이름·금액을 수정할 수 있게 합니다.
 * `costRowKey`가 아닌 항목명만 같은 경우 라벨에 맞춰 `expenseKey`만 채워 넣습니다.
 */
const USER_EDITABLE_STANDARD_EXPENSE_KEYS = ['②기타경비', '②운영경비', '②기타'] as const

const editableStandardExpenseKeySet = new Set<string>(USER_EDITABLE_STANDARD_EXPENSE_KEYS)

const resolvedStandardExpenseBucketKey = (row: MeetingValueRow): string | null => {
  const ek = String(row.expenseKey ?? '').trim()
  if (editableStandardExpenseKeySet.has(ek)) {
    return ek
  }
  const plain = stripLeadingIndexFromLabel(String(row.label ?? '')).trim()
  if (plain === '기타경비') {
    return '②기타경비'
  }
  if (plain === '운영경비') {
    return '②운영경비'
  }
  if (plain === '그 외 비용' || plain === '그외 비용' || plain === '그외비용') {
    return '②기타'
  }
  return null
}

/** 지출표에서만 금액이 채워지는 줄 — 회의표에서 금액 수동 수정 불가 */
const isExpenseSheetFedCostAmountRow = (r: MeetingValueRow): boolean => {
  if (String(r.expenseKey ?? '').trim() === MEETING_BEAN_MATERIAL_BUCKET_KEY) {
    return true
  }
  const k = resolvedStandardExpenseBucketKey(r)
  return k === '②기타경비' || k === '②운영경비'
}

const expenseSyncedMeetingCostAmountHint = (row: MeetingValueRow): string | undefined => {
  if (String(row.expenseKey ?? '').trim() === MEETING_BEAN_MATERIAL_BUCKET_KEY) {
    return '이 금액은 해당 월 거래명세 납품·판매량(kg)과 생두 주문 일자별 기록의 원/kg으로 추정합니다. 원두별 매출 분석과 같은 규칙이며, 거래명세·입출고·생두 주문을 수정하면 바뀝니다.'
  }
  if (!isExpenseSheetFedCostAmountRow(row)) {
    return undefined
  }
  const k = resolvedStandardExpenseBucketKey(row)
  if (k === '②운영경비') {
    return '이 금액은 지출표에서 카테고리 「운영경비」「기타운영비」로 분류된 금액만 합친 값입니다. 기타경비 분류 줄은 포함되지 않으며, 바꾸려면 지출표를 수정하세요.'
  }
  if (k === '②기타경비') {
    return '이 금액은 지출표에서 카테고리 「기타경비」이거나 카테고리·「용도」 규칙상 기타로 나뉜 금액만 합친 값입니다. 수정은 지출표에서 하세요.'
  }
  return undefined
}

const hydrateStandardExpenseKeyOnRow = (row: MeetingValueRow): MeetingValueRow => {
  if (String(row.expenseKey ?? '').trim().length > 0) {
    return row
  }
  const beanFallbackLabel = MEETING_COST_BUCKET_LABEL_FALLBACK[MEETING_BEAN_MATERIAL_BUCKET_KEY]
  const plain = stripLeadingIndexFromLabel(String(row.label ?? '')).trim()
  if (plain === beanFallbackLabel) {
    return { ...row, expenseKey: MEETING_BEAN_MATERIAL_BUCKET_KEY }
  }
  const rk = resolvedStandardExpenseBucketKey(row)
  if (!rk) {
    return row
  }
  return { ...row, expenseKey: rk }
}

const resolveMonthlyMeetingCostBreakdownTarget = (
  row: MeetingValueRow,
): MeetingCostDetailModalOpen | null => {
  if (String(row.expenseKey ?? '').trim() === MEETING_BEAN_MATERIAL_BUCKET_KEY) {
    return { kind: 'beanMaterial' }
  }
  const bucket = resolvedStandardExpenseBucketKey(row)
  if (bucket === '②기타' || bucket === '②기타경비' || bucket === '②운영경비') {
    return { kind: 'expense', bucket }
  }
  return null
}

const ensureMeetingBeanMaterialCostRowPresent = (body: MeetingValueRow[]): MeetingValueRow[] => {
  if (body.some((r) => String(r.expenseKey ?? '').trim() === MEETING_BEAN_MATERIAL_BUCKET_KEY)) {
    return body
  }
  const label = MEETING_COST_BUCKET_LABEL_FALLBACK[MEETING_BEAN_MATERIAL_BUCKET_KEY]
  const newRow: MeetingValueRow = {
    label,
    amount: null,
    share: null,
    expenseKey: MEETING_BEAN_MATERIAL_BUCKET_KEY,
  }
  const idxExpenseMaterial = body.findIndex((r) => costRowKey(r) === '①재료비')
  if (idxExpenseMaterial >= 0) {
    return [...body.slice(0, idxExpenseMaterial + 1), newRow, ...body.slice(idxExpenseMaterial + 1)]
  }
  const idxLease = body.findIndex((r) => costRowKey(r) === '③임대료')
  if (idxLease >= 0) {
    return [...body.slice(0, idxLease), newRow, ...body.slice(idxLease)]
  }
  return [newRow, ...body]
}

const ensureStandardUserExpenseBucketRowsInBody = (body: MeetingValueRow[]): MeetingValueRow[] => {
  const occupied = new Set<string>()
  for (const r of body) {
    const k = resolvedStandardExpenseBucketKey(r)
    if (k) {
      occupied.add(k)
    }
  }
  const inserts: MeetingValueRow[] = []
  for (const key of USER_EDITABLE_STANDARD_EXPENSE_KEYS) {
    if (occupied.has(key)) {
      continue
    }
    inserts.push({
      label: MEETING_COST_BUCKET_LABEL_FALLBACK[key] ?? key.replace(/^②/, ''),
      amount: null,
      share: null,
      expenseKey: key,
    })
    occupied.add(key)
  }
  if (inserts.length === 0) {
    return body
  }
  inserts.sort((a, b) => compareMeetingExpenseBucketKeys(a.expenseKey!, b.expenseKey!))
  return [...body, ...inserts]
}

const prepareExpenseLinkedCostBodyRows = (bodyWithoutGrand: MeetingValueRow[]): MeetingValueRow[] => {
  const hydrated = bodyWithoutGrand.map(hydrateStandardExpenseKeyOnRow)
  return ensureMeetingBeanMaterialCostRowPresent(ensureStandardUserExpenseBucketRowsInBody(hydrated))
}

const ensureEditableExpenseCostRowsShape = (costRows: MeetingValueRow[]): MeetingValueRow[] => {
  const grandIdx = costRows.findIndex(isCostGrandRow)
  const grandRow = grandIdx >= 0 ? costRows[grandIdx]! : null
  const body = costRows.filter((row) => !isCostGrandRow(row))
  const preparedBody = prepareExpenseLinkedCostBodyRows(body)
  if (!grandRow) {
    return preparedBody
  }
  const grandFirst = grandIdx === 0
  return grandFirst ? [grandRow, ...preparedBody] : [...preparedBody, grandRow]
}

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
    const resolvedCat = resolveExpenseCategoryForMeetingBucket(r).trim()
    const cat = resolvedCat.length > 0 ? resolvedCat : '미분류'
    const amt = typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : 0
    if (amt === 0) {
      continue
    }
    const meetingLabel = expenseCategoryToMeetingCostBucketKey(cat)
    map.set(meetingLabel, (map.get(meetingLabel) ?? 0) + amt)
  }

  const grandIdx = base.findIndex(isCostGrandRow)
  const grandRow = grandIdx >= 0 ? base[grandIdx]! : null
  const bodyRowsBase = prepareExpenseLinkedCostBodyRows(base.filter((row) => !isCostGrandRow(row)))

  const existingBucketKeys = new Set(bodyRowsBase.map(costRowKey))
  const inserts: MeetingValueRow[] = []
  for (const bucketKey of [...map.keys()].sort(compareMeetingExpenseBucketKeys)) {
    if (existingBucketKeys.has(bucketKey)) {
      continue
    }
    inserts.push({
      label: MEETING_COST_BUCKET_LABEL_FALLBACK[bucketKey] ?? bucketKey.replace(/^②/, ''),
      amount: null,
      share: null,
      expenseKey: bucketKey,
    })
    existingBucketKeys.add(bucketKey)
  }

  const bodyRows = [...bodyRowsBase, ...inserts]

  const patchedBody = bodyRows.map((row) => {
    const key = costRowKey(row)
    if (!map.has(key)) {
      return row
    }
    if (typeof row.amount === 'number' && Number.isFinite(row.amount)) {
      return row
    }
    return { ...row, amount: Math.round(map.get(key) ?? 0) }
  })

  if (grandRow) {
    const firstIsGrand = grandIdx === 0
    return firstIsGrand ? [grandRow, ...patchedBody] : [...patchedBody, grandRow]
  }
  return patchedBody
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
  if (/배달의민족|배민|우아한|woowahans/i.test(t) || /배달의\s*민족/.test(t)) {
    return 'baemin'
  }
  if (/쿠팡이츠|쿠팡/i.test(t)) {
    return 'coupang'
  }
  if (/땡겨요|요기요/.test(t)) {
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

const applySalesPatchesFromMap = (
  sales: MeetingValueRow[],
  patches: Map<MeetingSalesPatchKey, number>,
): MeetingValueRow[] => {
  if (patches.size === 0) {
    return sales
  }
  const consumed = new Set<MeetingSalesPatchKey>()
  return sales.map((row) => {
    if (isComputedSalesRow(row)) {
      return row
    }
    const pk = salesRowLabelToPatchKey(row.label)
    if (!pk || !patches.has(pk) || consumed.has(pk)) {
      return row
    }
    // 수동 입력이 이미 있는 칸은 자동 연동으로 덮어쓰지 않음
    if (typeof row.amount === 'number' && Number.isFinite(row.amount)) {
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
  const targetRows = rows.filter((row) => isRoastClientRow(row))
  const totalNovember = sumValues(targetRows.map((row) => row.november))
  const totalDecember = sumValues(targetRows.map((row) => row.december))
  const totalJanuary = sumValues(targetRows.map((row) => row.january))
  /** 집계 월 매출(거래명세·표에서 `january` 열에 해당) */
  const totalClosingMonth = totalJanuary

  return rows.map((row) => {
    if (isRoastSubtotalRow(row)) {
      return {
        ...row,
        november: totalNovember,
        december: totalDecember,
        january: totalJanuary,
        share: null,
      }
    }

    if (isRoastNetRow(row)) {
      const beanCost = rows.find((item) => isRoastBeanCostRow(item))
      return {
        ...row,
        november: totalNovember - (beanCost?.november ?? 0),
        december: totalDecember - (beanCost?.december ?? 0),
        january: totalJanuary - (beanCost?.january ?? 0),
        share: null,
      }
    }

    if (isRoastBeanCostRow(row)) {
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

/** 출금: 「비용 현황」에서 ⑨(비용 합계)를 제외한 항목 + (별도인 경우) 생두비용. */

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
    .filter((r) => !isComputedSalesRow(r))
    .map((r) => ({ label: r.label, amount: r.amount, share: null }))

  const roastingLines: MeetingCashflowAmountLine[] = roastingComputed
    .filter((r) => isRoastClientRow(r))
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
  roastingComputed: ReturnType<typeof computeRoastingSales>,
) => {
  const beanRaw = roastingComputed.find((r) => isRoastBeanCostRow(r))?.january
  const beanN = typeof beanRaw === 'number' && Number.isFinite(beanRaw) ? beanRaw : 0
  const hasRoastingBean = beanN !== 0
  const roastingBeanCost: MeetingCashflowAmountLine | null = hasRoastingBean
    ? { label: '로스팅실 생두비용', amount: Math.round(beanRaw!), share: null }
    : null

  const extraCostLines = computedCosts.filter((r) => {
    if (isCostGrandRow(r)) {
      return false
    }
    if (hasRoastingBean && (costRowKey(r) === '⑨로스팅실원두' || r.label === '⑨로스팅실원두')) {
      return false
    }
    return true
  })
  const totalOut = sumValues(extraCostLines.map((r) => r.amount)) + (roastingBeanCost?.amount ?? 0)
  return { roastingBeanCost, extraCostLines, totalOut }
}

const getMeetingCashflowPl = (extendedTotalIn: number, extendedTotalOut: number) => {
  const totalIn =
    typeof extendedTotalIn === 'number' && Number.isFinite(extendedTotalIn) ? extendedTotalIn : 0
  const totalOut =
    typeof extendedTotalOut === 'number' && Number.isFinite(extendedTotalOut) ? extendedTotalOut : 0
  const net = totalIn - totalOut
  /** 입금 합계 대비 현금 순이익 비율(−∞~∞). 입금이 0이면 산출 불가 */
  const netCashMarginRatio = totalIn > 0 ? net / totalIn : null
  return { totalIn, totalOut, net, netCashMarginRatio }
}

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
  if (parts.roastingBeanCost) {
    rows.push(['〈로스팅실 생두비용〉', '', '', ''])
    rows.push([
      parts.roastingBeanCost.label,
      excelCellAmount(parts.roastingBeanCost.amount),
      '',
      '',
    ])
  }
  rows.push(['〈비용 현황(⑨ 제외)〉', '', '', ''])
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
  roastRole: 'client',
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

const migrateMeetingValueRow = (r: MeetingValueRow, ctx: 'sales' | 'costs'): MeetingValueRow => {
  const out: MeetingValueRow = { ...r }
  if (!out.role) {
    if (out.label === '로스팅실 매출 총 합계') {
      out.role = 'salesRoastingTotal'
    } else if (out.label === '⑧총매출') {
      out.role = 'salesTotal'
    } else if (out.label === '⑨순이익') {
      out.role = 'salesNet'
    } else if (out.label === '⑨비용계') {
      out.role = 'costsGrand'
    }
  }
  if (ctx === 'costs' && (out.expenseKey == null || out.expenseKey === '') && /^[①②③④⑥⑦⑧⑨]/.test(out.label)) {
    out.expenseKey = out.label
  }
  out.label = stripLeadingIndexFromLabel(out.label)
  return out
}

const ensureRoastingTotalSalesRow = (rows: MeetingValueRow[]): MeetingValueRow[] => {
  if (rows.some((row) => isSalesRoastingTotalRow(row))) {
    return rows
  }
  const next = [...rows]
  const insertAt = next.findIndex((row) => isSalesTotalRow(row) || isSalesNetRow(row))
  const row: MeetingValueRow = { label: '로스팅실 매출 총 합계', amount: null, share: null, role: 'salesRoastingTotal' }
  if (insertAt < 0) {
    next.push(row)
  } else {
    next.splice(insertAt, 0, row)
  }
  return next
}

const migrateRoastRow = (r: MeetingMonthlyRow): MeetingMonthlyRow => {
  let out: MeetingMonthlyRow
  if (r.roastRole) {
    out = { ...r }
  } else if (r.label === '합 계' || r.label === '합계') {
    out = { ...r, roastRole: 'subtotal' }
  } else if (r.label === '생두비용') {
    out = { ...r, roastRole: 'beanCost' }
  } else if (r.label === '순이익') {
    out = { ...r, roastRole: 'net' }
  } else {
    out = { ...r, roastRole: 'client' }
  }
  if (isRoastClientRow(out)) {
    return { ...out, label: stripLeadingIndexFromLabel(out.label) }
  }
  return out
}

const migrateMeetingTemplateData = (d: MonthlyMeetingData): MonthlyMeetingData => ({
  title: d.title,
  storeName: d.storeName,
  monthLabel: d.monthLabel,
  months: d.months,
  currentMonthSales: ensureRoastingTotalSalesRow(d.currentMonthSales.map((row) => migrateMeetingValueRow(row, 'sales'))),
  currentMonthCosts: ensureEditableExpenseCostRowsShape(
    d.currentMonthCosts.map((row) => migrateMeetingValueRow(row, 'costs')),
  ),
  roastingSales: d.roastingSales.map(migrateRoastRow),
  storeSales: d.storeSales,
  productionColumns: d.productionColumns,
  productionRows: d.productionRows,
  inventoryColumns: d.inventoryColumns,
  inventoryRows: d.inventoryRows,
})

const migrateMonthState = (s: MonthlyMeetingMonthState): MonthlyMeetingMonthState => ({
  currentMonthSales: ensureRoastingTotalSalesRow(s.currentMonthSales.map((row) => migrateMeetingValueRow(row, 'sales'))),
  currentMonthCosts: ensureEditableExpenseCostRowsShape(
    s.currentMonthCosts.map((row) => migrateMeetingValueRow(row, 'costs')),
  ),
  storeSales: s.storeSales,
  productionRow: s.productionRow,
  inventoryRow: s.inventoryRow,
})

const normalizeMonthlyMeetingPageState = (raw: unknown): MonthlyMeetingPageState => {
  const parsed = (raw && typeof raw === 'object' ? raw : null) as Partial<MonthlyMeetingPageState> | null
  const parsedData = (parsed?.data as MonthlyMeetingData | undefined) ?? monthlyMeetingData
  const data = migrateMeetingTemplateData({
    ...parsedData,
    title: normalizeMeetingTitle(parsedData.title ?? monthlyMeetingData.title, parsedData.months),
  })

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
        ...Object.fromEntries(
          Object.entries(parsed?.monthStatesByMonth ?? {}).map(([k, st]) => [k, migrateMonthState(st as MonthlyMeetingMonthState)]),
        ),
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
  /** 입출고 페이지와 동일한 localStorage 키 + 캐시 갱신 시 4번 출고·재고 표를 다시 읽음 */
  const [inventoryLinkTick, setInventoryLinkTick] = useState(0)
  const [pageState, setPageState] = useState<MonthlyMeetingPageState>(createDefaultState)
  const pageStateRef = useRef(pageState)
  pageStateRef.current = pageState
  const monthlyMeetingCloudSaveTimerRef = useRef<number | null>(null)
  const [sectionEditModes, setSectionEditModes] = useState<Record<MeetingSectionEditKey, boolean>>(
    readStoredSectionEditModes,
  )
  const [isStorageReady, setIsStorageReady] = useState(false)
  const [isCloudReady, setIsCloudReady] = useState(mode === 'local')
  const lastCloudPollJsonRef = useRef('')
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
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
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
  const [meetingCostDetailModal, setMeetingCostDetailModal] = useState<MeetingCostDetailModalState>(null)
  const [expenseBreakdownSortKey, setExpenseBreakdownSortKey] =
    useState<MeetingExpenseBreakdownSortKey>('amount')
  const [expenseBreakdownSortDir, setExpenseBreakdownSortDir] = useState<'asc' | 'desc'>('desc')
  /** 클라우드 전용: 회사 문서의 지출표(지출 탭을 안 열어도 월 마감에서 활용) */
  const [companyExpenseRecordsCached, setCompanyExpenseRecordsCached] = useState<ExpenseRecord[]>([])
  /** 원두별 매출·생두 단가·매핑 변경 시 재료비(매출·생두) 줄 재계산 */
  const [beanMeetingMaterialDepsRev, setBeanMeetingMaterialDepsRev] = useState(0)
  const [outboundShareChartOpen, setOutboundShareChartOpen] = useState(true)
  const [outboundPieHoveredSliceIndex, setOutboundPieHoveredSliceIndex] = useState<number | null>(null)
  /** 출고·재고 세부 표는 모달에서만 표시 */
  const [piTableModal, setPiTableModal] = useState<null | 'outbound' | 'inventory'>(null)
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
            isRoastBeanCostRow(row) ? { ...row, january: null } : row,
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
          isRoastBeanCostRow(row) ? { ...row, january: agg.sumMoney } : row,
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
    const bumpBeanMeetingMaterial = () => setBeanMeetingMaterialDepsRev((n) => n + 1)
    window.addEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bumpGreenBean)
    window.addEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bumpBeanMeetingMaterial)
    window.addEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, bumpBeanMeetingMaterial)
    window.addEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, bumpBeanMeetingMaterial)
    window.addEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpStatements)
    window.addEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpBeanMeetingMaterial)
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
      window.removeEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bumpBeanMeetingMaterial)
      window.removeEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, bumpBeanMeetingMaterial)
      window.removeEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, bumpBeanMeetingMaterial)
      window.removeEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpStatements)
      window.removeEventListener(STATEMENT_RECORDS_SAVED_EVENT, bumpBeanMeetingMaterial)
      window.removeEventListener(EXPENSE_PAGE_SAVED_EVENT, bumpExpense)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    const bump = () => setInventoryLinkTick((n) => n + 1)
    const bumpBean = () => setBeanMeetingMaterialDepsRev((n) => n + 1)
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, bump)
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, bumpBean)
    return () => {
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, bump)
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, bumpBean)
    }
  }, [])

  useEffect(() => {
    const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        setInventoryLinkTick((n) => n + 1)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [mode, activeCompanyId])

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
      const idx = rows.findIndex((r) => isRoastBeanCostRow(r))
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

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId) {
      setCompanyExpenseRecordsCached([])
      return
    }

    let cancelled = false

    const pullExpenseFromCloud = async () => {
      try {
        const remote = await loadCompanyDocument<ExpensePageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.expensePage,
        )
        if (cancelled) {
          return
        }
        const records = remote ? normalizeExpensePageState(remote).records : []
        setCompanyExpenseRecordsCached(records)
      } catch (error) {
        console.error('월 마감회의: 회사 클라우드 지출표를 읽지 못했습니다.', error)
      }
    }

    void pullExpenseFromCloud()
    const id = window.setInterval(() => void pullExpenseFromCloud(), 8_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [activeCompanyId, mode])

  const lsExpenseRecordsForMeetingLink = useMemo(
    () => readExpensePageStateFromStorage().records,
    [expensePageStorageRev],
  )

  const expenseRecordsForMeetingLink = useMemo(
    () =>
      pickExpenseRecordsForMeetingLink(
        mode === 'cloud',
        lsExpenseRecordsForMeetingLink,
        companyExpenseRecordsCached,
      ),
    [companyExpenseRecordsCached, lsExpenseRecordsForMeetingLink, mode],
  )

  /** 지출표 → 재료비·기타 세부, 비용현황 ①②, 매출 채널(키워드) 자동 연동 + 거래명세·입출고·생두단가 기반 재료비(매출·생두) */
  useEffect(() => {
    if (!isStorageReady || sectionEditModes.summary) {
      return
    }
    const records = expenseRecordsForMeetingLink
    const stmtAll = parseMeetingStatementDeliveryRecords()
    const inv = readMeetingInventoryForBeanMaterial(mode, activeCompanyId)
    const mapOpts = { mode, companyId: activeCompanyId } as const

    setPageState((current) => {
      const fallbackStates = createMonthStates(current.data)
      let nextMonthStates = { ...current.monthStatesByMonth }
      let changed = false
      for (const monthLabel of current.data.months) {
        const ym = meetingMonthLabelToExpenseYm(monthLabel, records)
        if (!ym) {
          continue
        }
        const base = nextMonthStates[monthLabel] ?? fallbackStates[monthLabel]!
        const built = buildMeetingCostsFromExpenses(records, ym, base.currentMonthCosts)
        const stmMonth = filterStatementsByYmDelivery(stmtAll, ym)
        const beanResult = computeBeanSalesMaterialCostForYm(ym, stmMonth, inv, mapOpts)
        const nextCosts = computeCurrentMonthCosts(mergeBeanSalesMaterialCostIntoMeetingRows(built, ym, beanResult))
        const salesPatchMap = aggregateExpenseSalesPatches(records, ym)
        const nextSalesRaw = applySalesPatchesFromMap(base.currentMonthSales, salesPatchMap)

        const costsUnchanged =
          meetingValueRowsSignature(nextCosts) === meetingValueRowsSignature(computeCurrentMonthCosts(base.currentMonthCosts))
        const salesUnchanged = meetingValueRowsSignature(nextSalesRaw) === meetingValueRowsSignature(base.currentMonthSales)

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
  }, [
    expenseRecordsForMeetingLink,
    isStorageReady,
    sectionEditModes.summary,
    mode,
    activeCompanyId,
    statementRecordsStorageRev,
    inventoryLinkTick,
    beanMeetingMaterialDepsRev,
  ])

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
      const localJson = JSON.stringify(localState)
      if (mode !== 'cloud' || !activeCompanyId) {
        applyState(localState)
        return
      }

      try {
        const remoteState = await loadCompanyDocument<MonthlyMeetingPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.monthlyMeetingPage,
        )
        const normalizedRemote = remoteState ? normalizeMonthlyMeetingPageState(remoteState) : null
        const remoteJson = normalizedRemote ? JSON.stringify(normalizedRemote) : ''
        const lastSyncedJson = window.localStorage.getItem(MONTHLY_MEETING_LAST_SYNCED_JSON_KEY) ?? ''
        const hasUnsyncedLocalChanges = localJson !== lastSyncedJson
        const shouldPreferLocalOnHydrate =
          Boolean(normalizedRemote) && hasUnsyncedLocalChanges && localJson !== remoteJson

        if (shouldPreferLocalOnHydrate) {
          applyState(localState)
          return
        }

        if (normalizedRemote) {
          window.localStorage.setItem(MONTHLY_MEETING_LAST_SYNCED_JSON_KEY, remoteJson)
          applyState(normalizedRemote)
          return
        }

        applyState(localState)
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

  const flushMonthlyMeetingCloudSaveNow = useCallback(async () => {
    if (!isStorageReady || !isCloudReady) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    if (skipInitialDocumentSave()) {
      return
    }
    const payload = pageStateRef.current
    const nextJson = JSON.stringify(payload)
    if (nextJson === lastCloudPollJsonRef.current) {
      return
    }

    markDocumentDirty()
    markDocumentSaving()
    try {
      await saveCompanyDocument(
        activeCompanyId,
        COMPANY_DOCUMENT_KEYS.monthlyMeetingPage,
        payload,
        user?.id,
      )
      lastCloudPollJsonRef.current = nextJson
      window.localStorage.setItem(MONTHLY_MEETING_LAST_SYNCED_JSON_KEY, nextJson)
      markDocumentSaved()
    } catch (error) {
      console.error('월 마감회의 클라우드 저장에 실패했습니다.', error)
      markDocumentError()
    }
  }, [
    activeCompanyId,
    isCloudReady,
    isStorageReady,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    mode,
    skipInitialDocumentSave,
    user?.id,
  ])

  const scheduleDebouncedMonthlyMeetingCloudSave = () => {
    if (monthlyMeetingCloudSaveTimerRef.current !== null) {
      window.clearTimeout(monthlyMeetingCloudSaveTimerRef.current)
    }
    monthlyMeetingCloudSaveTimerRef.current = window.setTimeout(() => {
      monthlyMeetingCloudSaveTimerRef.current = null
      void flushMonthlyMeetingCloudSaveNow()
    }, 600)
  }

  /** 입력 칸에서 포커스가 빠져나올 때 디바운스 대기 없이 업로드 */
  const flushMonthlyMeetingCloudSaveOnEditableBlur = () => {
    if (monthlyMeetingCloudSaveTimerRef.current !== null) {
      window.clearTimeout(monthlyMeetingCloudSaveTimerRef.current)
      monthlyMeetingCloudSaveTimerRef.current = null
    }
    void flushMonthlyMeetingCloudSaveNow()
  }

  const flushMonthlyMeetingCloudSaveOnPageExit = useCallback(() => {
    if (monthlyMeetingCloudSaveTimerRef.current !== null) {
      window.clearTimeout(monthlyMeetingCloudSaveTimerRef.current)
      monthlyMeetingCloudSaveTimerRef.current = null
    }
    void flushMonthlyMeetingCloudSaveNow()
  }, [flushMonthlyMeetingCloudSaveNow])

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushMonthlyMeetingCloudSaveOnPageExit()
      }
    }

    window.addEventListener('beforeunload', flushMonthlyMeetingCloudSaveOnPageExit)
    window.addEventListener('pagehide', flushMonthlyMeetingCloudSaveOnPageExit)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', flushMonthlyMeetingCloudSaveOnPageExit)
      window.removeEventListener('pagehide', flushMonthlyMeetingCloudSaveOnPageExit)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [activeCompanyId, flushMonthlyMeetingCloudSaveOnPageExit, mode])

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
    const currentJson = JSON.stringify(pageState)
    if (currentJson === lastCloudPollJsonRef.current) {
      return
    }

    markDocumentDirty()
    scheduleDebouncedMonthlyMeetingCloudSave()

    return () => {
      if (monthlyMeetingCloudSaveTimerRef.current !== null) {
        window.clearTimeout(monthlyMeetingCloudSaveTimerRef.current)
        monthlyMeetingCloudSaveTimerRef.current = null
      }
    }
  }, [
    activeCompanyId,
    isCloudReady,
    isStorageReady,
    mode,
    pageState,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    skipInitialDocumentSave,
  ])

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
      inFlight = true
      try {
        const remote = await loadCompanyDocument<MonthlyMeetingPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.monthlyMeetingPage,
        )
        if (cancelled || !remote) {
          return
        }
        const normalized = normalizeMonthlyMeetingPageState(remote)
        const nextJson = JSON.stringify(normalized)
        if (nextJson !== lastJson) {
          // 미저장/저장 중/오류 중에는 원격 스냅샷 적용 안 함(lastJson 미갱신 → 저장 후 같은 원격 버전 재시도 가능)
          if (saveStateRef.current !== 'saved') {
            return
          }
          lastJson = nextJson
          lastCloudPollJsonRef.current = nextJson
          window.localStorage.setItem(MONTHLY_MEETING_LAST_SYNCED_JSON_KEY, nextJson)
          setPageState(normalized)
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
  }, [mode, activeCompanyId])

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
    if (!piTableModal && !meetingCostDetailModal) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPiTableModal(null)
        setMeetingCostDetailModal(null)
      }
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [meetingCostDetailModal, piTableModal])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }
    const inventoryKey = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
    const inventoryRaw = window.localStorage.getItem(inventoryKey)
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
          if (isMeetingOutboundExcludedBeanName(b.name)) {
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
        const outboundBeanKeySet = new Set(orderedOutboundBeanNames.map((name) => meetingBeanMergeKey(name)))
        const productionTailColsDeduped: string[] = []
        const seenTailKeys = new Set<string>()
        for (const label of productionTailCols) {
          const trimmed = label.trim()
          if (!trimmed || isMeetingOutboundExcludedBeanName(trimmed)) {
            continue
          }
          const key = meetingBeanMergeKey(trimmed)
          if (outboundBeanKeySet.has(key) || seenTailKeys.has(key)) {
            continue
          }
          seenTailKeys.add(key)
          productionTailColsDeduped.push(label)
        }
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
          ? (() => {
              const stockBeanKeySet = new Set(orderedStockBeanNames.map((name) => meetingBeanMergeKey(name)))
              const next: string[] = []
              const seenKeys = new Set<string>()
              for (const label of inventoryWithoutTotal) {
                const trimmed = label.trim()
                if (!trimmed || isMeetingOutboundExcludedBeanName(trimmed)) {
                  continue
                }
                const key = meetingBeanMergeKey(trimmed)
                if (stockBeanKeySet.has(key) || seenKeys.has(key)) {
                  continue
                }
                seenKeys.add(key)
                next.push(label)
              }
              return next
            })()
          : inventoryWithoutTotal.filter((label) => {
              const trimmed = label.trim()
              return trimmed.length > 0 && !isMeetingOutboundExcludedBeanName(trimmed)
            })

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

        const nextMonthStates = Object.fromEntries(
          Object.entries(current.monthStatesByMonth).map(([month, state]) => {
            let mergedProdValues = state.productionRow.values
            if (outboundMerge) {
              const headValues = state.productionRow.values.slice(0, rawBeanColumnIndex + 1)
              const tailValuesRaw = state.productionRow.values.slice(rawBeanColumnIndex + 1)
              const pairedTail = productionTailCols.map((label, index) => ({
                label,
                value: tailValuesRaw[index] ?? null,
              }))
              const keptTailValues: Array<number | null> = []
              const seenKeys = new Set<string>()
              for (const { label, value } of pairedTail) {
                const trimmed = label.trim()
                if (!trimmed || isMeetingOutboundExcludedBeanName(trimmed)) {
                  continue
                }
                const key = meetingBeanMergeKey(trimmed)
                if (outboundBeanKeySet.has(key) || seenKeys.has(key)) {
                  continue
                }
                seenKeys.add(key)
                keptTailValues.push(value)
              }
              let tailValues = keptTailValues
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
                const stockBeanKeySet = new Set(orderedStockBeanNames.map((name) => meetingBeanMergeKey(name)))
                const oldInvMapped = inventoryWithoutTotal.map((label, index) => ({
                  label,
                  value: oldInv[index] ?? null,
                }))
                const invHeadVals: Array<number | null> = []
                const seenKeys = new Set<string>()
                for (const { label, value } of oldInvMapped) {
                  const trimmed = label.trim()
                  if (!trimmed || isMeetingOutboundExcludedBeanName(trimmed)) {
                    continue
                  }
                  const key = meetingBeanMergeKey(trimmed)
                  if (stockBeanKeySet.has(key) || seenKeys.has(key)) {
                    continue
                  }
                  seenKeys.add(key)
                  invHeadVals.push(value)
                }
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
  }, [pageState.activeMonth, mode, activeCompanyId, inventoryLinkTick, isStorageReady])

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

  const summaryCostBucketExpenseLines = useMemo(() => {
    const emptyLists: Record<MeetingCostsExpenseBucketKey, OtherCostBucketExpenseEntry[]> = {
      '②기타': [],
      '②기타경비': [],
      '②운영경비': [],
    }
    if (!isStorageReady) {
      return emptyLists
    }
    const records = expenseRecordsForMeetingLink
    const ym = meetingMonthLabelToExpenseYm(activeMonth, records)
    if (!ym) {
      return emptyLists
    }
    return {
      '②기타': gatherExpenseMeetingBucketEntries(records, ym, '②기타'),
      '②기타경비': gatherExpenseMeetingBucketEntries(records, ym, '②기타경비'),
      '②운영경비': gatherExpenseMeetingBucketEntries(records, ym, '②운영경비'),
    }
  }, [activeMonth, expenseRecordsForMeetingLink, isStorageReady])

  const beanMaterialMeetingResultForActiveMonth = useMemo(() => {
    if (!isStorageReady) {
      return null
    }
    const records = expenseRecordsForMeetingLink
    const ym = meetingMonthLabelToExpenseYm(activeMonth, records)
    if (!ym) {
      return null
    }
    const stmtAll = parseMeetingStatementDeliveryRecords()
    const stmMonth = filterStatementsByYmDelivery(stmtAll, ym)
    const inv = readMeetingInventoryForBeanMaterial(mode, activeCompanyId)
    return computeBeanSalesMaterialCostForYm(ym, stmMonth, inv, { mode, companyId: activeCompanyId })
  }, [
    activeMonth,
    expenseRecordsForMeetingLink,
    isStorageReady,
    mode,
    activeCompanyId,
    statementRecordsStorageRev,
    inventoryLinkTick,
    beanMeetingMaterialDepsRev,
  ])

  const meetingCostDetailModalSortedEntries = useMemo(() => {
    if (!meetingCostDetailModal) {
      return []
    }
    if (meetingCostDetailModal.kind === 'expense') {
      return sortExpenseBreakdownEntries(
        summaryCostBucketExpenseLines[meetingCostDetailModal.bucket],
        expenseBreakdownSortKey,
        expenseBreakdownSortDir,
      )
    }
    const lines = beanMaterialMeetingResultForActiveMonth?.lines ?? []
    return sortExpenseBreakdownEntries(
      beanMaterialMeetingLinesToBreakdownEntries(lines),
      expenseBreakdownSortKey,
      expenseBreakdownSortDir,
    )
  }, [
    beanMaterialMeetingResultForActiveMonth,
    expenseBreakdownSortDir,
    expenseBreakdownSortKey,
    meetingCostDetailModal,
    summaryCostBucketExpenseLines,
  ])

  useEffect(() => {
    setExpenseBreakdownSortKey('amount')
    setExpenseBreakdownSortDir('desc')
  }, [meetingCostDetailModal])

  useEffect(() => {
    setMeetingCostDetailModal(null)
  }, [activeMonth])

  const expenseBreakdownSortDirHintLine = useMemo(() => {
    if (expenseBreakdownSortKey === 'date') {
      return expenseBreakdownSortDir === 'asc' ? '오래된 지출부터 (과거 → 최근)' : '가까운 지출부터 (최근 → 과거)'
    }
    if (expenseBreakdownSortKey === 'name') {
      return expenseBreakdownSortDir === 'asc' ? '이름 순 (ㄱㄴㄷ…)' : '이름 역순'
    }
    return expenseBreakdownSortDir === 'desc' ? '금액 큰 순' : '금액 작은 순'
  }, [expenseBreakdownSortDir, expenseBreakdownSortKey])

  const handleExpenseBreakdownSortPick = (key: MeetingExpenseBreakdownSortKey) => {
    if (key === expenseBreakdownSortKey) {
      setExpenseBreakdownSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setExpenseBreakdownSortKey(key)
    setExpenseBreakdownSortDir(key === 'amount' ? 'desc' : 'asc')
  }

  const summaryCostsExpenseBreakdownModal = useMemo(
    () => ({
      matchesRow: (row: MeetingValueRow, _rowIndex: number) => resolveMonthlyMeetingCostBreakdownTarget(row) != null,
      onOpenModal: (row: MeetingValueRow, _rowIndex: number) => {
        const target = resolveMonthlyMeetingCostBreakdownTarget(row)
        if (target) {
          setMeetingCostDetailModal(target)
        }
      },
    }),
    [],
  )

  const summaryCostsAmountInputTitle = useCallback((row: MeetingValueRow): string | undefined => {
    return expenseSyncedMeetingCostAmountHint(row)
  }, [])

  const computedRoastingSales = useMemo(
    () => computeRoastingSales(data.roastingSales),
    [data.roastingSales],
  )

  const computedCurrentMonthSales = useMemo(
    () => computeCurrentMonthSales(activeMonthState.currentMonthSales, computedCurrentMonthCosts, computedRoastingSales),
    [activeMonthState.currentMonthSales, computedCurrentMonthCosts, computedRoastingSales],
  )

  const computedStoreSales = useMemo(
    () => computeStoreSales(activeMonthState.storeSales),
    [activeMonthState.storeSales],
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
      getMeetingOutboundCashflow(computedCurrentMonthCosts, computedRoastingSales),
    [computedCurrentMonthCosts, computedRoastingSales],
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

  const productionReadRows = useMemo(
    () =>
      buildMeetingKgReadRows(data.productionColumns, activeMonthState.productionRow.values, {
        hideZero: true,
        aggregateColumnIndex: outboundAggregateColumnIndex,
      }),
    [data.productionColumns, activeMonthState.productionRow.values, outboundAggregateColumnIndex],
  )

  const inventoryReadRows = useMemo(
    () =>
      buildMeetingKgReadRows(data.inventoryColumns, computedInventoryRow.values, {
        hideZero: true,
        aggregateColumnIndex: -1,
      }),
    [data.inventoryColumns, computedInventoryRow.values],
  )

  const outboundSummaryKg = useMemo(() => {
    if (outboundAggregateColumnIndex >= 0) {
      const v = activeMonthState.productionRow.values[outboundAggregateColumnIndex]
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    return sumValues(activeMonthState.productionRow.values)
  }, [activeMonthState.productionRow.values, outboundAggregateColumnIndex])

  const inventoryTotalKg = useMemo(
    () => sumValues(computedInventoryRow.values),
    [computedInventoryRow.values],
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
      if (isRoastFixedBlockRow(row)) {
        return true
      }
      const v = row.january
      return v !== null && v !== 0 && Number.isFinite(v)
    })
  }, [computedRoastingSales, sectionEditModes.roasting])

  /**
   * 입출고 상단「기말 합」과 맞춤: 기준일·원두별 stock 합(저장된 beanRows 기준).
   * 재고현황 표에는 수동 열·생두 열이 같이 있어 `values` 전체 합은 생두 합과 달랐음.
   */
  const inventoryStockTotalKgForOverview = useMemo(() => {
    try {
      const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
      const inventoryRaw = window.localStorage.getItem(key)
      if (!inventoryRaw) {
        return null
      }
      const parsed = JSON.parse(inventoryRaw) as InventoryStorageState
      const inventoryMonth = parseMonthLabel(parsed.referenceDate)
      if (!inventoryMonth || inventoryMonth !== activeMonth) {
        return null
      }
      const refDate = typeof parsed.referenceDate === 'string' ? parsed.referenceDate : ''
      if (refDate.length < 10) {
        return null
      }
      const rows = getInventoryBeanStockSummaries(parsed.beanRows, parsed.days, refDate)
      if (rows.length === 0) {
        return null
      }
      return sumValues(rows.map((r) => r.stockAtReference))
    } catch {
      return null
    }
  }, [activeMonth, mode, activeCompanyId, inventoryLinkTick])

  const activeOverview = useMemo(() => {
    const costs = computedCurrentMonthCosts
    const costGrand = costs.find((row) => isCostGrandRow(row))?.amount ?? 0
    const inventoryTotalKg = inventoryStockTotalKgForOverview ?? sumValues(computedInventoryRow.values)
    return [
      { label: `${activeMonth} 입금 합계`, value: inboundCashflow.totalIn, unit: 'won' as const },
      { label: `${activeMonth} 입출금 순손익`, value: cashflowPl.net, unit: 'won' as const },
      {
        label: `${activeMonth} 입출금 순손익율`,
        value: cashflowPl.netCashMarginRatio,
        unit: 'ratio' as const,
      },
      { label: `${activeMonth} 비용계`, value: costGrand, unit: 'won' as const },
      { label: `${activeMonth} 재료비`, value: pickCostLineAmount(costs, '①재료비'), unit: 'won' as const },
      {
        label: `${activeMonth} 재료비(매출·생두)`,
        value: pickCostLineAmount(costs, MEETING_BEAN_MATERIAL_BUCKET_KEY),
        unit: 'won' as const,
      },
      { label: `${activeMonth} 기타경비`, value: pickCostLineAmount(costs, '②기타경비'), unit: 'won' as const },
      { label: `${activeMonth} 운영경비`, value: pickCostLineAmount(costs, '②운영경비'), unit: 'won' as const },
      { label: `${activeMonth} 인건비`, value: pickCostLineAmount(costs, '⑧인건비'), unit: 'won' as const },
      { label: `${activeMonth} 재고 합계`, value: inventoryTotalKg, unit: 'kg' as const },
    ]
  }, [
    activeMonth,
    cashflowPl.net,
    cashflowPl.netCashMarginRatio,
    computedCurrentMonthCosts,
    computedInventoryRow,
    inboundCashflow.totalIn,
    inventoryStockTotalKgForOverview,
  ])

  const updateData = (updater: (current: MonthlyMeetingData) => MonthlyMeetingData) => {
    setPageState((current) => ({
      ...current,
      data: updater(current.data),
    }))
  }

  const updateValueRow = (
    section: 'currentMonthSales' | 'currentMonthCosts',
    rowIndex: number,
    value: string,
  ) => {
    updateMonthState((current) => {
      const rows = current[section]
      const targetRow = rows[rowIndex]
      if (
        section === 'currentMonthCosts' &&
        targetRow &&
        isExpenseSheetFedCostAmountRow(targetRow)
      ) {
        return current
      }
      return {
        ...current,
        [section]: rows.map((row, index) =>
          index === rowIndex ? { ...row, amount: parseNullableNumber(value) } : row,
        ),
      }
    })
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
    section: 'currentMonthSales' | 'currentMonthCosts',
    rowIndex: number,
    value: string,
  ) => {
    const next = stripLeadingIndexFromLabel(value)
    updateMonthState((current) => ({
      ...current,
      [section]: current[section].map((row, index) =>
        index === rowIndex ? { ...row, label: next } : row,
      ),
    }))
  }

  const updateRowLabel = (
    section: 'roastingSales',
    rowIndex: number,
    value: string,
  ) => {
    const next = stripLeadingIndexFromLabel(value)
    updateData((current) => ({
      ...current,
      [section]: current[section].map((row, index) =>
        index === rowIndex ? { ...row, label: next } : row,
      ),
    }))
  }

  const addMonthStateRow = (section: 'currentMonthSales' | 'currentMonthCosts', label: string) => {
    updateMonthState((current) => {
      const rows = current[section]
      const insertIndex =
        section === 'currentMonthSales'
          ? rows.findIndex((row) => isComputedSalesRow(row))
          : rows.findIndex((row) => isCostGrandRow(row))

      const nextRows = [...rows]
      nextRows.splice(insertIndex === -1 ? nextRows.length : insertIndex, 0, createEmptyValueRow(label))

      return {
        ...current,
        [section]: nextRows,
      }
    })
  }

  const removeMonthStateRow = (section: 'currentMonthSales' | 'currentMonthCosts', rowIndex: number) => {
    updateMonthState((current) => ({
      ...current,
      [section]: current[section].filter((_, index) => index !== rowIndex),
    }))
  }

  const addRoastingSalesRow = () => {
    updateData((current) => {
      const insertIndex = current.roastingSales.findIndex((row) => isRoastSubtotalRow(row))
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
      const roastingComputedExport = computeRoastingSales(data.roastingSales)
      const monthSales = computeCurrentMonthSales(monthState.currentMonthSales, monthCosts, roastingComputedExport)
      const storeSales = computeStoreSales(monthState.storeSales)
      const inboundParts = buildMeetingInboundCashflowParts(
        monthSales,
        roastingComputedExport,
        storeSales,
      )
      const outboundCf = getMeetingOutboundCashflow(monthCosts, roastingComputedExport)
      const plCf = getMeetingCashflowPl(inboundParts.totalIn, outboundCf.totalOut)
      const inventoryRow = computeInventoryRow(monthState.inventoryRow)
      const notes = notesByMonth[month] ?? { summary: '', actions: '' }

      return [
        [`[${month} 마감회의]`, '', '', ''],
        ['매장명', data.storeName, '회의 제목', data.title],
        ['월', month, '', ''],
        [],
        ['1. 당월 매출', '', '', ''],
        ['번호', '항목', '금액', '점유비', ''],
        ...monthSales.map((row, rowIndex) => [
          meetingValueRowIndexText(monthSales, rowIndex, 'sales'),
          row.label,
          excelCellAmount(row.amount),
          excelCellShare(row.share),
          '',
        ]),
        [],
        ['1-1. 당월 비용현황', '', '', ''],
        ['번호', '항목', '금액', '점유비', ''],
        ...monthCosts.map((row, rowIndex) => [
          meetingValueRowIndexText(monthCosts, rowIndex, 'costs'),
          row.label,
          excelCellAmount(row.amount),
          excelCellShare(row.share),
          '',
        ]),
        [],
        ...buildInboundCashflowExcelRows(inboundParts),
        [],
        ...buildOutboundCashflowExcelRows(outboundCf),
        [],
        ['1-4. 입출금·손익 요약', '', '', ''],
        ['구분', '금액', '', ''],
        ['입금 합계', excelCellAmount(plCf.totalIn), '', ''],
        ['출금 합계', excelCellAmount(plCf.totalOut), '', ''],
        ['입출금 순손익 (입금 합계 − 출금 합계)', excelCellAmount(plCf.net), '', ''],
        [
          '입출금 순손익율 (순손익 ÷ 입금 합계)',
          plCf.netCashMarginRatio == null ? '' : excelCellShare(plCf.netCashMarginRatio),
          '',
          '',
        ],
        [],
        ['2. 로스팅실 매출 및 생두비용현황', '', '', ''],
        ['번호', '거래처명', roastingSalesMonthHeaderLabel, '점유비'],
        ...computeRoastingSales(data.roastingSales).map((row, rowIndex) => [
          meetingRoastRowIndexText(data.roastingSales, rowIndex),
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

  const closePiTableModal = () => setPiTableModal(null)
  const closeMeetingCostDetailModal = () => setMeetingCostDetailModal(null)

  const renderOutboundDataTable = () => (
    <>
      {productionInventoryEditMode ? (
        <div className="meeting-pi-wide-table-in-modal">
          <table className="meeting-table meeting-table-compact">
            <thead>
              <tr>
                <th>월</th>
                {visibleOutboundColumnIndices.map((index) => {
                  const column = data.productionColumns[index]
                  return (
                    <th key={`modal-production-column-${index}`}>
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
                    <td key={`modal-${activeMonth}-production-${index}`}>
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
      ) : (
        <div className="meeting-kg-read-list meeting-kg-read-list--in-modal">
          <p className="meeting-kg-read-month-label muted tiny">{activeMonth} 출고(kg)</p>
          {productionReadRows.length === 0 ? (
            <p className="muted tiny">0이 아닌 출고가 없습니다.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>품목</th>
                  <th className="meeting-kg-read-amount">kg</th>
                </tr>
              </thead>
              <tbody>
                {productionReadRows.map((row) => (
                  <tr
                    key={`out-modal-read-${row.displayLabel}`}
                    title={
                      row.merged
                        ? '이름이 같은 열이 여러 개 있어 읽기 화면에서만 합친 수치입니다.'
                        : undefined
                    }
                  >
                    <td>
                      {row.displayLabel}
                      {row.merged ? (
                        <span
                          className="meeting-kg-read-merge-mark"
                          title="같은 이름 열을 합침"
                          aria-label="(합침)"
                        >
                          *
                        </span>
                      ) : null}
                    </td>
                    <td className="meeting-kg-read-amount">
                      {meetingAmountDisplayFormatter.format(row.kg)} kg
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )

  const renderInventoryDataTable = () => (
    <>
      {productionInventoryEditMode ? (
        <div className="meeting-pi-wide-table-in-modal">
          <table className="meeting-table meeting-table-compact">
            <thead>
              <tr>
                <th>월</th>
                {data.inventoryColumns.map((column, index) => (
                  <th key={`modal-inventory-column-${index}`}>
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
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{activeMonth}</td>
                {computedInventoryRow.values.map((value, index) => (
                  <td key={`modal-${activeMonth}-inventory-${index}`}>
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
      ) : (
        <div className="meeting-kg-read-list meeting-kg-read-list--in-modal">
          <p className="meeting-kg-read-month-label muted tiny">{activeMonth} 재고(kg)</p>
          {inventoryReadRows.length === 0 ? (
            <p className="muted tiny">0이 아닌 재고가 없습니다.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>품목</th>
                  <th className="meeting-kg-read-amount">kg</th>
                </tr>
              </thead>
              <tbody>
                {inventoryReadRows.map((row) => (
                  <tr
                    key={`inv-modal-read-${row.displayLabel}`}
                    title={
                      row.merged
                        ? '이름이 같은 열이 여러 개 있어 읽기 화면에서만 합친 수치입니다.'
                        : undefined
                    }
                  >
                    <td>
                      {row.displayLabel}
                      {row.merged ? (
                        <span
                          className="meeting-kg-read-merge-mark"
                          title="같은 이름 열을 합침"
                          aria-label="(합침)"
                        >
                          *
                        </span>
                      ) : null}
                    </td>
                    <td className="meeting-kg-read-amount">
                      {meetingAmountDisplayFormatter.format(row.kg)} kg
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )

  return (
    <>
      <main
        className="meeting-layout"
        onBlurCapture={(event: FocusEvent<HTMLElement>) => {
          const target = event.target
          const isEditable =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement
          if (!isEditable) {
            return
          }
          if (mode !== 'cloud' || !activeCompanyId || !isStorageReady || !isCloudReady) {
            return
          }
          flushMonthlyMeetingCloudSaveOnEditableBlur()
        }}
      >
        <div className="meeting-page-hero-rehome no-print" aria-label="회의 요약">
          <h2 className="meeting-page-hero-rehome-heading">{data.title}</h2>
          <div className="hero-metrics meeting-hero-metrics">
            {activeOverview.map((metric) => (
              <div key={metric.label} className="metric-card">
                <span>{metric.label}</span>
                <strong>
                  {metric.value === null
                    ? '-'
                    : metric.unit === 'kg'
                      ? `${meetingAmountDisplayFormatter.format(metric.value)} kg`
                      : metric.unit === 'ratio'
                        ? formatSharePercent(metric.value)
                        : formatMoney(metric.value)}
                </strong>
              </div>
            ))}
          </div>
          <div className="hero-meta-row">
            <span className="page-hero-pill">{mode === 'cloud' ? '회사 공용 회의 문서' : '이 브라우저 회의 문서'}</span>
            <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
          </div>
        </div>
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
            <MeetingSummaryValueCard
              tableId="summary-sales"
              title="매출"
              newRowButtonLabel="항목 추가"
              rows={computedCurrentMonthSales}
              showShareColumn
              editMode={summaryEditMode}
              indexKind="sales"
              isAmountReadonly={isComputedSalesRow}
              onAddRow={() => addMonthStateRow('currentMonthSales', '새 매출 항목')}
              onLabelChange={(i, v) => updateMonthStateLabel('currentMonthSales', i, v)}
              onValueChange={(i, v) => updateValueRow('currentMonthSales', i, v)}
              onRemoveRow={(i) => removeMonthStateRow('currentMonthSales', i)}
            />
            <MeetingSummaryValueCard
              tableId="summary-costs"
              title="비용 현황"
              newRowButtonLabel="항목 추가"
              rows={computedCurrentMonthCosts}
              showShareColumn
              editMode={summaryEditMode}
              indexKind="costs"
              isAmountReadonly={(row) => isCostGrandRow(row) || isExpenseSheetFedCostAmountRow(row)}
              shouldShowRemoveRowButton={(row) => !isCostGrandRow(row)}
              rowExpenseBreakdownModal={summaryCostsExpenseBreakdownModal}
              amountInputTitle={summaryCostsAmountInputTitle}
              onAddRow={() => addMonthStateRow('currentMonthCosts', '새 비용 항목')}
              onLabelChange={(i, v) => updateMonthStateLabel('currentMonthCosts', i, v)}
              onValueChange={(i, v) => updateValueRow('currentMonthCosts', i, v)}
              onRemoveRow={(i) => removeMonthStateRow('currentMonthCosts', i)}
            />
          </div>

          <div className="meeting-summary-cashflow">
                <p className="meeting-cashflow-hint">
                  당월 매출(결제), 로스팅실 집계 월 거래처 매출, 매장 전체 판매(홀·배달·간편배달)을 합산한 입금
                  합계입니다. 점유비는 각 구간 안에서만 나눈 비율입니다(당월 결제끼리, 로스팅 거래처끼리, 매장 채널끼리 합이
                  100%). 출금은 위 「비용 현황」표의 ⑨(비용 합계)를 제외한 각 항목 금액, 로스팅실 생두비용(별도 반영
                  시)을 더한 값이며, 맨 아래 출금 합계에 표시됩니다(생두비용이 비용 표 ⑨에 이미 포함되면 이중 합산되지
                  않도록 한 줄을 생략합니다).
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
                          <td colSpan={2}>비용 현황 (⑨ 비용 합계 제외)</td>
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
                      <tr>
                        <th scope="row">입출금 순손익율 (순손익 ÷ 입금 합계)</th>
                        <td>
                          {cashflowPl.netCashMarginRatio == null
                            ? '—'
                            : formatSharePercent(cashflowPl.netCashMarginRatio)}
                        </td>
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
                      <th className="meeting-col-idx">번호</th>
                      <th>거래처명</th>
                      <th>{roastingSalesMonthHeaderLabel}</th>
                      <th>점유비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roastingSalesDisplayRows.map(({ row, rowIndex }, displayIdx) => (
                      <Fragment key={`roasting-sales-block-${rowIndex}`}>
                        {displayIdx > 0 &&
                        isRoastFixedBlockRow(row) &&
                        !isRoastFixedBlockRow(roastingSalesDisplayRows[displayIdx - 1]!.row) ? (
                          <tr className="meeting-cashflow-section-row">
                            <td colSpan={4}>집계 · 생두 · 손익</td>
                          </tr>
                        ) : null}
                        <tr>
                        <td className="meeting-col-idx" title="자동">
                          {meetingRoastDisplayIndexText(roastingSalesDisplayRows, displayIdx)}
                        </td>
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
                              {isRoastClientRow(row) ? (
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
                              isRoastReadonlyAmountRow(row)
                                ? 'meeting-cell-input meeting-cell-input-readonly'
                                : 'meeting-cell-input'
                            }
                            type="text"
                            inputMode="numeric"
                            value={formatAmountForInput(row.january)}
                            readOnly={isRoastReadonlyAmountRow(row)}
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
              입출고 <strong>기준일</strong>이 <strong>{activeMonth}</strong>이면 수치가 맞춰집니다. 품목별 세부는{' '}
              <strong>출고 표 보기 / 재고 표 보기</strong>를 눌러 모달에서 확인하세요.
            </p>
            <article className="meeting-card meeting-pi-article">
              <div className="meeting-card-header">
                <h3>{activeMonth} 출고현황</h3>
              </div>
              <div className="meeting-pi-surface" aria-label={`${activeMonth} 출고 요약`}>
                <div className="meeting-pi-surface-row">
                  <div className="meeting-pi-surface-metric">
                    <span className="meeting-pi-surface-metric-label">출고 합계(첫 열·합계 기준)</span>
                    <span className="meeting-pi-surface-metric-value">
                      {meetingAmountDisplayFormatter.format(outboundSummaryKg)} kg
                    </span>
                  </div>
                  {!productionInventoryEditMode && productionReadRows.length > 0 ? (
                    <div className="meeting-pi-surface-metric">
                      <span className="meeting-pi-surface-metric-label">0제외 품목(읽기)</span>
                      <span className="meeting-pi-surface-metric-value">{productionReadRows.length}건</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="meeting-pi-open-table-button"
                  onClick={() => setPiTableModal('outbound')}
                >
                  출고 {productionInventoryEditMode ? '입력' : '표'} 열기
                </button>
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

            <article className="meeting-card meeting-pi-article">
              <div className="meeting-card-header">
                <h3>{activeMonth} 재고현황</h3>
              </div>
              <div className="meeting-pi-surface" aria-label={`${activeMonth} 재고 요약`}>
                <div className="meeting-pi-surface-row">
                  <div className="meeting-pi-surface-metric">
                    <span className="meeting-pi-surface-metric-label">재고 열 합(참고)</span>
                    <span className="meeting-pi-surface-metric-value">
                      {meetingAmountDisplayFormatter.format(inventoryTotalKg)} kg
                    </span>
                  </div>
                  {!productionInventoryEditMode && inventoryReadRows.length > 0 ? (
                    <div className="meeting-pi-surface-metric">
                      <span className="meeting-pi-surface-metric-label">0제외 품목(읽기)</span>
                      <span className="meeting-pi-surface-metric-value">{inventoryReadRows.length}건</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="meeting-pi-open-table-button"
                  onClick={() => setPiTableModal('inventory')}
                >
                  재고 {productionInventoryEditMode ? '입력' : '표'} 열기
                </button>
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

      {piTableModal ? (
        <div
          className="meeting-pi-table-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={
            piTableModal === 'outbound' ? 'meeting-pi-modal-outbound-title' : 'meeting-pi-modal-inventory-title'
          }
          onClick={closePiTableModal}
        >
          <div
            className="meeting-pi-table-modal"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            {piTableModal === 'outbound' ? (
              <>
                <div className="meeting-pi-table-modal-top">
                  <h2 className="meeting-pi-table-modal-title" id="meeting-pi-modal-outbound-title">
                    {activeMonth} 출고현황
                  </h2>
                  <div className="meeting-pi-table-modal-actions">
                    {productionInventoryEditMode ? (
                      <button
                        type="button"
                        className="ghost-button meeting-mini-button"
                        onClick={() => addStructuredColumn('productionColumns')}
                      >
                        품목 추가
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="meeting-pi-table-modal-close"
                      onClick={closePiTableModal}
                      aria-label="닫기"
                    >
                      닫기
                    </button>
                  </div>
                </div>
                <p className="muted tiny meeting-pi-table-modal-hint">
                  첫 열은 출고 합계, 이어서 품목(생두)별 출고가 붙습니다. 입출고 동기면 재고·생두 열이 겹쳐 보일 수 있어,
                  읽기에서는 같은 이름 열의 kg을 한 줄로 합칩니다. 열을 나누려면 <strong>수정</strong>에서 이름을 구분하세요.
                </p>
                <div className="meeting-pi-table-modal-body">{renderOutboundDataTable()}</div>
              </>
            ) : (
              <>
                <div className="meeting-pi-table-modal-top">
                  <h2 className="meeting-pi-table-modal-title" id="meeting-pi-modal-inventory-title">
                    {activeMonth} 재고현황
                  </h2>
                  <div className="meeting-pi-table-modal-actions">
                    {productionInventoryEditMode ? (
                      <button
                        type="button"
                        className="ghost-button meeting-mini-button"
                        onClick={() => addStructuredColumn('inventoryColumns')}
                      >
                        항목 추가
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="meeting-pi-table-modal-close"
                      onClick={closePiTableModal}
                      aria-label="닫기"
                    >
                      닫기
                    </button>
                  </div>
                </div>
                <p className="muted tiny meeting-pi-table-modal-hint">
                  끝 열에 품목(생두)별 기준일 재고가 붙을 수 있습니다. 읽기에서는 0kg 열을 숨기고, 같은 품목명이면 kg만
                  합칩니다.
                </p>
                <div className="meeting-pi-table-modal-body">{renderInventoryDataTable()}</div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {meetingCostDetailModal ? (
        <div
          className="meeting-pi-table-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="meeting-cost-breakdown-modal-title"
          onClick={closeMeetingCostDetailModal}
        >
          <div
            className="meeting-pi-table-modal meeting-cost-breakdown-modal"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="meeting-pi-table-modal-top">
              <h2 className="meeting-pi-table-modal-title" id="meeting-cost-breakdown-modal-title">
                {activeMonth}{' '}
                {meetingCostDetailModal.kind === 'expense'
                  ? MEETING_COST_BUCKET_LABEL_FALLBACK[meetingCostDetailModal.bucket]
                  : MEETING_COST_BUCKET_LABEL_FALLBACK[MEETING_BEAN_MATERIAL_BUCKET_KEY]}{' '}
                · 포함 내역
              </h2>
              <div className="meeting-pi-table-modal-actions">
                <button
                  type="button"
                  className="meeting-pi-table-modal-close"
                  onClick={closeMeetingCostDetailModal}
                  aria-label="닫기"
                >
                  닫기
                </button>
              </div>
            </div>
            <p className="muted tiny meeting-pi-table-modal-hint">
              {meetingCostDetailModal.kind === 'expense'
                ? MEETING_COST_BREAKDOWN_MODAL_COPY[meetingCostDetailModal.bucket].hint
                : MEETING_BEAN_MATERIAL_MODAL_COPY.hint}
            </p>
            <div className="meeting-breakdown-sort-bar" role="toolbar" aria-label="내역 정렬">
              <span className="meeting-breakdown-sort-bar-label">정렬 기준</span>
              <div className="segmented meeting-breakdown-sort-segmented">
                <button
                  type="button"
                  className={expenseBreakdownSortKey === 'date' ? 'active' : ''}
                  aria-pressed={expenseBreakdownSortKey === 'date'}
                  aria-label="날짜 순으로 정렬. 다시 누르면 오름차순·내림차순을 바꿉니다."
                  onClick={() => handleExpenseBreakdownSortPick('date')}
                >
                  날짜
                </button>
                <button
                  type="button"
                  className={expenseBreakdownSortKey === 'name' ? 'active' : ''}
                  aria-pressed={expenseBreakdownSortKey === 'name'}
                  aria-label={meetingCostDetailModal.kind === 'expense' ? '거래처·내역 이름 순 정렬' : '원두(입출고명) 순 정렬'}
                  onClick={() => handleExpenseBreakdownSortPick('name')}
                >
                  이름
                </button>
                <button
                  type="button"
                  className={expenseBreakdownSortKey === 'amount' ? 'active' : ''}
                  aria-pressed={expenseBreakdownSortKey === 'amount'}
                  aria-label={
                    meetingCostDetailModal.kind === 'expense' ? '지출 금액 순 정렬' : '추정 금액 순 정렬'
                  }
                  onClick={() => handleExpenseBreakdownSortPick('amount')}
                >
                  금액
                </button>
              </div>
              <span className="muted tiny meeting-breakdown-sort-bar-hint" aria-live="polite">
                현재 순서: <strong>{expenseBreakdownSortDirHintLine}</strong>
              </span>
            </div>
            <div className="meeting-pi-table-modal-body">
              <div className="meeting-breakdown-panel meeting-breakdown-panel--in-modal-body">
                {meetingCostDetailModal.kind === 'expense'
                  ? renderExpenseBucketLinesList(
                      meetingCostDetailModalSortedEntries,
                      MEETING_COST_BREAKDOWN_MODAL_COPY[meetingCostDetailModal.bucket].caption,
                      MEETING_COST_BREAKDOWN_MODAL_COPY[meetingCostDetailModal.bucket].empty,
                    )
                  : renderExpenseBucketLinesList(
                      meetingCostDetailModalSortedEntries,
                      MEETING_BEAN_MATERIAL_MODAL_COPY.caption,
                      MEETING_BEAN_MATERIAL_MODAL_COPY.empty,
                      '원두별 매출 분석에서 동일 규칙으로 품목별 금액을 확인할 수 있습니다.',
                    )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

export default MonthlyMeetingPage
