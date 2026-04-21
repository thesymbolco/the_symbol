import * as XLSX from 'xlsx'
import { inventoryStatusData } from './inventoryStatusData'

export type InventoryBeanRow = {
  no: number
  name: string
  inbound: number[]
  production: number[]
  outbound: number[]
  stock: number[]
}

export type InventoryRoastingRow = {
  day: number | '계'
  values: number[]
}

export type BlendingRecipeComponent = {
  beanName: string
  rawPerCycle: number
}

export type BlendingRecipe = {
  components: BlendingRecipeComponent[]
  roastedPerCycle: number
}

/** 하위호환 별칭 */
export type BlendingDarkRecipeComponent = BlendingRecipeComponent
export type BlendingDarkRecipe = BlendingRecipe

export type InventoryStatusState = {
  referenceDate: string
  /** 실사 반영일(해당 일자 재고는 수동·실사값 유지, 그 다음 일부터만 자동 연쇄) */
  physicalCountDate: string
  /**
   * 일자 헤더「실사」로 표시한 날(달력 일자 1–31). 해당 열 재고를 직접 맞출 수 있게 하는 핀.
   * 비어 있으면 위쪽 `실사 기준일` 열만 월초와 함께 직접 입력 핀으로 쓴다.
   */
  surveyMarkedDays: number[]
  days: number[]
  beanRows: InventoryBeanRow[]
  roastingColumns: string[]
  roastingRows: InventoryRoastingRow[]
  /** 일자별 Blending-Dark 로스팅 사이클 횟수 (days와 같은 길이) */
  blendingDarkCycles: number[]
  /** 레시피: 이 값만 바꾸면 자동으로 사이클 1회 분량을 재계산한다 */
  blendingDarkRecipe: BlendingRecipe
  /** 일자별 Blending-Light 로스팅 사이클 횟수 */
  blendingLightCycles: number[]
  blendingLightRecipe: BlendingRecipe
}

export const DEFAULT_BLENDING_DARK_RECIPE: BlendingRecipe = {
  components: [
    { beanName: 'Brazil', rawPerCycle: 12 },
    { beanName: 'Sidamo G4', rawPerCycle: 4 },
    { beanName: 'Narino', rawPerCycle: 4 },
  ],
  roastedPerCycle: 16,
}

export const DEFAULT_BLENDING_LIGHT_RECIPE: BlendingRecipe = {
  components: [],
  roastedPerCycle: 0,
}

/**
 * 실사 기준일 기본값 = 기준일(그날까지 직접 입력 재고 유지, 다음 날부터 자동 연쇄).
 * 예전에 `physicalCountDate` 필드가 없을 때만 쓰임(구버전 저장 호환).
 */
export const defaultPhysicalCountDateFromReference = (referenceDate: string): string => {
  if (referenceDate.length >= 10) {
    return referenceDate
  }
  return referenceDate
}

/** `days`가 월의 각 일자일 때, 기준일 이하 중 가장 늦은 열(말일 초과 시 마지막 열) */
export const dayIndexForReferenceDate = (days: readonly number[], referenceDate: string): number => {
  if (days.length === 0) {
    return 0
  }
  const refDay = Number(referenceDate.slice(8, 10))
  if (!Number.isFinite(refDay) || refDay < 1) {
    return days.length - 1
  }
  let best = 0
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i]
    if (typeof d === 'number' && d <= refDay) {
      best = i
    }
  }
  return best
}

const BEAN_DAY_START_COLUMN_INDEX = 3
const BEAN_DAY_END_COLUMN_INDEX = 33
const ROASTING_DAY_START_ROW_INDEX = 3
const ROASTING_DAY_END_ROW_INDEX = 34
const INVENTORY_VALUE_ROW_LENGTH = BEAN_DAY_END_COLUMN_INDEX - BEAN_DAY_START_COLUMN_INDEX + 1
const EXTRA_BEAN_ROWS: InventoryBeanRow[] = [
  {
    no: 25,
    name: 'Blending-Light',
    inbound: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
    production: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
    outbound: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
    stock: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, (_, index) => (index < 31 ? 5 : 0)),
  },
]

