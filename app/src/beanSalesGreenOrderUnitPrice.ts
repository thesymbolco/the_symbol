import { readBlendWonOverridesByLabel } from './beanBlendWonOverrides'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import { readGreenBeanOrderPersistedFromStorage, type GreenBeanOrderDatedSnapshot } from './GreenBeanOrderPage'
import {
  isBlendingDarkBeanRow,
  isBlendingDecaffeineBeanRow,
  isBlendingLightBeanRow,
} from './inventoryBlendRecipes'
import {
  calendarYmPlusMonths,
  greenBeanStockKgByLabelAtYmEnd,
  type BlendingRecipe,
  type InventoryBeanRow,
  type InventoryStorageEnvelope,
} from './inventoryStatusUtils'

export type GreenOrderUnitPriceMode = 'monthly_avg' | 'latest' | 'moving_avg'

export const GREEN_ORDER_UNIT_PRICE_MODE_STORAGE_KEY = 'bean-green-order-unit-price-mode'
export const GREEN_ORDER_UNIT_PRICE_MODE_EVENT = 'bean-green-order-unit-price-mode-changed'

export const DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE: GreenOrderUnitPriceMode = 'moving_avg'

export function readStoredGreenOrderUnitPriceMode(): GreenOrderUnitPriceMode {
  if (typeof window === 'undefined') {
    return DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE
  }
  try {
    const raw = window.localStorage.getItem(GREEN_ORDER_UNIT_PRICE_MODE_STORAGE_KEY)
    if (raw === 'latest') {
      return 'latest'
    }
    if (raw === 'moving_avg') {
      return 'moving_avg'
    }
    return DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE
  } catch {
    return DEFAULT_GREEN_ORDER_UNIT_PRICE_MODE
  }
}

export function writeStoredGreenOrderUnitPriceMode(mode: GreenOrderUnitPriceMode): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(GREEN_ORDER_UNIT_PRICE_MODE_STORAGE_KEY, mode)
    window.dispatchEvent(new Event(GREEN_ORDER_UNIT_PRICE_MODE_EVENT))
  } catch {
    /* ignore */
  }
}

/** @deprecated LatestGreenOrderCost — use GreenOrderUnitPrice */
export type LatestGreenOrderCost = GreenOrderUnitPrice

export type GreenOrderUnitPrice = {
  wonPerKg: number
  /** UI 표시용: `2026-03 가중평균 (주문 2건)` · `2026-03-15` · `직접` 등 */
  basisRef: string
}

export type BlendRecipeSnapshot = {
  dark: BlendingRecipe | null
  light: BlendingRecipe | null
  decaf: BlendingRecipe | null
}

const snapshotOrder = (a: { orderDate: string; savedAt: string }, b: { orderDate: string; savedAt: string }): number => {
  const d = b.orderDate.localeCompare(a.orderDate)
  if (d !== 0) {
    return d
  }
  return b.savedAt.localeCompare(a.savedAt)
}

const monthKeyFromOrderDate = (orderDate: string): string => orderDate.slice(0, 7)

type LabelMoneyKg = { money: number; kg: number }

/** 한 스냅샷 안에서 같은 입고 라벨은 아래쪽 줄이 앞쪽을 덮는다(기존 최근 주문 규칙). */
function labelCostsInSnapshot(
  snap: GreenBeanOrderDatedSnapshot,
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
): Map<string, LabelMoneyKg> {
  const inSnap = new Map<string, LabelMoneyKg>()
  const items = snap.items
  if (!Array.isArray(items) || items.length === 0) {
    return inSnap
  }
  for (const it of items) {
    const name = typeof it?.itemName === 'string' ? it.itemName.trim() : ''
    if (!name) {
      continue
    }
    const q = typeof it.quantityKg === 'number' && Number.isFinite(it.quantityKg) ? it.quantityKg : 0
    const m = typeof it.lineTotal === 'number' && Number.isFinite(it.lineTotal) ? it.lineTotal : 0
    if (q <= 0 || m < 0) {
      continue
    }
    const { label } = mapStatementItemToInventoryLabel(name, inventoryBeanRows, mapOpts)
    inSnap.set(label, { money: m, kg: q })
  }
  return inSnap
}

