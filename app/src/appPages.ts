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
