import { useCallback, useEffect, useMemo, useState } from 'react'
import BeanSalesAnalysisPage from './BeanSalesAnalysisPage'
import BeanMarginCalcPage from './BeanMarginCalcPage'
import ExpensePage from './ExpensePage'
import MemoPage from './MemoPage'
import TeamManagementPage from './TeamManagementPage'
import WeeklyReminderPage from './WeeklyReminderPage'
import GreenBeanOrderPage from './GreenBeanOrderPage'
import StaffPayrollPage from './StaffPayrollPage.tsx'
import InventoryStatusPage, {
  getLowGreenBeanWarningItems,
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_STATUS_STORAGE_KEY,
  inventoryPageScopedKey,
  type LowGreenBeanWarningItem,
} from './InventoryStatusPage'
import { parseInventoryStatusStateFromLocalStorageJson } from './inventoryStatusUtils'
import MonthlyMeetingPage, {
  STATEMENT_RECORDS_SAVED_EVENT,
  STATEMENT_RECORDS_STORAGE_KEY,
} from './MonthlyMeetingPage'
import StatementsPage, { type StatementsHeroSummary } from './StatementsPage'
import {
  ACTIVE_PAGE_STORAGE_KEY,
  coerceAppActivePage,
  isBeanSalesAnalysisPageAvailable,
  type AppActivePage,
} from './appPages'
import { runtimeMode } from './lib/supabase'
import PageSaveStatus from './components/PageSaveStatus'
import { useAppRuntime } from './providers/AppRuntimeProvider.tsx'
import { useWeeklyReminderScheduler } from './hooks/useWeeklyReminderScheduler'
import {
  WEEKLY_REMINDER_FIRED_EVENT,
  type WeeklyReminderFiredDetail,
} from './lib/weeklyReminders'
import './App.css'


type PageCategoryId = 'trade' | 'closing' | 'supply' | 'org'

const PAGE_CATEGORY_GROUPS: {
  id: PageCategoryId
  label: string
  pages: { page: AppActivePage; label: string }[]
}[] = [
  {
    id: 'trade',
    label: '입력·분석',
    pages: [
      { page: 'statements', label: '거래명세 관리' },
      { page: 'beanSalesAnalysis', label: '원두별 매출 분석' },
    ],
  },
  {
    id: 'supply',
    label: '재고·생산',
    pages: [
      { page: 'inventory', label: '입출고 현황' },
      { page: 'greenBeanOrder', label: '생두 주문' },
      { page: 'beanMarginCalc', label: '원두별 마진 계산' },
    ],
  },
  {
    id: 'closing',
    label: '회의·마감',
    pages: [
      { page: 'dailyMeeting', label: '일일회의' },
      { page: 'weeklyReminders', label: '주간 알림' },
      { page: 'meeting', label: '월 마감회의' },
      { page: 'expense', label: '지출표' },
    ],
  },
  {
    id: 'org',
    label: '조직·인사',
    pages: [
      { page: 'staffPayroll', label: '직원·급여' },
      { page: 'team', label: '팀 관리' },
    ],
  },
]