function buildLatestLabelPrices(
  snapshots: readonly GreenBeanOrderDatedSnapshot[],
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
): Map<string, GreenOrderUnitPrice> {
  const out = new Map<string, GreenOrderUnitPrice>()
  const sorted = [...snapshots].sort(snapshotOrder)
  for (const snap of sorted) {
    const inThisSnapshot = labelCostsInSnapshot(snap, inventoryBeanRows, mapOpts)
    for (const [label, { money, kg }] of inThisSnapshot) {
      if (!out.has(label)) {
        out.set(label, { wonPerKg: money / kg, basisRef: snap.orderDate })
      }
    }
  }
  return out
}

function aggregateGreenPurchasesInYm(
  ym: string,
  snapshots: readonly GreenBeanOrderDatedSnapshot[],
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
): { totals: Map<string, LabelMoneyKg>; snapshotCountByLabel: Map<string, number> } {
  const prefix = ym.trim()
  const inMonth = snapshots.filter((s) => monthKeyFromOrderDate(s.orderDate) === prefix)
  const totals = new Map<string, LabelMoneyKg>()
  const snapshotCountByLabel = new Map<string, number>()

  for (const snap of inMonth) {
    const inThisSnapshot = labelCostsInSnapshot(snap, inventoryBeanRows, mapOpts)
    for (const [label, { money, kg }] of inThisSnapshot) {
      const prev = totals.get(label) ?? { money: 0, kg: 0 }
      totals.set(label, { money: prev.money + money, kg: prev.kg + kg })
      snapshotCountByLabel.set(label, (snapshotCountByLabel.get(label) ?? 0) + 1)
    }
  }
  return { totals, snapshotCountByLabel }
}

function buildMonthlyAvgLabelPrices(
  ym: string,
  snapshots: readonly GreenBeanOrderDatedSnapshot[],
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
): Map<string, GreenOrderUnitPrice> {
  const prefix = ym.trim()
  const { totals, snapshotCountByLabel } = aggregateGreenPurchasesInYm(ym, snapshots, inventoryBeanRows, mapOpts)

  const out = new Map<string, GreenOrderUnitPrice>()
  for (const [label, { money, kg }] of totals) {
    if (kg <= 0) {
      continue
    }
    const n = snapshotCountByLabel.get(label) ?? 0
    const snapNote = n > 0 ? `주문 ${n}건` : ''
    out.set(label, {
      wonPerKg: money / kg,
      basisRef: snapNote ? `${prefix} 가중평균 (${snapNote})` : `${prefix} 가중평균`,
    })
  }
  return out
}

/**
 * 전월 말 입출고 재고(kg)×전월 단가(당월 가중평균) + 당월 생두 주문 입고액 ÷ (전월 재고 kg + 당월 입고 kg).
 * 4월 주문 잔량이 5월 판매 원가에 섞이도록 하는 모드.
 */
function buildMovingAvgLabelPrices(
  ym: string,
  snapshots: readonly GreenBeanOrderDatedSnapshot[],
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts: MapStatementItemToInventoryOptions | undefined,
  blendRecipeSnapshot: BlendRecipeSnapshot | null | undefined,
  inventoryEnvelope: InventoryStorageEnvelope | null | undefined,
): Map<string, GreenOrderUnitPrice> {
  const prefix = ym.trim()
  if (!/^\d{4}-\d{2}$/.test(prefix)) {
    return new Map()
  }
  const prevYm = calendarYmPlusMonths(prefix, -1)
  const openingKgRaw = greenBeanStockKgByLabelAtYmEnd(prevYm, inventoryEnvelope)
  const openingKg = new Map<string, number>()
  for (const [rawLabel, kg] of openingKgRaw) {
    const { label } = mapStatementItemToInventoryLabel(rawLabel, inventoryBeanRows, mapOpts)
    if (kg > 0) {
      openingKg.set(label, (openingKg.get(label) ?? 0) + kg)
    }
  }

  const priorUnit = getGreenOrderWonPerKgByInventoryLabel(inventoryBeanRows, {
    mode: 'monthly_avg',
    ym: prevYm,
    mapOpts,
    blendRecipeSnapshot,
    monthlyFallbackToLatest: true,
    inventoryEnvelope: undefined,
  })

  const { totals: purchaseTotals, snapshotCountByLabel } = aggregateGreenPurchasesInYm(
    prefix,
    snapshots,
    inventoryBeanRows,
    mapOpts,
  )

  const labels = new Set<string>([...openingKg.keys(), ...purchaseTotals.keys()])
  const out = new Map<string, GreenOrderUnitPrice>()

  for (const label of labels) {
    const openKg = openingKg.get(label) ?? 0
    const prior = priorUnit.get(label)
    const priorWon = prior?.wonPerKg ?? 0
    const pur = purchaseTotals.get(label) ?? { money: 0, kg: 0 }
    const totalKg = openKg + pur.kg
    if (totalKg <= 0) {
      continue
    }
    const totalMoney = openKg * priorWon + pur.money
    const n = snapshotCountByLabel.get(label) ?? 0
    const openNote = openKg > 0 ? `전월(${prevYm})재고 ${formatKgNote(openKg)}kg` : ''
    const purNote = pur.kg > 0 ? `당월입고 ${formatKgNote(pur.kg)}kg${n > 0 ? `·주문${n}건` : ''}` : ''
    const bits = [openNote, purNote].filter(Boolean)
    out.set(label, {
      wonPerKg: totalMoney / totalKg,
      basisRef: bits.length > 0 ? `${prefix} 이동평균 (${bits.join(' + ')})` : `${prefix} 이동평균`,
    })
  }
  return out
}

