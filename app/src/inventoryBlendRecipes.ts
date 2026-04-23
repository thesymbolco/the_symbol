import type { InventoryBeanRow } from './inventoryStatusUtils'

export const BLENDING_DARK_BEAN_NAME = '13. DARK BLEND'
export const BLENDING_LIGHT_BEAN_NAME = '14. LIGHT BLEND'
export const BLENDING_DECAFFEINE_BEAN_NAME = '15. DECAFFEINE BLEND'

/** 예전 엑셀/로컬저장 품목명 → 현재 품목명 */
const LEGACY_BLENDING_TO_CANONICAL: Readonly<Record<string, string>> = {
  'Blending-Dark': BLENDING_DARK_BEAN_NAME,
  'Blending-Light': BLENDING_LIGHT_BEAN_NAME,
  'Blending-Signature': BLENDING_DECAFFEINE_BEAN_NAME,
}

export const canonicalBlendDisplayName = (name: string): string => {
  const t = name.trim()
  return LEGACY_BLENDING_TO_CANONICAL[t] ?? t
}

/**
 * "13. DARK BLEND" / "14 LIGHT BLEND" / "DARK BLEND" 등 번호·공백 차이를 무시한 뒤
 * "DARK BLEND" 같은 코어만 남긴다(엑셀·수동명이 canonical 전체 문자열과 다를 때 대비).
 */
const blendLineCoreName = (name: string): string => {
  const c = canonicalBlendDisplayName(name).trim()
  return c.replace(/^\d+(?:\.\s*|\s+)/, '').trim()
}

/**
 * 로스팅 열 표기(예: `DECAFFEINE BLEND`)와 생두 행 표기(예: `15. DECAFFEINE BLEND`)를 같은 품목으로 본다.
 * 번호·공백만 다른 경우 `normalizeNameKey`로는 맞지 않으므로 코어 명으로 비교한다.
 */
export const roastingColumnMatchesBeanRow = (columnLabel: string, beanRowName: string): boolean => {
  const a = columnLabel.trim().toLowerCase()
  const b = beanRowName.trim().toLowerCase()
  if (a === b) {
    return true
  }
  const ca = blendLineCoreName(columnLabel)
  const cb = blendLineCoreName(beanRowName)
  return ca.length > 0 && ca.toLowerCase() === cb.toLowerCase()
}

const isBlendCore = (name: string, core: 'DARK BLEND' | 'LIGHT BLEND' | 'DECAFFEINE BLEND') =>
  blendLineCoreName(name).toLowerCase() === core.toLowerCase()

export const isBlendingDarkBeanRow = (bean: InventoryBeanRow | undefined) =>
  Boolean(bean && isBlendCore(bean.name, 'DARK BLEND'))

export const isBlendingLightBeanRow = (bean: InventoryBeanRow | undefined) =>
  Boolean(bean && isBlendCore(bean.name, 'LIGHT BLEND'))

export const isBlendingDecaffeineBeanRow = (bean: InventoryBeanRow | undefined) =>
  Boolean(bean && isBlendCore(bean.name, 'DECAFFEINE BLEND'))

/** DARK / LIGHT / DECAFFEINE 블렌드 품목 — 생두 부족 경고 등에서 제외 */
export const isBlendingLineBeanRow = (bean: InventoryBeanRow | undefined) =>
  isBlendingDarkBeanRow(bean) || isBlendingLightBeanRow(bean) || isBlendingDecaffeineBeanRow(bean)

/** 다크·라이트: 자동 재고 = 전일+생산(raw)−출고(입고는 연채에 쓰지 않음). 디카페인 블렌드는 일반 생두와 동일 규칙. */
export const isBlendingOutboundAdjustsStockRow = (bean: InventoryBeanRow | undefined) =>
  isBlendingDarkBeanRow(bean) || isBlendingLightBeanRow(bean)

/** 자동 재고 연쇄에 쓰는 생산(환산) 배열. */
export const productionForAutoStock = (bean: InventoryBeanRow): number[] => [...bean.production]
