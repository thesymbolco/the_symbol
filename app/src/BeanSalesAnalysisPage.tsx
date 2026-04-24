import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import {
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_STATUS_STORAGE_KEY,
  inventoryPageScopedKey,
} from './InventoryStatusPage'
import { BLEND_WON_OVERRIDES_SAVED_EVENT } from './beanBlendWonOverrides'
import { getLatestGreenOrderWonPerKgByInventoryLabel } from './beanSalesGreenOrderUnitPrice'
import { GREEN_BEAN_ORDER_SAVED_EVENT, GREEN_BEAN_ORDER_STORAGE_KEY } from './GreenBeanOrderPage'
import {
  BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT,
  hasAnyStatementManualForItem,
  type StatementInventoryManualEntry,
  writeStatementInventoryManuals,
  syncStatementInventoryManualsFromCloud,
} from './beanStatementManualMappings'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel } from './beanSalesStatementMapping'
import { normalizeInventoryStatusState } from './inventoryStatusUtils'
import { exportStyledBeanSalesAnalysisExcel } from './beanSalesAnalysisExcelExport'
import { STATEMENT_RECORDS_SAVED_EVENT } from './MonthlyMeetingPage'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument } from './lib/companyDocuments'
import { useAppRuntime } from './providers/AppRuntimeProvider'
import StatementInventoryLinkModal from './StatementInventoryLinkModal'

type StatementRecord = {
  id: string
  deliveryDate: string
  itemName: string
  quantity: number
  unitPrice: number
  supplyAmount: number
  taxAmount: number
  totalAmount: number
  clientName: string
}

type StatementPageDocumentLike = {
  records?: StatementRecord[]
}

type InventoryPageDocumentLike = {
  inventoryState?: unknown
}

/** 입고 `N. 품목명` 집합에 못 올라간(매칭 시도 끝) 거래 — 매출 요약에서 제외됐지만 수치는 여기에 표시 */
type NotInInventorySummary = {
  itemName: string
  /** mapStatementItemToInventoryLabel이 만든 라벨(원문/임시) */
  mappedLabel: string
  totalRevenue: number
  totalQuantity: number
  transactionCount: number
}

type BeanSalesData = {
  /** 입출고 「N. 품목명」과 맞춘 표시명 */
  beanName: string
  /** 입출고 생두 `no` 기준 정렬(미매칭은 큰 값) */
  sortKey: number
  totalQuantity: number
  totalRevenue: number
  avgUnitPrice: number
  clientCount: number
  transactionCount: number
  clients: Array<{
    name: string
    quantity: number
    revenue: number
  }>
  /** 생두 주문 일자 기록·품목을 입출고 라벨에 맞춰 묶은 뒤, 가장 최근 스냅샷의 원/kg(없으면 null) */
  latestGreenWonPerKg: number | null
  latestGreenOrderDate: string | null
  /** 거래명세 평균단가(원) − 최근 주문가(원/kg) — 1/KG·비교 가능할 때만 참고 */
  spreadVsGreenOrder: number | null
  /** 최근 주문 원가(원/kg) × 판매수량 */
  estimatedCostAmount: number | null
  /** 매출액 − 추정 원가액 */
  estimatedProfitAmount: number | null
}

const STATEMENT_RECORDS_KEY = 'statement-records-v1'

/** 파이/막대/범례 공통: 매출 0 제외 뒤 상위 N (동일 값 유지) */
const BEAN_SALES_CHART_TOP = 10

const BEAN_SALES_CHART_COLORS = [
  '#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1',
  '#d084d0', '#ffb366', '#95d5b2', '#ffd93d', '#c9c9c9',
] as const

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('ko-KR').format(Math.round(value))
}

const formatNumber = (value: number): string => {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value)
}

const shortenBeanName = (name: string, max = 14): string => {
  if (name.length <= max) return name
  return `${name.slice(0, max)}…`
}

const BEAN_SALES_PLOT_H = 300

/**
 * Recharts 3 `ResponsiveContainer`는 부모 가로/세로가 0이면 children을 그리지 않습니다.
 * 배포 환경(그리드·지연 레이아웃)에서 첫 측정이 0이면 파이가 영구히 비어 보일 수 있어,
 * 최소 가로(fallback)로 고정 `PieChart`/`BarChart`에 넘깁니다.
 */
function useBeanSalesPlotWidth(fallbackW = 360) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallbackW)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const read = () => {
      const w = Math.floor(el.getBoundingClientRect().width)
      setWidth((prev) => (w > 0 ? w : Math.max(fallbackW, prev)))
    }
    read()
    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        read()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => {
        window.removeEventListener('resize', read)
        document.removeEventListener('visibilitychange', onVis)
      }
    }
    const ro = new ResizeObserver(() => read())
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [fallbackW])

  return { ref, width, plotHeight: BEAN_SALES_PLOT_H } as const
}