const PAGE_HEADER_META: Record<AppActivePage, { title: string; description: string }> = {
  statements: {
    title: '거래명세 관리',
    description: '거래명세 입력, 단가 관리, 월별 납품현황을 한 화면에서 이어서 관리합니다.',
  },
  beanSalesAnalysis: {
    title: '원두별 매출 분석',
    description: '거래명세서 데이터를 기반으로 원두별 매출과 수익성을 분석합니다.',
  },
  meeting: {
    title: '월 마감회의',
    description: '월 요약, 비용 현황, 생산과 판매 지표를 한 번에 정리하는 회의 화면입니다.',
  },
  inventory: {
    title: '입출고 현황',
    description: '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다.',
  },
  expense: {
    title: '지출표',
    description: '월별 지출 내역과 결제 상태, 비용 합계를 빠르게 정리합니다.',
  },
  staffPayroll: {
    title: '직원·급여',
    description: '직원 정보와 월 지급액, 수정 잠금 상태를 함께 관리합니다.',
  },
  greenBeanOrder: {
    title: '생두 주문',
    description: '',
  },
  beanMarginCalc: {
    title: '원두별 마진 계산',
    description: '생두가·운영경비·블렌딩 비율로 원두원가, 판매가, 마진율을 엑셀과 동일한 수식으로 계산합니다.',
  },
  memo: {
    title: '메모',
    description: '업무 메모와 링크 메모를 한곳에서 관리합니다.',
  },
  dailyMeeting: {
    title: '일일회의',
    description: '당일 메모와 회의 정리를 빠르게 남기고 이어서 확인합니다.',
  },
  weeklyReminders: {
    title: '주간 알림',
    description: '요일·시간별로 반복되는 업무 알림을 등록하고 브라우저 알림으로 받습니다.',
  },
  team: {
    title: '팀 관리',
    description: '회사 구성원 계정을 만들고 역할과 연락처를 관리합니다.',
  },
}

/** `#root … > header`(app-home-shell) 안 전체 너비 히어로 — 각 화면 본문의 hero-panel과 중복되지 않게 여기만 사용 */
const WORKSPACE_SHELL_PAGE_HERO: Record<
  AppActivePage,
  { headline: string; copyLocal: string; copyCloud: string }
> = {
  statements: {
    headline: '거래명세서 입력 및 월별 납품현황 관리',
    copyLocal:
      '거래명세서를 먼저 입력하고, 같은 데이터를 기반으로 월별 납품현황을 자동 집계할 수 있게 만든 화면입니다. 저장 데이터는 현재 브라우저에만 보관됩니다.',
    copyCloud:
      '거래명세, 단가표, 템플릿 설정이 같은 회사 문서로 함께 동기화됩니다. 입력 내용은 다른 기기에서도 이어서 확인할 수 있습니다.',
  },
  beanSalesAnalysis: {
    headline: '원두별 매출 및 수익성 분석',
    copyLocal:
      '거래명세서와 생두 주문 데이터를 연동해 원두별 매출, 원가, 수익을 분석합니다. 데이터는 현재 브라우저에 저장됩니다.',
    copyCloud:
      '거래명세서와 생두 주문 데이터를 연동해 원두별 매출, 원가, 수익을 분석합니다. 회사 문서로 동기화되어 팀원과 공유할 수 있습니다.',
  },
  expense: {
    headline: '지출표 관리',
    copyLocal:
      '건별 입력·엑셀 반영이 가능하고, 데이터는 이 브라우저에만 저장됩니다. 아래 표·요약은 같은 조건으로 맞춰집니다.',
    copyCloud:
      '건별 입력·엑셀 반영이 가능합니다. 회사 문서로 동기화되면 팀·다른 기기에서도 같은 지출표를 이어서 볼 수 있습니다.',
  },
  inventory: {
    headline: '생두 / 로스팅 현황',
    copyLocal:
      '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다. 저장 데이터는 이 브라우저에만 보관될 수 있습니다.',
    copyCloud:
      '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다. 회사 문서로 동기화되면 팀과 같은 재고 표를 공유합니다.',
  },
  meeting: {
    headline: '월 마감회의',
    copyLocal:
      '월별 회의 내용을 입력하면 합계와 점유비가 자동 계산되도록 정리했습니다. 상단 두 번째 숫자는 입금 합계에서 출금 합계를 뺀 입출금 순손익으로, 1번 요약 맨 아래 표와 같습니다.',
    copyCloud:
      '월별 회의 내용을 입력하면 합계와 점유비가 자동 계산되도록 정리했습니다. 회의 문서가 클라우드에 있으면 팀과 함께 수정·확인할 수 있습니다.',
  },
  staffPayroll: {
    headline: '직원·급여·근무',
    copyLocal:
      '매장명·직책·부서·월 급여·지급일·재직 여부를 한곳에 적어 두는 용도입니다. 3.3%·4대보험은 단순 추정이며, 실제 세액·보험과 다를 수 있습니다. 데이터는 이 브라우저에만 저장될 수 있습니다.',
    copyCloud:
      '매장명·직책·부서·월 급여·지급일·재직 여부를 한곳에 적어 두는 용도입니다. 3.3%·4대보험은 단순 추정이며, 실제 세액·보험과 다를 수 있습니다. 회사 문서로 동기화되면 팀과 공유할 수 있습니다.',
  },
  greenBeanOrder: {
    headline: '생두 주문',
    copyLocal: '',
    copyCloud: '',
  },
  beanMarginCalc: {
    headline: '원두별 마진 계산',
    copyLocal:
      '엑셀「원두별_마진_계산」과 같은 운영경비·블렌딩·마진 수식을 웹에서 계산합니다. 입력값은 이 브라우저에 저장됩니다.',
    copyCloud:
      '엑셀「원두별_마진_계산」과 같은 운영경비·블렌딩·마진 수식을 웹에서 계산합니다. 입력값은 이 브라우저에 저장됩니다.',
  },
  memo: {
    headline: '메모',
    copyLocal: `${PAGE_HEADER_META.memo.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.memo.description} 회사 문서로 동기화되면 팀과 공유할 수 있습니다.`,
  },
  dailyMeeting: {
    headline: '일일회의',
    copyLocal: `${PAGE_HEADER_META.dailyMeeting.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.dailyMeeting.description} 회사 문서로 동기화되면 팀과 공유할 수 있습니다.`,
  },
  weeklyReminders: {
    headline: '요일별 주간 알림',
    copyLocal:
      '매주 같은 요일·시간에 할 일 알림을 띄웁니다. 설정은 이 브라우저에 저장되며, 앱이 열려 있을 때 예약 시간에 알림이 울립니다.',
    copyCloud:
      '매주 같은 요일·시간에 할 일 알림을 띄웁니다. 설정은 이 브라우저에 저장되며, 앱이 열려 있을 때 예약 시간에 알림이 울립니다.',
  },
  team: {
    headline: '팀 관리',
    copyLocal: `${PAGE_HEADER_META.team.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.team.description} 클라우드 회사에서 구성원을 함께 관리합니다.`,
  },
}

