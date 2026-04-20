import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import PageSaveStatus from './components/PageSaveStatus'
import {
  BLENDING_DARK_BEAN_NAME,
  isBlendingDarkBeanRow,
  isBlendingLightBeanRow,
  isBlendingOutboundAdjustsStockRow,
  productionForAutoStock,
} from './inventoryBlendRecipes'
import {
  createDefaultInventoryStatusState,
  createZeroedInventoryStatusFrom,
  dayIndexForReferenceDate,
  normalizeInventoryStatusState,
  parseInventoryWorkbook,
  todayLocalIsoDateString,
  type InventoryBeanRow,
  type InventoryStatusState,
} from './inventoryStatusUtils'
import { ADMIN_FOUR_DIGIT_PIN } from './adminPin'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export const INVENTORY_STATUS_STORAGE_KEY = 'inventory-status-v1'
export const INVENTORY_STATUS_BASELINE_STORAGE_KEY = 'inventory-status-baseline-v1'
export const INVENTORY_STATUS_TEMPLATE_STORAGE_KEY = 'inventory-status-template-v1'
export const INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY = 'inventory-status-template-name-v1'
export const INVENTORY_AUTO_STOCK_MODE_KEY = 'inventory-auto-stock-mode-v1'
const INVENTORY_HISTORY_NOTES_STORAGE_KEY = 'inventory-history-notes-v1'

type FullResetOptions = {
  /** 생두·로스팅 표 수치 전부 0 (구조·품목명·날짜는 유지). 엑셀 업로드 기준이 있으면 그 baseline은 유지 */
  tableData: boolean
  template: boolean
  notes: boolean
  uiFilters: boolean
  stockInputMode: boolean
}

const DEFAULT_FULL_RESET_OPTIONS: FullResetOptions = {
  tableData: true,
  template: false,
  notes: false,
  uiFilters: false,
  stockInputMode: true,
}

const numberFormatter = new Intl.NumberFormat('ko-KR')
const SHEET_OPTIONS = [
  { id: 'beans', label: '생두전체현황' },
  { id: 'roasting', label: '로스팅현황' },
] as const
const DEFAULT_ROAST_YIELD = 0.8

const formatNumber = (value: number) => numberFormatter.format(value)

/** type=number에서 0을 보이면 다음 입력이 "03"처럼 붙음 → 0은 빈칸으로 표시 */
const inventoryNumericInputValue = (value: number) => (value === 0 ? '' : String(value))

const sumValues = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const convertRawInputToRoastedOutput = (value: number) =>
  Math.round(value * DEFAULT_ROAST_YIELD * 1000) / 1000
const convertRoastedOutputToRawInput = (value: number) =>
  Math.round((value / DEFAULT_ROAST_YIELD) * 1000) / 1000

/** 엑셀 열 개수(기준일 수)와 맞추기 — 길이가 어긋나면 이후 열이 밀려 보이는 문제 방지 */
const alignBeanValuesToDayCount = (values: readonly number[], dayCount: number): number[] =>
  Array.from({ length: dayCount }, (_, index) => values[index] ?? 0)

const alignRoastingValuesToColumnCount = (values: readonly number[], columnCount: number): number[] =>
  Array.from({ length: columnCount }, (_, index) => values[index] ?? 0)

const formatTwoDecimals = (value: number) =>
  Number.isInteger(value)
    ? formatNumber(value)
    : value.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const normalizeNameKey = (value: string) => value.trim().toLowerCase()


/** 일자별 상세 주간 보기: 로스팅 주차와 동일 구간 */
const BEAN_DETAIL_WEEK_RANGES = [
  { key: '1-7', label: '1–7일', start: 1, end: 7 },
  { key: '8-14', label: '8–14일', start: 8, end: 14 },
  { key: '15-21', label: '15–21일', start: 15, end: 21 },
  { key: '22-28', label: '22–28일', start: 22, end: 28 },
  { key: '29-31', label: '29–31일', start: 29, end: 31 },
] as const

const sumBeanValuesForWeek = (
  days: readonly number[],
  values: readonly number[],
  start: number,
  end: number,
) => {
  let total = 0
  for (let i = 0; i < days.length; i++) {
    const d = days[i] ?? 0
    if (d >= start && d <= end) {
      total += values[i] ?? 0
    }
  }
  return total
}

/** 해당 주 구간에 포함되는 일자 중 가장 늦은 날의 값(주말 재고 등) */
const lastBeanValueForWeek = (
  days: readonly number[],
  values: readonly number[],
  start: number,
  end: number,
) => {
  let bestDay = -1
  let bestVal = 0
  for (let i = 0; i < days.length; i++) {
    const d = days[i] ?? 0
    if (d < start || d > end) {
      continue
    }
    if (d >= bestDay) {
      bestDay = d
      bestVal = values[i] ?? 0
    }
  }
  return bestVal
}

type BeanDetailViewMode = 'daily' | 'weekly'

const buildBeanWeeklyDetailRows = (days: readonly number[], bean: InventoryBeanRow) => {
  const inbound = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    sumBeanValuesForWeek(days, bean.inbound, start, end),
  )
  const productionRaw = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    sumBeanValuesForWeek(days, bean.production, start, end),
  )
  const roasted = productionRaw.map((v) => convertRawInputToRoastedOutput(v))
  const outbound = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    sumBeanValuesForWeek(days, bean.outbound, start, end),
  )
  const stock = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    lastBeanValueForWeek(days, bean.stock, start, end),
  )
  return [
    { label: '입고', key: 'inbound' as const, values: inbound },
    { label: '생산 결과량', key: 'production' as const, values: roasted },
    { label: '출고', key: 'outbound' as const, values: outbound },
    { label: '환산 생두 사용량', key: 'raw-usage' as const, values: productionRaw },
    { label: '재고', key: 'stock' as const, values: stock },
  ]
}

const getHeatLevel = (value: number, maxValue: number) => {
  if (value <= 0 || maxValue <= 0) {
    return 'heat-0'
  }
  const ratio = value / maxValue
  if (ratio >= 0.75) {
    return 'heat-4'
  }
  if (ratio >= 0.5) {
    return 'heat-3'
  }
  if (ratio >= 0.25) {
    return 'heat-2'
  }
  return 'heat-1'
}

const formatReferenceDate = (value: string) => {
  const [year, month, day] = value.split('-')
  return `${year}.${month}.${day}`
}

const formatFileDate = (value: string) => value || new Date().toISOString().slice(0, 10)

/** 표시 월이 이번 달이면 오늘 일자, 아니면 기준일(또는 그 이후 첫 일자) — 일별 가로 스크롤 앵커 */
const pickScrollAnchorCalendarDay = (referenceDate: string, days: readonly number[]): number | null => {
  const sorted = [...days].filter((x) => Number.isFinite(x) && x >= 1 && x <= 31).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  const refYM = referenceDate.slice(0, 7)
  const now = new Date()
  const nowYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  if (refYM === nowYM) {
    const td = now.getDate()
    if (sorted.includes(td)) {
      return td
    }
    const next = sorted.find((d) => d >= td)
    if (next !== undefined) {
      return next
    }
    return sorted[sorted.length - 1] ?? null
  }
  const refD = Number(referenceDate.slice(8, 10))
  if (Number.isFinite(refD) && sorted.includes(refD)) {
    return refD
  }
  const next = sorted.find((d) => d >= refD)
  return next ?? sorted[sorted.length - 1] ?? null
}

const parseDateString = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }

  return window.btoa(binary)
}

const base64ToUint8Array = (value: string) => {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const toArrayBuffer = (value: ArrayBuffer | Uint8Array) => {
  if (value instanceof ArrayBuffer) {
    return value
  }

  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

const downloadBufferAsFile = (buffer: ArrayBuffer | Uint8Array, filename: string) => {
  const blob = new Blob([toArrayBuffer(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.URL.revokeObjectURL(url)
}

/**
 * 재고 연쇄에 쓰는「직접 입력(핀)」열: 항상 1열(월초) + 실사로 표시한 날.
 * 실사 표시가 없으면 예전과 같이 `실사 기준일` 열만 추가 핀으로 둔다.
 */
const buildStockPinnedDayIndices = (
  days: readonly number[],
  surveyMarkedDays: readonly number[],
  physicalCountDayIndex: number,
): Set<number> => {
  const pinned = new Set<number>()
  const n = days.length
  if (n === 0) {
    return pinned
  }
  pinned.add(0)
  for (const d of surveyMarkedDays) {
    const idx = days.indexOf(d)
    if (idx >= 0) {
      pinned.add(idx)
    }
  }
  if (surveyMarkedDays.length === 0) {
    const phys = Math.min(Math.max(physicalCountDayIndex, 0), n - 1)
    pinned.add(phys)
  }
  return pinned
}

/**
 * 자동 재고(일반 원두): 핀으로 찍은 열 재고는 직접 입력값을 기준으로 두되, 그날 환산 생두 생산량이 바뀌면
 * (새값−이전값)만큼 재고에서 빼서 반영한다. 그 외 일자는 전일재고+입고−생산(연쇄)이며 `production`은
 * `productionForAutoStock` 결과를 쓴다. Blending-Dark/Light는 `resyncAutoStockForBeanRow`만 사용한다.
 */
const computeAutoStockValues = (
  inbound: readonly number[],
  production: readonly number[],
  _outbound: readonly number[],
  manualStock: readonly number[],
  pinnedDayIndices: ReadonlySet<number>,
  rawProduction?: readonly number[] | null,
  previousRawProduction?: readonly number[] | null,
) => {
  const n = manualStock.length
  if (n === 0) {
    return []
  }

  const adjustPinnedForRawProductionDelta = (dayIndex: number, manualValue: number): number => {
    if (
      rawProduction == null ||
      previousRawProduction == null ||
      rawProduction.length !== previousRawProduction.length
    ) {
      return manualValue
    }
    const delta = (rawProduction[dayIndex] ?? 0) - (previousRawProduction[dayIndex] ?? 0)
    return manualValue - delta
  }

  const nextValues: number[] = new Array(n)
  nextValues[0] = adjustPinnedForRawProductionDelta(0, manualStock[0] ?? 0)
  for (let i = 1; i < n; i += 1) {
    if (pinnedDayIndices.has(i)) {
      nextValues[i] = adjustPinnedForRawProductionDelta(i, manualStock[i] ?? 0)
    } else {
      nextValues[i] =
        (nextValues[i - 1] ?? 0) + (inbound[i] ?? 0) - (production[i] ?? 0)
    }
  }
  return nextValues
}

/**
 * Blending-Dark/Light 자동 재고: 핀으로 찍은 열은 저장된 `stock`을 유지하고,
 * 그 밖의 열만 `전일재고+입고−생산−출고`로 채운다.
 */
const computeBlendingAutoStockWithPins = (
  bean: InventoryBeanRow,
  pinnedDayIndices: ReadonlySet<number>,
  prefixStock?: readonly number[],
): number[] => {
  const n = bean.stock.length
  if (n === 0) {
    return []
  }
  const base = prefixStock ? [...prefixStock] : [...bean.stock]
  const prod = productionForAutoStock(bean)
  for (let i = 0; i < n; i += 1) {
    if (pinnedDayIndices.has(i)) {
      continue
    }
    base[i] =
      (base[i - 1] ?? 0) +
      (bean.inbound[i] ?? 0) -
      (prod[i] ?? 0) -
      (bean.outbound[i] ?? 0)
  }
  return base
}

type ResyncAutoStockOptions = {
  /** 0일·실사일 등 직접 덮어쓴 재고가 있을 때 그 배열을 넣는다 */
  prefixStock?: readonly number[]
  /** 생산(raw) 변경 시 0일·실사일 핀만 (새−이전) 반영 */
  previousRawProduction?: readonly number[] | null
}

/**
 * 자동 재고에서 품목별 재고 배열을 한곳에서 맞춘다.
 * Blending-Dark/Light는 항상 `computeBlendingAutoStockWithPins`만 사용한다.
 */
const resyncAutoStockForBeanRow = (
  bean: InventoryBeanRow,
  pinnedDayIndices: ReadonlySet<number>,
  options?: ResyncAutoStockOptions,
): number[] => {
  if (isBlendingOutboundAdjustsStockRow(bean)) {
    return computeBlendingAutoStockWithPins(bean, pinnedDayIndices, options?.prefixStock)
  }
  const prev = options?.previousRawProduction
  const useRawDelta =
    prev != null && prev.length > 0 && prev.length === bean.production.length
  return computeAutoStockValues(
    bean.inbound,
    productionForAutoStock(bean),
    bean.outbound,
    options?.prefixStock ?? bean.stock,
    pinnedDayIndices,
    useRawDelta ? bean.production : undefined,
    useRawDelta ? prev : undefined,
  )
}

/** beanRows.production(raw)을 로스팅현황 일별값(결과량 kg)으로 투영 */
const syncRoastingRowsFromBeanProduction = (state: InventoryStatusState): InventoryStatusState['roastingRows'] => {
  const dailyRows = state.roastingRows.filter(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: number } => typeof row.day === 'number',
  )
  const totalsRow = state.roastingRows.find(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: '계' } => row.day === '계',
  )

  const nextDailyRows = dailyRows.map((row) => {
    const dayIndex = state.days.findIndex((d) => d === row.day)
    if (dayIndex < 0) {
      return row
    }
    const nextValues = state.roastingColumns.map((colName) => {
      const normalized = normalizeNameKey(colName)
      if (!normalized) {
        return 0
      }
      return state.beanRows.reduce((sum, bean) => {
        if (normalizeNameKey(bean.name) !== normalized) {
          return sum
        }
        return sum + convertRawInputToRoastedOutput(bean.production[dayIndex] ?? 0)
      }, 0)
    })
    return { ...row, values: nextValues }
  })

  const totals = state.roastingColumns.map((_, colIndex) =>
    nextDailyRows.reduce((sum, row) => sum + (row.values[colIndex] ?? 0), 0),
  )
  const nextTotalsRow = totalsRow ? { ...totalsRow, values: totals } : { day: '계' as const, values: totals }
  return [...nextDailyRows, nextTotalsRow]
}

/** 직접 입력 → 자동 재고로 바꿀 때: 실사일이 같은 달 1일만 잡혀 있고 기준일이 1일이 아니면 기준일과 맞춤 */
const applyPhysicalCountDateWhenEnablingAuto = (current: InventoryStatusState): InventoryStatusState => {
  const ref = current.referenceDate
  let physicalCountDate = current.physicalCountDate
  if (
    ref.length >= 10 &&
    physicalCountDate.length >= 10 &&
    physicalCountDate.slice(0, 8) === ref.slice(0, 8) &&
    physicalCountDate.slice(8, 10) === '01' &&
    ref.slice(8, 10) !== '01'
  ) {
    physicalCountDate = ref
  }
  if (physicalCountDate === current.physicalCountDate) {
    return current
  }
  return { ...current, physicalCountDate }
}

const isoDateWithDayOfMonth = (referenceDate: string, dayOfMonth: number): string => {
  if (referenceDate.length < 10) {
    return referenceDate
  }
  const d = Math.min(Math.max(Math.floor(dayOfMonth), 1), 31)
  return `${referenceDate.slice(0, 8)}${String(d).padStart(2, '0')}`
}

const withPhysicalCountDateFromSurveyMarks = (current: InventoryStatusState): InventoryStatusState => {
  if (current.surveyMarkedDays.length === 0) {
    return applyPhysicalCountDateWhenEnablingAuto(current)
  }
  const latestDay = Math.max(...current.surveyMarkedDays)
  return { ...current, physicalCountDate: isoDateWithDayOfMonth(current.referenceDate, latestDay) }
}

const isStockColumnEditable = (
  state: InventoryStatusState,
  dayIndex: number,
): boolean => {
  const day = state.days[dayIndex]
  if (day == null) {
    return false
  }
  return state.surveyMarkedDays.includes(day)
}

type SheetKey = (typeof SHEET_OPTIONS)[number]['id']
type RoastingViewMode = 'daily' | 'weekly'
type InventoryHistoryNote = {
  id: string
  date: string
  note: string
  createdAt: string
}

type InventoryPageDocument = {
  inventoryState: InventoryStatusState
  baselineState: InventoryStatusState
  templateBase64: string | null
  templateFileName: string
  historyNotes: InventoryHistoryNote[]
}

const normalizeInventoryHistoryNotes = (value: unknown): InventoryHistoryNote[] =>
  Array.isArray(value)
    ? value
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null
          }
          const source = entry as Partial<InventoryHistoryNote>
          const id = String(source.id ?? '').trim()
          const date = String(source.date ?? '').trim()
          const note = String(source.note ?? '').trim()
          const createdAt = String(source.createdAt ?? '').trim()
          if (!id || !date || !note || !createdAt) {
            return null
          }
          return { id, date, note, createdAt }
        })
        .filter((entry): entry is InventoryHistoryNote => entry !== null)
    : []

