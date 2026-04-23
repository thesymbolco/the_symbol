import { GREEN_BEAN_ORDER_INVENTORY_ALIASES } from './greenBeanOrderInventoryAliases'

export type BeanNameAliasEntry = { from: string; to: string }

export const BEAN_NAME_ALIASES_STORAGE_KEY = 'bean-name-aliases-v1'
export const BEAN_NAME_ALIASES_UPDATED_EVENT = 'bean-name-aliases-updated'

/**
 * 별칭 중복 키 정규화:
 * - `NY2 FC` / `NY2FC` / `NY2-FC`를 같은 from으로 본다.
 */
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s\-_./(),[\]{}]+/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')

export const readCustomBeanNameAliases = (): BeanNameAliasEntry[] => {
  try {
    const raw = window.localStorage.getItem(BEAN_NAME_ALIASES_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    const out: BeanNameAliasEntry[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') {
        continue
      }
      const o = row as { from?: unknown; to?: unknown }
      const from = String(o.from ?? '').trim()
      const to = String(o.to ?? '').trim()
      if (!from || !to) {
        continue
      }
      out.push({ from, to })
    }
    return out
  } catch {
    return []
  }
}

export const normalizeBeanNameAliases = (entries: BeanNameAliasEntry[]): BeanNameAliasEntry[] => {
  const byFrom = new Map<string, BeanNameAliasEntry>()
  for (const entry of entries) {
    const from = String(entry.from ?? '').trim()
    const to = String(entry.to ?? '').trim()
    if (!from || !to) {
      continue
    }
    byFrom.set(norm(from), { from, to })
  }
  return [...byFrom.values()]
}

export const writeCustomBeanNameAliases = (entries: BeanNameAliasEntry[]) => {
  const cleaned = normalizeBeanNameAliases(entries)
  try {
    window.localStorage.setItem(BEAN_NAME_ALIASES_STORAGE_KEY, JSON.stringify(cleaned))
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(BEAN_NAME_ALIASES_UPDATED_EVENT))
}

/**
 * 기본 별칭 + 앱에서 추가한 사용자 별칭.
 * 같은 from(정규화 기준)은 사용자 값을 우선한다.
 */
export const getEffectiveGreenBeanOrderAliases = (): ReadonlyArray<readonly [string, string]> => {
  const byFrom = new Map<string, readonly [string, string]>()
  for (const [from, to] of GREEN_BEAN_ORDER_INVENTORY_ALIASES) {
    const key = norm(from)
    if (!key) {
      continue
    }
    if (!byFrom.has(key)) {
      byFrom.set(key, [from, to])
    }
  }
  for (const row of readCustomBeanNameAliases()) {
    const key = norm(row.from)
    if (!key) {
      continue
    }
    byFrom.set(key, [row.from, row.to])
  }
  return [...byFrom.values()]
}
