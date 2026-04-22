import { inventoryPageScopedKey } from './InventoryStatusPage'
import type { InventoryBeanRow } from './inventoryStatusUtils'

export const BEAN_STATEMENT_MANUAL_KEY_BASE = 'bean-statement-mappings-v1'

export const BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT = 'bean-statement-mappings-updated'

export type StatementInventoryManualEntry = { from: string; toLabel: string }

const formatRowAsLabel = (b: Pick<InventoryBeanRow, 'no' | 'name'>) => {
  if (b.no != null && Number.isFinite(b.no as number)) {
    return `${b.no}. ${b.name}`
  }
  return b.name
}

function getStorageKey(mode: 'local' | 'cloud', companyId: string | null): string {
  return inventoryPageScopedKey(BEAN_STATEMENT_MANUAL_KEY_BASE, mode, companyId)
}

/**
 * `명세↔입고`에 **해당 거래 품목**으로 한 줄이라도 있으면 — ‘입고에 맞지 않은’ 표에서 뺌(이미 직접 잡은 건)
 */
export const hasAnyStatementManualForItem = (
  itemNameTrimmed: string,
  mode: 'local' | 'cloud',
  companyId: string | null,
): boolean => {
  const t = itemNameTrimmed.trim()
  if (!t) {
    return false
  }
  return readStatementInventoryManuals(mode, companyId).some((e) => e.from === t)
}

export const readStatementInventoryManuals = (mode: 'local' | 'cloud', companyId: string | null): StatementInventoryManualEntry[] => {
  try {
    const raw = window.localStorage.getItem(getStorageKey(mode, companyId))
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    const out: StatementInventoryManualEntry[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') {
        continue
      }
      const o = row as { from?: unknown; toLabel?: unknown }
      const from = String(o.from ?? '').trim()
      const toLabel = String(o.toLabel ?? '').trim()
      if (!from || !toLabel) {
        continue
      }
      out.push({ from, toLabel })
    }
    return out
  } catch {
    return []
  }
}

/** 같은 `from`이 여러 개면 **뒤**에 온 쪽(사용자가 아래에 추가한 느낌)이 우선. 여기서는 뒤가 덮어씀 */
export const writeStatementInventoryManuals = (
  mode: 'local' | 'cloud',
  companyId: string | null,
  entries: readonly StatementInventoryManualEntry[],
): void => {
  const byFrom = new Map<string, string>()
  for (const e of entries) {
    const from = e.from.trim()
    const to = e.toLabel.trim()
    if (from && to) {
      byFrom.set(from, to)
    }
  }
  const deduped: StatementInventoryManualEntry[] = Array.from(byFrom.entries()).map(([from, toLabel]) => ({
    from,
    toLabel,
  }))
  window.localStorage.setItem(getStorageKey(mode, companyId), JSON.stringify(deduped))
  window.dispatchEvent(new Event(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT))
}

/**
 * `beanSalesStatementMapping`의 자동 로직 **앞**에서 호출.
 * `from` = 거래명세에 적힌 `itemName` **전체(앞뒤 공백 제거)와 완전 일치**해야 함.
 */
export const resolveStatementInventoryManual = (
  itemNameTrimmed: string,
  beanRows: readonly InventoryBeanRow[],
  mode: 'local' | 'cloud',
  companyId: string | null,
): { label: string; sortKey: number; matched: boolean } | null => {
  if (!itemNameTrimmed) {
    return null
  }
  const list = readStatementInventoryManuals(mode, companyId)
  const to = list.find((e) => e.from === itemNameTrimmed)?.toLabel
  if (!to) {
    return null
  }
  for (const b of beanRows) {
    if (formatRowAsLabel(b) === to) {
      return { label: to, sortKey: b.no ?? 0, matched: true }
    }
  }
  return { label: to, sortKey: 900_000, matched: true }
}
