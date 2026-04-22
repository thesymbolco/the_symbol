import { mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import { readGreenBeanOrderPersistedFromStorage } from './GreenBeanOrderPage'
import type { InventoryBeanRow } from './inventoryStatusUtils'

export type LatestGreenOrderCost = {
  wonPerKg: number
  orderDate: string
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
 * 품목(입출고와 동일 `mapStatementItem` 라벨)마다 **가장 최근** 1kg당 주문가(원/kg)을 한 번씩만 넣는다.
 */
export function getLatestGreenOrderWonPerKgByInventoryLabel(
  inventoryBeanRows: readonly InventoryBeanRow[],
  mapOpts?: MapStatementItemToInventoryOptions,
): ReadonlyMap<string, LatestGreenOrderCost> {
  const out = new Map<string, LatestGreenOrderCost>()
  const persisted = readGreenBeanOrderPersistedFromStorage()
  const snapshots = [...(persisted.orderSnapshots ?? [])].sort(snapshotOrder)
  for (const snap of snapshots) {
    const items = snap.items
    if (!Array.isArray(items) || items.length === 0) {
      continue
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
      if (out.has(label)) {
        continue
      }
      out.set(label, { wonPerKg: m / q, orderDate: snap.orderDate })
    }
  }
  return out
}
