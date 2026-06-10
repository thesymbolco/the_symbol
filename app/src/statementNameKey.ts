/**
 * 거래명세 전반(거래처/품목/규격)의 동일성 판정용 정규화 키.
 * - 입력 폼, POS, 월별 납품현황 집계, 발행/입금일 override 키가 모두 이 함수를 공유한다.
 * - trim + 소문자 + 모든 공백 제거: "길 인천점" / "길인천점" / "길  인천점"을 같은 거래처로 취급.
 */
export const statementNameKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '')

/**
 * 과거 버전은 override 키의 거래처 부분을 "공백 1칸 정리"만 한 문자열로 저장했다.
 * 저장된 키(`YYYY-MM::거래처명`)를 현재 키 체계로 재계산해 병합한다.
 */
export const migrateStatementMonthlyOverrideKeys = <T extends { issueDate: string; paymentDate: string }>(
  overrides: Record<string, T>,
): Record<string, T> => {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const separatorIndex = key.indexOf('::')
    const migratedKey =
      separatorIndex >= 0
        ? `${key.slice(0, separatorIndex)}::${statementNameKey(key.slice(separatorIndex + 2))}`
        : key
    const existing = next[migratedKey]
    if (!existing) {
      next[migratedKey] = value
      continue
    }
    // 같은 거래처의 표기 변형이 충돌하면 비어 있지 않은 값을 우선해 병합
    next[migratedKey] = {
      ...existing,
      issueDate: existing.issueDate || value.issueDate,
      paymentDate: existing.paymentDate || value.paymentDate,
    }
  }
  return next
}