const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) {
      return 0
    }

    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return 0
}

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 브라우저 로컬 기준 오늘 `YYYY-MM-DD` (기준일·실사일·요약 재고 열에 사용) */
export const todayLocalIsoDateString = (): string => formatLocalDate(new Date())

const parseDateValue = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value)
  }

  if (typeof value === 'number') {
    const parsedDate = XLSX.SSF.parse_date_code(value)
    if (parsedDate) {
      return formatLocalDate(new Date(parsedDate.y, parsedDate.m - 1, parsedDate.d))
    }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return ''
    }

    const matched = trimmed.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
    if (matched) {
      const [, year, month, day] = matched
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }

    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) {
      return formatLocalDate(parsed)
    }
  }

  return formatLocalDate(new Date())
}

const cloneState = (state: InventoryStatusState): InventoryStatusState => ({
  referenceDate: state.referenceDate,
  physicalCountDate: state.physicalCountDate,
  surveyMarkedDays: [...state.surveyMarkedDays],
  days: [...state.days],
  beanRows: state.beanRows.map((bean) => ({
    no: bean.no,
    name: bean.name,
    inbound: [...bean.inbound],
    production: [...bean.production],
    outbound: [...bean.outbound],
    stock: [...bean.stock],
  })),
  roastingColumns: [...state.roastingColumns],
  roastingRows: state.roastingRows.map((row) => ({
    day: row.day,
    values: [...row.values],
  })),
  blendingDarkCycles: state.blendingDarkCycles
    ? [...state.blendingDarkCycles]
    : Array.from({ length: state.days.length }, () => 0),
  blendingDarkRecipe: state.blendingDarkRecipe
    ? {
        components: state.blendingDarkRecipe.components.map((c) => ({ ...c })),
        roastedPerCycle: state.blendingDarkRecipe.roastedPerCycle,
      }
    : {
        components: DEFAULT_BLENDING_DARK_RECIPE.components.map((c) => ({ ...c })),
        roastedPerCycle: DEFAULT_BLENDING_DARK_RECIPE.roastedPerCycle,
      },
  blendingLightCycles: state.blendingLightCycles
    ? [...state.blendingLightCycles]
    : Array.from({ length: state.days.length }, () => 0),
  blendingLightRecipe: state.blendingLightRecipe
    ? {
        components: state.blendingLightRecipe.components.map((c) => ({ ...c })),
        roastedPerCycle: state.blendingLightRecipe.roastedPerCycle,
      }
    : {
        components: DEFAULT_BLENDING_LIGHT_RECIPE.components.map((c) => ({ ...c })),
        roastedPerCycle: DEFAULT_BLENDING_LIGHT_RECIPE.roastedPerCycle,
      },
})

const ensureExpectedBeanRows = (beanRows: InventoryBeanRow[]) => {
  const nextRows = [...beanRows]

  for (const extraRow of EXTRA_BEAN_ROWS) {
    const exists = nextRows.some((bean) => bean.no === extraRow.no || bean.name === extraRow.name)
    if (!exists) {
      nextRows.push({
        no: extraRow.no,
        name: extraRow.name,
        inbound: [...extraRow.inbound],
        production: [...extraRow.production],
        outbound: [...extraRow.outbound],
        stock: [...extraRow.stock],
      })
    }
  }

  return nextRows.sort((left, right) => left.no - right.no)
}

