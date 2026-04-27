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
  BLENDING_DECAFFEINE_BEAN_NAME,
  BLENDING_LIGHT_BEAN_NAME,
  isBlendingDarkBeanRow,
  isBlendingDecaffeineBeanRow,
  isBlendingLightBeanRow,
  isBlendingLineBeanRow,
  isBlendingOutboundAdjustsStockRow,
  productionForAutoStock,
  roastingColumnMatchesBeanRow,
} from './inventoryBlendRecipes'
import {
  cloneBlendingRecipe,
  createDefaultInventoryStatusState,
  createZeroedInventoryStatusFrom,
  dayIndexForReferenceDate,
  normalizeInventoryStatusState,
  parseInventoryWorkbook,
  resizeBlendingCyclesToDayCount,
  todayLocalIsoDateString,
  type BlendingRecipe,
  type BlendingRecipeComponent,
  type InventoryBeanRow,
  type InventoryStatusState,
} from './inventoryStatusUtils'

type BlendTarget = 'dark' | 'light' | 'decaf'
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

const formatNumber = (value: number) => numberFormatter.format(value)

/** type=number에서 0을 보이면 다음 입력이 "03"처럼 붙음 → 0은 빈칸으로 표시 */
const inventoryNumericInputValue = (value: number) => (value === 0 ? '' : String(value))

