/**
 * 원두별 매출 분석과 동일한 규칙으로, 거래명세 특정 월 + 입출고·생두주문 원/kg을 사용해
 * 월 마감 「재료비(매출·생두)」줄 및 내역 패널을 채운다.
 */
import { hasAnyStatementManualForItem } from './beanStatementManualMappings'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import { getLatestGreenOrderWonPerKgByInventoryLabel, type BlendRecipeSnapshot } from './beanSalesGreenOrderUnitPrice'
import type { InventoryBeanRow, InventoryStatusState } from './inventoryStatusUtils'

export type BeanStatementDeliveryRecord = {
  deliveryDate: string
  itemName: string
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
  greenOrderDateRef: string | null
  estimatedCostWon: number | null
}

export type BeanSalesMaterialMeetingResult = {
  lines: BeanSalesMaterialMeetingLine[]
  /** 라인별 추정 원가 중 null을 제외한 합계(내역 표시와 동일) */
  totalEstimatedCostWon: number
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

/** 입출고 `beanRows` + 거래명세·생두 주문가로 월별 추정 재료 원가 라인 계산 */
export function computeBeanSalesMaterialCostForYm(
  ym: string | null,
  statementsInMonth: readonly BeanStatementDeliveryRecord[],
  inventory: InventoryStatusState | null,
  mapOptions: MapStatementItemToInventoryOptions,
): BeanSalesMaterialMeetingResult | null {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym.trim())) {
    return null
  }

  const scopedMode: 'local' | 'cloud' = mapOptions.mode ?? 'local'
  const scopedCompanyId = mapOptions.companyId ?? null

  const inventoryBeanRows: InventoryBeanRow[] = Array.isArray(inventory?.beanRows) ? inventory.beanRows : []
  const allowedInventoryLabels = new Set(inventoryBeanRows.map((b) => formatBeanRowLabel(b)))
  const blendSnapshot = blendRecipeSnapshotFromInventory(inventory)
  const latestGreenWonByLabel = getLatestGreenOrderWonPerKgByInventoryLabel(
    inventoryBeanRows,
    mapOptions,
    blendSnapshot,
  )

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
    const q =
      typeof record.quantity === 'number' && Number.isFinite(record.quantity) ? Math.max(0, record.quantity) : 0
    acc.totalQuantityKg += q
    const rev = typeof record.totalAmount === 'number' && Number.isFinite(record.totalAmount) ? record.totalAmount : 0
    acc.totalRevenueWon += rev
  }

  const lines: BeanSalesMaterialMeetingLine[] = Array.from(salesMap.values()).map((row) => {
    const g = latestGreenWonByLabel.get(row.beanLabel)
    const wonPerKg = g ? g.wonPerKg : null
    const greenOrderDateRef = g ? g.orderDate : null
    const estimatedCostWon =
      wonPerKg != null && row.totalQuantityKg > 0 ? Math.round(wonPerKg * row.totalQuantityKg) : null
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

  return { lines, totalEstimatedCostWon }
}
