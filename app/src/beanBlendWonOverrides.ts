import { inventoryPageScopedKey } from './InventoryStatusPage'
import type { MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'

export const BLEND_WON_OVERRIDES_KEY_BASE = 'bean-blend-won-kg-override-v1'

export const BLEND_WON_OVERRIDES_SAVED_EVENT = 'bean-blend-won-kg-override-saved'

type Scoped = { mode: 'local' | 'cloud'; companyId: string | null }

const parseScoped = (o?: MapStatementItemToInventoryOptions): Scoped | null => {
  if (!o?.mode) {
    return null
  }
  return { mode: o.mode, companyId: o.companyId ?? null }
}

const storageKey = (o: Scoped) => inventoryPageScopedKey(BLEND_WON_OVERRIDES_KEY_BASE, o.mode, o.companyId)

/**
 * 입고 라벨(예: `10. Brazil`) → 생두 원/kg **직접 보정**값(생두 주문 스냅샷이 없을 때·덮어쓸 때).
 */
export function readBlendWonOverridesByLabel(o?: MapStatementItemToInventoryOptions): ReadonlyMap<string, number> {
  const s = parseScoped(o)
  if (!s) {
    return new Map()
  }
  try {
    const raw = window.localStorage.getItem(storageKey(s))
    if (!raw) {
      return new Map()
    }
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return new Map()
    }
    const m = new Map<string, number>()
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const key = k.trim()
      if (!key) {
        continue
      }
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n) && n > 0) {
        m.set(key, Math.round(n * 1000) / 1000)
      }
    }
    return m
  } catch {
    return new Map()
  }
}

export function setBlendWonOverride(
  o: MapStatementItemToInventoryOptions,
  label: string,
  wonPerKg: number | null,
): void {
  const s = parseScoped(o)
  if (!s) {
    return
  }
  const t = label.trim()
  if (!t) {
    return
  }
  const k = storageKey(s)
  let record: Record<string, number> = {}
  try {
    const existing = window.localStorage.getItem(k)
    if (existing) {
      const p = JSON.parse(existing) as unknown
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        record = { ...p } as Record<string, number>
      }
    }
  } catch {
    // ignore
  }
  if (wonPerKg == null || !Number.isFinite(wonPerKg) || wonPerKg <= 0) {
    delete record[t]
  } else {
    record[t] = Math.round(wonPerKg * 1000) / 1000
  }
  window.localStorage.setItem(k, JSON.stringify(record))
  window.dispatchEvent(new Event(BLEND_WON_OVERRIDES_SAVED_EVENT))
}