const sumValues = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

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
  const outbound = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    sumBeanValuesForWeek(days, bean.outbound, start, end),
  )
  const stock = BEAN_DETAIL_WEEK_RANGES.map(({ start, end }) =>
    lastBeanValueForWeek(days, bean.stock, start, end),
  )
  return [
    { label: '입고', key: 'inbound' as const, values: inbound },
    { label: '생산(사용량)', key: 'production' as const, values: productionRaw },
    { label: '출고', key: 'outbound' as const, values: outbound },
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
 * 자동 재고(일반 원두): 핀으로 찍은 열은 직접 입력값 유지. 생산(사용량)은 입력 kg을 그대로 재고에서 차감한다.
 * 그 외 일자는 전일재고+입고−생산(연쇄)이며 `production`은 `productionForAutoStock` 결과를 쓴다.
 * Blending-Dark/Light는 `resyncAutoStockForBeanRow`만 사용한다.
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
 * Blending-Dark/Light 자동 재고: 핀으로 찍은 열(실사)은 직접 `stock`을 유지.
 * 그 밖의 열은 `전일재고 + 생산(raw) − 출고` (입고는 연채에 넣지 않음·비워 둬도 됨).
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
    base[i] = (base[i - 1] ?? 0) + (prod[i] ?? 0) - (bean.outbound[i] ?? 0)
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

const LOW_STOCK_LOSSTING_BASE_BEANS_KG = 40
const LOW_STOCK_OTHER_BEANS_KG = 5

/** 블렌딩/로스팅에 쓰는 Brazil·Narino·Sidamo(브라질·나리뇨·시다모) 등 — 기준 재고(kg)를 더 크게 둔다. */
const isSpecialLosstingBaseBean = (name: string) => {
  const n = name.trim().toLowerCase()
  if (n.includes('brazil') || n.includes('브라질')) {
    return true
  }
  if (n.includes('narino') || n.includes('nariño') || n.includes('nario') || n.includes('나리뇨')) {
    return true
  }
  if (n.includes('sidamo') || n.includes('시다모')) {
    return true
  }
  return false
}

export type LowGreenBeanWarningItem = { name: string; kg: number; threshold: number }

/**
 * 기준일 열·자동 연채 반영 후 재고(kg)로, 로스팅용 주요 3원두 40kg 미만·그 외 5kg 미만 항목만 반환.
 * DARK / LIGHT / DECAFFEINE 블렌드 품목 행은 제외. (App 전역 경고)
 */
export function getLowGreenBeanWarningItems(state: InventoryStatusState): LowGreenBeanWarningItem[] {
  if (!state.beanRows.length) {
    return []
  }
  const physIdx = dayIndexForReferenceDate(state.days, state.physicalCountDate)
  const pins = buildStockPinnedDayIndices(state.days, state.surveyMarkedDays, physIdx)
  const endingIdx = dayIndexForReferenceDate(state.days, state.referenceDate)
  const out: LowGreenBeanWarningItem[] = []
  for (const bean of state.beanRows) {
    if (isBlendingLineBeanRow(bean)) {
      continue
    }
    const resynced = state.skipAutoStockDisplay
      ? bean.stock
      : resyncAutoStockForBeanRow(bean, pins)
    const stockLen = resynced.length
    if (stockLen <= 0) {
      continue
    }
    const cappedIdx = Math.min(Math.max(endingIdx, 0), stockLen - 1)
    const kg = resynced[cappedIdx] ?? 0
    const thr = isSpecialLosstingBaseBean(bean.name) ? LOW_STOCK_LOSSTING_BASE_BEANS_KG : LOW_STOCK_OTHER_BEANS_KG
    if (kg < thr) {
      out.push({ name: bean.name, kg, threshold: thr })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

/** bean.production(생두 사용량 kg)을 로스팅 일별 열에 그대로 투영(수율 환산 없음) */
const syncRoastingRowsFromBeanProduction = (state: InventoryStatusState): InventoryStatusState['roastingRows'] => {
  const dailyRows = state.roastingRows.filter(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: number } => typeof row.day === 'number',
  )
  const totalsRow = state.roastingRows.find(
    (row): row is InventoryStatusState['roastingRows'][number] & { day: '계' } => row.day === '계',
  )

  const blends = [
    {
      beanKey: normalizeNameKey(BLENDING_DARK_BEAN_NAME),
      recipe: state.blendingDarkRecipe,
      cycles: state.blendingDarkCycles ?? [],
    },
    {
      beanKey: normalizeNameKey(BLENDING_LIGHT_BEAN_NAME),
      recipe: state.blendingLightRecipe,
      cycles: state.blendingLightCycles ?? [],
    },
    {
      beanKey: normalizeNameKey(BLENDING_DECAFFEINE_BEAN_NAME),
      recipe: state.blendingDecaffeineRecipe,
      cycles: state.blendingDecaffeineCycles ?? [],
    },
  ]

  // 각 블렌드별 구성 원두(bean key → 사이클 1회당 raw 합)
  const blendRawByBeanKey = blends.map((blend) => {
    const m = new Map<string, number>()
    if (blend.recipe) {
      for (const comp of blend.recipe.components) {
        const key = normalizeNameKey(comp.beanName)
        if (key && key !== blend.beanKey) {
          m.set(key, (m.get(key) ?? 0) + comp.rawPerCycle)
        }
      }
    }
    return m
  })

  const nextDailyRows = dailyRows.map((row) => {
    const dayIndex = state.days.findIndex((d) => d === row.day)
    if (dayIndex < 0) {
      return row
    }
    const dayCyclesByBlend = blends.map((blend) => blend.cycles[dayIndex] ?? 0)

    const nextValues = state.roastingColumns.map((colName) => {
      const normalized = normalizeNameKey(colName)
      if (!normalized) {
        return 0
      }
      // 매칭되는 bean.production(생두 kg)에서, 그날 그 원두에 대한 블렌딩 raw 기여분을 뺀
      // 단독(수동) 생산(사용)분을 일별 셀에 그대로 표시한다(환산·수율 없음).
      // Blending-Dark/Light/Decaf 행은 구성원이 아니어서 여기서는 0; 구성원 원두는 사이클·레시피로 production에 누적됨.
      return state.beanRows.reduce((sum, bean) => {
        if (!roastingColumnMatchesBeanRow(colName, bean.name)) {
          return sum
        }
        const beanKey = normalizeNameKey(bean.name)
        const blendingRaw = blends.reduce((s, _blend, i) => {
          const perCycleRaw = blendRawByBeanKey[i].get(beanKey) ?? 0
          return s + perCycleRaw * dayCyclesByBlend[i]
        }, 0)
        const standaloneRaw = Math.max(0, (bean.production[dayIndex] ?? 0) - blendingRaw)
        return sum + standaloneRaw
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

/** 클라우드+회사: 회사마다 localStorage 캐시 키를 분리 (공용 키 사용 시 문서/값이 뒤섞임) */
export const inventoryPageScopedKey = (base: string, mode: 'local' | 'cloud', companyId: string | null) => {
  if (mode === 'cloud' && companyId) {
    return `${base}::${companyId}`
  }
  return base
}

/** 입출고 현황 브라우저 캐시 갱신 시 App 전역 배너 등이 다시 읽도록 알림 */
export const INVENTORY_STATUS_CACHE_EVENT = 'inventory-status-cache-updated'

const readInventoryPageLocalDocument = (mode: 'local' | 'cloud', companyId: string | null): InventoryPageDocument => {
  const stateKey = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, companyId)
  const saved = window.localStorage.getItem(stateKey)
  const savedBaseline = window.localStorage.getItem(
    inventoryPageScopedKey(INVENTORY_STATUS_BASELINE_STORAGE_KEY, mode, companyId),
  )
  const savedTemplate = window.localStorage.getItem(
    inventoryPageScopedKey(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY, mode, companyId),
  )
  const savedTemplateName = window.localStorage.getItem(
    inventoryPageScopedKey(INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY, mode, companyId),
  )
  const savedNotes = window.localStorage.getItem(
    inventoryPageScopedKey(INVENTORY_HISTORY_NOTES_STORAGE_KEY, mode, companyId),
  )

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

    const values = alignBeanValuesToDayCount(rawValues, dayCount)

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

type DailyRoastingJournalProps = {
  days: number[]
  columnIndices: number[]
  columnNames: string[]
  columnDisplayNo: Map<number, number | null>
  dailyRows: Array<{ day: number | '계'; values: number[] }>
  columnTotals: number[]
  grandTotal: number
  latestActiveDay: number
  peakDay: { day: number; total: number }
  daysWithRoasting: number
  referenceDate: string
  onChangeCell: (day: number, columnIndex: number, nextValue: string) => void
  blendingDarkCycles: number[]
  blendingDarkRecipe: BlendingRecipe
  blendingLightCycles: number[]
  blendingLightRecipe: BlendingRecipe
  blendingDecaffeineCycles: number[]
  blendingDecaffeineRecipe: BlendingRecipe
  beanNameOptions: string[]
  onChangeBlendingCycles: (target: BlendTarget, day: number, nextCycles: number) => void
  onChangeRecipeComponent: (
    target: BlendTarget,
    index: number,
    patch: Partial<BlendingRecipeComponent>,
  ) => void
  onChangeRoastedPerCycle: (target: BlendTarget, value: number) => void
  onAddRecipeComponent: (target: BlendTarget) => void
  onRemoveRecipeComponent: (target: BlendTarget, index: number) => void
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']

function DailyRoastingJournal({
  days,
  columnIndices,
  columnNames,
  columnDisplayNo,
  dailyRows,
  columnTotals,
  grandTotal,
  latestActiveDay,
  peakDay,
  daysWithRoasting,
  referenceDate,
  onChangeCell,
  blendingDarkCycles,
  blendingDarkRecipe,
  blendingLightCycles,
  blendingLightRecipe,
  blendingDecaffeineCycles,
  blendingDecaffeineRecipe,
  beanNameOptions,
  onChangeBlendingCycles,
  onChangeRecipeComponent,
  onChangeRoastedPerCycle,
  onAddRecipeComponent,
  onRemoveRecipeComponent,
}: DailyRoastingJournalProps) {
  const [showEmptyDays, setShowEmptyDays] = useState(false)
  const [quickDay, setQuickDay] = useState<number | ''>('')
  const [quickColumnIndex, setQuickColumnIndex] = useState<number | ''>('')
  const [quickKg, setQuickKg] = useState('')
  const [addingOnDay, setAddingOnDay] = useState<number | null>(null)
  const [addDraftColumn, setAddDraftColumn] = useState<number | ''>('')
  const [addDraftKg, setAddDraftKg] = useState('')
  const [editingChip, setEditingChip] = useState<{ day: number; columnIndex: number } | null>(null)
  const [editDraftKg, setEditDraftKg] = useState('')
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [cycleQuickDay, setCycleQuickDay] = useState<number | ''>('')
  const [cycleQuickCount, setCycleQuickCount] = useState<string>('1')
  const [cycleQuickTarget, setCycleQuickTarget] = useState<BlendTarget>('dark')
  const totalDarkRawPerCycle = useMemo(
    () => blendingDarkRecipe.components.reduce((sum, c) => sum + c.rawPerCycle, 0),
    [blendingDarkRecipe],
  )
  const totalLightRawPerCycle = useMemo(
    () => blendingLightRecipe.components.reduce((sum, c) => sum + c.rawPerCycle, 0),
    [blendingLightRecipe],
  )
  const totalDecafRawPerCycle = useMemo(
    () => blendingDecaffeineRecipe.components.reduce((sum, c) => sum + c.rawPerCycle, 0),
    [blendingDecaffeineRecipe],
  )
  const totalMonthDarkCycles = useMemo(
    () => blendingDarkCycles.reduce((sum, v) => sum + (v || 0), 0),
    [blendingDarkCycles],
  )
  const totalMonthLightCycles = useMemo(
    () => blendingLightCycles.reduce((sum, v) => sum + (v || 0), 0),
    [blendingLightCycles],
  )
  const totalMonthDecafCycles = useMemo(
    () => blendingDecaffeineCycles.reduce((sum, v) => sum + (v || 0), 0),
    [blendingDecaffeineCycles],
  )

  const year = referenceDate.slice(0, 4)
  const month = referenceDate.slice(5, 7)

  const weekdayFor = useCallback(
    (day: number) => {
      if (!year || !month) return ''
      const d = new Date(`${year}-${month}-${String(day).padStart(2, '0')}T00:00:00`)
      if (Number.isNaN(d.getTime())) return ''
      return WEEKDAY_KO[d.getDay()] ?? ''
    },
    [year, month],
  )

  const dayEntries = useMemo(() => {
    const entries = days.map((day, dayIndex) => {
      const row = dailyRows.find((r) => r.day === day)
      const values = row?.values ?? []
      const items = columnIndices
        .map((columnIndex) => ({
          columnIndex,
          name: columnNames[columnIndex] ?? '',
          no: columnDisplayNo.get(columnIndex) ?? null,
          kg: values[columnIndex] ?? 0,
        }))
        .filter((item) => item.kg > 0)
        .sort((a, b) => b.kg - a.kg)
      const total = items.reduce((sum, item) => sum + item.kg, 0)
      const darkCycles = blendingDarkCycles[dayIndex] ?? 0
      const lightCycles = blendingLightCycles[dayIndex] ?? 0
      const decafCycles = blendingDecaffeineCycles[dayIndex] ?? 0
      return { day, total, items, darkCycles, lightCycles, decafCycles }
    })
    return entries
  }, [
    days,
    dailyRows,
    columnIndices,
    columnNames,
    columnDisplayNo,
    blendingDarkCycles,
    blendingLightCycles,
    blendingDecaffeineCycles,
  ])

  const visibleEntries = useMemo(() => {
    const filtered = showEmptyDays
      ? dayEntries
      : dayEntries.filter(
          (entry) =>
            entry.total > 0 ||
            entry.darkCycles > 0 ||
            entry.lightCycles > 0 ||
            entry.decafCycles > 0,
        )
    return [...filtered].sort((a, b) => b.day - a.day)
  }, [dayEntries, showEmptyDays])

  const topBeans = useMemo(() => {
    return columnIndices
      .map((columnIndex) => ({
        columnIndex,
        name: columnNames[columnIndex] ?? '',
        no: columnDisplayNo.get(columnIndex) ?? null,
        total: columnTotals[columnIndex] ?? 0,
      }))
      .filter((item) => item.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
  }, [columnIndices, columnNames, columnDisplayNo, columnTotals])

  const emptyDaysCount = dayEntries.length - dayEntries.filter((e) => e.total > 0).length

  const parseKgInput = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const num = Number(trimmed)
    if (!Number.isFinite(num) || num < 0) return null
    return num
  }

  const commitQuickAdd = () => {
    const day = typeof quickDay === 'number' ? quickDay : null
    const columnIndex = typeof quickColumnIndex === 'number' ? quickColumnIndex : null
    const kg = parseKgInput(quickKg)
    if (day === null || columnIndex === null || kg === null) return
    onChangeCell(day, columnIndex, String(kg))
    setQuickKg('')
  }

  const commitRowAdd = (day: number) => {
    const columnIndex = typeof addDraftColumn === 'number' ? addDraftColumn : null
    const kg = parseKgInput(addDraftKg)
    if (columnIndex === null || kg === null || kg <= 0) {
      setAddingOnDay(null)
      setAddDraftColumn('')
      setAddDraftKg('')
      return
    }
    onChangeCell(day, columnIndex, String(kg))
    setAddingOnDay(null)
    setAddDraftColumn('')
    setAddDraftKg('')
  }

  const commitChipEdit = () => {
    if (!editingChip) return
    const kg = parseKgInput(editDraftKg)
    if (kg === null) {
      setEditingChip(null)
      return
    }
    onChangeCell(editingChip.day, editingChip.columnIndex, String(kg))
    setEditingChip(null)
  }

  const commitCycleQuickAdd = () => {
    const day = typeof cycleQuickDay === 'number' ? cycleQuickDay : null
    const additional = Math.max(0, Math.round(Number(cycleQuickCount) || 0))
    if (day === null || additional <= 0) return
    const dayIndex = days.findIndex((d) => d === day)
    if (dayIndex < 0) return
    const existing =
      cycleQuickTarget === 'dark'
        ? blendingDarkCycles[dayIndex] ?? 0
        : cycleQuickTarget === 'light'
          ? blendingLightCycles[dayIndex] ?? 0
          : blendingDecaffeineCycles[dayIndex] ?? 0
    onChangeBlendingCycles(cycleQuickTarget, day, existing + additional)
    setCycleQuickCount('1')
  }

  if (columnIndices.length === 0) {
    return (
      <div className="inventory-daily-journal-empty">
        왼쪽 생두 전체현황에 품목을 먼저 추가하면 여기에 기록할 수 있어요.
      </div>
    )
  }

  return (
    <div className="inventory-daily-journal">
      <div className="inventory-daily-journal-summary">
        <div className="inventory-daily-journal-metric">
          <span className="inventory-daily-journal-metric-label">월 합계</span>
          <strong className="inventory-daily-journal-metric-value">
            {formatTwoDecimals(grandTotal)}
            <em>kg</em>
          </strong>
        </div>
        <div className="inventory-daily-journal-metric">
          <span className="inventory-daily-journal-metric-label">로스팅한 날</span>
          <strong className="inventory-daily-journal-metric-value">
            {daysWithRoasting}
            <em>일</em>
          </strong>
        </div>
        <div className="inventory-daily-journal-metric">
          <span className="inventory-daily-journal-metric-label">최다 로스팅일</span>
          <strong className="inventory-daily-journal-metric-value">
            {peakDay.day > 0 ? `${peakDay.day}일` : '-'}
            {peakDay.total > 0 ? (
              <em>{` · ${formatTwoDecimals(peakDay.total)}kg`}</em>
            ) : null}
          </strong>
        </div>
        <div className="inventory-daily-journal-metric">
          <span className="inventory-daily-journal-metric-label">최근 기록</span>
          <strong className="inventory-daily-journal-metric-value">
            {latestActiveDay > 0 ? `${latestActiveDay}일` : '-'}
          </strong>
        </div>
        <div className="inventory-daily-journal-metric inventory-daily-journal-metric-blend">
          <span className="inventory-daily-journal-metric-label">
            블렌딩
            <button
              type="button"
              className="inventory-daily-journal-recipe-toggle"
              onClick={() => setRecipeOpen((v) => !v)}
              title="레시피 설정"
            >
              {recipeOpen ? '레시피 ▴' : '레시피 ▾'}
            </button>
          </span>
          <strong className="inventory-daily-journal-metric-value">
            <span className="inventory-daily-journal-metric-dark">
              다크 {totalMonthDarkCycles}회
              <em>
                {' · '}
                {formatTwoDecimals(totalMonthDarkCycles * blendingDarkRecipe.roastedPerCycle)}kg
              </em>
            </span>
            <span className="inventory-daily-journal-metric-light">
              라이트 {totalMonthLightCycles}회
              <em>
                {' · '}
                {formatTwoDecimals(
                  totalMonthLightCycles * blendingLightRecipe.roastedPerCycle,
                )}kg
              </em>
            </span>
            <span className="inventory-daily-journal-metric-decaf">
              디카페인 {totalMonthDecafCycles}회
              <em>
                {' · '}
                {formatTwoDecimals(
                  totalMonthDecafCycles * blendingDecaffeineRecipe.roastedPerCycle,
                )}kg
              </em>
            </span>
          </strong>
        </div>
        {topBeans.length > 0 ? (
          <div className="inventory-daily-journal-topbeans">
            {topBeans.map((bean, idx) => (
              <span key={bean.columnIndex} className="inventory-daily-journal-topbean">
                <span className="inventory-daily-journal-topbean-rank">{`#${idx + 1}`}</span>
                <span className="inventory-daily-journal-topbean-name">
                  {bean.no != null ? `${bean.no}. ` : ''}
                  {bean.name}
                </span>
                <span className="inventory-daily-journal-topbean-kg">
                  {formatTwoDecimals(bean.total)}kg
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {recipeOpen ? (
        <div className="inventory-daily-journal-recipes">
          {([
            {
              target: 'dark' as BlendTarget,
              label: '블렌딩-다크',
              recipe: blendingDarkRecipe,
              rawTotal: totalDarkRawPerCycle,
              className: 'is-dark',
            },
            {
              target: 'light' as BlendTarget,
              label: '블렌딩-라이트',
              recipe: blendingLightRecipe,
              rawTotal: totalLightRawPerCycle,
              className: 'is-light',
            },
            {
              target: 'decaf' as BlendTarget,
              label: '블렌딩-디카페인',
              recipe: blendingDecaffeineRecipe,
              rawTotal: totalDecafRawPerCycle,
              className: 'is-decaf',
            },
          ]).map(({ target, label, recipe, rawTotal, className }) => (
            <div
              key={`recipe-panel-${target}`}
              className={`inventory-daily-journal-recipe ${className}`}
            >
              <div className="inventory-daily-journal-recipe-head">
                <strong>{label} 레시피</strong>
                <span>
                  사이클 1회 = 생두 {formatTwoDecimals(rawTotal)}kg → 로스팅{' '}
                  {formatTwoDecimals(recipe.roastedPerCycle)}kg
                </span>
              </div>
              <div className="inventory-daily-journal-recipe-rows">
                {recipe.components.length === 0 ? (
                  <div className="inventory-daily-journal-recipe-empty">
                    아직 재료가 없어요. 아래 「+ 재료 추가」로 시작하세요.
                  </div>
                ) : null}
                {recipe.components.map((comp, idx) => (
                  <div
                    key={`recipe-${target}-${idx}`}
                    className="inventory-daily-journal-recipe-row"
                  >
                    <select
                      className="inventory-daily-journal-select"
                      value={comp.beanName}
                      onChange={(event) =>
                        onChangeRecipeComponent(target, idx, {
                          beanName: event.target.value,
                        })
                      }
                    >
                      <option value="">생두 선택</option>
                      {beanNameOptions.map((name) => (
                        <option key={`recipe-bean-${target}-${idx}-${name}`} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      className="inventory-daily-journal-kg"
                      value={comp.rawPerCycle}
                      onChange={(event) =>
                        onChangeRecipeComponent(target, idx, {
                          rawPerCycle: Number(event.target.value) || 0,
                        })
                      }
                    />
                    <span className="inventory-daily-journal-recipe-unit">kg</span>
                    <button
                      type="button"
                      className="inventory-daily-journal-recipe-remove"
                      onClick={() => onRemoveRecipeComponent(target, idx)}
                      aria-label={`${label} 재료 ${idx + 1} 삭제`}
                      title="삭제"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="inventory-daily-journal-recipe-add"
                  onClick={() => onAddRecipeComponent(target)}
                >
                  + 재료 추가
                </button>
                <div className="inventory-daily-journal-recipe-row inventory-daily-journal-recipe-output">
                  <span>사이클당 {label} 생산</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    className="inventory-daily-journal-kg"
                    value={recipe.roastedPerCycle}
                    onChange={(event) =>
                      onChangeRoastedPerCycle(target, Number(event.target.value) || 0)
                    }
                  />
                  <span className="inventory-daily-journal-recipe-unit">kg</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="inventory-daily-journal-quickadd">
        <span className="inventory-daily-journal-quickadd-label">빠른 기록</span>
        <select
          className="inventory-daily-journal-select"
          value={quickDay}
          onChange={(event) => {
            const raw = event.target.value
            setQuickDay(raw === '' ? '' : Number(raw))
          }}
          aria-label="일자 선택"
        >
          <option value="">일자</option>
          {days.map((day) => (
            <option key={`qa-day-${day}`} value={day}>
              {`${day}일 ${weekdayFor(day) ? `(${weekdayFor(day)})` : ''}`}
            </option>
          ))}
        </select>
        <select
          className="inventory-daily-journal-select"
          value={quickColumnIndex}
          onChange={(event) => {
            const raw = event.target.value
            setQuickColumnIndex(raw === '' ? '' : Number(raw))
          }}
          aria-label="품목 선택"
        >
          <option value="">품목</option>
          {columnIndices.map((idx) => {
            const no = columnDisplayNo.get(idx) ?? null
            return (
              <option key={`qa-col-${idx}`} value={idx}>
                {no != null ? `${no}. ` : ''}
                {columnNames[idx] ?? ''}
              </option>
            )
          })}
        </select>
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          className="inventory-daily-journal-kg"
          placeholder="kg"
          value={quickKg}
          onChange={(event) => setQuickKg(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitQuickAdd()
          }}
        />
        <button
          type="button"
          className="primary-button inventory-daily-journal-commit"
          onClick={commitQuickAdd}
          disabled={quickDay === '' || quickColumnIndex === '' || parseKgInput(quickKg) === null}
        >
          기록
        </button>
        <label className="inventory-daily-journal-toggle">
          <input
            type="checkbox"
            checked={showEmptyDays}
            onChange={(event) => setShowEmptyDays(event.target.checked)}
          />
          로스팅 없는 날도 보기
          {emptyDaysCount > 0 ? (
            <span className="inventory-daily-journal-toggle-count">({emptyDaysCount})</span>
          ) : null}
        </label>
        <div className="inventory-daily-journal-quickadd-cycle">
          <span className="inventory-daily-journal-quickadd-label inventory-daily-journal-quickadd-label-cycle">
            블렌딩 사이클
          </span>
          <div className="inventory-daily-journal-target-toggle" role="group">
            <button
              type="button"
              className={cycleQuickTarget === 'dark' ? 'is-active is-dark' : 'is-dark'}
              onClick={() => setCycleQuickTarget('dark')}
            >
              다크
            </button>
            <button
              type="button"
              className={cycleQuickTarget === 'light' ? 'is-active is-light' : 'is-light'}
              onClick={() => setCycleQuickTarget('light')}
            >
              라이트
            </button>
            <button
              type="button"
              className={cycleQuickTarget === 'decaf' ? 'is-active is-decaf' : 'is-decaf'}
              onClick={() => setCycleQuickTarget('decaf')}
            >
              디카페인
            </button>
          </div>
          <select
            className="inventory-daily-journal-select"
            value={cycleQuickDay}
            onChange={(event) => {
              const raw = event.target.value
              setCycleQuickDay(raw === '' ? '' : Number(raw))
            }}
            aria-label="사이클 기록 일자"
          >
            <option value="">일자</option>
            {days.map((day) => (
              <option key={`cy-day-${day}`} value={day}>
                {`${day}일 ${weekdayFor(day) ? `(${weekdayFor(day)})` : ''}`}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            className="inventory-daily-journal-kg"
            placeholder="사이클"
            value={cycleQuickCount}
            onChange={(event) => setCycleQuickCount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitCycleQuickAdd()
            }}
          />
          <button
            type="button"
            className={`primary-button inventory-daily-journal-commit inventory-daily-journal-commit-cycle ${
              cycleQuickTarget === 'light' ? 'is-light' : cycleQuickTarget === 'decaf' ? 'is-decaf' : ''
            }`}
            onClick={commitCycleQuickAdd}
            disabled={
              cycleQuickDay === '' || Math.round(Number(cycleQuickCount) || 0) <= 0
            }
            title={`+${formatTwoDecimals(
              Math.max(0, Math.round(Number(cycleQuickCount) || 0)) *
                (cycleQuickTarget === 'dark'
                  ? blendingDarkRecipe.roastedPerCycle
                  : cycleQuickTarget === 'light'
                    ? blendingLightRecipe.roastedPerCycle
                    : blendingDecaffeineRecipe.roastedPerCycle),
            )}kg`}
          >
            사이클 추가
          </button>
          <span className="inventory-daily-journal-quickadd-hint">
            {typeof cycleQuickDay === 'number'
              ? `현재 ${
                  (cycleQuickTarget === 'dark'
                    ? blendingDarkCycles
                    : cycleQuickTarget === 'light'
                      ? blendingLightCycles
                      : blendingDecaffeineCycles)[days.findIndex((d) => d === cycleQuickDay)] ?? 0
                }회`
              : '일자를 먼저 고르세요'}
          </span>
        </div>
      </div>

      <div className="inventory-daily-journal-list">
        {visibleEntries.length === 0 ? (
          <div className="inventory-daily-journal-empty-list">
            아직 기록이 없어요. 위쪽「빠른 기록」으로 시작하세요.
          </div>
        ) : (
          visibleEntries.map((entry) => {
            const wd = weekdayFor(entry.day)
            const isEmpty = entry.items.length === 0
            const isSundayLike = wd === '일'
            return (
              <article
                key={`journal-${entry.day}`}
                className={`inventory-daily-journal-card ${
                  isEmpty ? 'is-empty' : ''
                } ${isSundayLike ? 'is-sunday' : ''}`}
              >
                <header className="inventory-daily-journal-card-head">
                  <div className="inventory-daily-journal-card-date">
                    <span className="inventory-daily-journal-card-day">{entry.day}</span>
                    <span className="inventory-daily-journal-card-wd">
                      {wd ? `(${wd})` : ''}
                    </span>
                  </div>
                  {(entry.darkCycles > 0 || entry.lightCycles > 0 || entry.decafCycles > 0) ? (
                    <div className="inventory-daily-journal-card-cycles is-readonly">
                      {entry.darkCycles > 0 ? (
                        <span className="inventory-daily-journal-card-cycle-badge is-dark">
                          다크 {entry.darkCycles}c
                          <button
                            type="button"
                            className="inventory-daily-journal-card-cycle-remove"
                            onClick={() => onChangeBlendingCycles('dark', entry.day, 0)}
                            aria-label={`${entry.day}일 다크 사이클 삭제`}
                            title="삭제"
                          >
                            ×
                          </button>
                        </span>
                      ) : null}
                      {entry.lightCycles > 0 ? (
                        <span className="inventory-daily-journal-card-cycle-badge is-light">
                          라이트 {entry.lightCycles}c
                          <button
                            type="button"
                            className="inventory-daily-journal-card-cycle-remove"
                            onClick={() => onChangeBlendingCycles('light', entry.day, 0)}
                            aria-label={`${entry.day}일 라이트 사이클 삭제`}
                            title="삭제"
                          >
                            ×
                          </button>
                        </span>
                      ) : null}
                      {entry.decafCycles > 0 ? (
                        <span className="inventory-daily-journal-card-cycle-badge is-decaf">
                          디카페인 {entry.decafCycles}c
                          <button
                            type="button"
                            className="inventory-daily-journal-card-cycle-remove"
                            onClick={() => onChangeBlendingCycles('decaf', entry.day, 0)}
                            aria-label={`${entry.day}일 디카페인 사이클 삭제`}
                            title="삭제"
                          >
                            ×
                          </button>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="inventory-daily-journal-card-total">
                    {entry.total > 0 ? `${formatTwoDecimals(entry.total)}kg` : '기록 없음'}
                  </div>
                </header>
                <div className="inventory-daily-journal-card-body">
                  {entry.items.map((item) => {
                    const isEditing =
                      editingChip?.day === entry.day &&
                      editingChip?.columnIndex === item.columnIndex
                    return (
                      <span
                        key={`chip-${entry.day}-${item.columnIndex}`}
                        className="inventory-daily-journal-chip"
                      >
                        <span className="inventory-daily-journal-chip-name">
                          {item.no != null ? (
                            <span className="inventory-daily-journal-chip-no">{item.no}.</span>
                          ) : null}
                          {item.name}
                        </span>
                        {isEditing ? (
                          <input
                            autoFocus
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="inventory-daily-journal-chip-input"
                            value={editDraftKg}
                            onChange={(event) => setEditDraftKg(event.target.value)}
                            onBlur={commitChipEdit}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter')
                                (event.target as HTMLInputElement).blur()
                              if (event.key === 'Escape') setEditingChip(null)
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="inventory-daily-journal-chip-kg"
                            onClick={() => {
                              setEditingChip({ day: entry.day, columnIndex: item.columnIndex })
                              setEditDraftKg(String(item.kg))
                            }}
                            title="클릭해서 kg 수정"
                          >
                            {formatTwoDecimals(item.kg)}
                            <em>kg</em>
                          </button>
                        )}
                        <button
                          type="button"
                          className="inventory-daily-journal-chip-remove"
                          onClick={() => onChangeCell(entry.day, item.columnIndex, '0')}
                          aria-label={`${item.name} 기록 삭제`}
                          title="삭제"
                        >
                          ×
                        </button>
                      </span>
                    )
                  })}
                  {addingOnDay === entry.day ? (
                    <span className="inventory-daily-journal-chip is-new">
                      <select
                        autoFocus
                        className="inventory-daily-journal-chip-select"
                        value={addDraftColumn}
                        onChange={(event) => {
                          const raw = event.target.value
                          setAddDraftColumn(raw === '' ? '' : Number(raw))
                        }}
                      >
                        <option value="">품목 선택</option>
                        {columnIndices.map((idx) => {
                          const no = columnDisplayNo.get(idx) ?? null
                          return (
                            <option key={`add-col-${idx}`} value={idx}>
                              {no != null ? `${no}. ` : ''}
                              {columnNames[idx] ?? ''}
                            </option>
                          )
                        })}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        className="inventory-daily-journal-chip-input"
                        placeholder="kg"
                        value={addDraftKg}
                        onChange={(event) => setAddDraftKg(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRowAdd(entry.day)
                          if (event.key === 'Escape') {
                            setAddingOnDay(null)
                            setAddDraftColumn('')
                            setAddDraftKg('')
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="inventory-daily-journal-chip-confirm"
                        onClick={() => commitRowAdd(entry.day)}
                        aria-label="추가"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        className="inventory-daily-journal-chip-remove"
                        onClick={() => {
                          setAddingOnDay(null)
                          setAddDraftColumn('')
                          setAddDraftKg('')
                        }}
                        aria-label="취소"
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="inventory-daily-journal-add-chip"
                      onClick={() => {
                        setAddingOnDay(entry.day)
                        setAddDraftColumn('')
                        setAddDraftKg('')
                      }}
                    >
                      + 품목 추가
                    </button>
                  )}
                </div>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

function InventoryStatusPage() {
  const { mode, activeCompanyId, user } = useAppRuntime()
  const [inventoryState, setInventoryState] = useState<InventoryStatusState>(() =>
    createDefaultInventoryStatusState(),
  )
  const inventoryStateRef = useRef(inventoryState)
  inventoryStateRef.current = inventoryState
  const [baselineState, setBaselineState] = useState<InventoryStatusState>(() =>
    createDefaultInventoryStatusState(),
  )
  const [templateBase64, setTemplateBase64] = useState<string | null>(null)
  const [templateFileName, setTemplateFileName] = useState<string>('')
  const [roastingViewMode, setRoastingViewMode] = useState<RoastingViewMode>('daily')
  const [hideZeroRoastingItems, setHideZeroRoastingItems] = useState(false)
  const [selectedBeanName, setSelectedBeanName] = useState<string>('')
  const [beanDetailViewMode, setBeanDetailViewMode] = useState<BeanDetailViewMode>('daily')
  const [beanDetailModalOpen, setBeanDetailModalOpen] = useState(false)
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
  const lastCloudPollJsonRef = useRef('')

  useEffect(() => {
    let cancelled = false

    setIsStorageReady(false)
    setIsCloudReady(mode === 'local')
    resetDocumentSaveUi()
    initialRoastingSyncDoneRef.current = false

    const applyDocument = (
      document: InventoryPageDocument,
      source: 'local' | 'cloud',
      hasRemoteDocument: boolean,
    ) => {
      const wasManualStockMode =
        window.localStorage.getItem(
          inventoryPageScopedKey(INVENTORY_AUTO_STOCK_MODE_KEY, mode, activeCompanyId),
        ) === 'false'
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
          skipAutoStockDisplay: false,
          beanRows: next.beanRows.map((bean) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, pins),
          })),
        }
        nextBaseline = next
        window.localStorage.setItem(
          inventoryPageScopedKey(INVENTORY_AUTO_STOCK_MODE_KEY, mode, activeCompanyId),
          'true',
        )
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
      const localDocument = readInventoryPageLocalDocument(mode, activeCompanyId)
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

    window.localStorage.setItem(
      inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId),
      JSON.stringify(inventoryState),
    )
    window.dispatchEvent(new Event(INVENTORY_STATUS_CACHE_EVENT))
  }, [activeCompanyId, inventoryState, isStorageReady, mode])

  // 생두전체현황(beanRows)을 마스터로 삼아 로스팅 열을 자동 동기화한다.
  // - 이름 변경: 같은 위치(position)에서 이름만 갱신, 일별 값 보존
  // - 추가/삭제/재정렬: 이름(name) 매칭으로 기존 값 최대한 보존, 새 열은 0으로 채움
  useEffect(() => {
    setInventoryState((current) => {
      const nextColumns = current.beanRows.map((bean) => bean.name)
      const sameLength = current.roastingColumns.length === nextColumns.length
      if (sameLength && current.roastingColumns.every((c, i) => c === nextColumns[i])) {
        return current
      }
      const oldColumns = current.roastingColumns
      const sourceIndexForNew = nextColumns.map((newName, i) => {
        const byName = oldColumns.findIndex(
          (col) => normalizeNameKey(col) === normalizeNameKey(newName),
        )
        if (byName >= 0) {
          return byName
        }
        if (sameLength) {
          return i
        }
        return -1
      })
      const roastingRows = current.roastingRows.map((row) => ({
        ...row,
        values: sourceIndexForNew.map((sourceIdx) =>
          sourceIdx >= 0 ? row.values[sourceIdx] ?? 0 : 0,
        ),
      }))
      return { ...current, roastingColumns: nextColumns, roastingRows }
    })
  }, [inventoryState.beanRows])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(
      inventoryPageScopedKey(INVENTORY_STATUS_BASELINE_STORAGE_KEY, mode, activeCompanyId),
      JSON.stringify(baselineState),
    )
  }, [activeCompanyId, baselineState, isStorageReady, mode])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    const templateKey = inventoryPageScopedKey(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY, mode, activeCompanyId)
    const templateNameKey = inventoryPageScopedKey(
      INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY,
      mode,
      activeCompanyId,
    )

    if (templateBase64) {
      window.localStorage.setItem(templateKey, templateBase64)
    } else {
      window.localStorage.removeItem(templateKey)
    }

    if (templateFileName) {
      window.localStorage.setItem(templateNameKey, templateFileName)
    } else {
      window.localStorage.removeItem(templateNameKey)
    }
  }, [activeCompanyId, isStorageReady, mode, templateBase64, templateFileName])

  useEffect(() => {
    if (!inventoryState.beanRows.some((bean) => bean.name === selectedBeanName)) {
      setSelectedBeanName(inventoryState.beanRows[0]?.name ?? '')
    }
  }, [inventoryState.beanRows, selectedBeanName])

  useEffect(() => {
    if (!isStorageReady) {
      return
    }

    window.localStorage.setItem(
      inventoryPageScopedKey(INVENTORY_HISTORY_NOTES_STORAGE_KEY, mode, activeCompanyId),
      JSON.stringify(historyNotes),
    )
  }, [activeCompanyId, historyNotes, isStorageReady, mode])

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
    const currentJson = JSON.stringify({ inventoryState, baselineState, templateBase64, templateFileName, historyNotes })
    if (currentJson === lastCloudPollJsonRef.current) {
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
        const remote = await loadCompanyDocument<InventoryPageDocument>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.inventoryPage,
        )
        if (cancelled || !remote) {
          return
        }
        const normalized = normalizeInventoryPageDocument(remote)
        const payload = {
          inventoryState: normalized.inventoryState,
          baselineState: normalized.baselineState,
          templateBase64: normalized.templateBase64,
          templateFileName: normalized.templateFileName,
          historyNotes: normalized.historyNotes,
        }
        const nextJson = JSON.stringify(payload)
        if (nextJson !== lastJson) {
          lastJson = nextJson
          lastCloudPollJsonRef.current = nextJson
          setInventoryState(normalized.inventoryState)
          setBaselineState(normalized.baselineState)
          setTemplateBase64(normalized.templateBase64)
          setTemplateFileName(normalized.templateFileName)
          setHistoryNotes(normalized.historyNotes)
          if (normalized.inventoryState.beanRows[0]) {
            setSelectedBeanName((prev) => {
              if (normalized.inventoryState.beanRows.some((b) => b.name === prev)) {
                return prev
              }
              return normalized.inventoryState.beanRows[0]?.name ?? ''
            })
          }
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

  /** 입고·생산·출고에 맞춘 연쇄 재고. 엑셀 업로드 직후(`skipAutoStockDisplay`)는 시트 재고 그대로 */
  const displayedBeanRows = useMemo(
    () =>
      inventoryState.skipAutoStockDisplay
        ? inventoryState.beanRows.map((bean) => ({ ...bean }))
        : inventoryState.beanRows.map((bean) => ({
            ...bean,
            stock: resyncAutoStockForBeanRow(bean, stockPinnedDayIndices),
          })),
    [inventoryState.beanRows, inventoryState.skipAutoStockDisplay, stockPinnedDayIndices],
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
          productionUsageTotal: sumValues(bean.production),
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
      const useSum = bean.productionUsageTotal
      if (showActiveOnly && useSum <= 0 && bean.inboundTotal <= 0 && bean.outboundTotal <= 0) {
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

  /** 로스팅 열을 화면에서 보여줄 연속 번호 기준으로 정렬 */
  const roastingColumnOrder = useMemo(() => {
    const nameToNo = new Map(inventoryState.beanRows.map((bean) => [normalizeNameKey(bean.name), bean.no]))
    return inventoryState.roastingColumns
      .map((column, index) => ({
        index,
        beanNo: nameToNo.get(normalizeNameKey(column)) ?? null,
        name: column,
      }))
      .sort((left, right) => {
        const ln = left.beanNo ?? 9999
        const rn = right.beanNo ?? 9999
        if (ln !== rn) {
          return ln - rn
        }
        return normalizeNameKey(left.name).localeCompare(normalizeNameKey(right.name), 'ko')
      })
  }, [inventoryState.beanRows, inventoryState.roastingColumns])

  /** 로스팅 열 인덱스 → 표시 번호. 생두 행과 이름이 매칭되면 생두의 no를 그대로 쓴다. */
  const roastingColumnIndexToDisplayNo = useMemo(() => {
    const m = new Map<number, number | null>()
    roastingColumnOrder.forEach((column) => {
      m.set(column.index, column.beanNo)
    })
    return m
  }, [roastingColumnOrder])

  const selectedBean =
    filteredDisplayedBeanRows.find((bean) => bean.name === selectedBeanName) ?? filteredDisplayedBeanRows[0] ?? null

  const scrollBeanDailyToCenterDay = useCallback(() => {
    if (!beanDetailModalOpen || beanDetailViewMode !== 'daily') {
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
  }, [beanDetailModalOpen, beanDetailViewMode, inventoryState.days, inventoryState.referenceDate])

  useLayoutEffect(() => {
    scrollBeanDailyToCenterDay()
    const id = window.requestAnimationFrame(() => scrollBeanDailyToCenterDay())
    return () => window.cancelAnimationFrame(id)
  }, [beanDetailModalOpen, scrollBeanDailyToCenterDay, selectedBeanName])

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
      (bean) => bean.endingStock > 0 || bean.productionUsageTotal > 0 || bean.inboundTotal > 0,
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
    }
  }, [computedRoastingTotals, roastingDailyRows])

  const roastingSummaryRows = useMemo(() => {
    const isBlendColumnName = (name: string) =>
      roastingColumnMatchesBeanRow(name, BLENDING_DARK_BEAN_NAME) ||
      roastingColumnMatchesBeanRow(name, BLENDING_LIGHT_BEAN_NAME) ||
      roastingColumnMatchesBeanRow(name, BLENDING_DECAFFEINE_BEAN_NAME)
    const blendUsageByColumnIndex = new Map<number, number>()
    const addBlendUsage = (
      blendName: string,
      recipe: InventoryStatusState['blendingDarkRecipe'],
      cycles: readonly number[],
    ) => {
      if (!recipe) {
        return
      }
      const totalRawPerCycle = recipe.components.reduce((sum, component) => sum + component.rawPerCycle, 0)
      const monthlyCycleCountRaw = cycles.reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
      let monthlyCycleCount = monthlyCycleCountRaw
      if (monthlyCycleCount <= 0 && totalRawPerCycle > 0) {
        // 사이클 기록이 0이어도 블렌딩 생산(사용) 합이 있다면 생산량으로 역산해 사용량을 보여준다.
        const blendColIndex = inventoryState.roastingColumns.findIndex((column) =>
          roastingColumnMatchesBeanRow(column, blendName),
        )
        if (blendColIndex >= 0) {
          const blendRoastedTotal = computedRoastingTotals[blendColIndex] ?? 0
          if (blendRoastedTotal > 0) {
            monthlyCycleCount = blendRoastedTotal / totalRawPerCycle
          }
        }
      }
      if (monthlyCycleCount <= 0) {
        return
      }
      recipe.components.forEach((component) => {
        const colIndex = inventoryState.roastingColumns.findIndex((column) =>
          roastingColumnMatchesBeanRow(column, component.beanName),
        )
        if (colIndex < 0) {
          return
        }
        const usage = component.rawPerCycle * monthlyCycleCount
        blendUsageByColumnIndex.set(colIndex, (blendUsageByColumnIndex.get(colIndex) ?? 0) + usage)
      })
    }
    addBlendUsage(
      BLENDING_DARK_BEAN_NAME,
      inventoryState.blendingDarkRecipe,
      inventoryState.blendingDarkCycles ?? [],
    )
    addBlendUsage(
      BLENDING_LIGHT_BEAN_NAME,
      inventoryState.blendingLightRecipe,
      inventoryState.blendingLightCycles ?? [],
    )
    addBlendUsage(
      BLENDING_DECAFFEINE_BEAN_NAME,
      inventoryState.blendingDecaffeineRecipe,
      inventoryState.blendingDecaffeineCycles ?? [],
    )

    const totalForShare = inventoryState.roastingColumns.reduce((sum, column, index) => {
      const rawRoastedTotal = computedRoastingTotals[index] ?? 0
      const blendUsageTotal = blendUsageByColumnIndex.get(index) ?? 0
      const roastedTotal = isBlendColumnName(column) ? rawRoastedTotal : Math.max(0, rawRoastedTotal - blendUsageTotal)
      return isBlendColumnName(column) ? sum : sum + roastedTotal
    }, 0)
    const maxTotal = inventoryState.roastingColumns.reduce((maxValue, column, index) => {
      const rawRoastedTotal = computedRoastingTotals[index] ?? 0
      const blendUsageTotal = blendUsageByColumnIndex.get(index) ?? 0
      const roastedTotal = isBlendColumnName(column) ? rawRoastedTotal : Math.max(0, rawRoastedTotal - blendUsageTotal)
      return Math.max(maxValue, roastedTotal)
    }, 0)

    const rows = inventoryState.roastingColumns.map((column, index) => {
      const rawRoastedTotal = computedRoastingTotals[index] ?? 0
      const isBlendColumn = isBlendColumnName(column)
      const blendUsageTotal = blendUsageByColumnIndex.get(index) ?? 0
      const roastedTotal = isBlendColumn ? rawRoastedTotal : Math.max(0, rawRoastedTotal - blendUsageTotal)
      const displayNo = roastingColumnIndexToDisplayNo.get(index) ?? null
      return {
        name: column,
        columnIndex: index,
        displayNo,
        roastedTotal,
        blendUsageTotal,
        share: isBlendColumn ? null : totalForShare > 0 ? roastedTotal / totalForShare : null,
        heatLevel: getHeatLevel(roastedTotal, maxTotal),
        isBlendColumn,
      }
    })

    return rows.sort((left, right) => {
      const ln = left.displayNo ?? 9999
      const rn = right.displayNo ?? 9999
      if (ln !== rn) {
        return ln - rn
      }
      return normalizeNameKey(left.name).localeCompare(normalizeNameKey(right.name), 'ko')
    })
  }, [
    computedRoastingTotals,
    inventoryState.blendingDarkCycles,
    inventoryState.blendingDarkRecipe,
    inventoryState.blendingDecaffeineCycles,
    inventoryState.blendingDecaffeineRecipe,
    inventoryState.blendingLightCycles,
    inventoryState.blendingLightRecipe,
    inventoryState.roastingColumns,
    roastingColumnIndexToDisplayNo,
  ])

  const visibleRoastingColumnIndices = useMemo(() => {
    const indices = roastingColumnOrder
      .map((column) => column.index)
      .filter((index) => !hideZeroRoastingItems || (computedRoastingTotals[index] ?? 0) > 0)
    return indices
  }, [computedRoastingTotals, hideZeroRoastingItems, roastingColumnOrder])

  const visibleRoastingSummaryRows = useMemo(
    () => roastingSummaryRows.filter((row) => !hideZeroRoastingItems || row.roastedTotal > 0),
    [hideZeroRoastingItems, roastingSummaryRows],
  )
  const visibleBlendingUsageRows = useMemo(
    () =>
      roastingSummaryRows.filter(
        (row) => !row.isBlendColumn && (!hideZeroRoastingItems || row.blendUsageTotal > 0),
      ),
    [hideZeroRoastingItems, roastingSummaryRows],
  )
  const totalBlendingUsage = useMemo(
    () => visibleBlendingUsageRows.reduce((sum, row) => sum + row.blendUsageTotal, 0),
    [visibleBlendingUsageRows],
  )

  const topRoastingItem = useMemo(() => {
    if (visibleRoastingSummaryRows.length === 0) {
      return null
    }
    return visibleRoastingSummaryRows.reduce((best, row) =>
      row.roastedTotal > best.roastedTotal ? row : best,
    )
  }, [visibleRoastingSummaryRows])
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

  const openBeanDetailModal = (beanName: string) => {
    setSelectedBeanName(beanName)
    setBeanDetailModalOpen(true)
  }

  const closeBeanDetailModal = () => {
    setBeanDetailModalOpen(false)
  }

  const handleBeanDetailModalWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!beanDetailModalOpen || beanDetailViewMode !== 'daily') {
      return
    }
    const container = beanDailyScrollRef.current
    if (!container) {
      return
    }
    if (container.scrollWidth <= container.clientWidth) {
      return
    }
    // 모달 안에서 휠(위/아래) 입력을 일자별 표의 좌/우 이동으로 변환
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return
    }
    container.scrollLeft += event.deltaY
    event.preventDefault()
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
          skipAutoStockDisplay: false,
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
        skipAutoStockDisplay: false,
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

  useEffect(() => {
    if (!selectedBean && beanDetailModalOpen) {
      setBeanDetailModalOpen(false)
    }
  }, [selectedBean, beanDetailModalOpen])

  useEffect(() => {
    if (!beanDetailModalOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBeanDetailModalOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [beanDetailModalOpen])

  useEffect(() => {
    if (!beanDetailModalOpen) {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [beanDetailModalOpen])

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
        const nextRaw = parsedValue
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
          skipAutoStockDisplay: false,
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
        skipAutoStockDisplay: false,
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
            nextBean = {
              ...nextBean,
              stock: resyncAutoStockForBeanRow(nextBean, pins),
            }
          }

          return nextBean
        }),
      }
    })
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
      return { ...current, skipAutoStockDisplay: false, roastingColumns, beanRows }
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

    // 로스팅 일별 셀은 '단독' 생산(사용)만 담기므로, production(전체)로 맞출 때 블렌딩 raw 기여를 더한다.
    const blendRawByBeanKey = new Map<string, number[]>()
    const addBlendContribution = (recipe: typeof current.blendingDarkRecipe, cycles: number[]) => {
      if (!recipe) return
      recipe.components.forEach((comp) => {
        const key = normalizeNameKey(comp.beanName)
        if (!key) return
        const arr = blendRawByBeanKey.get(key) ?? new Array(current.days.length).fill(0)
        for (let i = 0; i < current.days.length; i += 1) {
          arr[i] = (arr[i] ?? 0) + comp.rawPerCycle * (cycles[i] ?? 0)
        }
        blendRawByBeanKey.set(key, arr)
      })
    }
    addBlendContribution(current.blendingDarkRecipe, current.blendingDarkCycles ?? [])
    addBlendContribution(current.blendingLightRecipe, current.blendingLightCycles ?? [])
    addBlendContribution(current.blendingDecaffeineRecipe, current.blendingDecaffeineCycles ?? [])

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
        const colKey = normalizeNameKey(colName)
        const blendingRaw = blendRawByBeanKey.get(colKey)?.[dayIndex] ?? 0
        const rawValue = (roastedValue ?? 0) + blendingRaw
        nextBeanRows.forEach((bean) => {
          if (!roastingColumnMatchesBeanRow(colName, bean.name)) {
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
    setInventoryState((current) => {
      const synced = syncBeanProductionFromRoastingRows(current)
      if (synced === current) {
        return current
      }
      return { ...synced, skipAutoStockDisplay: false }
    })
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

      const targetColRaw = (current.roastingColumns[valueIndex] ?? '').trim()
      const targetColumnName = normalizeNameKey(targetColRaw)
      const previousRawByRow = current.beanRows.map((b) => [...b.production])
      const nextRaw = parsedRoasted

      // 사이클이 돌아간 날에는 구성 원두 production에 이미 블렌딩 기여분(raw)이 누적돼 있다.
      // 단독 로스팅만 수정하는 편집이므로, 블렌딩 기여분은 그대로 두고 단독 부분만 덮어쓴다.
      const computeBlendingRaw = (beanKey: string): number => {
        const blends = [
          { recipe: current.blendingDarkRecipe, cycles: current.blendingDarkCycles },
          { recipe: current.blendingLightRecipe, cycles: current.blendingLightCycles },
          { recipe: current.blendingDecaffeineRecipe, cycles: current.blendingDecaffeineCycles },
        ]
        return blends.reduce((sum, b) => {
          if (!b.recipe) return sum
          const perCycleRaw = b.recipe.components.reduce(
            (s, comp) => (normalizeNameKey(comp.beanName) === beanKey ? s + comp.rawPerCycle : s),
            0,
          )
          return sum + perCycleRaw * (b.cycles[dayIndex] ?? 0)
        }, 0)
      }

      const nextBeanRows = current.beanRows.map((bean) => {
        const beanKey = normalizeNameKey(bean.name)
        if (!targetColumnName || !roastingColumnMatchesBeanRow(targetColRaw, bean.name)) {
          return bean
        }
        const nextProduction = [...bean.production]
        const blendingRaw = computeBlendingRaw(beanKey)
        nextProduction[dayIndex] = nextRaw + blendingRaw
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
        skipAutoStockDisplay: false,
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

  /**
   * Blending(-Dark|-Light) 로스팅 사이클을 하루 단위로 설정한다.
   * - 증감분(Δ)만 구성 원두의 production(raw)에 반영한다.
   * - 블렌딩 행의 production은 `사이클 × 레시피 raw합`으로 갱신한다.
   * - 로스팅 현황/재고 자동 연쇄까지 한 번에 재동기화한다.
   */
  const updateBlendingCyclesForDay = (
    target: BlendTarget,
    day: number,
    nextCyclesValue: number,
  ) => {
    const newCycles = Math.max(0, Math.round(nextCyclesValue))
    setInventoryState((current) => {
      const dayIndex = current.days.findIndex((d) => d === day)
      if (dayIndex < 0) {
        return current
      }
      const cyclesKey: 'blendingDarkCycles' | 'blendingLightCycles' | 'blendingDecaffeineCycles' =
        target === 'dark'
          ? 'blendingDarkCycles'
          : target === 'light'
            ? 'blendingLightCycles'
            : 'blendingDecaffeineCycles'
      const recipe =
        target === 'dark'
          ? current.blendingDarkRecipe
          : target === 'light'
            ? current.blendingLightRecipe
            : current.blendingDecaffeineRecipe
      const blendBeanKey = normalizeNameKey(
        target === 'dark'
          ? BLENDING_DARK_BEAN_NAME
          : target === 'light'
            ? BLENDING_LIGHT_BEAN_NAME
            : BLENDING_DECAFFEINE_BEAN_NAME,
      )

      const currentCycles = current[cyclesKey][dayIndex] ?? 0
      if (currentCycles === newCycles) {
        return current
      }
      const delta = newCycles - currentCycles

      const componentRawByBeanKey = new Map<string, number>()
      for (const comp of recipe.components) {
        const key = normalizeNameKey(comp.beanName)
        if (!key) continue
        componentRawByBeanKey.set(
          key,
          (componentRawByBeanKey.get(key) ?? 0) + comp.rawPerCycle,
        )
      }
      const totalRawPerCycle = recipe.components.reduce(
        (sum, comp) => sum + comp.rawPerCycle,
        0,
      )

      const previousRawByRow = current.beanRows.map((b) => [...b.production])

      const nextBeanRows = current.beanRows.map((bean) => {
        const beanKey = normalizeNameKey(bean.name)
        if (beanKey === blendBeanKey) {
          // 블렌딩 원두 본체도 Δ 누적: 기존 수동 입력을 보존한다.
          const nextProduction = [...bean.production]
          nextProduction[dayIndex] = Math.max(
            0,
            (bean.production[dayIndex] ?? 0) + delta * totalRawPerCycle,
          )
          return { ...bean, production: nextProduction }
        }
        const rawRatio = componentRawByBeanKey.get(beanKey)
        if (rawRatio && rawRatio > 0) {
          const nextProduction = [...bean.production]
          nextProduction[dayIndex] = Math.max(
            0,
            (bean.production[dayIndex] ?? 0) + delta * rawRatio,
          )
          return { ...bean, production: nextProduction }
        }
        return bean
      })

      const nextCycles = [...current[cyclesKey]]
      nextCycles[dayIndex] = newCycles

      const updatedState: InventoryStatusState = {
        ...current,
        beanRows: nextBeanRows,
        [cyclesKey]: nextCycles,
      }
      const syncedRoasting = syncRoastingRowsFromBeanProduction(updatedState)

      const physIdx = dayIndexForReferenceDate(current.days, current.physicalCountDate)
      const pins = buildStockPinnedDayIndices(current.days, current.surveyMarkedDays, physIdx)

      return {
        ...updatedState,
        skipAutoStockDisplay: false,
        beanRows: updatedState.beanRows.map((bean, bi) => ({
          ...bean,
          stock: resyncAutoStockForBeanRow(bean, pins, {
            previousRawProduction: previousRawByRow[bi] ?? null,
          }),
        })),
        roastingRows: syncedRoasting,
      }
    })
  }

  const recipeKeyFor = (target: BlendTarget) =>
    target === 'dark'
      ? 'blendingDarkRecipe'
      : target === 'light'
        ? 'blendingLightRecipe'
        : 'blendingDecaffeineRecipe'

  const updateBlendingRecipeComponent = (
    target: BlendTarget,
    index: number,
    patch: Partial<BlendingRecipeComponent>,
  ) => {
    setInventoryState((current) => {
      const key = recipeKeyFor(target)
      const prev = current[key]
      const nextComponents = prev.components.map((comp, i) => {
        if (i !== index) return comp
        return {
          beanName: patch.beanName !== undefined ? patch.beanName : comp.beanName,
          rawPerCycle:
            patch.rawPerCycle !== undefined
              ? Math.max(0, patch.rawPerCycle)
              : comp.rawPerCycle,
        }
      })
      const nextRecipe = { ...prev, components: nextComponents }
      const next = { ...current, [key]: nextRecipe }
      return { ...next, skipAutoStockDisplay: false, roastingRows: syncRoastingRowsFromBeanProduction(next) }
    })
  }

  const updateBlendingRoastedPerCycle = (target: BlendTarget, value: number) => {
    setInventoryState((current) => {
      const key = recipeKeyFor(target)
      const prev = current[key]
      const roastedPerCycle = Math.max(0, value)
      if (roastedPerCycle === prev.roastedPerCycle) return current
      const nextRecipe = { ...prev, roastedPerCycle }
      const next = { ...current, [key]: nextRecipe }
      return { ...next, skipAutoStockDisplay: false, roastingRows: syncRoastingRowsFromBeanProduction(next) }
    })
  }

  const addBlendingRecipeComponent = (target: BlendTarget) => {
    setInventoryState((current) => {
      const key = recipeKeyFor(target)
      const prev = current[key]
      const nextRecipe = {
        ...prev,
        components: [...prev.components, { beanName: '', rawPerCycle: 0 }],
      }
      return { ...current, skipAutoStockDisplay: false, [key]: nextRecipe }
    })
  }

  const removeBlendingRecipeComponent = (target: BlendTarget, index: number) => {
    setInventoryState((current) => {
      const key = recipeKeyFor(target)
      const prev = current[key]
      const nextRecipe = {
        ...prev,
        components: prev.components.filter((_, i) => i !== index),
      }
      const next = { ...current, [key]: nextRecipe }
      return { ...next, skipAutoStockDisplay: false, roastingRows: syncRoastingRowsFromBeanProduction(next) }
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
      const dayCount = parsedState.days.length
      // 엑셀 시트에는 블렌딩 레시피/사이클이 없어, parse 결과만 쓰면 매번 빈(기본) 레시피로 덮어쓴다(디카·라이트 등이 "사라짐"처럼 보임). 임포트 직전 화면의 입출고 state에서 블렌딩만 이어 붙인다(클라우드 `company_documents`는 inventory 전체 JSON을 저장하나, 엑셀 다시 올릴 때 이 덮어쓰기가 먼저 흔한 원인).
      const prev = inventoryStateRef.current
      const nextState: InventoryStatusState = {
        ...parsedState,
        skipAutoStockDisplay: true,
        blendingDarkRecipe: cloneBlendingRecipe(prev.blendingDarkRecipe),
        blendingLightRecipe: cloneBlendingRecipe(prev.blendingLightRecipe),
        blendingDecaffeineRecipe: cloneBlendingRecipe(prev.blendingDecaffeineRecipe),
        blendingDarkCycles: resizeBlendingCyclesToDayCount(prev.blendingDarkCycles, dayCount),
        blendingLightCycles: resizeBlendingCyclesToDayCount(prev.blendingLightCycles, dayCount),
        blendingDecaffeineCycles: resizeBlendingCyclesToDayCount(prev.blendingDecaffeineCycles, dayCount),
      }
      setInventoryState(nextState)
      setBaselineState(nextState)
      setTemplateBase64(arrayBufferToBase64(buffer))
      setTemplateFileName(file.name)
      setSelectedBeanName(nextState.beanRows[0]?.name ?? '')
      setStatusMessage(
        `엑셀 반영: ${file.name} (kg 소수 둘째 자리, 재고·수치는 시트 그대로) · 다크/라이트/디카 블렌딩 레시피·사이클은 엑셀에 없어 이전 설정을 유지했습니다. · 복원 기준 저장`,
      )
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
          skipAutoStockDisplay: false,
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
        ['생산(사용)', alignBeanValuesToDayCount(bean.production, dayCount)],
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
      {isStorageReady ? (
    <div className="meeting-layout">
      <section className="panel inventory-top-controls-panel">
        <div className="inventory-page-snapshot-metrics no-print" aria-label="현황 요약">
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
              <span>월 누적 생산(사용) 합</span>
              <strong>{formatNumber(roastingMetrics.grandTotal)}kg</strong>
            </div>
          </div>
        </div>
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
                  skipAutoStockDisplay: false,
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
                  skipAutoStockDisplay: false,
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

      <>
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
                </colgroup>
                <thead>
                  <tr>
                    <th className="inventory-sticky-column inventory-bean-summary-no-name-th" scope="col">
                      NO · 생두명
                    </th>
                    <th scope="col">입고 합계</th>
                    <th scope="col">생산(사용) 합계</th>
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
                            onClick={() => openBeanDetailModal(bean.name)}
                          >
                            <span className="inventory-bean-summary-no-prefix">{bean.no}.</span> {bean.name}
                          </button>
                        )}
                      </td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.inboundTotal)}</td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.productionUsageTotal)}</td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.outboundTotal)}</td>
                      <td className="inventory-summary-num-cell">{formatNumber(bean.endingStock)}</td>
                    </tr>
                  ))}
                  {filteredBeanSummaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="inventory-empty-cell">
                        현재 조건에 맞는 품목이 없습니다.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {selectedBean && beanDetailModalOpen ? (
            <div
              className="inventory-reset-dialog-backdrop inventory-bean-detail-modal-backdrop"
              role="presentation"
              onClick={closeBeanDetailModal}
            >
              <div
                className="inventory-reset-dialog inventory-bean-detail-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="inventory-bean-detail-modal-title"
                onWheel={handleBeanDetailModalWheel}
                onClick={(event) => event.stopPropagation()}
              >
              <div className="meeting-card-header inventory-daily-detail-card-header">
                <h3 id="inventory-bean-detail-modal-title" className="inventory-daily-detail-heading">
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
                    onClick={closeBeanDetailModal}
                    title="원두 상세 닫기"
                  >
                    닫기
                  </button>
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
                      {BLENDING_DARK_BEAN_NAME}: 입고는 비워 둬도 됩니다(자동 재고에 쓰지 않음). 날짜마다{' '}
                      <strong>전일 재고 + 생산(사용) − 출고</strong>로 이어집니다. 실사한 날은 직접 맞춘 재고를
                      유지합니다.
                    </p>
                  ) : null}
                  {isBlendingLightBeanRow(selectedBean) ? (
                    <p className="muted tiny inventory-blend-dark-hint">
                      {BLENDING_LIGHT_BEAN_NAME}도 동일합니다. 입고 없이, 생산이 더해지고 출고가 빠집니다.
                    </p>
                  ) : null}
                  {isBlendingDecaffeineBeanRow(selectedBean) ? (
                    <p className="muted tiny inventory-blend-dark-hint">
                      {BLENDING_DECAFFEINE_BEAN_NAME}: 일반 생두와 같이 입고·생산·출고·재고가 이어집니다. 일자별 로스팅
                      현황에서 <strong>디카페인 블렌딩 레시피·사이클</strong>을 쓰면 구성 원두 사용량이 생산(사용)에
                      같이 반영됩니다.
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
                                { label: '생산(사용)', values: selectedBean.production, key: 'production' as const },
                                { label: '출고', values: selectedBean.outbound, key: 'outbound' as const },
                                { label: '재고', values: selectedBean.stock, key: 'stock' as const },
                              ]
                            : [
                                { label: '입고', values: selectedBean.inbound, key: 'inbound' as const },
                                { label: '생산(사용)', values: selectedBean.production, key: 'production' as const },
                                { label: '출고', values: selectedBean.outbound, key: 'outbound' as const },
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
                              const readOnly = stockAutoLocked
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
                                        row.key,
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
        <section className="meeting-grid">
          <div className="meeting-card inventory-roasting-summary-card">
            <div className="meeting-card-header">
              <h3>품목별 로스팅 요약</h3>
              <div className="inventory-roasting-summary-actions">
                <span className="inventory-master-hint" title="품목명은 위쪽「생두 전체현황」에서만 수정됩니다.">
                  생두 전체현황에서 수정하면 자동 반영
                </span>
                <button
                  type="button"
                  className={`ghost-button ${hideZeroRoastingItems ? 'active' : ''}`}
                  onClick={() => setHideZeroRoastingItems((current) => !current)}
                >
                  {hideZeroRoastingItems ? '전체 품목 보기' : '사용 품목만 보기'}
                </button>
              </div>
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
                <span>월 누적 사용(생두)</span>
                <strong>{formatTwoDecimals(roastingMetrics.grandTotal)}kg</strong>
              </div>
              <div className="inventory-roasting-kpi-chip inventory-roasting-kpi-chip--wide">
                <span>최다 로스팅 품목</span>
                <strong>
                  {topRoastingItem
                    ? `${topRoastingItem.displayNo != null ? `${topRoastingItem.displayNo}. ` : ''}${topRoastingItem.name} / ${formatTwoDecimals(topRoastingItem.roastedTotal)}kg`
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
            <div className="inventory-roasting-summary-tables">
              <div className="table-wrapper">
                <table className="meeting-table inventory-table">
                  <thead>
                    <tr>
                      <th>NO · 품목</th>
                      <th>생산(사용) 합</th>
                      <th>비중</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRoastingSummaryRows.map((row) => (
                      <tr key={`roasting-summary-${row.columnIndex}`}>
                        <td className={`inventory-text-left inventory-heat-cell ${row.heatLevel}`}>
                          {row.displayNo != null ? (
                            <span className="inventory-bean-summary-no-prefix">{row.displayNo}.</span>
                          ) : null}
                          {row.displayNo != null ? ' ' : null}
                          {row.name}
                        </td>
                        <td>{formatTwoDecimals(row.roastedTotal)}kg</td>
                        <td>{row.share === null ? '-' : row.share > 0 ? `${(row.share * 100).toFixed(1)}%` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-wrapper">
                <table className="meeting-table inventory-table">
                  <thead>
                    <tr>
                      <th>블렌딩용 원두</th>
                      <th>사용량</th>
                      <th>비중</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBlendingUsageRows.map((row) => (
                      <tr key={`roasting-summary-blend-usage-${row.columnIndex}`}>
                        <td className={`inventory-text-left inventory-heat-cell ${row.heatLevel}`}>
                          {row.displayNo != null ? (
                            <span className="inventory-bean-summary-no-prefix">{row.displayNo}.</span>
                          ) : null}
                          {row.displayNo != null ? ' ' : null}
                          {row.name}
                        </td>
                        <td>{formatTwoDecimals(row.blendUsageTotal)}kg</td>
                        <td>
                          {row.blendUsageTotal > 0 && totalBlendingUsage > 0
                            ? `${((row.blendUsageTotal / totalBlendingUsage) * 100).toFixed(1)}%`
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
            {roastingViewMode === 'daily' ? (
              <DailyRoastingJournal
                days={inventoryState.days}
                columnIndices={visibleRoastingColumnIndices}
                columnNames={inventoryState.roastingColumns}
                columnDisplayNo={roastingColumnIndexToDisplayNo}
                dailyRows={roastingDailyRows}
                columnTotals={computedRoastingTotals}
                grandTotal={roastingMetrics.grandTotal}
                latestActiveDay={roastingMetrics.latestActiveDay}
                peakDay={roastingMetrics.peakDay}
                daysWithRoasting={roastingMetrics.daysWithRoasting}
                referenceDate={inventoryState.referenceDate}
                onChangeCell={updateRoastingValue}
                blendingDarkCycles={inventoryState.blendingDarkCycles}
                blendingDarkRecipe={inventoryState.blendingDarkRecipe}
                blendingLightCycles={inventoryState.blendingLightCycles}
                blendingLightRecipe={inventoryState.blendingLightRecipe}
                blendingDecaffeineCycles={inventoryState.blendingDecaffeineCycles}
                blendingDecaffeineRecipe={inventoryState.blendingDecaffeineRecipe}
                beanNameOptions={inventoryState.beanRows.map((b) => b.name)}
                onChangeBlendingCycles={updateBlendingCyclesForDay}
                onChangeRecipeComponent={updateBlendingRecipeComponent}
                onChangeRoastedPerCycle={updateBlendingRoastedPerCycle}
                onAddRecipeComponent={addBlendingRecipeComponent}
                onRemoveRecipeComponent={removeBlendingRecipeComponent}
              />
            ) : (
              <div className="table-wrapper">
                <table className="meeting-table inventory-table">
                  <thead>
                    <tr>
                      <th className="inventory-sticky-column">주차</th>
                      {visibleRoastingColumnIndices.map((index) => {
                        const headerNo = roastingColumnIndexToDisplayNo.get(index) ?? null
                        return (
                          <th key={`roast-col-h-${index}`} className="inventory-roasting-th-name">
                            <div className="inventory-roasting-th-name-inner">
                              {headerNo != null ? (
                                <span className="inventory-roasting-col-no-prefix" aria-hidden>
                                  {headerNo}.
                                </span>
                              ) : null}
                              <span
                                className="inventory-roasting-column-name-label"
                                title="품목명은 생두 전체현황에서만 수정할 수 있습니다."
                              >
                                {inventoryState.roastingColumns[index] ?? ''}
                              </span>
                            </div>
                          </th>
                        )
                      })}
                      <th>주 합계</th>
                      <th>전주 대비</th>
                      <th>활성 품목</th>
                      <th>Top 품목</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roastingWeeklyRows.map((row) => (
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
            )}
          </div>
        </section>
      </>
    </div>
      ) : (
        <div className="meeting-layout inventory-page-hydration-loading" aria-busy="true">
          <section className="panel">
            <p className="inventory-page-hydration-message" role="status">
              입출고 현황을 불러오는 중…
            </p>
          </section>
        </div>
      )}

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
