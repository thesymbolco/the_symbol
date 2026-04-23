import { readBlendWonOverridesByLabel } from './beanBlendWonOverrides'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import { readGreenBeanOrderPersistedFromStorage } from './GreenBeanOrderPage'
import {
  isBlendingDarkBeanRow,
  isBlendingDecaffeineBeanRow,
  isBlendingLightBeanRow,
} from './inventoryBlendRecipes'
import type { BlendingRecipe, InventoryBeanRow } from './inventoryStatusUtils'

export type LatestGreenOrderCost = {
  wonPerKg: number
  orderDate: string
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

/**
 * 생두 주문「일자 기록」스냅샷을 날짜·저장 시각 역순으로 훑어,
 * 품목(입출고와 동일 `mapStatementItem` 라벨)마다 **가장 최근** 1kg당 주문가(원/kg)을 넣는다.
 *
 * - 스냅샷은 **최신 주문일부터** 본다. 한 스냅샷 안에서 같은 입고 라벨(예: `10. Brazil`)에
 *   여러 줄이 있으면 **아래쪽 줄이 앞쪽 줄을 덮는다**(같은 주문서에서 모지아나·세하도 등이
 *   둘 다 `Brazil` 행으로 붙을 때, 뒤에 적은 줄의 단가가 쓰이게).
 */
export function getLatestGreenOrderWonPerKgByInventoryLabel(
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
  blendRecipeSnapshot?: BlendRecipeSnapshot | null,
): ReadonlyMap<string, LatestGreenOrderCost> {
  const out = new Map<string, LatestGreenOrderCost>()
  const persisted = readGreenBeanOrderPersistedFromStorage()
  const snapshots = [...(persisted.orderSnapshots ?? [])].sort(snapshotOrder)
  for (const snap of snapshots) {
    const items = snap.items
    if (!Array.isArray(items) || items.length === 0) {
      continue
    }
    const inThisSnapshot = new Map<string, LatestGreenOrderCost>()
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
      inThisSnapshot.set(label, { wonPerKg: m / q, orderDate: snap.orderDate })
    }
    for (const [label, cost] of inThisSnapshot) {
      if (!out.has(label)) {
        out.set(label, cost)
      }
    }
  }
  const overrides = readBlendWonOverridesByLabel(mapOpts)
  for (const [label, w] of overrides) {
    const prev = out.get(label)
    out.set(label, {
      wonPerKg: w,
      orderDate:
        prev?.orderDate && /^\d{4}-\d{2}-\d{2}/.test(prev.orderDate) ? prev.orderDate : '직접',
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
    // 생두 주문 1차 루프가 실수로 블렌드 라벨(예: 15. DECAFFEINE BLEND)에 붙인 단가가 있으면,
    // 그 값이 남은 채로 레시피 가중평균이 실패·부분일 때 잘못된 금액이 보인다. 레시피로 계산할 때는 먼저 뺀다.
    out.delete(target.label)
    let weighted = 0
    let totalRaw = 0
    let latestDate = ''
    for (const comp of recipe.components) {
      const raw = Number(comp.rawPerCycle)
      if (!Number.isFinite(raw) || raw <= 0) {
        continue
      }
      const { label } = mapStatementItemToInventoryLabel(comp.beanName, inventoryBeanRows, mapOpts)
      const c = out.get(label)
      if (!c) {
        // 구성 원두 일부의 최근 주문가가 없더라도, 있는 비율만으로 블렌드 평균을 계산한다.
        continue
      }
      weighted += c.wonPerKg * raw
      totalRaw += raw
      if (c.orderDate && /^\d{4}-\d{2}-\d{2}/.test(c.orderDate) && c.orderDate > latestDate) {
        latestDate = c.orderDate
      }
    }
    if (totalRaw <= 0) {
      continue
    }
    out.set(target.label, { wonPerKg: weighted / totalRaw, orderDate: latestDate || '' })
  }
  return out
}
