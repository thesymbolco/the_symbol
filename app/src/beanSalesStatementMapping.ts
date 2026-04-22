import { GREEN_BEAN_ORDER_INVENTORY_ALIASES } from './greenBeanOrderInventoryAliases'
import { canonicalBlendDisplayName } from './inventoryBlendRecipes'
import type { InventoryBeanRow } from './inventoryStatusUtils'

const normCompact = (s: string) => s.trim().toLowerCase().replace(/\s/g, '')

const normSpaced = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * 괄호(매장명·내부 메모 등)는 매칭용 문자열에서 제거
 * (반각·전각 `()` `（）` 모두)
 */
export const stripParensForMatch = (s: string): string => {
  let t = s
  let prev = ''
  while (t !== prev) {
    prev = t
    t = t.replace(/[\(（][^)）]*[\)）]/g, ' ')
  }
  return t.replace(/\s+/g, ' ').replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const coreFromName = (name: string) => name.replace(/^\d+(?:\.\s*|\s+)/, '').trim()

/**
 * 입출고와 동일한 표기: `11. Decaf 세라도 NY2FC`
 * (InventoryStatusPage: `{bean.no}. {bean.name}`)
 */
export const formatBeanRowLabel = (bean: Pick<InventoryBeanRow, 'no' | 'name'>): string => {
  if (bean.no != null && Number.isFinite(bean.no as number)) {
    return `${bean.no}. ${bean.name}`
  }
  return bean.name
}

