/**
 * 생두 주문「구분」에 적는 이름(한글 풀네임·짧은 영문 등)이 입출고 `beanRows.name`과
 * 다를 때 재고 열이 붙도록 하는 별칭입니다. 왼쪽은 주문에 쓰는 문자열, 오른쪽은 입출고에 저장된 생두명.
 *
 * 정확히 같은 이름이 이미 입출고에 있으면 그 값이 우선이고, 별칭은 그때 덮어쓰지 않습니다.
 * 새 품목은 이 배열에 한 줄 추가하면 됩니다.
 */
export const GREEN_BEAN_ORDER_INVENTORY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // --- 주문 한글 풀네임(알마·GSC 견적 등) ↔ 로스팅/입출고 짧은 영문명 ---
  ['에티오피아 코케 허니 예가체프 G1', 'Koke honey'],
  ['에티오피아 예가체프 G2', 'Yirgacheffe'],
  ['에티오피아 모모라 워시드 구지 G1', 'Mormora'],
  // 아래 세 줄은 입출고 생두명을 각각 Kenya / Colombia Narino / Brazil 로 쓸 때 재고가 붙습니다.
  ['케냐 아이히더 AA PLUS', 'Kenya'],
  ['인도네시아 아체가요 G1 TP', 'Ache Gayo Mountain'],
  ['인도네시아 만델링 G1 TP', 'Mandling'],
  ['과테말라 안티구아 SHB', 'Antigua SHB'],
  ['과테말라 안티구아 디카페인', 'Decaf Antigua SHB'],
  ['콜롬비아 나리노 수프리모', 'Colombia Narino'],
  ['브라질 세라도 NY2 FC', 'Brazil'],
  ['브라질 세라도 NY2FC', 'Brazil'],
  ['에티오피아 시다모 G4', 'Sidamo G4'],
  ['브라질 산토스 슈가케인 디카페인', 'Decaf Brazil 슈가케인'],
  ['블라질 산토스 슈가케인 디카페인', 'Decaf Brazil 슈가케인'],

]
