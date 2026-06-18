/** 앱 셸과 개별 페이지(백업 복원 등)가 함께 쓰는 활성 페이지 식별자. */
export const ACTIVE_PAGE_STORAGE_KEY = 'active-page-v1'

export type AppActivePage =
  | 'statements'
  | 'beanSalesAnalysis'
  | 'meeting'
  | 'inventory'
  | 'expense'
  | 'staffPayroll'
  | 'greenBeanOrder'
  | 'beanMarginCalc'
  | 'memo'
  | 'dailyMeeting'
  | 'weeklyReminders'
  | 'team'

const APP_ACTIVE_PAGES: readonly AppActivePage[] = [
  'statements',
  'beanSalesAnalysis',
  'meeting',
  'inventory',
  'expense',
  'staffPayroll',
  'greenBeanOrder',
  'beanMarginCalc',
  'memo',
  'dailyMeeting',
  'weeklyReminders',
  'team',
]

export const parseAppActivePage = (value: unknown): AppActivePage | undefined =>
  APP_ACTIVE_PAGES.includes(value as AppActivePage) ? (value as AppActivePage) : undefined

/** 배포 클라우드에서는 숨김 — dev 서버·로컬 모드에서만 노출 (클라우드 egress 절감). */
export function isBeanSalesAnalysisPageAvailable(mode: 'local' | 'cloud'): boolean {
  return import.meta.env.DEV || mode === 'local'
}

export function coerceAppActivePage(
  value: unknown,
  mode: 'local' | 'cloud',
): AppActivePage | undefined {
  const page = parseAppActivePage(value)
  if (!page) {
    return undefined
  }
  if (page === 'beanSalesAnalysis' && !isBeanSalesAnalysisPageAvailable(mode)) {
    return undefined
  }
  return page
}