const findByExactName = (name: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
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

const findLongestSubstringRow = (cleanCompact: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
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
 * `GREEN_BEAN_ORDER_INVENTORY_ALIASES`의 오른쪽 값이 실제 `bean.name`과 다를 수 있어(예: Colombia Narino)
 * `findByExactName` / 부분일치로 입출고 행에 연결한다.
 */
const resolveAliasedTarget = (targetFromAlias: string, rows: readonly InventoryBeanRow[]): InventoryBeanRow | null => {
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

type KeywordSpec = { re: RegExp; target: string }

/** 품목문구만 보고 먼저 잡는 키(한글/영문 혼용) → 입출고 `bean.name`과 동일한 문자열 (위에 있을수록 먼저 적용) */
const KEYWORD_TO_BEAN_NAME: KeywordSpec[] = [
  {
    re: /블렌딩[-–\s]*길\s*시그니처|blending[-\s]*signature/iu,
    target: '15. DECAFFEINE BLEND',
  },
  { re: /^(유로|euro)$/i, target: 'Euro' },
  { re: /^(케냐|kenya|aa\s*faq|aa\s*plus|aa\s*플러스|aa\s*\+)/i, target: 'Ihider' },
  { re: /나리[노뇨]|narino|콜롬비아.*나리|colombia.*nari/i, target: 'Narino' },
  { re: /sidamo|시다모/i, target: 'Sidamo G4' },
  { re: /mogiana|모지아나|세하도(?!.*디카)|^브라질$/i, target: 'Mogiana' },
  { re: /koke|코케|코케허니|예가체프 g1(?!.*g2)/i, target: 'Koke honey' },
  { re: /yirgacheffe|예가체프(?!.*g1)/i, target: 'Yirgacheffe' },
  { re: /mormora|모모라/i, target: 'Mormora' },
  { re: /aricha|아리차/i, target: 'Aricha' },
  { re: /ihider|아이히더/i, target: 'Ihider' },
  { re: /achegayo|아체가요/i, target: 'Ache Gayo Mountain' },
  { re: /mandling|만델링/i, target: 'Mandling' },
  { re: /antigua(?!.*디카)|안티구아(?!.*디카)/i, target: 'Antigua SHB' },
  { re: /decaf.*antigua|디카.*안티|decaf antigua|과테말라.*디카(?!.*yirg)/i, target: 'Decaf Antigua SHB' },
  { re: /decaf yirg|yirgacheffe.*디카|decaf.*예가/i, target: 'Decaf Yirgacheffe' },
  { re: /세라도 ny2|ny2fc|decaf.*세라도|디카.*세하도/i, target: 'Decaf 세라도 NY2FC' },
  { re: /huila|후일라|다리오|dario|수프리모/i, target: 'Huila Supremo' },
  { re: /cerrado(?!.*decaf)/i, target: 'Cerrado NY2' },
  { re: /kappi royale|카피.*로얄|인도.*kappi/i, target: 'India Kappi Royale' },
  { re: /다크(?!.*라이트)|dark\s*blend|blending-dark|블렌딩.*다크|다크로스/i, target: '13. DARK BLEND' },
  { re: /라이트\s*blend|light\s*blend|blending-light|블렌딩.*라이트/i, target: '14. LIGHT BLEND' },
  { re: /deca?ffe?ine|디카페인\s*blend|blending-signature|15\.|decaf.*blend(?!.*dark)/i, target: '15. DECAFFEINE BLEND' },
]

/**
 * App.tsx `DEFAULT_ITEM_OPTIONS`·실제 납품 품목에서 자주 쓰는 풀문구 → `bean.name`
 * (공백·대소문자는 normCompact로 비교)
 */
const PHRASE_TO_BEAN_NAME: ReadonlyArray<readonly [string, string]> = [
  ['에티오피아 코케허니 예가체프 G1', 'Koke honey'],
  ['에티오피아 예가체프 G2', 'Yirgacheffe'],
  ['에티오피아 모모라 워시드 구지 G1', 'Mormora'],
  ['케냐 AA FAQ', 'Ihider'],
  ['인도네시아 아체가요 G1', 'Ache Gayo Mountain'],
  ['인도네시아 만델링 G1', 'Mandling'],
  ['과테말라 안티구아 SHB', 'Antigua SHB'],
  ['디카페인 (안티구아+세하도 50:50)', 'Decaf Antigua SHB'],
  ['콜롬비아 다리오 수프리모', 'Huila Supremo'],
  ['에티오피아 시다모 G4', 'Sidamo G4'],
  ['블렌딩-길 시그니처', '15. DECAFFEINE BLEND'],
  ['블렌딩 길 시그니처', '15. DECAFFEINE BLEND'],
  ['블렌딩 다크로스나', '13. DARK BLEND'],
  ['블렌딩 라이트', '14. LIGHT BLEND'],
  ['과테말라 안티구아 디카페인', 'Decaf Antigua SHB'],
  ['브라질 슈가케인 디카페인', 'Decaf 세라도 NY2FC'],
  ['브라질 세하도', 'Mogiana'],
]

function findByPhraseMap(clean: string): string | null {
  const c = normCompact(clean)
  const sorted = [...PHRASE_TO_BEAN_NAME].sort(
    (a, b) => normCompact(b[0]).length - normCompact(a[0]).length,
  )
  for (const [phrase, beanName] of sorted) {
    const p = normCompact(phrase)
    if (c === p) {
      return beanName
    }
    if (p.length >= 6 && c.includes(p)) {
      return beanName
    }
  }
  return null
}

/**
 * 거래명세 `itemName` → 입출고와 같은 「N. 품목명」 표시, 및 정렬용 `sortKey` (no 없으면 큰 수)
 */
export function mapStatementItemToInventoryLabel(
  itemName: string,
  beanRows: readonly InventoryBeanRow[],
): { label: string; sortKey: number; matched: boolean } {
  if (!itemName?.trim()) {
    return { label: '—', sortKey: 999_999, matched: false }
  }

  const raw = itemName.trim()
  const blended = canonicalBlendDisplayName(raw)
  const forMatch = stripParensForMatch(blended)
  const forMatchSpaced = normSpaced(forMatch)
  const forMatchCompact = normCompact(forMatch)

  /** 더치는 입출고 생두 행이 아닐 수 있어 별도 표기 */
  if (/디카페인.*더치|더치.*디카/i.test(raw) || /디카.*더치|더치.*디카/i.test(forMatch)) {
    return { label: '더치(디카페인) 음료', sortKey: 950_000, matched: true }
  }

  const tokenOnly =
    forMatch.length > 0 && !/[\s,，]/.test(forMatch) ? forMatch : ''
  if (tokenOnly) {
    const singleTokenToBeanName: ReadonlyArray<readonly [string, string]> = [
      ['디카페인', '15. DECAFFEINE BLEND'],
      ['나리노', 'Narino'],
      ['나리뇨', 'Narino'],
      ['브라질', 'Mogiana'],
      ['유로', 'Euro'],
      ['케냐', 'Ihider'],
    ]
    for (const [tok, beanName] of singleTokenToBeanName) {
      if (tokenOnly === tok) {
        if (beanRows.length === 0) {
          return { label: beanName, sortKey: 900_000, matched: true }
        }
        const row = findByExactName(beanName, beanRows)
        if (row) {
          return { label: formatBeanRowLabel(row), sortKey: row.no ?? 0, matched: true }
        }
        break
      }
    }
  }

  if (beanRows.length === 0) {
    const fromPhrase = findByPhraseMap(forMatch)
    if (fromPhrase) {
      return { label: fromPhrase, sortKey: 900_000, matched: true }
    }
    for (const { re, target } of KEYWORD_TO_BEAN_NAME) {
      if (re.test(forMatchSpaced) || re.test(raw)) {
        return { label: target, sortKey: 900_000, matched: true }
      }
    }
    for (const [from, to] of GREEN_BEAN_ORDER_INVENTORY_ALIASES) {
      if (forMatchCompact.includes(normCompact(from)) || normCompact(from) === forMatchCompact) {
        return { label: to, sortKey: 900_000, matched: true }
      }
    }
    return { label: raw, sortKey: 900_000, matched: false }
  }

  // 1) 자주 쓰는 풀문구 (앱 품목 옵션 등)
  const fromPhrase = findByPhraseMap(forMatch)
  if (fromPhrase) {
    const row = findByExactName(fromPhrase, beanRows) ?? resolveAliasedTarget(fromPhrase, beanRows)
    if (row) {
      return { label: formatBeanRowLabel(row), sortKey: row.no ?? 0, matched: true }
    }
  }

  // 2) 키워드 → inventory bean name
  for (const { re, target } of KEYWORD_TO_BEAN_NAME) {
    if (re.test(forMatchSpaced) || re.test(raw)) {
      const row = findByExactName(target, beanRows)
      if (row) {
        return { label: formatBeanRowLabel(row), sortKey: row.no ?? 0, matched: true }
      }
    }
  }

  // 3) 생두주문-재고 별칭
  for (const [from, to] of GREEN_BEAN_ORDER_INVENTORY_ALIASES) {
    if (forMatchCompact.includes(normCompact(from)) || normCompact(from) === forMatchCompact) {
      const row = resolveAliasedTarget(to, beanRows) ?? findByExactName(to, beanRows)
      if (row) {
        return { label: formatBeanRowLabel(row), sortKey: row.no ?? 0, matched: true }
      }
    }
  }

  // 4) 품목명이 입고명과 직접 일치(괄호 제거 후)
  const direct = findByExactName(forMatch, beanRows)
  if (direct) {
    return { label: formatBeanRowLabel(direct), sortKey: direct.no ?? 0, matched: true }
  }

  // 5) 가장 긴 부분일치(영문/한글 혼용 대비)
  const sub = findLongestSubstringRow(forMatchCompact, beanRows)
  if (sub) {
    return { label: formatBeanRowLabel(sub), sortKey: sub.no ?? 0, matched: true }
  }

  // 6) 그대로(미매칭) — 괄호는 표시는 유지하되, 너무 길면 축약은 하지 않음
  return { label: raw, sortKey: 900_000, matched: false }
}