/** 품목명·날짜 열·로스팅 열 구조는 유지하고 입고·생산·출고·재고·로스팅 수치만 모두 0으로 맞춘다. */
export const createZeroedInventoryStatusFrom = (current: InventoryStatusState): InventoryStatusState => {
  const base = cloneState(current)
  return {
    ...base,
    surveyMarkedDays: [],
    beanRows: base.beanRows.map((bean) => ({
      ...bean,
      inbound: bean.inbound.map(() => 0),
      production: bean.production.map(() => 0),
      outbound: bean.outbound.map(() => 0),
      stock: bean.stock.map(() => 0),
    })),
    roastingRows: base.roastingRows.map((row) => ({
      ...row,
      values: row.values.map(() => 0),
    })),
    blendingDarkCycles: base.blendingDarkCycles.map(() => 0),
    blendingLightCycles: base.blendingLightCycles.map(() => 0),
  }
}

export const createDefaultInventoryStatusState = (): InventoryStatusState => {
  const today = todayLocalIsoDateString()
  return cloneState({
    referenceDate: today,
    physicalCountDate: defaultPhysicalCountDateFromReference(today),
    surveyMarkedDays: [],
    days: [...inventoryStatusData.days],
    beanRows: ensureExpectedBeanRows(
      inventoryStatusData.beanRows.map((bean) => ({
        no: bean.no,
        name: bean.name,
        inbound: [...bean.inbound],
        production: [...bean.production],
        outbound: [...bean.outbound],
        stock: [...bean.stock],
      })),
    ),
    roastingColumns: [...inventoryStatusData.roastingColumns],
    roastingRows: inventoryStatusData.roastingRows.map((row) => ({
      day: row.day,
      values: [...row.values],
    })),
    blendingDarkCycles: Array.from({ length: inventoryStatusData.days.length }, () => 0),
    blendingDarkRecipe: {
      components: DEFAULT_BLENDING_DARK_RECIPE.components.map((c) => ({ ...c })),
      roastedPerCycle: DEFAULT_BLENDING_DARK_RECIPE.roastedPerCycle,
    },
    blendingLightCycles: Array.from({ length: inventoryStatusData.days.length }, () => 0),
    blendingLightRecipe: {
      components: DEFAULT_BLENDING_LIGHT_RECIPE.components.map((c) => ({ ...c })),
      roastedPerCycle: DEFAULT_BLENDING_LIGHT_RECIPE.roastedPerCycle,
    },
  })
}

const normalizeCyclesArray = (raw: unknown, days: unknown): number[] => {
  if (Array.isArray(raw)) {
    return raw.map((v) => Math.max(0, Math.round(toNumber(v))))
  }
  const length = Array.isArray(days) ? days.length : 0
  return Array.from({ length }, () => 0)
}

const normalizeRecipe = (raw: unknown, fallback: BlendingRecipe): BlendingRecipe => {
  const src = raw as Partial<BlendingRecipe> | undefined
  if (!src || !Array.isArray(src.components)) {
    return {
      components: fallback.components.map((c) => ({ ...c })),
      roastedPerCycle: fallback.roastedPerCycle,
    }
  }
  return {
    components: (src.components as unknown[]).map((c) => {
      const comp = c as Partial<BlendingRecipeComponent>
      return {
        beanName: String(comp?.beanName ?? ''),
        rawPerCycle: Math.max(0, toNumber(comp?.rawPerCycle)),
      }
    }),
    roastedPerCycle: Math.max(0, toNumber(src.roastedPerCycle)),
  }
}

