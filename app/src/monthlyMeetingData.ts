export type MeetingValueRow = {
  label: string
  amount: number | null
  share?: number | null
}

export type MeetingMonthlyRow = {
  label: string
  november: number | null
  december: number | null
  january: number | null
  share?: number | null
}

export type MeetingStoreSalesRow = {
  month: string
  hall: number | null
  hallShare: number | null
  delivery: number | null
  deliveryShare: number | null
  quick: number | null
  quickShare: number | null
  total: number | null
}

export type MeetingProductionRow = {
  label: string
  values: Array<number | null>
}

export type MonthlyMeetingData = {
  title: string
  storeName: string
  monthLabel: string
  months: string[]
  currentMonthSales: MeetingValueRow[]
  currentMonthCosts: MeetingValueRow[]
  materialCostDetails: MeetingValueRow[]
  otherCostDetails: MeetingValueRow[]
  roastingSales: MeetingMonthlyRow[]
  storeSales: MeetingStoreSalesRow[]
  productionColumns: string[]
  productionRows: MeetingProductionRow[]
  inventoryColumns: string[]
  inventoryRows: MeetingProductionRow[]
}

const months = Array.from({ length: 12 }, (_, index) => `${index + 1}월`)
const currentMonthLabel = `${new Date().getMonth() + 1}월`

export const monthlyMeetingData: MonthlyMeetingData = {
  title: '월 마감 보고회의',
  storeName: '',
  monthLabel: currentMonthLabel,
  months,
  currentMonthSales: [
    { label: '①현금', amount: null, share: null },
    { label: '②현금영수증', amount: null, share: null },
    { label: '③계좌이체', amount: null, share: null },
    { label: '④카드', amount: null, share: null },
    { label: '⑤배달의 민족', amount: null, share: null },
    { label: '⑥쿠팡', amount: null, share: null },
    { label: '⑦땡겨요', amount: null, share: null },
    { label: '⑧총매출', amount: null, share: null },
    { label: '⑨순이익', amount: null, share: null },
  ],
  currentMonthCosts: [
    { label: '①재료비', amount: null, share: null },
    { label: '②기타', amount: null, share: null },
    { label: '③임대료', amount: null, share: null },
    { label: '④관리비', amount: null, share: null },
    { label: '⑥전기세', amount: null, share: null },
    { label: '⑦세금과공과', amount: null, share: null },
    { label: '⑧인건비', amount: null, share: null },
    { label: '⑨로스팅실원두', amount: null, share: null },
    { label: '⑨비용계', amount: null, share: null },
  ],
  materialCostDetails: [
    { label: '①경성물류', amount: null, share: null },
    { label: '②매장음료,재료', amount: null, share: null },
    { label: '③디저트재료', amount: null, share: null },
    { label: '비용계', amount: null, share: null },
  ],
  otherCostDetails: [
    { label: '①생각대로 배달료', amount: null },
    { label: '②택배비', amount: null },
    { label: '③프린터 잉크', amount: null },
    { label: '④그랜드타이어 머신기', amount: null },
    { label: '비용계', amount: null },
  ],
  roastingSales: [
    { label: '라미랑드', november: null, december: null, january: null, share: null },
    { label: '길 브런치(전체)', november: null, december: null, january: null, share: null },
    { label: '메리본', november: null, december: null, january: null, share: null },
    { label: '팜에이트', november: null, december: null, january: null, share: null },
    { label: '카푸치노', november: null, december: null, january: null, share: null },
    { label: '브릿지로지스틱스', november: null, december: null, january: null, share: null },
    { label: '그랜드타이어 전체', november: null, december: null, january: null, share: null },
    { label: '합 계', november: null, december: null, january: null, share: null },
    { label: '생두비용', november: null, december: null, january: null, share: null },
    { label: '순이익', november: null, december: null, january: null, share: null },
  ],
  storeSales: months.map((month) => ({
    month,
    hall: null,
    hallShare: null,
    delivery: null,
    deliveryShare: null,
    quick: null,
    quickShare: null,
    total: null,
  })),
  productionColumns: [
    '출고 합계(KG)',
    '더치(L)',
    '조각케이크',
    '휘낭시에',
    '스콘',
    '에그타르트',
    '까눌레',
    '마카롱',
    '브라우니',
    '주문케이크',
  ],
  productionRows: months.map((month) => ({
    label: month,
    values: Array.from({ length: 10 }, () => null),
  })),
  inventoryColumns: ['생두', '원두', '더치', '디저트', '디저트재료', '더치용 싱글 재고'],
  inventoryRows: months.map((month) => ({
    label: month,
    values: Array.from({ length: 6 }, () => null),
  })),
}