const formatKgNote = (kg: number): string =>
  Number.isInteger(kg) || kg % 1 === 0 ? String(Math.round(kg)) : kg.toFixed(2)

function applyBlendRecipesAndOverrides(
  base: Map<string, GreenOrderUnitPrice>,
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
  blendRecipeSnapshot?: BlendRecipeSnapshot | null,
): Map<string, GreenOrderUnitPrice> {
  const out = new Map(base)
  const overrides = readBlendWonOverridesByLabel(mapOpts)
  for (const [label, w] of overrides) {
    const prev = out.get(label)
    out.set(label, {
      wonPerKg: w,
      basisRef: prev?.basisRef && prev.basisRef !== '직접' ? `직접 (${prev.basisRef})` : '직접',
    })
  }

  const blendTargets: Array<{ label: string; recipe: BlendingRecipe | null }> = []
  const darkBlend = inventoryBeanRows.find((row) => isBlendingDarkBeanRow(row))
  if (darkBlend) {
    blendTargets.push({
      label: formatBeanRowLabel(darkBlend),
      recipe: blendRecipeSnapshot?.dark ?? null,
    })
  }
  const lightBlend = inventoryBeanRows.find((row) => isBlendingLightBeanRow(row))
  if (lightBlend) {
    blendTargets.push({
      label: formatBeanRowLabel(lightBlend),
      recipe: blendRecipeSnapshot?.light ?? null,
    })
  }
  const decafBlend = inventoryBeanRows.find((row) => isBlendingDecaffeineBeanRow(row))
  if (decafBlend) {
    blendTargets.push({
      label: formatBeanRowLabel(decafBlend),
      recipe: blendRecipeSnapshot?.decaf ?? null,
    })
  }

  for (const target of blendTargets) {
    const recipe = target.recipe
    if (!recipe || !Array.isArray(recipe.components) || recipe.components.length === 0) {
      continue
    }
    out.delete(target.label)
    let weighted = 0
    let totalRaw = 0
    const basisParts: string[] = []
    for (const comp of recipe.components) {
      const raw = Number(comp.rawPerCycle)
      if (!Number.isFinite(raw) || raw <= 0) {
        continue
      }
      const { label } = mapStatementItemToInventoryLabel(comp.beanName, inventoryBeanRows, mapOpts)
      const c = out.get(label)
      if (!c) {
        continue
      }
      weighted += c.wonPerKg * raw
      totalRaw += raw
      if (c.basisRef) {
        basisParts.push(c.basisRef)
      }
    }
    if (totalRaw <= 0) {
      continue
    }
    const uniqueBasis = [...new Set(basisParts)].slice(0, 2).join(' · ')
    out.set(target.label, {
      wonPerKg: weighted / totalRaw,
      basisRef: uniqueBasis ? `블렌드 (${uniqueBasis})` : '블렌드 레시피',
    })
  }

  return out
}