const readInventoryPageLocalDocument = (): InventoryPageDocument => {
  const saved = window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY)
  const savedBaseline = window.localStorage.getItem(INVENTORY_STATUS_BASELINE_STORAGE_KEY)
  const savedTemplate = window.localStorage.getItem(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY)
  const savedTemplateName = window.localStorage.getItem(INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY)
  const savedNotes = window.localStorage.getItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY)

  const defaultState = createDefaultInventoryStatusState()

  let inventoryState = defaultState
  let baselineState = defaultState
  if (saved) {
    try {
      const parsed = normalizeInventoryStatusState(JSON.parse(saved))
      const parsedBaseline = savedBaseline ? normalizeInventoryStatusState(JSON.parse(savedBaseline)) : null
      if (parsed) {
        inventoryState = parsed
        baselineState = parsedBaseline ?? parsed
      }
    } catch (error) {
      console.error('저장된 입출고 현황을 읽지 못했습니다.', error)
    }
  }

  let historyNotes: InventoryHistoryNote[] = []
  if (savedNotes) {
    try {
      historyNotes = normalizeInventoryHistoryNotes(JSON.parse(savedNotes))
    } catch {
      historyNotes = []
    }
  }

  return {
    inventoryState,
    baselineState,
    templateBase64: savedTemplate,
    templateFileName: savedTemplateName ?? '',
    historyNotes,
  }
}

const normalizeInventoryPageDocument = (value: unknown): InventoryPageDocument => {
  const defaultState = createDefaultInventoryStatusState()
  if (!value || typeof value !== 'object') {
    return {
      inventoryState: defaultState,
      baselineState: defaultState,
      templateBase64: null,
      templateFileName: '',
      historyNotes: [],
    }
  }

  const source = value as Partial<InventoryPageDocument>
  const inventoryState =
    source.inventoryState && typeof source.inventoryState === 'object'
      ? normalizeInventoryStatusState(source.inventoryState) ?? defaultState
      : defaultState
  const baselineState =
    source.baselineState && typeof source.baselineState === 'object'
      ? normalizeInventoryStatusState(source.baselineState) ?? inventoryState
      : inventoryState

  return {
    inventoryState,
    baselineState,
    templateBase64:
      typeof source.templateBase64 === 'string' && source.templateBase64.length > 0
        ? source.templateBase64
        : null,
    templateFileName: typeof source.templateFileName === 'string' ? source.templateFileName : '',
    historyNotes: normalizeInventoryHistoryNotes(source.historyNotes),
  }
}

const getCellText = (cell: ExcelJS.Cell) => {
  if (typeof cell.text === 'string' && cell.text.trim()) {
    return cell.text.trim()
  }

  if (typeof cell.value === 'string') {
    return cell.value.trim()
  }

  return ''
}

const findReferenceDateCell = (worksheet: ExcelJS.Worksheet) => {
  for (let rowNumber = 1; rowNumber <= 5; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    for (let columnNumber = 1; columnNumber <= 40; columnNumber += 1) {
      const label = getCellText(row.getCell(columnNumber))
      if (!label.includes('기준일')) {
        continue
      }

      for (let nextColumn = columnNumber + 1; nextColumn <= columnNumber + 5; nextColumn += 1) {
        const candidate = row.getCell(nextColumn)
        if (candidate.value !== null && getCellText(candidate) !== '') {
          return candidate
        }
      }
    }
  }

  return worksheet.getRow(1).getCell(35)
}

const applyStateToTemplateWorkbook = (workbook: ExcelJS.Workbook, inventoryState: InventoryStatusState) => {
  const beanSheet = workbook.getWorksheet('생두전체현황')
  const roastingSheet = workbook.getWorksheet('로스팅현황')
  const beanNameSheet = workbook.getWorksheet('원두명')

  if (!beanSheet || !roastingSheet) {
    return false
  }

  const dayCount = inventoryState.days.length
  const dailyTotalColumnIndex = dayCount + 4

  findReferenceDateCell(beanSheet).value = parseDateString(inventoryState.referenceDate)

  /** 시트 행 순서 ≠ 앱 beanRows 순서(NO 정렬 등)일 때 인덱스로 쓰면 값이 엉켜 깨짐 → 품목명으로 매칭 */
  const beanByNameKey = new Map<string, InventoryBeanRow>()
  for (const bean of inventoryState.beanRows) {
    const key = normalizeNameKey(bean.name)
    if (key) {
      beanByNameKey.set(key, bean)
    }
  }

  let currentBean: InventoryBeanRow | null = null
  for (let rowNumber = 3; rowNumber <= beanSheet.rowCount; rowNumber += 1) {
    const row = beanSheet.getRow(rowNumber)
    const nameText = getCellText(row.getCell(2))
    const label = getCellText(row.getCell(3))

    if (!label) {
      continue
    }

    if (nameText) {
      const key = normalizeNameKey(nameText)
      currentBean = beanByNameKey.get(key) ?? null
      if (currentBean) {
        row.getCell(1).value = currentBean.no
        row.getCell(2).value = currentBean.name
      }
    }

    if (!currentBean) {
      continue
    }

    const bean = currentBean

    const rawValues =
      label === '입고'
        ? bean.inbound
        : label === '생산'
          ? bean.production
          : label === '출고'
            ? bean.outbound
            : label === '재고'
              ? bean.stock
              : null

    if (!rawValues) {
      continue
    }

    const values =
      label === '생산'
        ? alignBeanValuesToDayCount(
            rawValues.map((value) => convertRawInputToRoastedOutput(value)),
            dayCount,
          )
        : alignBeanValuesToDayCount(rawValues, dayCount)

    values.forEach((value, index) => {
      row.getCell(index + 4).value = value
    })
    row.getCell(dailyTotalColumnIndex).value = values.reduce((total, value) => total + value, 0)
  }

  const roastingDailyRows = inventoryState.roastingRows.filter(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: number } => typeof row.day === 'number',
  )
  const roastingColumnCount = inventoryState.roastingColumns.length
  const roastingTotals = inventoryState.roastingColumns.map((_, columnIndex) =>
    roastingDailyRows.reduce((total, row) => total + (row.values[columnIndex] ?? 0), 0),
  )

  for (let rowNumber = 4; rowNumber <= 34; rowNumber += 1) {
    const row = roastingSheet.getRow(rowNumber)
    const day = Number(row.getCell(1).value ?? 0)
    const dailyRow = roastingDailyRows.find((item) => item.day === day)
    const values = alignRoastingValuesToColumnCount(
      dailyRow?.values ?? [],
      roastingColumnCount,
    )
    values.forEach((value, index) => {
      row.getCell(index + 2).value = value
    })
  }

  const totalRow = roastingSheet.getRow(35)
  roastingTotals.forEach((value, index) => {
    totalRow.getCell(index + 2).value = value
  })
  roastingSheet.getRow(36).getCell(roastingSheet.columnCount || 27).value = roastingTotals.reduce(
    (total, value) => total + value,
    0,
  )

  if (beanNameSheet) {
    inventoryState.beanRows.forEach((bean, index) => {
      const row = beanNameSheet.getRow(index + 2)
      row.getCell(1).value = bean.no
      row.getCell(2).value = bean.name
    })
  }

  return true
}