function categoryIdForPage(page: AppActivePage): PageCategoryId {
  for (const g of PAGE_CATEGORY_GROUPS) {
    if (g.pages.some((p) => p.page === page)) {
      return g.id
    }
  }
  return 'trade'
}

const readStatementRecordCountFromStorage = () => {
  try {
    const raw = window.localStorage.getItem(STATEMENT_RECORDS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function App() {
  const { mode, activeCompany, activeCompanyId, user, signOut, isReady } = useAppRuntime()
  const [activePage, setActivePage] = useState<AppActivePage>(() => {
    const savedPage = window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY)
    const resolved = coerceAppActivePage(savedPage, runtimeMode)
    if (resolved) {
      return resolved
    }
    if (savedPage === 'memo') {
      return 'dailyMeeting'
    }

    return 'statements'
  })
  const [isHomeRailOpen, setIsHomeRailOpen] = useState(false)

  const visiblePageCategoryGroups = useMemo(
    () =>
      PAGE_CATEGORY_GROUPS.map((group) => ({
        ...group,
        pages: group.pages.filter(
          (p) => p.page !== 'beanSalesAnalysis' || isBeanSalesAnalysisPageAvailable(mode),
        ),
      })).filter((group) => group.pages.length > 0),
    [mode],
  )

  const navigateToPage = useCallback(
    (page: AppActivePage) => {
      if (page === 'beanSalesAnalysis' && !isBeanSalesAnalysisPageAvailable(mode)) {
        setActivePage('statements')
        return
      }
      setActivePage(page)
    },
    [mode],
  )

  useEffect(() => {
    if (activePage === 'beanSalesAnalysis' && !isBeanSalesAnalysisPageAvailable(mode)) {
      setActivePage('statements')
    }
  }, [activePage, mode])

  const activeCategoryId = useMemo(() => categoryIdForPage(activePage), [activePage])
  const activeCategoryLabel = useMemo(
    () => PAGE_CATEGORY_GROUPS.find((g) => g.id === activeCategoryId)?.label ?? '업무',
    [activeCategoryId],
  )
  const activePageMeta = useMemo(() => PAGE_HEADER_META[activePage], [activePage])
  const activeCategoryGroup = useMemo(
    () => visiblePageCategoryGroups.find((g) => g.id === activeCategoryId) ?? visiblePageCategoryGroups[0],
    [activeCategoryId, visiblePageCategoryGroups],
  )
  const totalWorkspacePages = useMemo(
    () => visiblePageCategoryGroups.reduce((sum, group) => sum + group.pages.length, 0),
    [visiblePageCategoryGroups],
  )

  const [lowGreenBeanWarningItems, setLowGreenBeanWarningItems] = useState<LowGreenBeanWarningItem[]>([])

  const lowGreenBeanWarningDigest = useMemo(
    () =>
      lowGreenBeanWarningItems
        .map((i) => `${i.name}\0${i.kg.toFixed(4)}\0${i.threshold}`)
        .join('|'),
    [lowGreenBeanWarningItems],
  )
  const [isLowGreenBeanPanelDismissed, setIsLowGreenBeanPanelDismissed] = useState(false)
  const [firedWeeklyReminders, setFiredWeeklyReminders] = useState<WeeklyReminderFiredDetail[]>([])
  useWeeklyReminderScheduler(mode, activeCompanyId, mode === 'local' || isReady)

  useEffect(() => {
    const onFired = (event: Event) => {
      const detail = (event as CustomEvent<WeeklyReminderFiredDetail>).detail
      if (!detail?.reminder) {
        return
      }
      setFiredWeeklyReminders((current) => [...current, detail])
    }
    window.addEventListener(WEEKLY_REMINDER_FIRED_EVENT, onFired)
    return () => window.removeEventListener(WEEKLY_REMINDER_FIRED_EVENT, onFired)
  }, [])

  useEffect(() => {
    if (firedWeeklyReminders.length === 0) {
      return
    }
    const id = window.setTimeout(() => {
      setFiredWeeklyReminders([])
    }, 45_000)
    return () => window.clearTimeout(id)
  }, [firedWeeklyReminders.length])

  useEffect(() => {
    setIsLowGreenBeanPanelDismissed(false)
  }, [lowGreenBeanWarningDigest])

  const refreshLowGreenBeanWarnings = useCallback(() => {
    try {
      const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        setLowGreenBeanWarningItems([])
        return
      }
      const state = parseInventoryStatusStateFromLocalStorageJson(JSON.parse(raw) as unknown)
      if (!state) {
        setLowGreenBeanWarningItems([])
        return
      }
      setLowGreenBeanWarningItems(getLowGreenBeanWarningItems(state))
    } catch {
      setLowGreenBeanWarningItems([])
    }
  }, [mode, activeCompanyId])

  /** 거래명세 페이지가 셸 헤더(히어로)에 보여 달라고 보내는 요약 — 페이지가 떠 있을 때만 채워진다 */
  const [statementsHeroSummary, setStatementsHeroSummary] = useState<StatementsHeroSummary | null>(null)
  const [statementStickyHScrollVisible, setStatementStickyHScrollVisible] = useState(false)

  /** 모든 페이지 공통 `명세 N건` 표시용 — 저장 이벤트·localStorage 기준 */
  const [statementRecordCount, setStatementRecordCount] = useState(readStatementRecordCountFromStorage)
  useEffect(() => {
    const onRecordsChanged = () => setStatementRecordCount(readStatementRecordCountFromStorage())
    window.addEventListener(STATEMENT_RECORDS_SAVED_EVENT, onRecordsChanged)
    window.addEventListener('storage', onRecordsChanged)
    return () => {
      window.removeEventListener(STATEMENT_RECORDS_SAVED_EVENT, onRecordsChanged)
      window.removeEventListener('storage', onRecordsChanged)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, activePage)
  }, [activePage])

  useEffect(() => {
    if (!isHomeRailOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsHomeRailOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isHomeRailOpen])

  useEffect(() => {
    void refreshLowGreenBeanWarnings()
    const onCacheOrStorage = () => {
      void refreshLowGreenBeanWarnings()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshLowGreenBeanWarnings()
      }
    }
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, onCacheOrStorage)
    window.addEventListener('storage', onCacheOrStorage)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, onCacheOrStorage)
      window.removeEventListener('storage', onCacheOrStorage)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshLowGreenBeanWarnings])

  useEffect(() => {
    void refreshLowGreenBeanWarnings()
  }, [activePage, refreshLowGreenBeanWarnings])










  return (
    <div
      className={`app-shell${activePage === 'statements' && statementStickyHScrollVisible ? ' app-shell--sticky-hscroll-pad' : ''}`}
    >
      <header className="app-home-shell no-print" aria-label="워크스페이스 홈">
        <button
          type="button"
          className="app-home-rail-toggle"
          aria-label={isHomeRailOpen ? '메뉴 닫기' : '메뉴 열기'}
          aria-expanded={isHomeRailOpen}
          onClick={() => setIsHomeRailOpen((current) => !current)}
        >
          <span aria-hidden>☰</span>
        </button>
        {isHomeRailOpen ? (
          <button
            type="button"
            className="app-home-rail-backdrop"
            aria-label="메뉴 닫기"
            onClick={() => setIsHomeRailOpen(false)}
          />
        ) : null}
        <aside className={`app-home-rail${isHomeRailOpen ? ' open' : ''}`}>
          <div className="app-home-rail-brand">
            <span className="app-home-rail-eyebrow">The Symbol Edit</span>
            <strong>{mode === 'cloud' ? activeCompany?.companyName ?? 'Cloud workspace' : 'Local workspace'}</strong>
            <p>{mode === 'cloud' ? '팀이 함께 보는 업무 허브' : '이 브라우저에서 사용하는 개인 업무 허브'}</p>
          </div>

          <nav className="app-home-rail-nav" aria-label="상위 구역">
            {visiblePageCategoryGroups.map((group) => {
              const isActiveGroup = group.id === activeCategoryId
              return (
                <button
                  key={group.id}
                  type="button"
                  className={`app-home-rail-link${isActiveGroup ? ' active' : ''}`}
                  onClick={() => {
                    if (group.pages[0]) {
                      navigateToPage(group.pages[0].page)
                    }
                  }}
                >
                  <span>{group.label}</span>
                  <strong>{group.pages[0]?.label ?? group.label}</strong>
                </button>
              )
            })}
          </nav>

          <div className="app-home-rail-subnav" aria-label="현재 구역 화면">
            <span className="app-home-rail-subnav-label">현재 구역</span>
            {activeCategoryGroup.pages.map((p) => (
              <button
                key={p.page}
                type="button"
                className={`app-home-rail-subnav-link${activePage === p.page ? ' active' : ''}`}
                onClick={() => {
                  navigateToPage(p.page)
                  setIsHomeRailOpen(false)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {mode === 'cloud' && activeCompany ? (
            <div className="app-home-rail-session">
              <div className="page-nav-session-meta">
                <strong>{activeCompany.companyName}</strong>
                <span>{user?.email ?? ''}</span>
              </div>
              <div className="app-home-rail-session-footer">
                <button
                  type="button"
                  className="app-home-rail-signout-button"
                  onClick={() => void signOut()}
                >
                  로그아웃
                </button>
              </div>
            </div>
          ) : null}
        </aside>

        <section className="app-home-stage">
          <div className="app-home-stage-hero">
            <div className="app-home-stage-copy">
              <span className="app-home-stage-eyebrow">{activeCategoryLabel}</span>
              <h2>{activePageMeta.title}</h2>
              <p>{activePageMeta.description}</p>
            </div>
            <div className="app-home-stage-pills" aria-label="현재 작업 정보">
              <span className="workspace-showcase-pill">{mode === 'cloud' ? '클라우드 동기화' : '브라우저 저장'}</span>
              <span className="workspace-showcase-pill">{totalWorkspacePages}개 업무 화면</span>
              <span className="workspace-showcase-pill">{activeCategoryGroup.pages.length}개 현재 구역 화면</span>
            </div>
          </div>

          <div className="app-home-stage-grid">
            <header
              className="hero-panel statements-hero-compact statements-hero-embedded app-home-workspace-page-hero-span app-home-stage-merged no-print"
              aria-label="현재 화면 안내"
            >
              <div>
                <p className="eyebrow">
                  {mode === 'cloud' ? activeCompany?.companyName ?? '클라우드 워크스페이스' : '로컬 워크스페이스'}
                </p>
                <h1>{WORKSPACE_SHELL_PAGE_HERO[activePage].headline}</h1>
                <p className="hero-copy">
                  {mode === 'cloud'
                    ? WORKSPACE_SHELL_PAGE_HERO[activePage].copyCloud
                    : WORKSPACE_SHELL_PAGE_HERO[activePage].copyLocal}
                </p>
                <div className="hero-meta-row no-print">
                  <span className="page-hero-pill">{activeCategoryLabel}</span>
                  <span className="page-hero-pill">{activePageMeta.title}</span>
                  <span className="page-hero-pill">
                    {mode === 'cloud' ? '회사 공용 문서' : '개인 브라우저 문서'}
                  </span>
                  <span className="page-hero-pill">{activeCategoryGroup.pages.length}개 하위 메뉴</span>
                  <span className="page-hero-pill">명세 {statementRecordCount}건</span>
                  {activePage === 'statements' && statementsHeroSummary ? (
                    <PageSaveStatus
                      mode={mode}
                      saveState={statementsHeroSummary.saveState}
                      lastSavedAt={statementsHeroSummary.lastSavedAt}
                    />
                  ) : null}
                </div>
              </div>
              <div className="hero-metrics">
                {activePage === 'statements' && statementsHeroSummary ? (
                  <>
                    <div className="metric-card">
                      <span>저장 건수</span>
                      <strong>{statementsHeroSummary.recordCount}건</strong>
                    </div>
                    <div className="metric-card">
                      <span>전체 총액</span>
                      <strong>{statementsHeroSummary.grandTotalLabel}</strong>
                    </div>
                    <div className="metric-card">
                      <span>{statementsHeroSummary.selectedYear}년 집계 거래처</span>
                      <strong>{statementsHeroSummary.summaryClientCount}곳</strong>
                    </div>
                    <div className="metric-card">
                      <span>{statementsHeroSummary.scopeYmLabel} 납품 합계</span>
                      <strong>{statementsHeroSummary.scopeMonthTotalLabel}</strong>
                    </div>
                    <div className="metric-card">
                      <span>{statementsHeroSummary.scopeYmLabel} 집계 거래처</span>
                      <strong>{statementsHeroSummary.scopeMonthClientCount}곳</strong>
                    </div>
                    <div className="metric-card">
                      <span>{statementsHeroSummary.scopeYmLabel} 납품 건수</span>
                      <strong>{statementsHeroSummary.scopeMonthRecordCount}건</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="metric-card">
                      <span>업무 구역</span>
                      <strong>{activeCategoryLabel}</strong>
                    </div>
                    <div className="metric-card">
                      <span>이 화면</span>
                      <strong>{activePageMeta.title}</strong>
                    </div>
                    <div className="metric-card">
                      <span>저장·연동</span>
                      <strong>{mode === 'cloud' ? '클라우드' : '로컬'}</strong>
                    </div>
                  </>
                )}
              </div>
            </header>
          </div>

        </section>
      </header>

      {activePage === 'statements' ? (
        <StatementsPage
          onHeroSummaryChange={setStatementsHeroSummary}
          onStickyHScrollVisibleChange={setStatementStickyHScrollVisible}
          onRestoreActivePage={navigateToPage}
        />
      ) : activePage === 'beanSalesAnalysis' && isBeanSalesAnalysisPageAvailable(mode) ? (
        <BeanSalesAnalysisPage />
      ) : activePage === 'meeting' ? (
        <MonthlyMeetingPage />
      ) : activePage === 'expense' ? (
        <ExpensePage />
      ) : activePage === 'staffPayroll' ? (
        <StaffPayrollPage />
      ) : activePage === 'greenBeanOrder' ? (
        <GreenBeanOrderPage />
      ) : activePage === 'beanMarginCalc' ? (
        <BeanMarginCalcPage />
      ) : activePage === 'dailyMeeting' ? (
        <MemoPage mode="dailyOnly" />
      ) : activePage === 'weeklyReminders' ? (
        <WeeklyReminderPage />
      ) : activePage === 'team' ? (
        <TeamManagementPage />
      ) : (
        <InventoryStatusPage />
      )}

      {firedWeeklyReminders.length > 0 ? (
        <div
          className="app-weekly-reminder-floating no-print"
          role="status"
          aria-live="polite"
          aria-labelledby="app-weekly-reminder-floating-title"
        >
          <div className="app-weekly-reminder-floating-header">
            <span id="app-weekly-reminder-floating-title" className="app-weekly-reminder-floating-title">
              주간 알림
            </span>
            <button
              type="button"
              className="app-weekly-reminder-floating-close"
              onClick={() => setFiredWeeklyReminders([])}
              aria-label="알림 닫기"
            >
              ×
            </button>
          </div>
          <ul className="app-weekly-reminder-floating-list">
            {firedWeeklyReminders.map((item) => (
              <li key={`${item.reminder.id}-${item.firedAt}`}>
                <strong>{item.reminder.title}</strong>
                {item.reminder.message ? <span>{item.reminder.message}</span> : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ghost-button small-hit app-weekly-reminder-floating-link"
            onClick={() => setActivePage('weeklyReminders')}
          >
            알림 설정 보기
          </button>
        </div>
      ) : null}

      {lowGreenBeanWarningItems.length > 0 && !isLowGreenBeanPanelDismissed ? (
        <div
          className="app-low-green-bean-floating no-print"
          role="dialog"
          aria-modal="false"
          aria-labelledby="app-low-green-bean-floating-title"
          aria-live="polite"
        >
          <div className="app-low-green-bean-floating-header">
            <span id="app-low-green-bean-floating-title" className="app-low-green-bean-floating-title">
              생두 재고 경고
            </span>
            <button
              type="button"
              className="app-low-green-bean-floating-close"
              onClick={() => setIsLowGreenBeanPanelDismissed(true)}
              aria-label="경고 닫기"
            >
              ×
            </button>
          </div>
          <p className="app-low-green-bean-floating-hint">
            DARK / LIGHT / DECAFFEINE BLEND 제외. Brazil·Narino·Sidamo 계열 <strong>40kg</strong> 미만, 그 밖 <strong>5kg</strong>{' '}
            미만.
          </p>
          <ul className="app-low-green-bean-floating-list">
            {lowGreenBeanWarningItems.map((item) => (
              <li key={item.name}>
                <span className="app-low-green-bean-floating-name">{item.name}</span>
                <span className="app-low-green-bean-floating-value">
                  {item.kg.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}kg
                </span>
                <span className="app-low-green-bean-floating-thr">(기준 {item.threshold}kg)</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export default App
