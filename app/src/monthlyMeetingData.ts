export type MeetingValueRowRole = 'salesRoastingTotal' | 'salesTotal' | 'salesNet' | 'costsGrand'

/**
 * `label`은 자유(표에 보이는 이름). 집계·지출 자동칸은 `role` / `expenseKey`로 구분.
 */
export type MeetingValueRow = {
  label: string
  amount: number | null
  share?: number | null
  role?: MeetingValueRowRole
  /** 지출표 → 비용행 자동 값: 없으면 `label` 문자열로 매칭(구 데이터 호환) */
  expenseKey?: string | null
}

export type MeetingRoastRowRole = 'client' | 'subtotal' | 'beanCost' | 'net'

export type MeetingMonthlyRow = {
  label: string
  november: number | null
  december: number | null
  january: number | null
  share?: number | null
  /** 거래처 `client` / 집계·고정(합계·생두·순이익) */
  roastRole?: MeetingRoastRowRole
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
  roastingSales: MeetingMonthlyRow[]
  storeSales: MeetingStoreSalesRow[]
  productionColumns: string[]
  productionRows: MeetingProductionRow[]
  inventoryColumns: string[]
  inventoryRows: MeetingProductionRow[]
}

const months = Array.from({ length: 12 }, (_, index) => `${index + 1}월`)
const currentMonthLabel = `${new Date().getMonth() + 1}월`

/** 열 1칸(이름·열 추가로 늘림) — 품목·열 전부 사용자가 편집 */
const singleEmptyColumn: string[] = ['']

const emptyProductionRowFor = (label: string, colCount: number) => ({
  label,
  values: Array.from({ length: Math.max(1, colCount) }, () => null as number | null),
})

export const monthlyMeetingData: MonthlyMeetingData = {
  title: '월 마감 보고회의',
  storeName: '',
  monthLabel: currentMonthLabel,
  months,
  currentMonthSales: [
    { label: '로스팅실 매출 총 합계', amount: null, share: null, role: 'salesRoastingTotal' },
    { label: '총매출', amount: null, share: null, role: 'salesTotal' },
    { label: '순이익(매출−비용)', amount: null, share: null, role: 'salesNet' },
  ],
  currentMonthCosts: [
    { label: '비용 합계', amount: null, share: null, role: 'costsGrand' },
    {
      label: '재료비(매출·생두)',
      amount: null,
      share: null,
      expenseKey: '①매출별생두재료',
    },
    { label: '기타경비', amount: null, share: null, expenseKey: '②기타경비' },
    { label: '운영경비', amount: null, share: null, expenseKey: '②운영경비' },
    { label: '그 외 비용', amount: null, share: null, expenseKey: '②기타' },
  ],
  roastingSales: [
    { label: '합계', november: null, december: null, january: null, share: null, roastRole: 'subtotal' },
    { label: '생두비용', november: null, december: null, january: null, share: null, roastRole: 'beanCost' },
    { label: '순이익', november: null, december: null, january: null, share: null, roastRole: 'net' },
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
  productionColumns: singleEmptyColumn,
  productionRows: months.map((month) => emptyProductionRowFor(month, singleEmptyColumn.length)),
  inventoryColumns: singleEmptyColumn,
  inventoryRows: months.map((month) => emptyProductionRowFor(month, singleEmptyColumn.length)),
}
