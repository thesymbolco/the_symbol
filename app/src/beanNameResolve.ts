import { getEffectiveGreenBeanOrderAliases } from './beanNameAliasStore'
import type { InventoryBeanRow } from './inventoryStatusUtils'

/**
 * 입출고 `beanRows[].name`이 정본(SSOT)입니다. 이 모듈은 **외부 문자열**(주문·명세·앱 품목)
 * 를 그 행에 붙이기 위한 공통 비교·별칭 해석을 한곳에 둡니다.
 *
 * - 거래명세 한 줄 → 표시·정렬: `mapStatementItemToInventoryLabel` (`beanSalesStatementMapping`)
 * - 가벼운 "이 문자열이 어느 생두 행이냐": `resolveExternalLabelToInventoryRow` (이 파일)
 * - 기본 별칭은 코드, 추가 별칭은 앱(localStorage)에서 관리
 */

/**
 * 이름 비교용 정규화:
 * - 소문자
 * - 공백 제거
 * - 일반 기호(`-_/.,()`) 제거
 * => `NY2 FC`, `NY2FC`, `NY2-FC`를 동일 키로 본다.
 */
export const normCompact = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s\-_./(),[\]{}]+/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')

export const coreFromName = (name: string) => name.replace(/^\d+(?:\.\s*|\s+)/, '').trim()

export const findByExactName = (name: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
  const t = normCompact(name)
  for (const b of rows) {
    if (normCompact(b.name) === t) {
      return b
    }
    if (normCompact(coreFromName(b.name)) === t) {
      return b
    }
  }
  return null
}

export const findLongestSubstringRow = (cleanCompact: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
  let best: InventoryBeanRow | null = null
  let bestLen = 0
  for (const b of rows) {
    for (const frag of [b.name, coreFromName(b.name)]) {
      const f = normCompact(frag)
      if (f.length < 2) {
        continue
      }
      if (cleanCompact.includes(f) && f.length > bestLen) {
        best = b
        bestLen = f.length
      }
    }
  }
  return best
}

/**
 * `GREEN_BEAN_ORDER_INVENTORY_ALIASES` 오른쪽 값이 실제 `bean.name`과 다를 수 있어
 * `findByExactName` / 부분일치로 입출고 행에 연결한다.
 */
export const resolveAliasedTarget = (targetFromAlias: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
  const exact = findByExactName(targetFromAlias, rows)
  if (exact) {
    return exact
  }
  const t = normCompact(targetFromAlias)
  if (t.length < 2) {
    return null
  }
  return findLongestSubstringRow(t, rows)
}

export type ResolveExternalLabelVia = 'exact' | 'order_alias' | 'substring' | 'none'

/**
 * 키워드·괄호 처리·수동 맵(`beanStatementManualMappings`) 없이,
 * (1) 정확 일치 (2) 생두주문 별칭 배열 (3) 가장 긴 부분일치 순으로 `beanRows`를 찾는다.
 * — 거래명세 전체 로직이 필요하면 `mapStatementItemToInventoryLabel` 를 쓴다.
 */
export function resolveExternalLabelToInventoryRow(
  raw: string,
  beanRows: readonly InventoryBeanRow[],
): { row: InventoryBeanRow | null; via: ResolveExternalLabelVia } {
  const t = raw.trim()
  if (!t) {
    return { row: null, via: 'none' }
  }
  if (beanRows.length > 0) {
    const exact = findByExactName(t, beanRows)
    if (exact) {
      return { row: exact, via: 'exact' }
    }
  }
  const c = normCompact(t)
  const aliases = getEffectiveGreenBeanOrderAliases()
  for (const [from, to] of aliases) {
    if (c.includes(normCompact(from)) || normCompact(from) === c) {
      if (beanRows.length === 0) {
        return { row: null, via: 'order_alias' }
      }
      const row = resolveAliasedTarget(to, beanRows) ?? findByExactName(to, beanRows)
      if (row) {
        return { row, via: 'order_alias' }
      }
    }
  }
  if (beanRows.length > 0) {
    const sub = findLongestSubstringRow(c, beanRows)
    if (sub) {
      return { row: sub, via: 'substring' }
    }
  }
  return { row: null, via: 'none' }
}
