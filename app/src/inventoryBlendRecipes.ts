import type { InventoryBeanRow } from './inventoryStatusUtils'

/** 품목명이 이 값이면 「블렌딩 다크」행(UI 안내용). 다른 원두와 생산·재고 숫자는 연동하지 않는다. */
export const BLENDING_DARK_BEAN_NAME = 'Blending-Dark'

/** `inventoryStatusUtils` EXTRA_BEAN_ROWS와 동일한 품목명 */
export const BLENDING_LIGHT_BEAN_NAME = 'Blending-Light'

export const isBlendingDarkBeanRow = (bean: InventoryBeanRow | undefined) =>
  Boolean(bean && bean.name.trim() === BLENDING_DARK_BEAN_NAME)

export const isBlendingLightBeanRow = (bean: InventoryBeanRow | undefined) =>
  Boolean(bean && bean.name.trim() === BLENDING_LIGHT_BEAN_NAME)

/** 블렌딩 다크·라이트: 자동 재고 연쇄에서 일별 출고만큼 재고를 줄인다(입고·생산과 별도). */
export const isBlendingOutboundAdjustsStockRow = (bean: InventoryBeanRow | undefined) =>
  isBlendingDarkBeanRow(bean) || isBlendingLightBeanRow(bean)

/** 자동 재고 연쇄에 쓰는 생산(환산) 배열. */
export const productionForAutoStock = (bean: InventoryBeanRow): number[] => [...bean.production]