export const normalizeInventoryStatusState = (value: unknown): InventoryStatusState | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const source = value as Partial<InventoryStatusState>
  if (
    typeof source.referenceDate !== 'string' ||
    !Array.isArray(source.days) ||
    !Array.isArray(source.beanRows) ||
    !Array.isArray(source.roastingColumns) ||
    !Array.isArray(source.roastingRows)
  ) {
    return null
  }

  try {
    const surveyMarkedDaysRaw = Array.isArray(source.surveyMarkedDays)
      ? source.surveyMarkedDays.map((d) => toNumber(d))
      : []
    const surveyMarkedDays = [...new Set(surveyMarkedDaysRaw.filter((d) => d >= 1 && d <= 31))].sort(
      (a, b) => a - b,
    )

    const today = todayLocalIsoDateString()
    const refOk = typeof source.referenceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.referenceDate)
    const referenceDate = refOk ? source.referenceDate : today
    const physOk =
      typeof source.physicalCountDate === 'string' &&
      source.physicalCountDate.length >= 10 &&
      /^\d{4}-\d{2}-\d{2}$/.test(source.physicalCountDate)
    const physicalCountDate: string =
      physOk && typeof source.physicalCountDate === 'string'
        ? source.physicalCountDate
        : defaultPhysicalCountDateFromReference(referenceDate)

    return {
      referenceDate,
      physicalCountDate,
      surveyMarkedDays,
      days: source.days.map((day) => toNumber(day)),
      beanRows: source.beanRows.map((bean) => ({
        no: toNumber(bean.no),
        name: String(bean.name ?? ''),
        inbound: Array.isArray(bean.inbound) ? bean.inbound.map(toNumber) : [],
        production: Array.isArray(bean.production) ? bean.production.map(toNumber) : [],
        outbound: Array.isArray(bean.outbound) ? bean.outbound.map(toNumber) : [],
        stock: Array.isArray(bean.stock) ? bean.stock.map(toNumber) : [],
      })),
      roastingColumns: source.roastingColumns.map((column) => String(column)),
      roastingRows: source.roastingRows.map((row) => ({
        day: row.day === '계' ? '계' : toNumber(row.day),
        values: Array.isArray(row.values) ? row.values.map(toNumber) : [],
      })),
      blendingDarkCycles: normalizeCyclesArray(
        (source as Partial<InventoryStatusState>).blendingDarkCycles,
        source.days,
      ),
      blendingDarkRecipe: normalizeRecipe(
        (source as Partial<InventoryStatusState>).blendingDarkRecipe,
        DEFAULT_BLENDING_DARK_RECIPE,
      ),
      blendingLightCycles: normalizeCyclesArray(
        (source as Partial<InventoryStatusState>).blendingLightCycles,
        source.days,
      ),
      blendingLightRecipe: normalizeRecipe(
        (source as Partial<InventoryStatusState>).blendingLightRecipe,
        DEFAULT_BLENDING_LIGHT_RECIPE,
      ),
    }
  } catch {
    return null
  }
}

const getSheetCellValue = (sheet: XLSX.WorkSheet, rowIndex: number, columnIndex: number) => {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
  const cell = sheet[address]
  if (!cell) {
    return null
  }

  return cell.w ?? cell.v ?? null
}

const getSheetCell = (sheet: XLSX.WorkSheet, rowIndex: number, columnIndex: number) => {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
  return sheet[address]
}

const findReferenceDateValue = (sheet: XLSX.WorkSheet) => {
  for (let rowIndex = 0; rowIndex < 5; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < 40; columnIndex += 1) {
      const currentValue = String(getSheetCellValue(sheet, rowIndex, columnIndex) ?? '').trim()
      if (!currentValue.includes('기준일')) {
        continue
      }

      for (let nextColumnIndex = columnIndex + 1; nextColumnIndex < columnIndex + 6; nextColumnIndex += 1) {
        const nextCell = getSheetCell(sheet, rowIndex, nextColumnIndex)
        const nextValue = nextCell?.w ?? nextCell?.v ?? null
        if (nextCell?.f && /TODAY\s*\(\s*\)/i.test(nextCell.f)) {
          return new Date()
        }

        if (nextValue !== null && String(nextValue).trim() !== '') {
          return nextValue
        }
      }
    }
  }

  const fallbackCell = getSheetCell(sheet, 0, 34)
  if (fallbackCell?.f && /TODAY\s*\(\s*\)/i.test(fallbackCell.f)) {
    return new Date()
  }

  return fallbackCell?.w ?? fallbackCell?.v ?? null
}

