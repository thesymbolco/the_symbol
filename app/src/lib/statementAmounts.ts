import { statementNameKey } from '../statementNameKey'

const normalize = statementNameKey

export const isTaxFreeNote = (note: string) => normalize(note) === normalize('부가세 없음')

/** 세액 포함 단가 → 공급가(부가세 별도) 단가. 지출표·세금계산서와 동일한 10/11 반올림. */
export const supplyUnitFromTaxIncludedUnit = (taxIncludedUnit: number) =>
  Math.round((taxIncludedUnit / 11) * 10)

/**
 * 공급가액 기준 세액. 합계는 `Math.round(공급가 × 1.1)`에 맞춰 1원 단위 오차를 줄인다.
 * 합계 끝자리가 1이면 세액 1원 내림(기존 실무 보정).
 */
export const calculateTaxAmount = (supplyAmount: number, note: string) => {
  if (isTaxFreeNote(note)) {
    return 0
  }
  const totalAmount = Math.round(supplyAmount * 1.1)
  let taxAmount = totalAmount - supplyAmount
  const total = supplyAmount + taxAmount
  if (total % 10 === 1) {
    taxAmount = Math.max(0, taxAmount - 1)
  }
  return taxAmount
}

export const computeStatementLineAmounts = (
  quantity: number,
  unitPrice: number,
  note: string,
) => {
  const supplyAmount = Math.round(quantity * unitPrice)
  const taxAmount = calculateTaxAmount(supplyAmount, note)
  return {
    quantity,
    unitPrice,
    supplyAmount,
    taxAmount,
    totalAmount: supplyAmount + taxAmount,
  }
}