function BeanSalesAnalysisPage() {
  const { mode, activeCompanyId } = useAppRuntime()
  const [inventoryReadTick, setInventoryReadTick] = useState(0)
  const [greenOrderReadTick, setGreenOrderReadTick] = useState(0)
  const [manualMappingTick, setManualMappingTick] = useState(0)
  const mapOptions = useMemo(
    () => ({ mode, companyId: activeCompanyId } as const),
    [mode, activeCompanyId],
  )
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear())
  const [viewMode, setViewMode] = useState<'revenue' | 'detailed'>('revenue')
  const [sortBy, setSortBy] = useState<'inventory' | 'revenue' | 'quantity'>('inventory')
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkModalPreferredToLabel, setLinkModalPreferredToLabel] = useState<string | null>(null)
  const [statementRecordsTick, setStatementRecordsTick] = useState(0)
  const [greenOrderCloudSyncTick, setGreenOrderCloudSyncTick] = useState(0)
  const [statementRecordsRaw, setStatementRecordsRaw] = useState<StatementRecord[]>([])
  const [inventoryStateRaw, setInventoryStateRaw] = useState<unknown>(null)

  const revenuePiePlot = useBeanSalesPlotWidth(360)
  const revenueBarPlot = useBeanSalesPlotWidth(360)
  const profitPiePlot = useBeanSalesPlotWidth(360)
  const profitBarPlot = useBeanSalesPlotWidth(360)

  useEffect(() => {
    const onInv = () => setInventoryReadTick((n) => n + 1)
    const onGbo = () => setGreenOrderReadTick((n) => n + 1)
    const onManual = () => setManualMappingTick((n) => n + 1)
    const onBlendOvr = () => setGreenOrderReadTick((n) => n + 1)
    const onStatement = () => setStatementRecordsTick((n) => n + 1)
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, onInv)
    window.addEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, onGbo)
    window.addEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, onManual)
    window.addEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, onBlendOvr)
    window.addEventListener(STATEMENT_RECORDS_SAVED_EVENT, onStatement)
    return () => {
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, onInv)
      window.removeEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, onGbo)
      window.removeEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, onManual)
      window.removeEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, onBlendOvr)
      window.removeEventListener(STATEMENT_RECORDS_SAVED_EVENT, onStatement)
    }
  }, [])

  useEffect(() => {
    void syncStatementInventoryManualsFromCloud(mode, activeCompanyId)
  }, [mode, activeCompanyId, manualMappingTick])

  /**
   * 클라우드 모드: 다른 환경에서 문서를 수정해도 이 화면이 자동 반영되도록
   * 필요한 문서를 폴링해서 로컬 캐시(및 이벤트)까지 갱신합니다.
   */
  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }

    let cancelled = false
    let inFlight = false

    let lastManualMappings = ''
    let lastStatementRecords = ''
    let lastInventoryDoc = ''
    let lastGreenOrderDoc = ''

    const CLOUD_SYNC_INTERVAL_MS = 10_000

    const poll = async () => {
      if (cancelled || inFlight) {
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      inFlight = true
      try {
        const [manualDoc, statementDoc, inventoryDoc, greenOrderDoc] = await Promise.all([
          loadCompanyDocument<StatementInventoryManualEntry[]>(
            activeCompanyId,
            COMPANY_DOCUMENT_KEYS.statementInventoryMappings,
          ),
          loadCompanyDocument<StatementPageDocumentLike>(activeCompanyId, COMPANY_DOCUMENT_KEYS.statementPage),
          loadCompanyDocument<InventoryPageDocumentLike>(activeCompanyId, COMPANY_DOCUMENT_KEYS.inventoryPage),
          loadCompanyDocument<unknown>(activeCompanyId, COMPANY_DOCUMENT_KEYS.greenBeanOrderPage),
        ])
        if (cancelled) {
          return
        }

        // 1) 수동 매핑
        if (Array.isArray(manualDoc)) {
          const sorted = [...manualDoc].sort((a, b) => a.from.localeCompare(b.from, 'ko'))
          const nextJson = JSON.stringify(sorted)
          if (nextJson !== lastManualMappings) {
            lastManualMappings = nextJson
            writeStatementInventoryManuals('cloud', activeCompanyId, sorted)
          }
        }

        // 2) 거래명세
        if (statementDoc && Array.isArray(statementDoc.records)) {
          const nextJson = JSON.stringify(statementDoc.records)
          if (nextJson !== lastStatementRecords) {
            lastStatementRecords = nextJson
            window.localStorage.setItem(STATEMENT_RECORDS_KEY, JSON.stringify(statementDoc.records))
            window.dispatchEvent(new Event(STATEMENT_RECORDS_SAVED_EVENT))
            setStatementRecordsRaw(statementDoc.records)
          }
        }

        // 3) 입출고
        if (inventoryDoc) {
          const candidate = (inventoryDoc as any)?.inventoryState ?? inventoryDoc
          const normalized = normalizeInventoryStatusState(candidate)
          if (normalized) {
            const nextJson = JSON.stringify(normalized)
            if (nextJson !== lastInventoryDoc) {
              lastInventoryDoc = nextJson
              const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, 'cloud', activeCompanyId)
              window.localStorage.setItem(key, JSON.stringify(normalized))
              window.dispatchEvent(new Event(INVENTORY_STATUS_CACHE_EVENT))
              setInventoryStateRaw(normalized)
            }
          }
        }

        // 4) 생두 주문(최근 주문가 계산용)
        if (greenOrderDoc) {
          const nextJson = JSON.stringify(greenOrderDoc)
          if (nextJson !== lastGreenOrderDoc) {
            lastGreenOrderDoc = nextJson
            window.localStorage.setItem(GREEN_BEAN_ORDER_STORAGE_KEY, JSON.stringify(greenOrderDoc))
            setGreenOrderCloudSyncTick((n) => n + 1)
          }
        }
      } catch {
        // ignore: 폴링 중 실패는 다음 주기에 재시도
      } finally {
        inFlight = false
      }
    }

    // 초기 1회 즉시 + 이후 폴링(배포 환경 부하·네트워트 완화: 간격 늘림, 탭 비활성 시 생략)
    void poll()
    const id = window.setInterval(() => void poll(), CLOUD_SYNC_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [mode, activeCompanyId])

  useEffect(() => {
    let cancelled = false
    const loadStatementRecords = async () => {
      if (mode === 'cloud' && activeCompanyId) {
        try {
          const remote = await loadCompanyDocument<StatementPageDocumentLike>(
            activeCompanyId,
            COMPANY_DOCUMENT_KEYS.statementPage,
          )
          if (cancelled) {
            return
          }
          if (Array.isArray(remote?.records)) {
            setStatementRecordsRaw(remote.records)
            return
          }
        } catch (error) {
          console.error('원두별 매출 분석: 거래명세 클라우드 문서를 읽지 못했습니다.', error)
        }
      }
      try {
        const saved = window.localStorage.getItem(STATEMENT_RECORDS_KEY)
        if (!saved) {
          setStatementRecordsRaw([])
          return
        }
        const parsed = JSON.parse(saved) as StatementRecord[]
        setStatementRecordsRaw(Array.isArray(parsed) ? parsed : [])
      } catch {
        setStatementRecordsRaw([])
      }
    }
    void loadStatementRecords()
    return () => {
      cancelled = true
    }
  }, [mode, activeCompanyId, statementRecordsTick])

  useEffect(() => {
    let cancelled = false
    const readInventoryFromLocal = () => {
      const readState = (key: string) => {
        try {
          const raw = window.localStorage.getItem(key)
          if (!raw) {
            return null
          }
          const parsed = JSON.parse(raw)
          const normalized = normalizeInventoryStatusState(parsed)
          return normalized ?? null
        } catch {
          return null
        }
      }
      const primaryKey = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
      return readState(primaryKey) ?? (primaryKey !== INVENTORY_STATUS_STORAGE_KEY ? readState(INVENTORY_STATUS_STORAGE_KEY) : null)
    }
    const loadInventoryState = async () => {
      if (mode === 'cloud' && activeCompanyId) {
        try {
          const remote = await loadCompanyDocument<InventoryPageDocumentLike>(
            activeCompanyId,
            COMPANY_DOCUMENT_KEYS.inventoryPage,
          )
          if (cancelled) {
            return
          }
          const candidate = remote?.inventoryState ?? remote
          const normalized = normalizeInventoryStatusState(candidate)
          if (normalized) {
            setInventoryStateRaw(normalized)
            return
          }
        } catch (error) {
          console.error('원두별 매출 분석: 입출고 클라우드 문서를 읽지 못했습니다.', error)
        }
      }
      setInventoryStateRaw(readInventoryFromLocal())
    }
    void loadInventoryState()
    return () => {
      cancelled = true
    }
  }, [mode, activeCompanyId, inventoryReadTick])

  useEffect(() => {
    let cancelled = false
    const syncGreenOrderForAnalysis = async () => {
      if (mode !== 'cloud' || !activeCompanyId) {
        setGreenOrderCloudSyncTick((n) => n + 1)
        return
      }
      try {
        const remote = await loadCompanyDocument<unknown>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.greenBeanOrderPage,
        )
        if (cancelled) {
          return
        }
        if (remote) {
          window.localStorage.setItem(GREEN_BEAN_ORDER_STORAGE_KEY, JSON.stringify(remote))
        }
      } catch (error) {
        console.error('원두별 매출 분석: 생두 주문 클라우드 문서를 읽지 못했습니다.', error)
      } finally {
        if (!cancelled) {
          setGreenOrderCloudSyncTick((n) => n + 1)
        }
      }
    }
    void syncGreenOrderForAnalysis()
    return () => {
      cancelled = true
    }
  }, [mode, activeCompanyId, greenOrderReadTick])

  const statementRecords = useMemo(() => {
    return statementRecordsRaw.filter((record) => new Date(record.deliveryDate).getFullYear() === selectedYear)
  }, [selectedYear, statementRecordsRaw])

  const inventoryBeanRows = useMemo(() => {
    const normalized = normalizeInventoryStatusState(inventoryStateRaw)
    return Array.isArray(normalized?.beanRows) ? normalized.beanRows : []
  }, [inventoryStateRaw])

  const blendRecipeSnapshot = useMemo(() => {
    const st = normalizeInventoryStatusState(inventoryStateRaw)
    if (!st) {
      return { dark: null, light: null, decaf: null }
    }
    return {
      dark: st.blendingDarkRecipe ?? null,
      light: st.blendingLightRecipe ?? null,
      decaf: st.blendingDecaffeineRecipe ?? null,
    }
  }, [inventoryStateRaw])

  const latestGreenWonByLabel = useMemo(
    () => getLatestGreenOrderWonPerKgByInventoryLabel(inventoryBeanRows, mapOptions, blendRecipeSnapshot),
    [inventoryBeanRows, greenOrderReadTick, greenOrderCloudSyncTick, mapOptions, manualMappingTick, blendRecipeSnapshot],
  )

  /** 입출고 생두 표에 없는 품목(키워드만 맞는 영문·더치·미매칭 원문)은 집계에서 제외 */
  const allowedInventoryLabels = useMemo(
    () => new Set(inventoryBeanRows.map((b) => formatBeanRowLabel(b))),
    [inventoryBeanRows],
  )

  const { beanSalesAnalysis, notInInventoryByStatement, excludedRevenueNotInInventory } = useMemo(() => {
    const salesMap = new Map<string, BeanSalesData>()
    const notIn = new Map<string, NotInInventorySummary>()

    statementRecords.forEach((record) => {
      const { label, sortKey } = mapStatementItemToInventoryLabel(
        record.itemName,
        inventoryBeanRows,
        mapOptions,
      )
      if (inventoryBeanRows.length > 0 && !allowedInventoryLabels.has(label)) {
        if (hasAnyStatementManualForItem(record.itemName, mapOptions.mode, mapOptions.companyId)) {
          return
        }
        const key = record.itemName
        const ex =
          notIn.get(key) ??
          ({
            itemName: key,
            mappedLabel: label,
            totalRevenue: 0,
            totalQuantity: 0,
            transactionCount: 0,
          } satisfies NotInInventorySummary)
        ex.mappedLabel = label
        ex.totalRevenue += record.totalAmount
        ex.totalQuantity += record.quantity
        ex.transactionCount += 1
        notIn.set(key, ex)
        return
      }
      const beanName = label

      if (!salesMap.has(beanName)) {
        salesMap.set(beanName, {
          beanName,
          sortKey,
          totalQuantity: 0,
          totalRevenue: 0,
          avgUnitPrice: 0,
          clientCount: 0,
          transactionCount: 0,
          clients: [],
          latestGreenWonPerKg: null,
          latestGreenOrderDate: null,
          spreadVsGreenOrder: null,
          estimatedCostAmount: null,
          estimatedProfitAmount: null,
        })
      } else {
        const prev = salesMap.get(beanName)!
        if (sortKey < prev.sortKey) {
          prev.sortKey = sortKey
        }
      }

      const data = salesMap.get(beanName)!
      data.totalQuantity += record.quantity
      data.totalRevenue += record.totalAmount
      data.transactionCount += 1

      let clientData = data.clients.find((c) => c.name === record.clientName)
      if (!clientData) {
        clientData = { name: record.clientName, quantity: 0, revenue: 0 }
        data.clients.push(clientData)
      }
      clientData.quantity += record.quantity
      clientData.revenue += record.totalAmount
    })

    Array.from(salesMap.values()).forEach((data) => {
      data.avgUnitPrice = data.totalQuantity > 0 ? data.totalRevenue / data.totalQuantity : 0
      data.clientCount = data.clients.length
      data.clients.sort((a, b) => b.revenue - a.revenue)
      const g = latestGreenWonByLabel.get(data.beanName)
      if (g) {
        data.latestGreenWonPerKg = g.wonPerKg
        data.latestGreenOrderDate = g.orderDate
        data.spreadVsGreenOrder = data.avgUnitPrice - g.wonPerKg
        data.estimatedCostAmount = g.wonPerKg * data.totalQuantity
        data.estimatedProfitAmount = data.totalRevenue - data.estimatedCostAmount
      } else {
        data.latestGreenWonPerKg = null
        data.latestGreenOrderDate = null
        data.spreadVsGreenOrder = null
        data.estimatedCostAmount = null
        data.estimatedProfitAmount = null
      }
    })

    const rows = Array.from(salesMap.values())
    const byInventory = [...rows].sort((a, b) => {
      if (a.sortKey !== b.sortKey) {
        return a.sortKey - b.sortKey
      }
      return a.beanName.localeCompare(b.beanName, 'ko')
    })
    const byRevenue = [...rows].sort((a, b) => b.totalRevenue - a.totalRevenue)
    const byQuantity = [...rows].sort((a, b) => b.totalQuantity - a.totalQuantity)

    let sorted: BeanSalesData[]
    switch (sortBy) {
      case 'inventory':
        sorted = byInventory
        break
      case 'revenue':
        sorted = byRevenue
        break
      case 'quantity':
        sorted = byQuantity
        break
    }
    const notInList = Array.from(notIn.values()).sort((a, b) => b.totalRevenue - a.totalRevenue)
    const excludedSum = notInList.reduce((s, r) => s + r.totalRevenue, 0)
    return { beanSalesAnalysis: sorted, notInInventoryByStatement: notInList, excludedRevenueNotInInventory: excludedSum }
  }, [statementRecords, sortBy, inventoryBeanRows, latestGreenWonByLabel, allowedInventoryLabels, mapOptions, manualMappingTick])

  /** 매출 요약 표·차트·엑셀(요약 시트)과 동일: 매출액 0인 품목 제외 */
  const rowsWithRevenue = useMemo(
    () => beanSalesAnalysis.filter((d) => d.totalRevenue > 0),
    [beanSalesAnalysis],
  )

  const revenueChartData = useMemo(() => {
    return [...rowsWithRevenue]
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, BEAN_SALES_CHART_TOP)
      .map((data, index) => ({
        ...data,
        fill: BEAN_SALES_CHART_COLORS[index % BEAN_SALES_CHART_COLORS.length],
      }))
  }, [rowsWithRevenue])

  /** 생두 주문이 있어 이익(추정)이 잡힌 행만 */
  const rowsWithKnownProfit = useMemo(
    () => rowsWithRevenue.filter((d) => d.estimatedProfitAmount != null),
    [rowsWithRevenue],
  )

  const totalEstimatedProfit = useMemo(
    () => rowsWithKnownProfit.reduce((s, d) => s + (d.estimatedProfitAmount ?? 0), 0),
    [rowsWithKnownProfit],
  )

  const totalPositiveProfit = useMemo(
    () => rowsWithKnownProfit.reduce((s, d) => s + Math.max(0, d.estimatedProfitAmount ?? 0), 0),
    [rowsWithKnownProfit],
  )

  const profitBarChartData = useMemo(() => {
    return [...rowsWithKnownProfit]
      .sort((a, b) => (b.estimatedProfitAmount ?? 0) - (a.estimatedProfitAmount ?? 0))
      .slice(0, BEAN_SALES_CHART_TOP)
      .map((data, index) => ({
        ...data,
        fill: (data.estimatedProfitAmount ?? 0) >= 0
          ? BEAN_SALES_CHART_COLORS[index % BEAN_SALES_CHART_COLORS.length]
          : '#b71c1c',
      }))
  }, [rowsWithKnownProfit])

  const profitPieChartData = useMemo(() => {
    return [...rowsWithKnownProfit]
      .filter((d) => (d.estimatedProfitAmount ?? 0) > 0)
      .sort((a, b) => (b.estimatedProfitAmount ?? 0) - (a.estimatedProfitAmount ?? 0))
      .slice(0, BEAN_SALES_CHART_TOP)
      .map((data, index) => ({
        ...data,
        fill: BEAN_SALES_CHART_COLORS[index % BEAN_SALES_CHART_COLORS.length],
      }))
  }, [rowsWithKnownProfit])

  const totalRevenue = beanSalesAnalysis.reduce((sum, data) => sum + data.totalRevenue, 0)
  const totalQuantity = beanSalesAnalysis.reduce((sum, data) => sum + data.totalQuantity, 0)

  const handleExportBeanSalesExcel = useCallback(async () => {
    const sortByLabel =
      sortBy === 'inventory' ? '입출고 순(번호)' : sortBy === 'revenue' ? '매출순' : '수량순'
    const sRev = rowsWithRevenue.reduce((s, d) => s + d.totalRevenue, 0)
    const sQty = rowsWithRevenue.reduce((s, d) => s + d.totalQuantity, 0)
    const summaryRows = rowsWithRevenue.map((d) => ({
      beanName: d.beanName,
      totalRevenue: d.totalRevenue,
      sharePct: sRev > 0 ? (d.totalRevenue / sRev) * 100 : 0,
      totalQuantity: d.totalQuantity,
      avgUnitPrice: d.avgUnitPrice,
      latestGreenWonPerKg: d.latestGreenWonPerKg,
      estimatedCostAmount: d.estimatedCostAmount,
      estimatedProfitAmount: d.estimatedProfitAmount,
      spreadVsGreenOrder: d.spreadVsGreenOrder,
      clientCount: d.clientCount,
      transactionCount: d.transactionCount,
    }))
    const clientLines = rowsWithRevenue.flatMap((d) =>
      d.clients.map((c) => ({
        beanName: d.beanName,
        clientName: c.name,
        quantity: c.quantity,
        revenue: c.revenue,
      })),
    )
    await exportStyledBeanSalesAnalysisExcel({
      year: selectedYear,
      sortByLabel,
      createdAt: new Date(),
      summaryRows,
      summaryTotals: { totalRevenue: sRev, totalQuantity: sQty },
      notInRows: notInInventoryByStatement.map((r) => ({ ...r })),
      clientLines,
    })
  }, [rowsWithRevenue, selectedYear, sortBy, notInInventoryByStatement])

  return (
    <div className="bean-sales-analysis-page">
      <div className="page-header">
        <div className="page-header__title-row">
          <h1>원두별 매출 분석</h1>
          <button
            type="button"
            className="bean-sales-open-link-modal"
            onClick={() => {
              setLinkModalPreferredToLabel(null)
              setLinkModalOpen(true)
            }}
          >
            명세↔입고
          </button>
        </div>
      </div>

      <div className="analysis-controls">
        <label className="analysis-control-field">
          연도
          <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map(year => (
              <option key={year} value={year}>{year}년</option>
            ))}
          </select>
        </label>

        <div className="view-mode-tabs">
          <button 
            className={viewMode === 'revenue' ? 'active' : ''}
            onClick={() => setViewMode('revenue')}
          >
            매출 현황
          </button>
          <button 
            className={viewMode === 'detailed' ? 'active' : ''}
            onClick={() => setViewMode('detailed')}
          >
            상세 분석
          </button>
        </div>

        <label className="analysis-control-field">
          목록 정렬
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="inventory">입출고 순(번호)</option>
            <option value="revenue">매출순</option>
            <option value="quantity">수량순</option>
          </select>
        </label>

        <button
          type="button"
          className="ghost-button bean-sales-export-excel"
          onClick={() => void handleExportBeanSalesExcel()}
        >
          엑셀 내보내기
        </button>
      </div>

      <div className="summary-metrics">
        <div className="metric-card">
          <span>총 매출액</span>
          <strong>{formatCurrency(totalRevenue)}원</strong>
        </div>
        <div className="metric-card">
          <span>총 판매량</span>
          <strong>{formatNumber(totalQuantity)}개</strong>
        </div>
        <div className="metric-card">
          <span>품목 수</span>
          <strong>{rowsWithRevenue.length}개</strong>
        </div>
        {rowsWithKnownProfit.length > 0 ? (
          <div className="metric-card">
            <span>이익(추정) 합</span>
            <strong
              className={totalEstimatedProfit >= 0 ? 'bean-sales-metric-profit-pos' : 'bean-sales-metric-profit-neg'}
            >
              {formatCurrency(totalEstimatedProfit)}원
            </strong>
          </div>
        ) : null}
        {inventoryBeanRows.length > 0 && notInInventoryByStatement.length > 0 ? (
          <div className="metric-card bean-sales-metric-warn">
            <span>입고에 맞지 않은 품목(누락)</span>
            <strong>{notInInventoryByStatement.length}개 · {formatCurrency(excludedRevenueNotInInventory)}원</strong>
          </div>
        ) : null}
      </div>

      {viewMode === 'revenue' && (
        <div className="analysis-section">
          <div className="chart-grid">
            <div className="chart-container">
              <h3>원두별 매출 비율</h3>
              <div ref={revenuePiePlot.ref} className="bean-sales-chart-plot">
                <PieChart width={revenuePiePlot.width} height={revenuePiePlot.plotHeight}>
                  <Pie
                    data={revenueChartData}
                    dataKey="totalRevenue"
                    nameKey="beanName"
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={94}
                    paddingAngle={2}
                    label={false}
                    isAnimationActive={false}
                  >
                    {revenueChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => `${formatCurrency(Number(value))}원`}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.beanName ?? ''}
                    contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }}
                  />
                </PieChart>
              </div>
              <div className="bean-sales-pie-legend" aria-label="원두별 매출 비율 범례">
                {revenueChartData.map((data) => (
                  <div key={data.beanName} className="bean-sales-pie-legend__item" title={data.beanName}>
                    <span className="bean-sales-pie-legend__dot" style={{ background: data.fill }} />
                    <span className="bean-sales-pie-legend__name">{shortenBeanName(data.beanName, 16)}</span>
                    <span className="bean-sales-pie-legend__value">
                      {totalRevenue > 0 ? ((data.totalRevenue / totalRevenue) * 100).toFixed(1) : '0.0'}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="chart-container">
              <h3>원두별 매출 금액</h3>
              <div ref={revenueBarPlot.ref} className="bean-sales-chart-plot">
                <BarChart
                  data={revenueChartData}
                  width={revenueBarPlot.width}
                  height={revenueBarPlot.plotHeight}
                  layout="vertical"
                  margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tickFormatter={(value) => `${Math.round(value / 10000)}만`} tick={{ fontSize: 12 }} />
                  <YAxis
                    type="category"
                    dataKey="beanName"
                    width={116}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => shortenBeanName(String(value), 10)}
                  />
                  <Tooltip
                    formatter={(value) => `${formatCurrency(Number(value))}원`}
                    labelFormatter={(label) => String(label)}
                    contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }}
                  />
                  <Bar dataKey="totalRevenue" radius={[0, 2, 2, 0]} isAnimationActive={false}>
                    {revenueChartData.map((entry, index) => (
                      <Cell key={`rev-bar-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </div>
            </div>
          </div>

          <div className="chart-grid bean-sales-chart-grid--profit">
            <div className="chart-container">
              <h3>원두별 이익 비율</h3>
              {rowsWithKnownProfit.length === 0 ? (
                <p className="bean-sales-chart-empty">생두 주문이 있으면 품목별 이익(추정)을 계산합니다.</p>
              ) : profitPieChartData.length === 0 ? (
                <p className="bean-sales-chart-empty">흑자(추정) 품목이 없습니다.</p>
              ) : (
                <>
                  <div ref={profitPiePlot.ref} className="bean-sales-chart-plot">
                    <PieChart width={profitPiePlot.width} height={profitPiePlot.plotHeight}>
                      <Pie
                        data={profitPieChartData}
                        dataKey="estimatedProfitAmount"
                        nameKey="beanName"
                        cx="50%"
                        cy="50%"
                        innerRadius={58}
                        outerRadius={94}
                        paddingAngle={2}
                        label={false}
                        isAnimationActive={false}
                      >
                        {profitPieChartData.map((entry, index) => (
                          <Cell key={`profit-pie-${index}`} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => `${formatCurrency(Number(value))}원`}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.beanName ?? ''}
                        contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }}
                      />
                    </PieChart>
                  </div>
                  <div className="bean-sales-pie-legend" aria-label="원두별 이익(추정) 비율 범례">
                    {profitPieChartData.map((data) => (
                      <div key={data.beanName} className="bean-sales-pie-legend__item" title={data.beanName}>
                        <span className="bean-sales-pie-legend__dot" style={{ background: data.fill }} />
                        <span className="bean-sales-pie-legend__name">{shortenBeanName(data.beanName, 16)}</span>
                        <span className="bean-sales-pie-legend__value">
                          {totalPositiveProfit > 0
                            ? ((data.estimatedProfitAmount ?? 0) / totalPositiveProfit * 100).toFixed(1)
                            : '0.0'}
                          %
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="chart-container">
              <h3>원두별 이익 금액</h3>
              {rowsWithKnownProfit.length === 0 ? (
                <p className="bean-sales-chart-empty">생두 주문이 있으면 품목별 이익(추정)을 계산합니다.</p>
              ) : (
                <div ref={profitBarPlot.ref} className="bean-sales-chart-plot">
                  <BarChart
                    data={profitBarChartData}
                    width={profitBarPlot.width}
                    height={profitBarPlot.plotHeight}
                    layout="vertical"
                    margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                  >
                    <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => `${Math.round(value / 10000)}만`}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="beanName"
                      width={116}
                      tick={{ fontSize: 12 }}
                      tickFormatter={(value) => shortenBeanName(String(value), 10)}
                    />
                    <Tooltip
                      formatter={(value) => {
                        const n = Number(value)
                        return `${n >= 0 ? '' : '−'}${formatCurrency(Math.abs(n))}원`
                      }}
                      labelFormatter={(label) => String(label)}
                      contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }}
                    />
                    <Bar dataKey="estimatedProfitAmount" radius={[0, 2, 2, 0]} isAnimationActive={false}>
                      {profitBarChartData.map((entry, index) => (
                        <Cell key={`profit-bar-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </div>
              )}
            </div>
          </div>

          <div className="revenue-summary-table revenue-summary-table--no-hscroll">
            <h3>매출 요약</h3>
            <table className="bean-sales-revenue-table">
              <thead>
                <tr>
                  <th>원두명</th>
                  <th>매출액</th>
                  <th>매출 비율</th>
                  <th>수량</th>
                  <th>매출 평균단가</th>
                  <th>최근 주문</th>
                  <th>원가액</th>
                  <th>이익</th>
                  <th>스프레드</th>
                  <th>거래처 수</th>
                  <th>거래 건수</th>
                  <th>수정</th>
                </tr>
              </thead>
              <tbody>
                {beanSalesAnalysis
                  .filter(data => data.totalRevenue > 0)
                  .map(data => (
                    <tr key={data.beanName}>
                      <td><strong>{data.beanName}</strong></td>
                      <td>{formatCurrency(data.totalRevenue)}원</td>
                      <td>{totalRevenue > 0 ? ((data.totalRevenue / totalRevenue) * 100).toFixed(1) : 0}%</td>
                      <td>{formatNumber(data.totalQuantity)}개</td>
                      <td>{formatCurrency(data.avgUnitPrice)}원</td>
                      <td>
                        {data.latestGreenWonPerKg != null ? `${formatCurrency(data.latestGreenWonPerKg)}원` : '—'}
                      </td>
                      <td>
                        {data.estimatedCostAmount != null ? `${formatCurrency(data.estimatedCostAmount)}원` : '—'}
                      </td>
                      <td
                        className={
                          data.estimatedProfitAmount != null
                            ? data.estimatedProfitAmount >= 0
                              ? 'bean-sales-spread-pos'
                              : 'bean-sales-spread-neg'
                            : 'bean-sales-td-muted'
                        }
                      >
                        {data.estimatedProfitAmount != null
                          ? `${data.estimatedProfitAmount >= 0 ? '+' : '−'}${formatCurrency(Math.abs(data.estimatedProfitAmount))}원`
                          : '—'}
                      </td>
                      <td
                        className={
                          data.spreadVsGreenOrder != null
                            ? data.spreadVsGreenOrder >= 0
                              ? 'bean-sales-spread-pos'
                              : 'bean-sales-spread-neg'
                            : 'bean-sales-td-muted'
                        }
                      >
                        {data.spreadVsGreenOrder != null ? `${data.spreadVsGreenOrder >= 0 ? '+' : '−'}${formatCurrency(Math.abs(data.spreadVsGreenOrder))}원` : '—'}
                      </td>
                      <td>{data.clientCount}곳</td>
                      <td>{data.transactionCount}건</td>
                      <td>
                        <button
                          type="button"
                          className="bean-sales-row-edit-btn"
                          onClick={() => {
                            setLinkModalPreferredToLabel(data.beanName)
                            setLinkModalOpen(true)
                          }}
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {inventoryBeanRows.length > 0 && notInInventoryByStatement.length > 0 ? (
        <div className="analysis-section bean-sales-not-in-inventory">
          <h3>입고에 맞지 않은 품목</h3>
          <div className="revenue-summary-table">
            <table>
              <thead>
                <tr>
                  <th>거래명세 품목</th>
                  <th>매칭 시도 라벨</th>
                  <th>매출액(합)</th>
                  <th>수량(합)</th>
                  <th>거래 건수</th>
                </tr>
              </thead>
              <tbody>
                {notInInventoryByStatement.map((row) => (
                  <tr key={row.itemName}>
                    <td>
                      <strong>{row.itemName}</strong>
                    </td>
                    <td className="bean-sales-td-muted">{row.mappedLabel}</td>
                    <td>{formatCurrency(row.totalRevenue)}원</td>
                    <td>{formatNumber(row.totalQuantity)}</td>
                    <td>{row.transactionCount}건</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {viewMode === 'detailed' && (
        <div className="analysis-section">
          <h2>상세 분석</h2>
          {beanSalesAnalysis.map(data => (
            <div key={data.beanName} className="detailed-bean-analysis">
              <div className="bean-analysis-header">
                <h3>{data.beanName}</h3>
                <div className="bean-metrics">
                  <span className="metric">
                    매출 {formatCurrency(data.totalRevenue)}원
                  </span>
                  <span className="metric">
                    수량 {formatNumber(data.totalQuantity)}개
                  </span>
                  <span className="metric">
                    평균단가 {formatCurrency(data.avgUnitPrice)}원
                  </span>
                  {data.latestGreenWonPerKg != null ? (
                    <span className="metric">
                      최근 생두주문 {formatCurrency(data.latestGreenWonPerKg)}원/kg · {data.latestGreenOrderDate ?? ''}
                    </span>
                  ) : (
                    <span className="metric bean-sales-td-muted">생두 주문 일자 기록 없음</span>
                  )}
                  {data.spreadVsGreenOrder != null ? (
                    <span
                      className={
                        data.spreadVsGreenOrder >= 0 ? 'metric bean-sales-spread-pos' : 'metric bean-sales-spread-neg'
                      }
                    >
                      스프레드{' '}
                      {data.spreadVsGreenOrder >= 0 ? '+' : '−'}
                      {formatCurrency(Math.abs(data.spreadVsGreenOrder))}원
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="client-breakdown">
                <h4>거래처별 현황 ({data.clientCount}곳)</h4>
                <div className="client-list">
                  {data.clients.map(client => (
                    <div key={client.name} className="client-item">
                      <span className="client-name">{client.name}</span>
                      <span className="client-stats">
                        {formatNumber(client.quantity)}개 · {formatCurrency(client.revenue)}원
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <StatementInventoryLinkModal
        open={linkModalOpen}
        onClose={() => {
          setLinkModalOpen(false)
          setLinkModalPreferredToLabel(null)
        }}
        inventoryBeanRows={inventoryBeanRows}
        mode={mode}
        activeCompanyId={activeCompanyId}
        preferredToLabel={linkModalPreferredToLabel}
      />

      <style>{`
        .bean-sales-analysis-page {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }

        .page-header {
          margin-bottom: 30px;
        }

        .page-header__title-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px 14px;
          margin-bottom: 10px;
        }

        .page-header__title-row h1 {
          color: #333;
          margin: 0;
          font-size: 24px;
        }

        .bean-sales-open-link-modal {
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 500;
          border: 1px solid #0d6efd;
          color: #0d6efd;
          background: #fff;
          border-radius: 6px;
          cursor: pointer;
          white-space: nowrap;
        }

        .bean-sales-open-link-modal:hover { background: #e7f1ff; }
        .bean-sales-row-edit-btn {
          border: 1px solid #0d6efd;
          background: #fff;
          color: #0d6efd;
          border-radius: 6px;
          font-size: 12px;
          padding: 4px 9px;
          cursor: pointer;
          white-space: nowrap;
        }
        .bean-sales-row-edit-btn:hover { background: #e7f1ff; }

        .analysis-controls {
          display: flex;
          gap: 20px;
          align-items: center;
          margin-bottom: 30px;
          padding: 20px;
          background: #f8f9fa;
          border-radius: 8px;
          flex-wrap: wrap;
        }

        .analysis-control-field {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .analysis-control-field select {
          padding: 6px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
        }

        .bean-sales-export-excel {
          margin-left: auto;
        }

        .view-mode-tabs {
          display: flex;
          gap: 2px;
          border: 1px solid #ddd;
          border-radius: 6px;
          overflow: hidden;
        }

        .view-mode-tabs button {
          padding: 8px 16px;
          border: none;
          background: white;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.2s;
        }

        .view-mode-tabs button:hover {
          background: #f0f0f0;
        }

        .view-mode-tabs button.active {
          background: #007bff;
          color: white;
        }

        .summary-metrics {
          display: flex;
          gap: 20px;
          margin-bottom: 30px;
          flex-wrap: wrap;
        }

        .metric-card {
          flex: 1;
          min-width: 150px;
          padding: 20px;
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          text-align: center;
        }

        .metric-card span {
          display: block;
          color: #666;
          font-size: 14px;
          margin-bottom: 8px;
        }

        .metric-card strong {
          display: block;
          color: #333;
          font-size: 20px;
          font-weight: 600;
        }

        .bean-sales-metric-warn {
          border: 1px solid #e6c86a;
          background: #fffdf5;
        }

        .bean-sales-not-in-inventory h3 {
          color: #333;
          font-size: 18px;
          margin-bottom: 8px;
        }

        .analysis-section {
          margin-bottom: 40px;
        }

        .chart-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 30px;
        }

        .chart-container {
          background: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          min-width: 0;
        }

        .bean-sales-chart-plot {
          width: 100%;
          min-height: 300px;
          min-width: 240px;
          overflow-x: auto;
        }

        .chart-container h3 {
          margin: 0 0 15px 0;
          color: #2c3440;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }

        .bean-sales-chart-grid--profit {
          margin-top: 6px;
        }

        .bean-sales-chart-empty {
          min-height: 200px;
          margin: 0;
          padding: 32px 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          font-size: 14px;
          color: #6c757d;
          line-height: 1.5;
        }

        .metric-card strong.bean-sales-metric-profit-pos {
          color: #1b5e20;
        }
        .metric-card strong.bean-sales-metric-profit-neg {
          color: #b71c1c;
        }

        .bean-sales-pie-legend {
          margin-top: 10px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px 10px;
        }
        .bean-sales-pie-legend__item {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          font-size: 12px;
          color: #4b5563;
        }
        .bean-sales-pie-legend__dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex: 0 0 auto;
        }
        .bean-sales-pie-legend__name {
          flex: 1;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bean-sales-pie-legend__value {
          font-variant-numeric: tabular-nums;
          color: #374151;
          font-weight: 600;
        }

        .revenue-summary-table {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          overflow-x: auto;
          overflow-y: hidden;
        }

        .revenue-summary-table--no-hscroll {
          overflow-x: hidden;
          max-width: 100%;
        }

        .revenue-summary-table h3 {
          margin: 0;
          padding: 20px;
          background: #f8f9fa;
          color: #333;
          font-size: 16px;
          border-bottom: 1px solid #e9ecef;
        }

        .revenue-summary-table table.bean-sales-revenue-table {
          width: 100%;
          border-collapse: collapse;
          min-width: 0;
          table-layout: fixed;
        }

        .revenue-summary-table th,
        .revenue-summary-table td {
          padding: 8px 6px;
          text-align: left;
          border-bottom: 1px solid #e9ecef;
          vertical-align: top;
        }

        .revenue-summary-table th:nth-child(1),
        .revenue-summary-table td:nth-child(1) {
          width: 18%;
          min-width: 120px;
          word-break: break-word;
        }

        .revenue-summary-table th {
          background: #f8f9fa;
          font-weight: 600;
          color: #333;
          font-size: 12px;
        }

        .revenue-summary-table td {
          color: #666;
          font-size: 12px;
        }

        .revenue-summary-table td strong {
          font-size: 12px;
        }

        .detailed-bean-analysis {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          margin-bottom: 20px;
          overflow: hidden;
        }

        .bean-analysis-header {
          padding: 20px;
          background: #f8f9fa;
          border-bottom: 1px solid #e9ecef;
        }

        .bean-analysis-header h3 {
          margin: 0 0 10px 0;
          color: #333;
          font-size: 18px;
        }

        .bean-metrics {
          display: flex;
          gap: 20px;
          flex-wrap: wrap;
        }

        .metric {
          font-size: 14px;
          font-weight: 500;
          color: #666;
        }

        .client-breakdown {
          padding: 20px;
        }

        .client-breakdown h4 {
          margin: 0 0 15px 0;
          color: #333;
          font-size: 14px;
        }

        .client-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .client-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: #f8f9fa;
          border-radius: 4px;
          font-size: 14px;
        }

        .client-name {
          font-weight: 500;
          color: #333;
        }

        .client-stats {
          color: #666;
        }

        .bean-sales-td-muted {
          color: #888;
          font-size: 13px;
        }
        .bean-sales-spread-pos {
          color: #1e6b3a;
          font-weight: 600;
        }
        .bean-sales-spread-neg {
          color: #b00020;
          font-weight: 600;
        }

        @media (max-width: 768px) {
          .chart-grid {
            grid-template-columns: 1fr;
          }
          
          .analysis-controls {
            flex-direction: column;
            align-items: stretch;
          }
          
          .view-mode-tabs {
            align-self: stretch;
          }

          .summary-metrics {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  )
}

export default BeanSalesAnalysisPage