function fillMonthlyFromLatestFallback(
  monthly: Map<string, GreenOrderUnitPrice>,
  latest: Map<string, GreenOrderUnitPrice>,
  ym: string,
): Map<string, GreenOrderUnitPrice> {
  const out = new Map(monthly)
  for (const [label, cost] of latest) {
    if (out.has(label)) {
      continue
    }
    out.set(label, {
      wonPerKg: cost.wonPerKg,
      basisRef: `${ym} 주문 없음 → 최근 (${cost.basisRef})`,
    })
  }
  return out
}

export type GetGreenOrderWonPerKgOptions = {
  mode: GreenOrderUnitPriceMode
  /** `monthly_avg` · `moving_avg`일 때 필수 (`YYYY-MM`) */
  ym?: string | null
  mapOpts?: MapStatementItemToInventoryOptions
  blendRecipeSnapshot?: BlendRecipeSnapshot | null
  /** 당월 주문이 없을 때 최근 주문 단가로 채울지 (기본 true) */
  monthlyFallbackToLatest?: boolean
  /** `moving_avg`: 전월 말 재고 kg — 입출고 v2 `inventoryByMonth` */
  inventoryEnvelope?: InventoryStorageEnvelope | null
}

/**
 * 생두 주문「일자 기록」으로 입출고 라벨별 원/kg.
 * - `latest`: 스냅샷을 최신 주문일부터 훑어 품목별 **가장 최근** 단가
 * - `monthly_avg`: 해당 월 스냅샷을 **Σ금액÷Σkg** 가중평균 (당월 주문 없으면 최근 단가로 보완 가능)
 * - `moving_avg`: **전월 말 입출고 재고** + **당월 입고** 가중평균 (4월 잔량→5월 판매 반영)
 */
export function getGreenOrderWonPerKgByInventoryLabel(
  inventoryBeanRows: readonly InventoryBeanRow[],
  options: GetGreenOrderWonPerKgOptions,
): ReadonlyMap<string, GreenOrderUnitPrice> {
  const persisted = readGreenBeanOrderPersistedFromStorage()
  const snapshots = persisted.orderSnapshots ?? []
  const mapOpts = options.mapOpts
  const latest = buildLatestLabelPrices(snapshots, inventoryBeanRows, mapOpts)

  let base: Map<string, GreenOrderUnitPrice>
  if (options.mode === 'latest') {
    base = latest
  } else {
    const ym = typeof options.ym === 'string' ? options.ym.trim() : ''
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      base = latest
    } else if (options.mode === 'moving_avg') {
      const moving = buildMovingAvgLabelPrices(
        ym,
        snapshots,
        inventoryBeanRows,
        mapOpts,
        options.blendRecipeSnapshot,
        options.inventoryEnvelope,
      )
      base =
        options.monthlyFallbackToLatest === false
          ? moving
          : fillMonthlyFromLatestFallback(moving, latest, ym)
    } else {
      const monthly = buildMonthlyAvgLabelPrices(ym, snapshots, inventoryBeanRows, mapOpts)
      base =
        options.monthlyFallbackToLatest === false
          ? monthly
          : fillMonthlyFromLatestFallback(monthly, latest, ym)
    }
  }

  return applyBlendRecipesAndOverrides(base, inventoryBeanRows, mapOpts, options.blendRecipeSnapshot)
}

/**
 * 생두 주문「일자 기록」스냅샷을 날짜·저장 시각 역순으로 훑어,
 * 품목(입출고와 동일 `mapStatementItem` 라벨)마다 **가장 최근** 1kg당 주문가(원/kg)을 넣는다.
 */
export function getLatestGreenOrderWonPerKgByInventoryLabel(
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
  blendRecipeSnapshot?: BlendRecipeSnapshot | null,
): ReadonlyMap<string, GreenOrderUnitPrice> {
  return getGreenOrderWonPerKgByInventoryLabel(inventoryBeanRows, {
    mode: 'latest',
    mapOpts,
    blendRecipeSnapshot,
  })
}

/** `LatestGreenOrderCost` 호환: `orderDate` 필드 */
export function greenOrderUnitPriceToLegacy(cost: GreenOrderUnitPrice): { wonPerKg: number; orderDate: string } {
  return { wonPerKg: cost.wonPerKg, orderDate: cost.basisRef }
}
