/**
 * 원두별 매출 분석과 동일한 규칙으로, 거래명세 특정 월 + 입출고·생두주문 원/kg을 사용해
 * 월 마감 「재료비(매출·생두)」줄 및 내역 패널을 채운다.
 */
import { hasAnyStatementManualForItem } from './beanStatementManualMappings'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import {
  DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE,
  getGreenOrderWonPerKgByInventoryLabel,
  type BlendRecipeSnapshot,
  type GreenOrderUnitPriceMode,
} from './beanSalesGreenOrderUnitPrice'
import { roastedBeanCost1KgFromGreenWonPerKg } from './beanSalesRoastedCost'
import type { InventoryBeanRow, InventoryStatusState, InventoryStorageEnvelope } from './inventoryStatusUtils'

export type BeanStatementDeliveryRecord = {
  deliveryDate: string
  itemName: string
  specUnit: string
  quantity: number
  totalAmount: number
  clientName: string
}

export type BeanSalesMaterialMeetingLine = {
  beanLabel: string
  sortKey: number
  totalQuantityKg: number
  totalRevenueWon: number
  wonPerKg: number | null
  /** 생두 단가 근거: `2026-03 가중평균 (주문 2건)` · `2026-03-15` · `직접` 등 */
  greenOrderDateRef: string | null
  estimatedCostWon: number | null
}

export type BeanSalesMaterialMeetingResult = {
  lines: BeanSalesMaterialMeetingLine[]
  /** 라인별 추정 원가 중 null을 제외한 합계(내역 표시와 동일) */
  totalEstimatedCostWon: number
  priceMode: GreenOrderUnitPriceMode
}

const deliveryYmPrefix = (deliveryDate: string): string => {
  const s = typeof deliveryDate === 'string' ? deliveryDate.trim() : ''
  if (s.length < 7) {
    return ''
  }
  if (/^\d{4}-\d{2}/.test(s)) {
    return s.slice(0, 7)
  }
  return ''
}

/** `YYYY-MM` 납품월만 포함 (원두별 매출 분석의 연 단위 후보 안에서 회의 월에 맞춤) */
export function filterStatementsByYmDelivery(
  records: readonly BeanStatementDeliveryRecord[],
  ym: string,
): BeanStatementDeliveryRecord[] {
  const prefix = ym.trim()
  if (!/^\d{4}-\d{2}$/.test(prefix)) {
    return []
  }
  return records.filter((r) => deliveryYmPrefix(r.deliveryDate) === prefix)
}

function blendRecipeSnapshotFromInventory(st: InventoryStatusState | null): BlendRecipeSnapshot {
  if (!st) {
    return { dark: null, light: null, decaf: null }
  }
  return {
    dark: st.blendingDarkRecipe ?? null,
    light: st.blendingLightRecipe ?? null,
    decaf: st.blendingDecaffeineRecipe ?? null,
  }
}

const normalizeSpecUnit = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/ML/g, 'ML')

/** 거래명세 수량을 kg로 환산(1kg/200g 대응). 규격이 없으면 기존과 동일하게 quantity를 kg로 간주. */
export const statementQuantityToKg = (record: BeanStatementDeliveryRecord): number => {
  const qty = typeof record.quantity === 'number' && Number.isFinite(record.quantity) ? Math.max(0, record.quantity) : 0
  if (qty <= 0) {
    return 0
  }
  const spec = normalizeSpecUnit(record.specUnit)
  if (
    spec === '200/G' ||
    spec === '200G' ||
    spec === '0.2/KG' ||
    spec === '0.2KG' ||
    spec === '1/5KG'
  ) {
    return qty * 0.2
  }
  return qty
}

/** 입출고 `beanRows` + 거래명세·생두 주문가로 월별 추정 재료 원가 라인 계산 */
export type ComputeBeanSalesMaterialCostOptions = MapStatementItemToInventoryOptions & {
  /** 기본: 이동평균(전월 재고+당월 입고) */
  greenOrderPriceMode?: GreenOrderUnitPriceMode
  /** `moving_avg` 시 전월 말 재고 — 입출고 v2 월별 스냅샷 */
  inventoryEnvelope?: InventoryStorageEnvelope | null
}