function InventoryStatusPage() {
  const { mode, activeCompanyId, user } = useAppRuntime()
  const [inventoryState, setInventoryState] = useState<InventoryStatusState>(() =>
    createDefaultInventoryStatusState(),
  )
  const [baselineState, setBaselineState] = useState<InventoryStatusState>(() =>
    createDefaultInventoryStatusState(),
  )
  const [templateBase64, setTemplateBase64] = useState<string | null>(null)
  const [templateFileName, setTemplateFileName] = useState<string>('')
  const [activeSheet, setActiveSheet] = useState<SheetKey>('beans')
  const [roastingViewMode, setRoastingViewMode] = useState<RoastingViewMode>('daily')
  const [hideZeroRoastingItems, setHideZeroRoastingItems] = useState(true)
  const [selectedBeanName, setSelectedBeanName] = useState<string>('')
  const [beanDetailViewMode, setBeanDetailViewMode] = useState<BeanDetailViewMode>('daily')
  const beanDetailSectionRef = useRef<HTMLDivElement>(null)
  const beanDailyScrollRef = useRef<HTMLDivElement>(null)
  const [beanSearchTerm, setBeanSearchTerm] = useState('')
  const [showStockOnly, setShowStockOnly] = useState(false)
  const [showActiveOnly, setShowActiveOnly] = useState(false)
  const [historyNotes, setHistoryNotes] = useState<InventoryHistoryNote[]>([])
  const [noteDate, setNoteDate] = useState(() => todayLocalIsoDateString())
  const [noteDraft, setNoteDraft] = useState('')
  const [statusMessage, setStatusMessage] = useState('브라우저에 자동 저장됩니다.')
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
  const initialRoastingSyncDoneRef = useRef(false)
  /** 로스팅 열 품목명 수정 시작 시 해당 열의 원래 문자열(생두 행과 동기화에 사용) */
  const roastingColumnRenameOriginRef = useRef<Map<number, string>>(new Map())
  const [fullResetDialogOpen, setFullResetDialogOpen] = useState(false)
  const [fullResetPin, setFullResetPin] = useState('')
  const [fullResetDialogError, setFullResetDialogError] = useState('')
  const [fullResetOptions, setFullResetOptions] = useState<FullResetOptions>(DEFAULT_FULL_RESET_OPTIONS)
  const fullResetPinInputRef = useRef<HTMLInputElement>(null)
  /** 켠 경우에만 생두명·로스팅 열 품목명을 바꿀 수 있습니다. */
  const [inventoryNameEditMode, setInventoryNameEditMode] = useState(false)
  const [nameEditUnlockDialogOpen, setNameEditUnlockDialogOpen] = useState(false)
  const [nameEditUnlockPin, setNameEditUnlockPin] = useState('')
  const [nameEditUnlockError, setNameEditUnlockError] = useState('')
  const nameEditUnlockPinInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false

    setIsStorageReady(false)
    setIsCloudReady(mode === 'local')
    resetDocumentSaveUi()

    const applyDocument = (
      document: InventoryPageDocument,
      source: 'local' | 'cloud',
      hasRemoteDocument: boolean,
    ) => {
      const wasManualStockMode = window.localStorage.getItem(INVENTORY_AUTO_STOCK_MODE_KEY) === 'false'
      let next = document.inventoryState
      let nextBaseline = document.baselineState
      let migratedFromManual = false

      if (wasManualStockMode && next.surveyMarkedDays.length === 0 && next.days.length > 0) {
        migratedFromManual = true
        next = { ...next, surveyMarkedDays: [...next.days] }
        next = withPhysicalCountDateFromSurveyMarks(next)
        const physIdx = dayIndexForReferenceDate(next.days, next.physicalCountDate)
        const pins = buildStockPinnedDayIndices(next.days, next.surveyMarkedDays, physIdx)
        next = {
          ...next,
          beanRows: next.beanRows.map((bean) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, pins),
          })),
        }
        nextBaseline = next
        window.localStorage.setItem(INVENTORY_AUTO_STOCK_MODE_KEY, 'true')
      }

      if (cancelled) {
        return
      }

      setInventoryState(next)
      setBaselineState(migratedFromManual ? next : nextBaseline)
      setTemplateBase64(document.templateBase64)
      setTemplateFileName(document.templateFileName)
      setHistoryNotes(document.historyNotes)
      setSelectedBeanName(next.beanRows[0]?.name ?? '')
      setStatusMessage(
        migratedFromManual
          ? '예전「직접 입력」재고를 유지하도록 모든 날에 실사 표시를 켰습니다. 필요 없는 날은 늦은 날부터 순서대로 해제해 주세요.'
          : source === 'cloud'
            ? '클라우드에서 입출고 현황을 불러왔습니다.'
            : hasRemoteDocument
              ? '이전에 편집한 입출고 현황을 불러왔습니다.'
              : '브라우저 입출고 현황을 불러왔습니다. 아직 클라우드 문서는 없습니다.'
      )
      setIsStorageReady(true)
      setIsCloudReady(true)
    }

    const loadDocument = async () => {
      const localDocument = readInventoryPageLocalDocument()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyDocument(localDocument, 'local', true)
        return
      }

      try {
        const remoteDocument = await loadCompanyDocument<InventoryPageDocument>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.inventoryPage,
        )
        if (remoteDocument) {
          applyDocument(normalizeInventoryPageDocument(remoteDocument), 'cloud', true)
        } else {
          applyDocument(localDocument, 'local', false)
        }
      } catch (error) {
        console.error('입출고 현황 클라우드 문서를 읽지 못했습니다.', error)
        applyDocument(localDocument, 'local', true)
      }
    }

    void loadDocument()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode, resetDocumentSaveUi])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(INVENTORY_STATUS_STORAGE_KEY, JSON.stringify(inventoryState))
  }, [inventoryState, isStorageReady])

  useEffect(() => {
    if (!inventoryNameEditMode) {
      roastingColumnRenameOriginRef.current.clear()
    }
  }, [inventoryNameEditMode])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(INVENTORY_STATUS_BASELINE_STORAGE_KEY, JSON.stringify(baselineState))
  }, [baselineState, isStorageReady])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    if (templateBase64) {
      window.localStorage.setItem(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY, templateBase64)
    } else {
      window.localStorage.removeItem(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY)
    }

    if (templateFileName) {
      window.localStorage.setItem(INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY, templateFileName)
    } else {
      window.localStorage.removeItem(INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY)
    }
  }, [isStorageReady, templateBase64, templateFileName])

  useEffect(() => {
    if (!inventoryState.beanRows.some((bean) => bean.name === selectedBeanName)) {
      setSelectedBeanName(inventoryState.beanRows[0]?.name ?? '')
    }
  }, [inventoryState.beanRows, selectedBeanName])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(INVENTORY_HISTORY_NOTES_STORAGE_KEY, JSON.stringify(historyNotes))
  }, [historyNotes, isStorageReady])

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
        COMPANY_DOCUMENT_KEYS.inventoryPage,
        {
          inventoryState,
          baselineState,
          templateBase64,
          templateFileName,
          historyNotes,
        },
        user?.id,
      )
        .then(() => {
          markDocumentSaved()
        })
        .catch((error) => {
          console.error('입출고 현황 클라우드 저장에 실패했습니다.', error)
          markDocumentError()
        })
    }, 600)

    return () => window.clearTimeout(timeoutId)
  }, [
    activeCompanyId,
    baselineState,
    historyNotes,
    inventoryState,
    isCloudReady,
    isStorageReady,
    mode,
    templateBase64,
    templateFileName,
    user?.id,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    skipInitialDocumentSave,
  ])

  const endingStockDayIndex = useMemo(
    () => dayIndexForReferenceDate(inventoryState.days, inventoryState.referenceDate),
    [inventoryState.days, inventoryState.referenceDate],
  )

  const physicalCountDayIndex = useMemo(
    () => dayIndexForReferenceDate(inventoryState.days, inventoryState.physicalCountDate),
    [inventoryState.days, inventoryState.physicalCountDate],
  )

  const surveyMarkedDaySet = useMemo(
    () => new Set(inventoryState.surveyMarkedDays),
    [inventoryState.surveyMarkedDays],
  )

  const stockPinnedDayIndices = useMemo(
    () =>
      buildStockPinnedDayIndices(
        inventoryState.days,
        inventoryState.surveyMarkedDays,
        physicalCountDayIndex,
      ),
    [inventoryState.days, inventoryState.surveyMarkedDays, physicalCountDayIndex],
  )

  /** 항상 입고·생산·출고에 맞춘 연쇄 재고(실사로 찍은 열·월초만 직접값 유지) */
  const displayedBeanRows = useMemo(
    () =>
      inventoryState.beanRows.map((bean) => ({
        ...bean,
        stock: resyncAutoStockForBeanRow(bean, stockPinnedDayIndices),
      })),
    [inventoryState.beanRows, stockPinnedDayIndices],
  )

  const beanSummaryRows = useMemo(
    () =>
      displayedBeanRows.map((bean) => {
        const stockLen = bean.stock.length
        const cappedIdx =
          stockLen <= 0 ? 0 : Math.min(Math.max(endingStockDayIndex, 0), stockLen - 1)
        return {
          no: bean.no,
          name: bean.name,
          inboundTotal: sumValues(bean.inbound),
          roastedOutputTotal: sumValues(bean.production.map(convertRawInputToRoastedOutput)),
          rawUsageTotal: isBlendingDarkBeanRow(bean) ? null : sumValues(bean.production),
          outboundTotal: sumValues(bean.outbound),
          endingStock: bean.stock[cappedIdx] ?? 0,
        }
      }),
    [displayedBeanRows, endingStockDayIndex],
  )

  const filteredBeanSummaryRows = useMemo(() => {
    const normalizedSearch = beanSearchTerm.trim().toLowerCase()
    const filtered = beanSummaryRows.filter((bean) => {
      if (normalizedSearch && !bean.name.toLowerCase().includes(normalizedSearch)) {
        return false
      }
      if (showStockOnly && bean.endingStock <= 0) {
        return false
      }
      const rawUsage = bean.rawUsageTotal ?? 0
      if (showActiveOnly && rawUsage <= 0 && bean.inboundTotal <= 0 && bean.outboundTotal <= 0) {
        return false
      }
      return true
    })
    return [...filtered].sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0))
  }, [beanSearchTerm, beanSummaryRows, showActiveOnly, showStockOnly])

  const filteredBeanNames = useMemo(
    () => new Set(filteredBeanSummaryRows.map((bean) => bean.name)),
    [filteredBeanSummaryRows],
  )

  const filteredDisplayedBeanRows = useMemo(() => {
    const rows = displayedBeanRows.filter((bean) => filteredBeanNames.has(bean.name))
    return [...rows].sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0))
  }, [displayedBeanRows, filteredBeanNames])

  /** 로스팅 열 인덱스 → 입출고 생두 NO (이름 일치 시) */
  const roastingColumnIndexToBeanNo = useMemo(() => {
    const m = new Map<number, number>()
    for (const bean of inventoryState.beanRows) {
      const idx = inventoryState.roastingColumns.findIndex(
        (col) => normalizeNameKey(col) === normalizeNameKey(bean.name),
      )
      if (idx >= 0) {
        m.set(idx, bean.no)
      }
    }
    return m
  }, [inventoryState.beanRows, inventoryState.roastingColumns])

  const selectedBean =
    filteredDisplayedBeanRows.find((bean) => bean.name === selectedBeanName) ?? filteredDisplayedBeanRows[0] ?? null

  const scrollBeanDailyToCenterDay = useCallback(() => {
    if (beanDetailViewMode !== 'daily') {
      return
    }
    const el = beanDailyScrollRef.current
    if (!el) {
      return
    }
    const anchorDay = pickScrollAnchorCalendarDay(inventoryState.referenceDate, inventoryState.days)
    if (anchorDay == null) {
      return
    }
    const dayIndex = inventoryState.days.findIndex((d) => d === anchorDay)
    if (dayIndex < 0) {
      return
    }
    const cell = el.querySelector(`thead tr th:nth-child(${dayIndex + 2})`) as HTMLElement | null
    if (!cell) {
      return
    }
    const rCell = cell.getBoundingClientRect()
    const rEl = el.getBoundingClientRect()
    const cellCenterX = rCell.left + rCell.width / 2
    const elCenterX = rEl.left + rEl.width / 2
    const nextLeft = el.scrollLeft + (cellCenterX - elCenterX)
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth)
    el.scrollLeft = Math.max(0, Math.min(maxScroll, nextLeft))
  }, [beanDetailViewMode, inventoryState.days, inventoryState.referenceDate])

  useLayoutEffect(() => {
    scrollBeanDailyToCenterDay()
    const id = window.requestAnimationFrame(() => scrollBeanDailyToCenterDay())
    return () => window.cancelAnimationFrame(id)
  }, [scrollBeanDailyToCenterDay, selectedBeanName])

  useEffect(() => {
    if (beanDetailViewMode !== 'daily') {
      return
    }
    const onResize = () => scrollBeanDailyToCenterDay()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [beanDetailViewMode, scrollBeanDailyToCenterDay])

  const inventoryMetric = useMemo(() => {
    const totalEndingStock = beanSummaryRows.reduce((total, bean) => total + bean.endingStock, 0)
    const activeBeans = beanSummaryRows.filter(
      (bean) => bean.endingStock > 0 || (bean.rawUsageTotal ?? 0) > 0 || bean.inboundTotal > 0,
    ).length

    return {
      totalEndingStock,
      activeBeans,
    }
  }, [beanSummaryRows])

  const roastingDailyRows = inventoryState.roastingRows.filter(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: number } => typeof row.day === 'number',
  )
  /** `계` 행 저장값이 아닌, 현재 일별 입력값으로 로스팅 합계를 항상 재계산 */
  const computedRoastingTotals = useMemo(
    () =>
      inventoryState.roastingColumns.map((_, columnIndex) =>
        roastingDailyRows.reduce((total, row) => total + (row.values[columnIndex] ?? 0), 0),
      ),
    [inventoryState.roastingColumns, roastingDailyRows],
  )

  const roastingMetrics = useMemo(() => {
    const grandTotal = sumValues(computedRoastingTotals)
    const activeItems = computedRoastingTotals.filter((value) => value > 0).length
    const latestActiveDayRow = [...roastingDailyRows].reverse().find((row) => sumValues(row.values) > 0) ?? null
    const peakDay = roastingDailyRows.reduce<{ day: number; total: number }>(
      (best, row) => {
        const total = sumValues(row.values)
        if (total > best.total) {
          return { day: row.day, total }
        }
        return best
      },
      { day: 0, total: 0 },
    )
    const daysWithRoasting = roastingDailyRows.filter((row) => sumValues(row.values) > 0).length
    const averagePerActiveDay = daysWithRoasting > 0 ? grandTotal / daysWithRoasting : 0

    return {
      grandTotal,
      activeItems,
      peakDay,
      latestActiveDay: latestActiveDayRow?.day ?? 0,
      latestActiveDayTotal: latestActiveDayRow ? sumValues(latestActiveDayRow.values) : 0,
      daysWithRoasting,
      averagePerActiveDay,
      rawUsageEstimate: convertRoastedOutputToRawInput(grandTotal),
    }
  }, [computedRoastingTotals, roastingDailyRows])

  const roastingSummaryRows = useMemo(() => {
    const maxTotal = Math.max(...computedRoastingTotals, 0)
    const totalForShare = inventoryState.roastingColumns.reduce((sum, column, index) => {
      const roastedTotal = computedRoastingTotals[index] ?? 0
      return column.trim() === BLENDING_DARK_BEAN_NAME ? sum : sum + roastedTotal
    }, 0)
    const nameToNo = new Map(inventoryState.beanRows.map((b) => [normalizeNameKey(b.name), b.no]))
    const rows = inventoryState.roastingColumns.map((column, index) => {
      const roastedTotal = computedRoastingTotals[index] ?? 0
      const isBlendingDark = column.trim() === BLENDING_DARK_BEAN_NAME
      const beanNo = nameToNo.get(normalizeNameKey(column)) ?? null
      return {
        name: column,
        columnIndex: index,
        beanNo,
        roastedTotal,
        rawUsageTotal: isBlendingDark ? null : convertRoastedOutputToRawInput(roastedTotal),
        share: isBlendingDark ? null : totalForShare > 0 ? roastedTotal / totalForShare : null,
        heatLevel: getHeatLevel(roastedTotal, maxTotal),
      }
    })

    return rows.sort((left, right) => {
      const ln = left.beanNo ?? 9999
      const rn = right.beanNo ?? 9999
      if (ln !== rn) {
        return ln - rn
      }
      return normalizeNameKey(left.name).localeCompare(normalizeNameKey(right.name), 'ko')
    })
  }, [computedRoastingTotals, inventoryState.beanRows, inventoryState.roastingColumns])

  const visibleRoastingColumnIndices = useMemo(() => {
    const indices = inventoryState.roastingColumns
      .map((_, index) => index)
      .filter((index) => !hideZeroRoastingItems || (computedRoastingTotals[index] ?? 0) > 0)
    return [...indices].sort((i, j) => {
      const ni = roastingColumnIndexToBeanNo.get(i) ?? 9999
      const nj = roastingColumnIndexToBeanNo.get(j) ?? 9999
      if (ni !== nj) {
        return ni - nj
      }
      return i - j
    })
  }, [computedRoastingTotals, hideZeroRoastingItems, inventoryState.roastingColumns, roastingColumnIndexToBeanNo])

  const visibleRoastingSummaryRows = useMemo(
    () => roastingSummaryRows.filter((row) => !hideZeroRoastingItems || row.roastedTotal > 0),
    [hideZeroRoastingItems, roastingSummaryRows],
  )

  const topRoastingItem = useMemo(() => {
    if (visibleRoastingSummaryRows.length === 0) {
      return null
    }
    return visibleRoastingSummaryRows.reduce((best, row) =>
      row.roastedTotal > best.roastedTotal ? row : best,
    )
  }, [visibleRoastingSummaryRows])
  const maxRoastingCellValue = useMemo(
    () =>
      roastingDailyRows.reduce(
        (maxValue, row) =>
          Math.max(
            maxValue,
            ...visibleRoastingColumnIndices.map((index) => row.values[index] ?? 0),
          ),
        0,
      ),
    [roastingDailyRows, visibleRoastingColumnIndices],
  )

  const roastingWeeklyRows = useMemo(() => {
    const weeks = [
      { key: 'week-1', label: '1-7일', start: 1, end: 7 },
      { key: 'week-2', label: '8-14일', start: 8, end: 14 },
      { key: 'week-3', label: '15-21일', start: 15, end: 21 },
      { key: 'week-4', label: '22-28일', start: 22, end: 28 },
      { key: 'week-5', label: '29-31일', start: 29, end: 31 },
    ]

    return weeks
      .map((week) => {
        const rows = roastingDailyRows.filter((row) => row.day >= week.start && row.day <= week.end)
        const values = inventoryState.roastingColumns.map((_, columnIndex) =>
          rows.reduce((total, row) => total + (row.values[columnIndex] ?? 0), 0),
        )
        const total = sumValues(values)
        const topColumnIndex = values.reduce(
          (bestIndex, value, index, sourceValues) =>
            value > (sourceValues[bestIndex] ?? 0) ? index : bestIndex,
          0,
        )

        return {
          ...week,
          values,
          total,
          activeItemCount: values.filter((value) => value > 0).length,
          topItemName:
            total > 0 ? inventoryState.roastingColumns[topColumnIndex] ?? '-' : '-',
          topItemTotal: total > 0 ? values[topColumnIndex] ?? 0 : 0,
        }
      })
      .filter((week) => week.total > 0 || week.values.some((value) => value > 0))
      .map((week, index, sourceWeeks) => ({
        ...week,
        deltaFromPrevious: index === 0 ? null : week.total - sourceWeeks[index - 1].total,
        isCurrentWeek:
          (() => {
            const referenceDay = Number(inventoryState.referenceDate.split('-')[2] ?? 0)
            return referenceDay >= week.start && referenceDay <= week.end
          })(),
      }))
  }, [inventoryState.referenceDate, inventoryState.roastingColumns, roastingDailyRows])

  const maxWeeklyRoastingCellValue = useMemo(
    () =>
      roastingWeeklyRows.reduce(
        (maxValue, row) =>
          Math.max(maxValue, ...visibleRoastingColumnIndices.map((index) => row.values[index] ?? 0)),
        0,
      ),
    [roastingWeeklyRows, visibleRoastingColumnIndices],
  )

  const selectedBeanIndex = inventoryState.beanRows.findIndex((bean) => bean.name === selectedBean?.name)

  const beanWeeklyDetailRows = useMemo(() => {
    if (!selectedBean) {
      return []
    }
    return buildBeanWeeklyDetailRows(inventoryState.days, selectedBean)
  }, [selectedBean, inventoryState.days])

  const focusBeanDetail = (beanName: string) => {
    setSelectedBeanName(beanName)
    window.requestAnimationFrame(() => {
      beanDetailSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const toggleSurveyMarkedDay = (calendarDay: number) => {
    const outcome = {
      blockedMessage: null as string | null,
      successMessage: null as string | null,
      autoHistoryNote: null as { date: string; note: string } | null,
    }

    setInventoryState((current) => {
      const marks = current.surveyMarkedDays
      const wasMarked = marks.includes(calendarDay)

      const resyncAll = (next: InventoryStatusState): InventoryStatusState => {
        const synced = withPhysicalCountDateFromSurveyMarks(next)
        const physIdx = dayIndexForReferenceDate(synced.days, synced.physicalCountDate)
        const pins = buildStockPinnedDayIndices(synced.days, synced.surveyMarkedDays, physIdx)
        return {
          ...synced,
          beanRows: synced.beanRows.map((bean) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, pins),
          })),
        }
      }

      if (wasMarked) {
        const latestMark = Math.max(...marks)
        if (calendarDay !== latestMark) {
          outcome.blockedMessage =
            '실사 표시는 달력상 가장 늦은 날(가장 최근에 표시한 날)부터만 해제할 수 있습니다. 그보다 이른 날은 먼저 해제할 수 없습니다.'
          return current
        }
        const nextSurvey = marks.filter((d) => d !== calendarDay).sort((a, b) => a - b)
        outcome.successMessage =
          nextSurvey.length === 0 ? '실사 표시를 모두 해제했습니다.' : '실사 표시를 해제했습니다.'
        outcome.autoHistoryNote = {
          date: current.referenceDate,
          note: `실사 표시 해제: ${calendarDay}일`,
        }
        return resyncAll({
          ...current,
          surveyMarkedDays: nextSurvey,
        })
      }

      if (marks.includes(calendarDay)) {
        return current
      }
      outcome.successMessage = '실사한 날로 표시했습니다. 해당 열 재고를 직접 맞출 수 있습니다.'
      outcome.autoHistoryNote = {
        date: current.referenceDate,
        note: `실사 표시: ${calendarDay}일`,
      }
      return resyncAll({
        ...current,
        surveyMarkedDays: [...marks, calendarDay].sort((a, b) => a - b),
      })
    })

    if (outcome.blockedMessage) {
      setStatusMessage(outcome.blockedMessage)
      return
    }
    if (outcome.successMessage) {
      setStatusMessage(outcome.successMessage)
    }
    if (outcome.autoHistoryNote) {
      setHistoryNotes((current) => [
        {
          id: crypto.randomUUID(),
          date: outcome.autoHistoryNote?.date ?? todayLocalIsoDateString(),
          note: outcome.autoHistoryNote?.note ?? '',
          createdAt: new Date().toISOString(),
        },
        ...current,
      ])
    }
  }

  /** 현재 선택 품목 재고를 연쇄 계산값으로 다시 맞춤 */
  const restoreSelectedBeanStockFromAuto = () => {
    if (selectedBeanIndex < 0) {
      return
    }
    setInventoryState((current) => {
      const bean = current.beanRows[selectedBeanIndex]
      if (!bean) {
        return current
      }
      const physIdx = dayIndexForReferenceDate(current.days, current.physicalCountDate)
      const pins = buildStockPinnedDayIndices(current.days, current.surveyMarkedDays, physIdx)
      const restored = resyncAutoStockForBeanRow(bean, pins)
      return {
        ...current,
        beanRows: current.beanRows.map((row, idx) => (idx === selectedBeanIndex ? { ...row, stock: restored } : row)),
      }
    })
    setStatusMessage('선택 품목 재고를 복구했습니다.')
  }

  const handleRestoreSelectedBeanStockWithPin = () => {
    const entered = window.prompt('재고 연쇄 다시 맞춤 비밀번호(4자리)를 입력하세요.')
    if (entered == null) {
      setStatusMessage('재고 연쇄 다시 맞춤을 취소했습니다.')
      return
    }
    if (entered.trim() !== ADMIN_FOUR_DIGIT_PIN) {
      setStatusMessage('비밀번호가 올바르지 않습니다.')
      return
    }
    restoreSelectedBeanStockFromAuto()
  }

  useEffect(() => {
    if (filteredDisplayedBeanRows.length === 0) {
      return
    }

    if (!filteredDisplayedBeanRows.some((bean) => bean.name === selectedBeanName)) {
      setSelectedBeanName(filteredDisplayedBeanRows[0].name)
    }
  }, [filteredDisplayedBeanRows, selectedBeanName])

  const updateBeanValue = (
    beanIndex: number,
    targetKey: 'inbound' | 'production' | 'outbound' | 'stock',
    valueIndex: number,
    nextValue: string,
  ) => {
    const parsedValue = Number(nextValue) || 0
    setInventoryState((current) => {
      const pinsFor = (s: InventoryStatusState) => {
        const physIdx = dayIndexForReferenceDate(s.days, s.physicalCountDate)
        return buildStockPinnedDayIndices(s.days, s.surveyMarkedDays, physIdx)
      }

      if (targetKey === 'production') {
        const previousRawByRow = current.beanRows.map((b) => [...b.production])
        const nextRaw = convertRoastedOutputToRawInput(parsedValue)
        const nextBeanRows = current.beanRows.map((bean, index) => {
          if (index !== beanIndex) {
            return bean
          }
          const nextValues = [...bean.production]
          nextValues[valueIndex] = nextRaw
          return { ...bean, production: nextValues }
        })
        const pins = pinsFor({ ...current, beanRows: nextBeanRows })
        const withRoastingSynced = syncRoastingRowsFromBeanProduction({
          ...current,
          beanRows: nextBeanRows,
        })
        return {
          ...current,
          beanRows: nextBeanRows.map((bean, bi) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, pins, {
              previousRawProduction: previousRawByRow[bi] ?? null,
            }),
          })),
          roastingRows: withRoastingSynced,
        }
      }

      return {
        ...current,
        beanRows: current.beanRows.map((bean, index) => {
          if (index !== beanIndex) {
            return bean
          }

          if (targetKey === 'stock') {
            if (!isStockColumnEditable(current, valueIndex)) {
              return bean
            }
            const merged = [...bean.stock]
            merged[valueIndex] = parsedValue
            const pins = pinsFor(current)
            return {
              ...bean,
              stock: resyncAutoStockForBeanRow(bean, pins, { prefixStock: merged }),
            }
          }

          const nextValues = [...bean[targetKey]]
          nextValues[valueIndex] = parsedValue

          let nextBean: InventoryBeanRow = {
            ...bean,
            [targetKey]: nextValues,
          }

          const pins = pinsFor(current)

          if (targetKey === 'inbound') {
            nextBean = {
              ...nextBean,
              stock: resyncAutoStockForBeanRow(nextBean, pins),
            }
          }

          if (targetKey === 'outbound' && isBlendingOutboundAdjustsStockRow(nextBean)) {
            const oldOut = bean.outbound[valueIndex] ?? 0
            const delta = parsedValue - oldOut
            const patched = [...bean.stock]
            const pinArr = [...pins]
            const maxPin = pinArr.length > 0 ? Math.max(...pinArr) : 0
            if (valueIndex <= maxPin) {
              for (let j = valueIndex; j <= maxPin; j += 1) {
                patched[j] -= delta
              }
            }
            nextBean = {
              ...nextBean,
              stock: resyncAutoStockForBeanRow(nextBean, pins, { prefixStock: patched }),
            }
          }

          return nextBean
        }),
      }
    })
  }

  const updateRoastingColumnName = (columnIndex: number, nextName: string) => {
    if (!inventoryNameEditMode) {
      return
    }
    setInventoryState((current) => {
      if (columnIndex < 0 || columnIndex >= current.roastingColumns.length) {
        return current
      }
      const origin = roastingColumnRenameOriginRef.current.get(columnIndex) ?? current.roastingColumns[columnIndex] ?? ''
      const originKey = normalizeNameKey(origin)
      const trimmed = nextName.trim()
      const keyForDup = trimmed.length > 0 ? normalizeNameKey(trimmed) : originKey
      const duplicate =
        keyForDup !== originKey &&
        current.beanRows.some((b) => normalizeNameKey(b.name) === keyForDup && normalizeNameKey(b.name) !== originKey)
      if (duplicate) {
        setStatusMessage('이미 같은 이름의 품목이 있어 그 이름으로는 바꿀 수 없습니다.')
        return current
      }
      const roastingColumns = [...current.roastingColumns]
      roastingColumns[columnIndex] = nextName
      const beanLabel = trimmed.length > 0 ? trimmed : null
      const beanRows = current.beanRows.map((bean) => {
        if (normalizeNameKey(bean.name) !== originKey) {
          return bean
        }
        if (beanLabel) {
          return { ...bean, name: beanLabel }
        }
        return bean
      })
      return { ...current, roastingColumns, beanRows }
    })
  }

  const finalizeRoastingColumnName = (columnIndex: number) => {
    const origin = roastingColumnRenameOriginRef.current.get(columnIndex)
    roastingColumnRenameOriginRef.current.delete(columnIndex)
    if (origin === undefined) {
      return
    }
    const prevKey = normalizeNameKey(origin.trim())
    let resolvedForSelect = origin.trim()
    setInventoryState((current) => {
      if (columnIndex < 0 || columnIndex >= current.roastingColumns.length) {
        return current
      }
      const raw = (current.roastingColumns[columnIndex] ?? '').trim()
      const resolved = raw.length > 0 ? raw : origin.trim()
      resolvedForSelect = resolved
      const roastingColumns = [...current.roastingColumns]
      roastingColumns[columnIndex] = resolved
      const beanRows = current.beanRows.map((bean) =>
        normalizeNameKey(bean.name) === prevKey ? { ...bean, name: resolved } : bean,
      )
      return { ...current, roastingColumns, beanRows }
    })
    setSelectedBeanName((sel) => (normalizeNameKey(sel) === prevKey ? resolvedForSelect : sel))
  }

  const commitInventoryProductRenameFromSummary = (previousDisplayName: string, nextRaw: string) => {
    if (!inventoryNameEditMode) {
      return
    }
    const resolved = nextRaw.trim().length > 0 ? nextRaw.trim() : previousDisplayName.trim()
    const prevKey = normalizeNameKey(previousDisplayName)
    const nextKey = normalizeNameKey(resolved)
    if (nextKey === prevKey) {
      return
    }
    setInventoryState((current) => {
      const duplicate = current.beanRows.some(
        (b) => normalizeNameKey(b.name) === nextKey && normalizeNameKey(b.name) !== prevKey,
      )
      if (duplicate) {
        setStatusMessage('이미 같은 이름의 품목이 있어 그 이름으로는 바꿀 수 없습니다.')
        return current
      }
      const roastingColumns = current.roastingColumns.map((col) =>
        normalizeNameKey(col) === prevKey ? resolved : col,
      )
      const beanRows = current.beanRows.map((bean) =>
        normalizeNameKey(bean.name) === prevKey ? { ...bean, name: resolved } : bean,
      )
      return { ...current, roastingColumns, beanRows }
    })
    setSelectedBeanName((sel) => (normalizeNameKey(sel) === prevKey ? resolved : sel))
    setStatusMessage('품목명을 바꿨습니다.')
  }

  /** 현재 로스팅표 입력값을 생두 production(raw)으로 일괄 반영 (기존 입력값 마이그레이션용) */
  const syncBeanProductionFromRoastingRows = (current: InventoryStatusState): InventoryStatusState => {
    const previousRawByRow = current.beanRows.map((b) => [...b.production])
    let changed = false

    const nextBeanRows = current.beanRows.map((bean) => ({ ...bean, production: [...bean.production] }))
    const roastingDailyRows = current.roastingRows.filter(
      (row): row is InventoryStatusState['roastingRows'][number] & { day: number } => typeof row.day === 'number',
    )

    roastingDailyRows.forEach((row) => {
      const dayIndex = current.days.findIndex((d) => d === row.day)
      if (dayIndex < 0) {
        return
      }
      row.values.forEach((roastedValue, colIndex) => {
        const colName = (current.roastingColumns[colIndex] ?? '').trim()
        if (!colName) {
          return
        }
        const rawValue = convertRoastedOutputToRawInput(roastedValue ?? 0)
        nextBeanRows.forEach((bean) => {
          if (bean.name.trim() !== colName) {
            return
          }
          if ((bean.production[dayIndex] ?? 0) !== rawValue) {
            bean.production[dayIndex] = rawValue
            changed = true
          }
        })
      })
    })

    if (!changed) {
      return current
    }

    const physIdx = dayIndexForReferenceDate(current.days, current.physicalCountDate)
    const pins = buildStockPinnedDayIndices(current.days, current.surveyMarkedDays, physIdx)
    return {
      ...current,
      beanRows: nextBeanRows.map((bean, bi) => ({
        ...bean,
        stock: resyncAutoStockForBeanRow(bean, pins, {
          previousRawProduction: previousRawByRow[bi] ?? null,
        }),
      })),
    }
  }

  /** 코드 변경 이전에 입력해둔 로스팅값도 1회 자동 반영 */
  useEffect(() => {
    if (!isStorageReady || initialRoastingSyncDoneRef.current) {
      return
    }
    initialRoastingSyncDoneRef.current = true
    setInventoryState((current) => syncBeanProductionFromRoastingRows(current))
  }, [isStorageReady])

  const updateRoastingValue = (day: number, valueIndex: number, nextValue: string) => {
    const parsedRoasted = Number(nextValue) || 0
    setInventoryState((current) => {
      const targetRow = current.roastingRows.find((row) => row.day === day)
      if (!targetRow || targetRow.day === '계') {
        return current
      }
      const dayIndex = current.days.findIndex((d) => d === targetRow.day)
      if (dayIndex < 0) {
        return current
      }

      const targetColumnName = normalizeNameKey(current.roastingColumns[valueIndex] ?? '')
      const previousRawByRow = current.beanRows.map((b) => [...b.production])
      const nextRaw = convertRoastedOutputToRawInput(parsedRoasted)

      const nextBeanRows = current.beanRows.map((bean) => {
        if (!targetColumnName || normalizeNameKey(bean.name) !== targetColumnName) {
          return bean
        }
        const nextProduction = [...bean.production]
        nextProduction[dayIndex] = nextRaw
        return { ...bean, production: nextProduction }
      })

      const nextRoastingRows = current.roastingRows.map((row) => {
        if (row.day !== day) {
          return row
        }
        const nextValues = [...row.values]
        nextValues[valueIndex] = parsedRoasted
        return { ...row, values: nextValues }
      })

      const physIdx = dayIndexForReferenceDate(current.days, current.physicalCountDate)
      const pins = buildStockPinnedDayIndices(current.days, current.surveyMarkedDays, physIdx)
      return {
        ...current,
        beanRows: nextBeanRows.map((bean, bi) => ({
          ...bean,
          stock: resyncAutoStockForBeanRow(bean, pins, {
            previousRawProduction: previousRawByRow[bi] ?? null,
          }),
        })),
        roastingRows: nextRoastingRows,
      }
    })
  }

  const handleAddHistoryNote = () => {
    if (!noteDraft.trim()) {
      return
    }

    setHistoryNotes((current) => [
      {
        id: crypto.randomUUID(),
        date: noteDate,
        note: noteDraft.trim(),
        createdAt: new Date().toISOString(),
      },
      ...current,
    ])
    setNoteDraft('')
  }

  const handleDeleteHistoryNote = (id: string) => {
    setHistoryNotes((current) => current.filter((note) => note.id !== id))
  }

  const handleWorkbookUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
      const parsedState = parseInventoryWorkbook(workbook)
      // 엑셀의 `생산` 행은 일반 원두는 "생산 결과량(로스팅 kg)"으로 보고 내부(raw)로 환산합니다.
      // Blending-Dark는 시트에 이미 생두 사용량(raw) 기준으로 적는 경우가 많아 같은 환산을 하면 값이 커져 재고가 음수로 깨집니다.
      const uploadNormalizedState: InventoryStatusState = {
        ...parsedState,
        beanRows: parsedState.beanRows.map((bean) => ({
          ...bean,
          production: isBlendingDarkBeanRow(bean)
            ? [...bean.production]
            : bean.production.map((value) => convertRoastedOutputToRawInput(value)),
        })),
      }
      const physIdx = dayIndexForReferenceDate(
        uploadNormalizedState.days,
        uploadNormalizedState.physicalCountDate,
      )
      const pins = buildStockPinnedDayIndices(
        uploadNormalizedState.days,
        uploadNormalizedState.surveyMarkedDays,
        physIdx,
      )
      const nextState = {
        ...uploadNormalizedState,
        beanRows: uploadNormalizedState.beanRows.map((bean) => ({
          ...bean,
          stock: resyncAutoStockForBeanRow(bean, pins),
        })),
      }
      setTemplateBase64(arrayBufferToBase64(buffer))
      setTemplateFileName(file.name)
      setInventoryState(nextState)
      setBaselineState(nextState)
      setSelectedBeanName(nextState.beanRows[0]?.name ?? '')
      setStatusMessage(`엑셀 자료 반영 완료: ${file.name} (이 상태가 기본값 복원 기준으로 저장됩니다)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '엑셀 파일을 읽는 중 오류가 발생했습니다.'
      setStatusMessage(message)
    } finally {
      event.target.value = ''
    }
  }

  const handleResetDefault = () => {
    if (!templateBase64) {
      setStatusMessage('엑셀 자료를 업로드한 뒤에만 기본값 복원을 사용할 수 있습니다.')
      return
    }
    const shouldReset = window.confirm(
      '입출고 현황을 마지막으로 업로드한 엑셀 기준 상태로 되돌릴까요?\n현재 페이지에서 수정한 내용은 사라집니다.',
    )

    if (!shouldReset) {
      setStatusMessage('기본값 복원을 취소했습니다.')
      return
    }

    setInventoryState(baselineState)
    setSelectedBeanName(baselineState.beanRows[0]?.name ?? '')
    setStatusMessage('업로드한 엑셀 기준 상태로 되돌렸습니다.')
  }

  const closeFullResetDialog = useCallback(() => {
    setFullResetDialogOpen(false)
    setFullResetPin('')
    setFullResetDialogError('')
    setFullResetOptions({ ...DEFAULT_FULL_RESET_OPTIONS })
  }, [])

  const openFullResetDialog = () => {
    setFullResetDialogError('')
    setFullResetPin('')
    setFullResetOptions({ ...DEFAULT_FULL_RESET_OPTIONS })
    setFullResetDialogOpen(true)
  }

  const confirmFullInventoryReset = () => {
    const anyOption = Object.values(fullResetOptions).some(Boolean)
    if (!anyOption) {
      setFullResetDialogError('초기화할 항목을 한 가지 이상 선택해 주세요.')
      return
    }
    if (fullResetPin !== ADMIN_FOUR_DIGIT_PIN) {
      setFullResetDialogError('비밀번호가 올바르지 않습니다.')
      return
    }

    const hadUploadedTemplate = Boolean(templateBase64)
    const o = fullResetOptions
    let zeroedSnapshot: InventoryStatusState | null = null

    if (o.tableData) {
      zeroedSnapshot = createZeroedInventoryStatusFrom(inventoryState)
      setInventoryState(zeroedSnapshot)
      if (!hadUploadedTemplate || o.template) {
        setBaselineState(zeroedSnapshot)
      }
    }
    if (o.template) {
      if (!o.tableData) {
        const synced = normalizeInventoryStatusState(JSON.parse(JSON.stringify(inventoryState)))
        if (synced) {
          setBaselineState(synced)
        }
      }
      setTemplateBase64(null)
      setTemplateFileName('')
    }
    if (o.notes) {
      setHistoryNotes([])
    }
    if (o.uiFilters) {
      setBeanSearchTerm('')
      setShowStockOnly(false)
      setShowActiveOnly(false)
    }
    if (o.stockInputMode) {
      setInventoryState((cur) => {
        const next = applyPhysicalCountDateWhenEnablingAuto({ ...cur, surveyMarkedDays: [] })
        const physIdx = dayIndexForReferenceDate(next.days, next.physicalCountDate)
        const pins = buildStockPinnedDayIndices(next.days, next.surveyMarkedDays, physIdx)
        return {
          ...next,
          beanRows: next.beanRows.map((bean) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, pins),
          })),
        }
      })
    }

    if (o.tableData && zeroedSnapshot) {
      setSelectedBeanName(zeroedSnapshot.beanRows[0]?.name ?? '')
    } else if (o.uiFilters) {
      setSelectedBeanName(inventoryState.beanRows[0]?.name ?? '')
    }

    const doneLabels: string[] = []
    if (o.tableData) {
      doneLabels.push('생두·로스팅 표(숫자 0)')
    }
    if (o.template) {
      doneLabels.push('엑셀 서식')
    }
    if (o.notes) {
      doneLabels.push('히스토리 메모')
    }
    if (o.uiFilters) {
      doneLabels.push('검색·필터')
    }
    if (o.stockInputMode) {
      doneLabels.push('실사 표시(일자 헤더)')
    }

    closeFullResetDialog()
    setStatusMessage(`초기화했습니다: ${doneLabels.join(', ')}`)
  }

  useEffect(() => {
    if (!fullResetDialogOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeFullResetDialog()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullResetDialogOpen, closeFullResetDialog])

  useEffect(() => {
    if (!fullResetDialogOpen) {
      return
    }
    const id = window.requestAnimationFrame(() => {
      fullResetPinInputRef.current?.focus()
      fullResetPinInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [fullResetDialogOpen])

  const closeNameEditUnlockDialog = useCallback(() => {
    setNameEditUnlockDialogOpen(false)
    setNameEditUnlockPin('')
    setNameEditUnlockError('')
  }, [])

  useEffect(() => {
    if (!nameEditUnlockDialogOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeNameEditUnlockDialog()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nameEditUnlockDialogOpen, closeNameEditUnlockDialog])

  useEffect(() => {
    if (!nameEditUnlockDialogOpen) {
      return
    }
    const id = window.requestAnimationFrame(() => {
      nameEditUnlockPinInputRef.current?.focus()
      nameEditUnlockPinInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [nameEditUnlockDialogOpen])

  const handleInventoryNameEditToggle = () => {
    if (inventoryNameEditMode) {
      setInventoryNameEditMode(false)
      return
    }
    setNameEditUnlockError('')
    setNameEditUnlockPin('')
    setNameEditUnlockDialogOpen(true)
  }

  const confirmNameEditUnlock = () => {
    if (nameEditUnlockPin !== ADMIN_FOUR_DIGIT_PIN) {
      setNameEditUnlockError('비밀번호가 올바르지 않습니다.')
      return
    }
    closeNameEditUnlockDialog()
    setInventoryNameEditMode(true)
  }

  const handleExportWorkbook = async () => {
    const exportFileName =
      templateFileName || `입출고현황_${formatFileDate(inventoryState.referenceDate)}.xlsx`
    const dayCount = inventoryState.days.length
    const roastingColumnCount = inventoryState.roastingColumns.length
    const exportState = {
      ...inventoryState,
      beanRows: displayedBeanRows,
    }

    if (templateBase64) {
      try {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(toArrayBuffer(base64ToUint8Array(templateBase64)))
        const applied = applyStateToTemplateWorkbook(workbook, exportState)

        if (applied) {
          const buffer = await workbook.xlsx.writeBuffer()
          downloadBufferAsFile(buffer as ArrayBuffer, exportFileName)
          setStatusMessage('업로드한 원본 엑셀 서식을 유지한 채 수정값을 저장했습니다.')
          return
        }
      } catch {
        setStatusMessage('원본 서식 유지 저장에 실패해 새 엑셀 파일 형식으로 저장합니다.')
      }
    }

    const workbook = XLSX.utils.book_new()

    const beanSheetRows: Array<Array<string | number>> = [
      ['■ 원두별 전체현황', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '기준일 :', '', '', inventoryState.referenceDate],
      ['NO', '생두명', '구분', ...inventoryState.days, '계'],
    ]

    displayedBeanRows.forEach((bean) => {
      const rows = [
        ['입고', alignBeanValuesToDayCount(bean.inbound, dayCount)],
        [
          '생산',
          alignBeanValuesToDayCount(
            bean.production.map((value) => convertRawInputToRoastedOutput(value)),
            dayCount,
          ),
        ],
        ['출고', alignBeanValuesToDayCount(bean.outbound, dayCount)],
        ['재고', alignBeanValuesToDayCount(bean.stock, dayCount)],
      ] as const

      rows.forEach(([label, values], rowIndex) => {
        beanSheetRows.push([
          rowIndex === 0 ? bean.no : '',
          rowIndex === 0 ? bean.name : '',
          label,
          ...values,
          values.reduce((total, value) => total + value, 0),
        ])
      })
    })

    const beanWorksheet = XLSX.utils.aoa_to_sheet(beanSheetRows)
    beanWorksheet['!cols'] = [
      { wch: 8 },
      { wch: 24 },
      { wch: 10 },
      ...inventoryState.days.map(() => ({ wch: 6 })),
      { wch: 10 },
    ]

    const roastingDailySheetRows = roastingDailyRows.map((row) => {
      const aligned = alignRoastingValuesToColumnCount(row.values, roastingColumnCount)
      return [row.day, ...aligned, aligned.reduce((total, value) => total + value, 0)]
    })

    const roastingTotalValues = inventoryState.roastingColumns.map((_, index) =>
      roastingDailyRows.reduce((total, row) => total + (row.values[index] ?? 0), 0),
    )

    const roastingSheetRows: Array<Array<string | number>> = [
      ['■ 일자별 로스팅현황', ...Array(roastingColumnCount).fill(''), '단위:kg'],
      ['NO', ...inventoryState.roastingColumns, '일 합계'],
      ...roastingDailySheetRows,
      ['계', ...roastingTotalValues, roastingTotalValues.reduce((total, value) => total + value, 0)],
    ]

    const roastingWorksheet = XLSX.utils.aoa_to_sheet(roastingSheetRows)
    roastingWorksheet['!cols'] = [
      { wch: 8 },
      ...inventoryState.roastingColumns.map(() => ({ wch: 16 })),
      { wch: 10 },
    ]

    const beanNameWorksheet = XLSX.utils.aoa_to_sheet([
      ['NO', '원두명'],
      ...displayedBeanRows.map((bean) => [bean.no, bean.name]),
    ])
    beanNameWorksheet['!cols'] = [{ wch: 8 }, { wch: 24 }]

    XLSX.utils.book_append_sheet(workbook, beanWorksheet, '생두전체현황')
    XLSX.utils.book_append_sheet(workbook, roastingWorksheet, '로스팅현황')
    XLSX.utils.book_append_sheet(workbook, beanNameWorksheet, '원두명')

    XLSX.writeFile(workbook, exportFileName)
    setStatusMessage('현재 페이지 수정 내용을 새 엑셀 파일로 저장했습니다.')
  }

  return (
    <>
    <div className="meeting-layout">
      <header className="hero-panel">
        <div>
          <div className="inventory-hero-title-row">
            <h1>생두 / 로스팅 현황</h1>
            <div className="hero-metrics inventory-hero-metrics-inline">
              <div className="metric-card">
                <span>기준일</span>
                <strong>{formatReferenceDate(inventoryState.referenceDate)}</strong>
              </div>
              <div className="metric-card">
                <span>기준일 재고 합계</span>
                <strong>{formatNumber(inventoryMetric.totalEndingStock)}kg</strong>
              </div>
              <div className="metric-card">
                <span>총 로스팅량</span>
                <strong>{formatNumber(roastingMetrics.grandTotal)}kg</strong>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="panel inventory-top-controls-panel">
        <div className="meeting-config-row inventory-config-row inventory-config-row--single-line">
          <label className="meeting-inline-field">
            기준일
            <input
              type="date"
              value={inventoryState.referenceDate}
              onChange={(event) => {
                const nextRef = event.target.value
                setInventoryState((current) => ({
                  ...current,
                  referenceDate: nextRef,
                  physicalCountDate: `${nextRef.slice(0, 8)}${current.physicalCountDate.slice(8, 10)}`,
                }))
              }}
            />
          </label>
          <label className="meeting-inline-field">
            실사 기준일
            <input
              type="date"
              value={inventoryState.physicalCountDate}
              onChange={(event) =>
                setInventoryState((current) => ({
                  ...current,
                  physicalCountDate: `${current.referenceDate.slice(0, 8)}${event.target.value.slice(8, 10)}`,
                }))
              }
            />
          </label>
          <label className="meeting-inline-field">
            재고 보유 품목
            <input value={`${inventoryMetric.activeBeans}개`} readOnly />
          </label>
          <label className="meeting-inline-field">
            품목 검색
            <input
              value={beanSearchTerm}
              onChange={(event) => setBeanSearchTerm(event.target.value)}
              placeholder="생두명 검색"
            />
          </label>
        </div>
        <div className="inventory-actions inventory-actions--under-config">
          <button
            type="button"
            className={
              showStockOnly
                ? 'inventory-toggle-button inventory-actions-toggle-button active'
                : 'inventory-toggle-button inventory-actions-toggle-button'
            }
            onClick={() => setShowStockOnly((current) => !current)}
          >
            {showStockOnly ? '전체 재고 보기' : '재고 있는 품목만'}
          </button>
          <button
            type="button"
            className={
              showActiveOnly
                ? 'inventory-toggle-button inventory-actions-toggle-button active'
                : 'inventory-toggle-button inventory-actions-toggle-button'
            }
            onClick={() => setShowActiveOnly((current) => !current)}
          >
            {showActiveOnly ? '전체 활동 보기' : '사용 이력 품목만'}
          </button>
          <label className="upload-button secondary">
            자료 엑셀 업로드
            <input type="file" accept=".xlsx,.xls" onChange={handleWorkbookUpload} />
          </label>
          <button type="button" className="ghost-button" onClick={handleExportWorkbook}>
            엑셀 저장
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={handleResetDefault}
            disabled={!templateBase64}
            title={
              templateBase64
                ? '마지막으로 업로드한 엑셀 기준으로 표를 되돌립니다.'
                : '엑셀 자료를 업로드한 뒤에만 사용할 수 있습니다.'
            }
          >
            기본값 복원
          </button>
          <div className="segmented inventory-sheet-tabs inventory-sheet-tabs--actionline">
            {SHEET_OPTIONS.map((sheet) => (
              <button
                key={sheet.id}
                type="button"
                className={activeSheet === sheet.id ? 'active' : ''}
                onClick={() => setActiveSheet(sheet.id)}
              >
                {sheet.label}
              </button>
            ))}
          </div>
        </div>
        <div className="page-status-bar">
          <div className="page-status-inline inventory-status-inline">
            <p className="page-status-message" role="status" aria-live="polite">
              {statusMessage}
            </p>
            <span
              className="inventory-info-tooltip-trigger"
              role="img"
              aria-label="재고 연쇄·실사 설명"
              title="입고·생산·출고는 날짜별로 모두 적을 수 있고, 재고는 그에 맞춰 자동으로 이어집니다. 재고를 직접 맞출 수 있는 칸은 월초(1일)와, 일자 헤더에서「실사」를 켠 날, 그리고 실사 표시가 없을 때는 위쪽「실사 기준일」열입니다. 여러 날에 실사를 켜면 그 사이도 연쇄로 계산됩니다. 일자 옆 ●는 재고를 직접 넣는 칸입니다. 실사 해제는 달력상 가장 늦게 켠 날부터만 가능합니다."
            >
              i
            </span>
          </div>
          <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
        </div>
      </section>

      {activeSheet === 'beans' ? (
        <section className="meeting-grid">
          <div className="meeting-card">
            <div className="meeting-card-header inventory-bean-summary-card-header">
              <h3>품목별 요약</h3>
              <div className="inventory-bean-summary-header-actions">
                <span className="inventory-filter-summary">
                  {filteredBeanSummaryRows.length} / {beanSummaryRows.length}개 표시
                </span>
                <div className="inventory-bean-summary-action-buttons">
                  <button
                    type="button"
                    className={`ghost-button small-hit inventory-bean-summary-name-edit-button${
                      inventoryNameEditMode ? ' active' : ''
                    }`}
                    onClick={handleInventoryNameEditToggle}
                    title={
                      inventoryNameEditMode
                        ? '품목명 편집을 마칩니다. 로스팅 열·품목별 요약에서 이름을 더 바꾸려면 다시 켜세요.'
                        : '관리자 비밀번호(0402) 확인 후 품목명을 바꿀 수 있습니다. 생두 행과 로스팅 열 이름이 함께 바뀝니다.'
                    }
                  >
                    {inventoryNameEditMode ? '이름 수정 끝' : '이름 수정'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button small-hit inventory-bean-summary-reset-button"
                    onClick={openFullResetDialog}
                  >
                    초기화
                  </button>
                </div>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="meeting-table inventory-table inventory-bean-summary-table">
                <colgroup>
                  <col className="inventory-summary-col-name inventory-summary-col-no-name" />
                  <col className="inventory-summary-col-num" />
                  <col className="inventory-summary-col-num" />
                  <col className="inventory-summary-col-num" />
                  <col className="inventory-summary-col-num" />
                  <col className="inventory-summary-col-num" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="inventory-sticky-column inventory-bean-summary-no-name-th" scope="col">
                      NO · 생두명
                    </th>
                    <th scope="col">입고 합계</th>
                    <th scope="col">생산 결과량 합계</th>
                    <th scope="col">환산 생두 사용량</th>
                    <th scope="col">출고 합계</th>
                    <th scope="col">기준일 재고</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBeanSummaryRows.map((bean) => (
                    <tr key={bean.name}>
                      <td className="inventory-sticky-column inventory-text-left inventory-bean-name-td inventory-bean-summary-no-name-td">
                        {inventoryNameEditMode ? (
                          <input
                            key={`${bean.no}-${bean.name}`}
                            className="inventory-cell-input inventory-bean-summary-name-input"
                            defaultValue={bean.name}
                            aria-label={`${bean.no}번 생두명`}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                ;(event.target as HTMLInputElement).blur()
                              }
                            }}
                            onBlur={(event) => {
                              const next = event.target.value
                              if (next.trim() !== bean.name.trim()) {
                                commitInventoryProductRenameFromSummary(bean.name, next)
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="inventory-bean-name-cell-button"
                            onClick={() => focusBeanDetail(bean.name)}
                          >
                            <span className="inventory-bean-summary-no-prefix">{bean.no}.</span> {bean.name}
                          </button>
                        )}
                      </td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.inboundTotal)}</td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.roastedOutputTotal)}</td>
                      <td className="inventory-summary-num-cell">
                        {bean.rawUsageTotal === null ? '-' : formatNumber(bean.rawUsageTotal)}
                      </td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.outboundTotal)}</td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.endingStock)}</td>
                    </tr>
                  ))}
                  {filteredBeanSummaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="inventory-empty-cell">
                        현재 조건에 맞는 품목이 없습니다.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {selectedBean ? (
            <div ref={beanDetailSectionRef} className="meeting-card inventory-bean-detail-card">
              <div className="meeting-card-header inventory-daily-detail-card-header">
                <h3 className="inventory-daily-detail-heading">
                  <span className="inventory-daily-detail-bean-title">
                    {selectedBean.no}. {selectedBean.name}
                  </span>
                  <span className="inventory-daily-detail-title-suffix">
                    {beanDetailViewMode === 'weekly' ? ' 주간 상세' : ' 일자별 상세'}
                  </span>
                </h3>
                <div className="segmented inventory-bean-detail-view-toggle">
                  <button
                    type="button"
                    className="ghost-button small-hit"
                    onClick={handleRestoreSelectedBeanStockWithPin}
                    title="비밀번호(0402) 확인 후 선택 품목 재고를 다시 연쇄 계산합니다"
                  >
                    재고맞춤
                  </button>
                  <button
                    type="button"
                    className={beanDetailViewMode === 'daily' ? 'active' : ''}
                    onClick={() => setBeanDetailViewMode('daily')}
                  >
                    일별
                  </button>
                  <button
                    type="button"
                    className={beanDetailViewMode === 'weekly' ? 'active' : ''}
                    onClick={() => setBeanDetailViewMode('weekly')}
                  >
                    주간
                  </button>
                </div>
              </div>
              {beanDetailViewMode === 'daily' ? (
                <>
                  {isBlendingDarkBeanRow(selectedBean) ? (
                    <p className="muted tiny inventory-blend-dark-hint">
                      Blending-Dark는 다른 원두 행과 숫자를 연동하지 않습니다. 이 품목만 입고·생산·출고·재고를
                      따로 적어 주시면 됩니다. 일별 출고만큼 그날부터 재고가 줄어듭니다.
                    </p>
                  ) : null}
                  {isBlendingLightBeanRow(selectedBean) ? (
                    <p className="muted tiny inventory-blend-dark-hint">
                      Blending-Light도 일별 출고만큼 재고가 줄어듭니다.
                    </p>
                  ) : null}
                  <div ref={beanDailyScrollRef} className="inventory-bean-daily-x-scroll">
                    <table className="meeting-table inventory-table">
                      <thead>
                        <tr>
                          <th className="inventory-sticky-column">구분</th>
                          {inventoryState.days.map((day) => {
                            const isUserSurveyMark = surveyMarkedDaySet.has(day)
                            const showDayMarker = isUserSurveyMark
                            const markerLabel = '실사한 날'
                            return (
                              <th key={day} scope="col" className="inventory-day-th">
                                <span className="inventory-day-th-inner">
                                  <span className="inventory-day-th-num">{day}</span>
                                  <button
                                    type="button"
                                    className={
                                      isUserSurveyMark
                                        ? 'inventory-survey-day-button inventory-survey-day-button--on'
                                        : 'inventory-survey-day-button'
                                    }
                                    title="실사한 날로 표시하면 해당 열 재고를 직접 맞출 수 있습니다. 해제는 달력상 가장 늦게 표시한 날부터만 가능합니다."
                                    aria-pressed={isUserSurveyMark}
                                    onClick={() => toggleSurveyMarkedDay(day)}
                                  >
                                    실사
                                  </button>
                                  {showDayMarker ? (
                                    <span
                                      className="inventory-day-marker"
                                      title={markerLabel}
                                      aria-label={markerLabel}
                                    />
                                  ) : null}
                                </span>
                              </th>
                            )
                          })}
                          <th>합계</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          isBlendingDarkBeanRow(selectedBean)
                            ? [
                                { label: '입고', values: selectedBean.inbound, key: 'inbound' as const },
                                {
                                  label: '블렌딩 생산량',
                                  values: selectedBean.production.map(convertRawInputToRoastedOutput),
                                  key: 'production' as const,
                                },
                                { label: '출고', values: selectedBean.outbound, key: 'outbound' as const },
                                { label: '재고', values: selectedBean.stock, key: 'stock' as const },
                              ]
                            : [
                                { label: '입고', values: selectedBean.inbound, key: 'inbound' as const },
                                {
                                  label: '생산 결과량',
                                  values: selectedBean.production.map(convertRawInputToRoastedOutput),
                                  key: 'production' as const,
                                },
                                { label: '출고', values: selectedBean.outbound, key: 'outbound' as const },
                                {
                                  label: '환산 생두 사용량',
                                  values: selectedBean.production,
                                  key: 'raw-usage' as const,
                                },
                                { label: '재고', values: selectedBean.stock, key: 'stock' as const },
                              ]
                        ).map((row) => (
                          <tr key={row.label}>
                            <td className="inventory-sticky-column inventory-text-left">
                              {row.label}
                            </td>
                            {row.values.map((value, index) => {
                              const stockAutoLocked =
                                row.key === 'stock' &&
                                !isStockColumnEditable(inventoryState, index)
                              const readOnly = row.key === 'raw-usage' || stockAutoLocked
                              const stepMin =
                                row.key === 'production' || row.key === 'inbound' || row.key === 'outbound'
                                  ? { step: 1, min: 0 }
                                  : row.key === 'stock' && !readOnly
                                    ? { step: 1, min: 0 }
                                    : {}
                              return (
                                <td key={`${row.label}-${index + 1}`}>
                                  <input
                                    type="number"
                                    {...stepMin}
                                    className={
                                      readOnly
                                        ? 'inventory-cell-input meeting-cell-input-readonly'
                                        : 'inventory-cell-input'
                                    }
                                    value={inventoryNumericInputValue(value)}
                                    readOnly={readOnly}
                                    onChange={(event) =>
                                      updateBeanValue(
                                        selectedBeanIndex,
                                        row.key === 'raw-usage' ? 'production' : row.key,
                                        index,
                                        event.target.value,
                                      )
                                    }
                                  />
                                </td>
                              )
                            })}
                            <td>{formatNumber(sumValues(row.values))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="table-wrapper">
                  <table className="meeting-table inventory-table">
                    <thead>
                      <tr>
                        <th className="inventory-sticky-column">구분</th>
                        {BEAN_DETAIL_WEEK_RANGES.map((w) => (
                          <th key={w.key}>{w.label}</th>
                        ))}
                        <th>합계</th>
                      </tr>
                    </thead>
                    <tbody>
                      {beanWeeklyDetailRows.map((row) => (
                        <tr key={row.label}>
                          <td className="inventory-sticky-column inventory-text-left">
                            {row.label}
                          </td>
                          {row.values.map((value, wi) => (
                            <td key={BEAN_DETAIL_WEEK_RANGES[wi].key}>{formatTwoDecimals(value)}</td>
                          ))}
                          <td>{formatTwoDecimals(sumValues(row.values))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {beanDetailViewMode === 'weekly' ? (
                <p className="muted tiny inventory-bean-weekly-hint">
                  주간 보기는 집계 표시입니다. 입고·생산·출고는 해당 주 일자 합계, 재고는 그 주에 포함된 날짜 중
                  가장 늦은 날의 재고입니다. 수정은「일별」에서 해 주세요.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="meeting-card">
            <div className="meeting-card-header">
              <h3>수정 이력 메모</h3>
              <span className="inventory-filter-summary">{historyNotes.length}건 저장됨</span>
            </div>
            <div className="meeting-config-row inventory-config-row inventory-note-row">
              <label className="meeting-inline-field inventory-note-field">
                메모
                <span className="inventory-note-inline-date">
                  <span>날짜</span>
                  <input type="date" value={noteDate} onChange={(event) => setNoteDate(event.target.value)} />
                </span>
                <textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="예: 예가체프 입고 수량 수정, 재고 실사 반영"
                />
              </label>
              <div className="meeting-inline-field inventory-note-action">
                <button type="button" className="secondary" onClick={handleAddHistoryNote}>
                  저장
                </button>
              </div>
            </div>
            <div className="inventory-note-list">
              {historyNotes.length === 0 ? (
                <p className="inventory-empty-message">아직 남겨둔 메모가 없습니다.</p>
              ) : (
                historyNotes.map((note) => (
                  <div key={note.id} className="inventory-note-item">
                    <div className="inventory-note-item-header">
                      <strong>{formatReferenceDate(note.date)}</strong>
                      <div className="inventory-note-item-actions">
                        <span>{new Date(note.createdAt).toLocaleString('ko-KR')}</span>
                        <button
                          type="button"
                          className="inventory-note-delete"
                          onClick={() => handleDeleteHistoryNote(note.id)}
                          title="메모 삭제"
                          aria-label="메모 삭제"
                        >
                          -
                        </button>
                      </div>
                    </div>
                    <p>{note.note}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="meeting-grid">
          <div className="meeting-card inventory-roasting-summary-card">
            <div className="meeting-card-header">
              <h3>품목별 로스팅 요약</h3>
              <button
                type="button"
                className={`ghost-button ${hideZeroRoastingItems ? 'active' : ''}`}
                onClick={() => setHideZeroRoastingItems((current) => !current)}
              >
                {hideZeroRoastingItems ? '전체 품목 보기' : '사용 품목만 보기'}
              </button>
            </div>
            <div className="inventory-roasting-kpi-strip" aria-label="로스팅 요약 지표">
              <div className="inventory-roasting-kpi-chip">
                <span>최근 로스팅 일자</span>
                <strong>
                  {roastingMetrics.latestActiveDay > 0
                    ? `${roastingMetrics.latestActiveDay}일 / ${formatTwoDecimals(roastingMetrics.latestActiveDayTotal)}kg`
                    : '-'}
                </strong>
              </div>
              <div className="inventory-roasting-kpi-chip">
                <span>최대 로스팅 일자</span>
                <strong>
                  {roastingMetrics.peakDay.day > 0
                    ? `${roastingMetrics.peakDay.day}일 / ${formatTwoDecimals(roastingMetrics.peakDay.total)}kg`
                    : '-'}
                </strong>
              </div>
              <div className="inventory-roasting-kpi-chip">
                <span>월 누적 결과량</span>
                <strong>{formatTwoDecimals(roastingMetrics.grandTotal)}kg</strong>
              </div>
              <div className="inventory-roasting-kpi-chip">
                <span>환산 생두</span>
                <strong>{formatTwoDecimals(roastingMetrics.rawUsageEstimate)}kg</strong>
              </div>
              <div className="inventory-roasting-kpi-chip inventory-roasting-kpi-chip--wide">
                <span>최다 로스팅 품목</span>
                <strong>
                  {topRoastingItem
                    ? `${topRoastingItem.beanNo != null ? `${topRoastingItem.beanNo}. ` : ''}${topRoastingItem.name} / ${formatTwoDecimals(topRoastingItem.roastedTotal)}kg`
                    : '-'}
                </strong>
              </div>
              <div className="inventory-roasting-kpi-chip">
                <span>활동일 평균</span>
                <strong>
                  {roastingMetrics.daysWithRoasting > 0
                    ? `${formatTwoDecimals(roastingMetrics.averagePerActiveDay)}kg`
                    : '-'}
                </strong>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="meeting-table inventory-table">
                <thead>
                  <tr>
                    <th>NO · 품목</th>
                    <th>로스팅 결과량</th>
                    <th>환산 생두 사용량</th>
                    <th>비중</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRoastingSummaryRows.map((row) => (
                    <tr key={`roasting-summary-${row.name}`}>
                      <td className={`inventory-text-left inventory-heat-cell ${row.heatLevel}`}>
                        {row.beanNo != null ? (
                          <>
                            <span className="inventory-bean-summary-no-prefix">{row.beanNo}.</span> {row.name}
                          </>
                        ) : (
                          row.name
                        )}
                      </td>
                      <td>{formatTwoDecimals(row.roastedTotal)}kg</td>
                      <td>{row.rawUsageTotal === null ? '-' : `${formatTwoDecimals(row.rawUsageTotal)}kg`}</td>
                      <td>{row.share === null ? '-' : row.share > 0 ? `${(row.share * 100).toFixed(1)}%` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="meeting-card">
            <div className="meeting-card-header">
              <h3>{roastingViewMode === 'daily' ? '일자별 로스팅 현황' : '주단위 로스팅 현황'}</h3>
              <div className="segmented">
                <button
                  type="button"
                  className={roastingViewMode === 'daily' ? 'active' : ''}
                  onClick={() => setRoastingViewMode('daily')}
                >
                  일별
                </button>
                <button
                  type="button"
                  className={roastingViewMode === 'weekly' ? 'active' : ''}
                  onClick={() => setRoastingViewMode('weekly')}
                >
                  주별
                </button>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="meeting-table inventory-table">
                <thead>
                  <tr>
                    <th className="inventory-sticky-column">
                      {roastingViewMode === 'daily' ? '일자' : '주차'}
                    </th>
                    {visibleRoastingColumnIndices.map((index) => (
                      <th key={`roast-col-h-${index}`} className="inventory-roasting-th-name">
                        <div className="inventory-roasting-th-name-inner">
                          {roastingColumnIndexToBeanNo.has(index) ? (
                            <span className="inventory-roasting-col-no-prefix" aria-hidden>
                              {roastingColumnIndexToBeanNo.get(index)}.
                            </span>
                          ) : null}
                          <input
                            type="text"
                            className="inventory-cell-input inventory-roasting-column-name-input"
                            aria-label={`로스팅 열 ${index + 1} 품목명`}
                            value={inventoryState.roastingColumns[index] ?? ''}
                            readOnly={!inventoryNameEditMode}
                            title={
                              inventoryNameEditMode
                                ? '입출고와 같은 이름의 생두 행이 함께 바뀝니다. 다른 품목과 겹치는 이름은 쓸 수 없습니다.'
                                : '품목별 요약의「이름 수정」을 누른 뒤에만 바꿀 수 있습니다.'
                            }
                            onFocus={
                              inventoryNameEditMode
                                ? () => {
                                    roastingColumnRenameOriginRef.current.set(
                                      index,
                                      inventoryState.roastingColumns[index] ?? '',
                                    )
                                  }
                                : undefined
                            }
                            onBlur={
                              inventoryNameEditMode ? () => finalizeRoastingColumnName(index) : undefined
                            }
                            onChange={(event) => updateRoastingColumnName(index, event.target.value)}
                          />
                        </div>
                      </th>
                    ))}
                    <th>{roastingViewMode === 'daily' ? '일 합계' : '주 합계'}</th>
                    {roastingViewMode === 'weekly' ? <th>전주 대비</th> : null}
                    {roastingViewMode === 'weekly' ? <th>활성 품목</th> : null}
                    {roastingViewMode === 'weekly' ? <th>Top 품목</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {roastingViewMode === 'daily'
                    ? roastingDailyRows.map((row) => (
                        <tr key={row.day}>
                          <td className="inventory-sticky-column">{row.day}</td>
                          {visibleRoastingColumnIndices.map((index) => (
                            <td key={`${row.day}-col-${index}`}>
                              <input
                                type="number"
                                className={`inventory-cell-input inventory-heat-cell ${getHeatLevel(
                                  row.values[index] ?? 0,
                                  maxRoastingCellValue,
                                )}`}
                                value={inventoryNumericInputValue(row.values[index] ?? 0)}
                                onChange={(event) => updateRoastingValue(row.day, index, event.target.value)}
                              />
                            </td>
                          ))}
                          <td>{formatTwoDecimals(sumValues(row.values))}</td>
                        </tr>
                      ))
                    : roastingWeeklyRows.map((row) => (
                        <tr
                          key={row.key}
                          className={row.isCurrentWeek ? 'inventory-week-current' : undefined}
                        >
                          <td className="inventory-sticky-column">{row.label}</td>
                          {visibleRoastingColumnIndices.map((index) => (
                            <td
                              key={`${row.key}-col-${index}`}
                              className={`inventory-heat-cell ${getHeatLevel(
                                row.values[index] ?? 0,
                                maxWeeklyRoastingCellValue,
                              )}`}
                            >
                              {formatTwoDecimals(row.values[index] ?? 0)}
                            </td>
                          ))}
                          <td>{formatTwoDecimals(row.total)}</td>
                          <td
                            className={
                              row.deltaFromPrevious === null
                                ? ''
                                : row.deltaFromPrevious >= 0
                                  ? 'inventory-delta-positive'
                                  : 'inventory-delta-negative'
                            }
                          >
                            {row.deltaFromPrevious === null
                              ? '-'
                              : `${row.deltaFromPrevious > 0 ? '▲ ' : row.deltaFromPrevious < 0 ? '▼ ' : '− '}${
                                  row.deltaFromPrevious > 0 ? '+' : ''
                                }${formatTwoDecimals(row.deltaFromPrevious)}kg`}
                          </td>
                          <td>{row.activeItemCount}개</td>
                          <td>
                            {row.topItemTotal > 0
                              ? `${row.topItemName} / ${formatTwoDecimals(row.topItemTotal)}kg`
                              : '-'}
                          </td>
                        </tr>
                      ))}
                </tbody>
                {inventoryState.roastingColumns.length > 0 ? (
                  <tfoot>
                    <tr>
                      <td className="inventory-sticky-column">계</td>
                      {visibleRoastingColumnIndices.map((index) => (
                        <td key={`total-col-${index}`}>
                          {formatTwoDecimals(computedRoastingTotals[index] ?? 0)}
                        </td>
                      ))}
                      <td>{formatTwoDecimals(roastingMetrics.grandTotal)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </div>
        </section>
      )}
    </div>

    {fullResetDialogOpen ? (
      <div
        className="inventory-reset-dialog-backdrop"
        role="presentation"
        onClick={closeFullResetDialog}
      >
        <div
          className="inventory-reset-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-full-reset-dialog-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="inventory-full-reset-dialog-title" className="inventory-reset-dialog-title">
            전체 초기화
          </h2>
          <p className="inventory-reset-dialog-body">
            아래에서 초기화할 항목을 고른 뒤 비밀번호를 입력하고 「초기화 실행」을 누르세요. 표를 초기화하면
            지금 표에 있는 <strong>품목 행(엑셀에서 올린 품목만 포함)</strong>은 그대로 두고,{' '}
            <strong>입고·생산·출고·재고·로스팅 수치만 모두 0</strong>으로 맞춥니다. 엑셀을 올려 둔 경우 그때 저장된
            「기본값 복원」기준은 그대로 두어, 복원으로 업로드 당시 표를 다시 불러올 수 있습니다.
          </p>
          <fieldset className="inventory-reset-dialog-fieldset">
            <legend className="inventory-reset-dialog-legend">초기화할 항목</legend>
            <label className="inventory-reset-dialog-check">
              <input
                type="checkbox"
                checked={fullResetOptions.tableData}
                onChange={() => {
                  setFullResetDialogError('')
                  setFullResetOptions((p) => ({ ...p, tableData: !p.tableData }))
                }}
              />
              <span>
                <strong>생두·로스팅 표 (숫자 전부 0)</strong>
                <span className="inventory-reset-dialog-check-desc">
                  지금 표에 있는 품목·날짜·로스팅 열 구성은 유지하고 칸 숫자만 0입니다. 엑셀 업로드 기준이 있으면 그
                  기준 상태는 바꾸지 않아 「기본값 복원」으로 업로드 당시를 불러올 수 있습니다. 업로드한 적이 없을 때만
                  기준값도 0으로 맞춥니다.
                </span>
              </span>
            </label>
            <label className="inventory-reset-dialog-check">
              <input
                type="checkbox"
                checked={fullResetOptions.template}
                onChange={() => {
                  setFullResetDialogError('')
                  setFullResetOptions((p) => ({ ...p, template: !p.template }))
                }}
              />
              <span>
                <strong>업로드 엑셀 서식</strong>
                <span className="inventory-reset-dialog-check-desc">
                  원본 서식 유지 저장에 쓰이던 업로드 파일 정보를 지웁니다.
                </span>
              </span>
            </label>
            <label className="inventory-reset-dialog-check">
              <input
                type="checkbox"
                checked={fullResetOptions.notes}
                onChange={() => {
                  setFullResetDialogError('')
                  setFullResetOptions((p) => ({ ...p, notes: !p.notes }))
                }}
              />
              <span>
                <strong>수정 이력 메모</strong>
                <span className="inventory-reset-dialog-check-desc">페이지 하단에 저장된 메모를 모두 지웁니다.</span>
              </span>
            </label>
            <label className="inventory-reset-dialog-check">
              <input
                type="checkbox"
                checked={fullResetOptions.uiFilters}
                onChange={() => {
                  setFullResetDialogError('')
                  setFullResetOptions((p) => ({ ...p, uiFilters: !p.uiFilters }))
                }}
              />
              <span>
                <strong>품목 검색·요약 필터</strong>
                <span className="inventory-reset-dialog-check-desc">
                  검색어, 「재고 있는 품목만」「사용 이력 품목만」을 끕니다. 선택 중이던 품목은 목록의 첫 품목으로
                  맞춥니다.
                </span>
              </span>
            </label>
            <label className="inventory-reset-dialog-check">
              <input
                type="checkbox"
                checked={fullResetOptions.stockInputMode}
                onChange={() => {
                  setFullResetDialogError('')
                  setFullResetOptions((p) => ({ ...p, stockInputMode: !p.stockInputMode }))
                }}
              />
              <span>
                <strong>실사 표시 전부 해제</strong>
                <span className="inventory-reset-dialog-check-desc">
                  일자 헤더에 켜 둔 실사 표시를 모두 끄고, 실사 기준일·월초만 재고 직접 입력 핀으로 두고 재고를 다시 연쇄 계산합니다.
                </span>
              </span>
            </label>
          </fieldset>
          <label className="inventory-reset-dialog-field">
            <span className="inventory-reset-dialog-label">비밀번호 (4자리)</span>
            <input
              ref={fullResetPinInputRef}
              className="inventory-reset-dialog-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              placeholder="0000"
              aria-invalid={fullResetDialogError ? true : undefined}
              value={fullResetPin}
              onChange={(event) => {
                setFullResetDialogError('')
                const next = event.target.value.replace(/\D/g, '').slice(0, 4)
                setFullResetPin(next)
              }}
            />
          </label>
          {fullResetDialogError ? (
            <p className="inventory-reset-dialog-error" role="alert">
              {fullResetDialogError}
            </p>
          ) : null}
          <div className="inventory-reset-dialog-actions">
            <button type="button" className="ghost-button" onClick={closeFullResetDialog}>
              취소
            </button>
            <button type="button" className="ghost-button inventory-bean-summary-reset-button" onClick={confirmFullInventoryReset}>
              초기화 실행
            </button>
          </div>
        </div>
      </div>
    ) : null}

    {nameEditUnlockDialogOpen ? (
      <div
        className="inventory-reset-dialog-backdrop"
        role="presentation"
        onClick={closeNameEditUnlockDialog}
      >
        <div
          className="inventory-reset-dialog inventory-name-edit-unlock-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-name-edit-unlock-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="inventory-name-edit-unlock-title" className="inventory-reset-dialog-title">
            품목명 수정
          </h2>
          <p className="inventory-reset-dialog-body">
            생두·로스팅 <strong>품목명</strong>을 바꾸려면 관리자 비밀번호(4자리)를 입력한 뒤 「확인」을 누르세요.
          </p>
          <label className="inventory-reset-dialog-field">
            <span className="inventory-reset-dialog-label">비밀번호 (4자리)</span>
            <input
              ref={nameEditUnlockPinInputRef}
              className="inventory-reset-dialog-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              placeholder="0000"
              aria-invalid={nameEditUnlockError ? true : undefined}
              value={nameEditUnlockPin}
              onChange={(event) => {
                setNameEditUnlockError('')
                const next = event.target.value.replace(/\D/g, '').slice(0, 4)
                setNameEditUnlockPin(next)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmNameEditUnlock()
                }
              }}
            />
          </label>
          {nameEditUnlockError ? (
            <p className="inventory-reset-dialog-error" role="alert">
              {nameEditUnlockError}
            </p>
          ) : null}
          <div className="inventory-reset-dialog-actions">
            <button type="button" className="ghost-button" onClick={closeNameEditUnlockDialog}>
              취소
            </button>
            <button type="button" className="ghost-button" onClick={confirmNameEditUnlock}>
              확인
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  )
}

export default InventoryStatusPage
