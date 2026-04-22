import { useEffect, useMemo, useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import {
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_STATUS_STORAGE_KEY,
  inventoryPageScopedKey,
} from './InventoryStatusPage'
import { mapStatementItemToInventoryLabel } from './beanSalesStatementMapping'
import { normalizeInventoryStatusState } from './inventoryStatusUtils'
import { useAppRuntime } from './providers/AppRuntimeProvider'

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
}

const STATEMENT_RECORDS_KEY = 'statement-records-v1'

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('ko-KR').format(Math.round(value))
}

const formatNumber = (value: number): string => {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value)
}

function BeanSalesAnalysisPage() {
  const { mode, activeCompanyId } = useAppRuntime()
  const [inventoryReadTick, setInventoryReadTick] = useState(0)
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear())
  const [viewMode, setViewMode] = useState<'revenue' | 'detailed'>('revenue')
  const [sortBy, setSortBy] = useState<'inventory' | 'revenue' | 'quantity'>('inventory')

  useEffect(() => {
    const onInv = () => setInventoryReadTick((n) => n + 1)
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, onInv)
    return () => window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, onInv)
  }, [])

  const statementRecords = useMemo(() => {
    try {
      const saved = window.localStorage.getItem(STATEMENT_RECORDS_KEY)
      if (!saved) return []
      const parsed = JSON.parse(saved) as StatementRecord[]
      return parsed.filter(record => 
        new Date(record.deliveryDate).getFullYear() === selectedYear
      )
    } catch {
      return []
    }
  }, [selectedYear])

  const inventoryBeanRows = useMemo(() => {
    try {
      const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        return []
      }
      const st = normalizeInventoryStatusState(JSON.parse(raw))
      return st?.beanRows ?? []
    } catch {
      return []
    }
  }, [statementRecords, mode, activeCompanyId, inventoryReadTick])

  const beanSalesAnalysis = useMemo(() => {
    const salesMap = new Map<string, BeanSalesData>()
    
    statementRecords.forEach(record => {
      const { label, sortKey } = mapStatementItemToInventoryLabel(record.itemName, inventoryBeanRows)
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
          clients: []
        })
      } else {
        const ex = salesMap.get(beanName)!
        if (sortKey < ex.sortKey) {
          ex.sortKey = sortKey
        }
      }
      
      const data = salesMap.get(beanName)!
      data.totalQuantity += record.quantity
      data.totalRevenue += record.totalAmount
      data.transactionCount += 1
      
      // 클라이언트별 집계
      let clientData = data.clients.find(c => c.name === record.clientName)
      if (!clientData) {
        clientData = { name: record.clientName, quantity: 0, revenue: 0 }
        data.clients.push(clientData)
      }
      clientData.quantity += record.quantity
      clientData.revenue += record.totalAmount
    })
    
    // 평균 단가 및 클라이언트 수 계산
    Array.from(salesMap.values()).forEach(data => {
      data.avgUnitPrice = data.totalQuantity > 0 ? data.totalRevenue / data.totalQuantity : 0
      data.clientCount = data.clients.length
      data.clients.sort((a, b) => b.revenue - a.revenue)
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

    switch (sortBy) {
      case 'inventory':
        return byInventory
      case 'revenue':
        return byRevenue
      case 'quantity':
        return byQuantity
    }
  }, [statementRecords, sortBy, inventoryBeanRows])

  const chartColors = [
    '#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1',
    '#d084d0', '#ffb366', '#95d5b2', '#ffd93d', '#c9c9c9'
  ]

  const revenueChartData = useMemo(() => {
    return [...beanSalesAnalysis]
      .filter((data) => data.totalRevenue > 0)
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10)
      .map((data, index) => ({
        ...data,
        fill: chartColors[index % chartColors.length]
      }))
  }, [beanSalesAnalysis])

  const totalRevenue = beanSalesAnalysis.reduce((sum, data) => sum + data.totalRevenue, 0)
  const totalQuantity = beanSalesAnalysis.reduce((sum, data) => sum + data.totalQuantity, 0)

  return (
    <div className="bean-sales-analysis-page">
      <div className="page-header">
        <h1>원두별 매출 분석</h1>
        <p>
          거래명세 품목을 <strong>현재 워크스페이스의 입출고 표</strong>와 맞춥니다(로컬/클라우드·회사별 캐시 키 동일). 괄호
          안 매장명(예: 라미랑드)은 매칭에서 제거합니다. 표가 비어 있으면 번호·이름 풀 표기는 어렵고 키워드만 씁니다.
        </p>
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
          <strong>{beanSalesAnalysis.length}개</strong>
        </div>
      </div>

      {viewMode === 'revenue' && (
        <div className="analysis-section">
          <div className="chart-grid">
            <div className="chart-container">
              <h3>원두별 매출 비율</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={revenueChartData}
                    dataKey="totalRevenue"
                    nameKey="beanName"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    label={(props: any) => `${props.beanName || ''} ${((props.percent || 0) * 100).toFixed(1)}%`}
                  >
                    {revenueChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => `${formatCurrency(Number(value))}원`} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-container">
              <h3>원두별 매출 금액</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={revenueChartData.slice(0, 8)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="beanName" 
                    tick={{ fontSize: 12 }}
                    interval={0}
                    angle={-45}
                    textAnchor="end"
                    height={80}
                  />
                  <YAxis tickFormatter={(value) => `${Math.round(value / 10000)}만`} />
                  <Tooltip formatter={(value) => `${formatCurrency(Number(value))}원`} />
                  <Bar dataKey="totalRevenue" fill="#8884d8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="revenue-summary-table">
            <h3>매출 요약</h3>
            <table>
              <thead>
                <tr>
                  <th>원두명</th>
                  <th>매출액</th>
                  <th>매출 비율</th>
                  <th>수량</th>
                  <th>평균 단가</th>
                  <th>거래처 수</th>
                  <th>거래 건수</th>
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
                      <td>{data.clientCount}곳</td>
                      <td>{data.transactionCount}건</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

      <style>{`
        .bean-sales-analysis-page {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }

        .page-header {
          margin-bottom: 30px;
        }

        .page-header h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 24px;
        }

        .page-header p {
          color: #666;
          font-size: 14px;
        }

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
        }

        .chart-container h3 {
          margin: 0 0 15px 0;
          color: #333;
          font-size: 16px;
        }

        .revenue-summary-table {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          overflow: hidden;
        }

        .revenue-summary-table h3 {
          margin: 0;
          padding: 20px;
          background: #f8f9fa;
          color: #333;
          font-size: 16px;
          border-bottom: 1px solid #e9ecef;
        }

        .revenue-summary-table table {
          width: 100%;
          border-collapse: collapse;
        }

        .revenue-summary-table th,
        .revenue-summary-table td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #e9ecef;
        }

        .revenue-summary-table th {
          background: #f8f9fa;
          font-weight: 600;
          color: #333;
          font-size: 14px;
        }

        .revenue-summary-table td {
          color: #666;
          font-size: 14px;
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