export function computeBeanSalesMaterialCostForYm(
  ym: string | null,
  statementsInMonth: readonly BeanStatementDeliveryRecord[],
  inventory: InventoryStatusState | null,
  mapOptions: ComputeBeanSalesMaterialCostOptions,
): BeanSalesMaterialMeetingResult | null {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym.trim())) {
    return null
  }

  const scopedMode: 'local' | 'cloud' = mapOptions.mode ?? 'local'
  const scopedCompanyId = mapOptions.companyId ?? null

  const inventoryBeanRows: InventoryBeanRow[] = Array.isArray(inventory?.beanRows) ? inventory.beanRows : []
  const allowedInventoryLabels = new Set(inventoryBeanRows.map((b) => formatBeanRowLabel(b)))
  const blendSnapshot = blendRecipeSnapshotFromInventory(inventory)
  const priceMode = mapOptions.greenOrderPriceMode ?? DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE
  const greenWonByLabel = getGreenOrderWonPerKgByInventoryLabel(inventoryBeanRows, {
    mode: priceMode,
    ym: ym.trim(),
    mapOpts: mapOptions,
    blendRecipeSnapshot: blendSnapshot,
    inventoryEnvelope: mapOptions.inventoryEnvelope,
  })

  type BuildAcc = {
    beanLabel: string
    sortKey: number
    totalQuantityKg: number
    totalRevenueWon: number
  }
  const salesMap = new Map<string, BuildAcc>()

  for (const record of statementsInMonth) {
    const { label, sortKey } = mapStatementItemToInventoryLabel(record.itemName, inventoryBeanRows, mapOptions)
    if (inventoryBeanRows.length > 0 && !allowedInventoryLabels.has(label)) {
      if (hasAnyStatementManualForItem(record.itemName, scopedMode, scopedCompanyId)) {
        continue
      }
      continue
    }
    const beanName = label
    let acc = salesMap.get(beanName)
    if (!acc) {
      acc = {
        beanLabel: beanName,
        sortKey,
        totalQuantityKg: 0,
        totalRevenueWon: 0,
      }
      salesMap.set(beanName, acc)
    } else if (sortKey < acc.sortKey) {
      acc.sortKey = sortKey
    }
    const q = statementQuantityToKg(record)
    acc.totalQuantityKg += q
    const rev = typeof record.totalAmount === 'number' && Number.isFinite(record.totalAmount) ? record.totalAmount : 0
    acc.totalRevenueWon += rev
  }

  const lines: BeanSalesMaterialMeetingLine[] = Array.from(salesMap.values()).map((row) => {
    const g = greenWonByLabel.get(row.beanLabel)
    const wonPerKg = g ? g.wonPerKg : null
    const greenOrderDateRef = g ? g.basisRef : null
    const roastedCost1kg = wonPerKg != null ? roastedBeanCost1KgFromGreenWonPerKg(wonPerKg) : null
    const estimatedCostWon =
      roastedCost1kg != null && row.totalQuantityKg > 0 ? Math.round(roastedCost1kg * row.totalQuantityKg) : null
    return {
      beanLabel: row.beanLabel,
      sortKey: row.sortKey,
      totalQuantityKg: row.totalQuantityKg,
      totalRevenueWon: row.totalRevenueWon,
      wonPerKg,
      greenOrderDateRef,
      estimatedCostWon,
    }
  })

  lines.sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      return a.sortKey - b.sortKey
    }
    return a.beanLabel.localeCompare(b.beanLabel, 'ko')
  })

  let totalEstimatedCostWon = 0
  for (const line of lines) {
    if (line.estimatedCostWon != null && line.estimatedCostWon > 0) {
      totalEstimatedCostWon += line.estimatedCostWon
    }
  }

  return { lines, totalEstimatedCostWon, priceMode }
}