export const parseInventoryWorkbook = (workbook: XLSX.WorkBook): InventoryStatusState => {
  const beanSheet = workbook.Sheets['생두전체현황']
  const roastingSheet = workbook.Sheets['로스팅현황']

  if (!beanSheet || !roastingSheet) {
    throw new Error('엑셀에서 `생두전체현황`, `로스팅현황` 시트를 찾지 못했습니다.')
  }

  const defaultState = createDefaultInventoryStatusState()
  const beanRows: InventoryBeanRow[] = []
  let currentBean: InventoryBeanRow | null = null

  const createValueRow = (targetRowIndex: number) =>
    Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, (_, offset) =>
      toNumber(getSheetCellValue(beanSheet, targetRowIndex, BEAN_DAY_START_COLUMN_INDEX + offset)),
    )

  for (let rowIndex = 2; rowIndex <= 79; rowIndex += 1) {
    const no = toNumber(getSheetCellValue(beanSheet, rowIndex, 0))
    const name = String(getSheetCellValue(beanSheet, rowIndex, 1) ?? '').trim()
    const label = String(getSheetCellValue(beanSheet, rowIndex, 2) ?? '').trim()

    if (!label) {
      continue
    }

    if (name) {
      currentBean = {
        no,
        name,
        inbound: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
        production: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
        outbound: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
        stock: Array.from({ length: INVENTORY_VALUE_ROW_LENGTH }, () => 0),
      }
      beanRows.push(currentBean)
    }

    if (!currentBean) {
      continue
    }

    const nextValues = createValueRow(rowIndex)

    if (label === '입고') {
      currentBean.inbound = nextValues
    } else if (label === '생산') {
      currentBean.production = nextValues
    } else if (label === '출고') {
      currentBean.outbound = nextValues
    } else if (label === '재고') {
      currentBean.stock = nextValues
    }
  }

  const roastingColumns = Array.from({ length: 26 }, (_, offset) =>
    String(getSheetCellValue(roastingSheet, 1, offset + 1) ?? ''),
  ).filter(Boolean)

  const roastingRows: InventoryRoastingRow[] = []

  for (let rowIndex = ROASTING_DAY_START_ROW_INDEX; rowIndex <= ROASTING_DAY_END_ROW_INDEX; rowIndex += 1) {
    const dayCell = getSheetCellValue(roastingSheet, rowIndex, 0)
    if (dayCell === null || dayCell === '') {
      continue
    }

    const values = Array.from({ length: roastingColumns.length }, (_, offset) =>
      toNumber(getSheetCellValue(roastingSheet, rowIndex, offset + 1)),
    )

    roastingRows.push({
      day: dayCell === '계' ? '계' : toNumber(dayCell),
      values,
    })
  }

  const referenceDate = parseDateValue(findReferenceDateValue(beanSheet))
  return {
    referenceDate,
    physicalCountDate: referenceDate,
    surveyMarkedDays: [],
    days: defaultState.days,
    beanRows: beanRows.length > 0 ? beanRows : defaultState.beanRows,
    roastingColumns: roastingColumns.length > 0 ? roastingColumns : defaultState.roastingColumns,
    roastingRows: roastingRows.length > 0 ? roastingRows : defaultState.roastingRows,
    blendingDarkCycles: Array.from({ length: defaultState.days.length }, () => 0),
    blendingDarkRecipe: {
      components: DEFAULT_BLENDING_DARK_RECIPE.components.map((c) => ({ ...c })),
      roastedPerCycle: DEFAULT_BLENDING_DARK_RECIPE.roastedPerCycle,
    },
    blendingLightCycles: Array.from({ length: defaultState.days.length }, () => 0),
    blendingLightRecipe: {
      components: DEFAULT_BLENDING_LIGHT_RECIPE.components.map((c) => ({ ...c })),
      roastedPerCycle: DEFAULT_BLENDING_LIGHT_RECIPE.roastedPerCycle,
    },
  }
}
