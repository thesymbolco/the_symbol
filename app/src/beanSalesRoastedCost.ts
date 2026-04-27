/**
 * 생두 주문가(원/kg)를 기준으로 로스팅 원두 원가를 맞춤.
 * - 1kg: 스프레드시트 `=B/1000*1250` (B = 생두 1kg 가격(원)과 동일한 스케일의 kg당 단가)
 * - 200g: 1kg 원가의 1/5 (`=C/5`, C = 1kg 원가)
 */
export function roastedBeanCost1KgFromGreenWonPerKg(greenWonPerKg: number): number {
  return (greenWonPerKg / 1000) * 1250
}

export function roastedBeanCost200gFrom1KgCost(roasted1kgCost: number): number {
  return roasted1kgCost / 5
}
