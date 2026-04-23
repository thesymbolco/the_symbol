import ExcelJS from 'exceljs'
import { downloadBufferAsFile } from './monthlyMeetingExcelStyledExport'

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
}

const cellStr = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const moneyFmt = '#,##0'
const qtyFmt = '#,##0.00'
const pctFmt = '0.0'

export type BeanSalesExportSummaryRow = {
  beanName: string
  totalRevenue: number
  sharePct: number
  totalQuantity: number
  avgUnitPrice: number
  latestGreenWonPerKg: number | null
  estimatedCostAmount: number | null
  estimatedProfitAmount: number | null
  spreadVsGreenOrder: number | null
  clientCount: number
  transactionCount: number
}

export type BeanSalesNotInRow = {
  itemName: string
  mappedLabel: string
  totalRevenue: number
  totalQuantity: number
  transactionCount: number
}

export type BeanSalesClientLine = {
  beanName: string
  clientName: string
  quantity: number
  revenue: number
}

export type BeanSalesAnalysisExcelInput = {
  year: number
  sortByLabel: string
  createdAt: Date
  summaryRows: BeanSalesExportSummaryRow[]
  summaryTotals: {
    totalRevenue: number
    totalQuantity: number
  }
  notInRows: BeanSalesNotInRow[]
  clientLines: BeanSalesClientLine[]
}

type Kind = 'title' | 'meta' | 'spacer' | 'section' | 'head' | 'data' | 'sum'

const classify = (r: number, row: (string | number)[][]): Kind => {
  const a = cellStr(row[r]?.[0]).trim()
  if (r === 0 && a.startsWith('[')) {
    return 'title'
  }
  if (a === '—' && row[r]?.length === 1) {
    return 'spacer'
  }
  if (a.startsWith('■')) {
    return 'section'
  }
  if (a === '원두명' || a === '입고 품목' || a === '거래명세 품목') {
    return 'head'
  }
  if (a === '합계') {
    return 'sum'
  }
  if (r <= 2 && (a.startsWith('기준') || a.startsWith('생성'))) {
    return 'meta'
  }
  return 'data'
}

type ApplyVariant = 'summary' | 'notIn' | 'client'

const setNumByVariant = (cell: ExcelJS.Cell, c: number, n: boolean, k: Kind, v: ApplyVariant) => {
  if (!n || c <= 0) {
    return
  }
  if (v === 'summary' && k === 'sum') {
    if (c === 2) {
      cell.numFmt = pctFmt
    } else if (c === 3) {
      cell.numFmt = qtyFmt
    } else if (c === 1) {
      cell.numFmt = moneyFmt
    }
    return
  }
  if (v === 'summary' && k === 'data') {
    if (c === 2) {
      cell.numFmt = pctFmt
    } else if (c === 3) {
      cell.numFmt = qtyFmt
    } else if (c === 9 || c === 10) {
      cell.numFmt = '#,##0'
    } else {
      cell.numFmt = moneyFmt
    }
    return
  }
  if (v === 'notIn' && k === 'data') {
    if (c === 2) {
      cell.numFmt = moneyFmt
    } else if (c === 3) {
      cell.numFmt = qtyFmt
    } else if (c === 4) {
      cell.numFmt = '#,##0'
    }
    return
  }
  if (v === 'client' && k === 'data') {
    if (c === 2) {
      cell.numFmt = qtyFmt
    } else if (c === 3) {
      cell.numFmt = moneyFmt
    }
  }
}

const applySheet = (ws: ExcelJS.Worksheet, matrix: (string | number)[][], variant: ApplyVariant) => {
  const maxCols = Math.max(1, ...matrix.map((r) => r.length))
  let dataStripe = 0

  matrix.forEach((row, r0) => {
    const k = classify(r0, matrix)
    const excelRow = ws.getRow(r0 + 1)

    for (let c = 0; c < maxCols; c += 1) {
      const cell = excelRow.getCell(c + 1)
      const raw = row[c]
      const n = typeof raw === 'number' && !Number.isNaN(raw)
      cell.value = raw === '' || raw === undefined || raw === null ? null : raw
      cell.border = BORDER as ExcelJS.Borders

      if (k === 'spacer') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
        continue
      }
      if (k === 'title') {
        cell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      } else if (k === 'meta') {
        cell.font = { size: 10, color: { argb: 'FF475569' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      } else if (k === 'section') {
        cell.font = { bold: true, size: 11, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      } else if (k === 'head') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEFE3' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
      } else if (k === 'sum' && variant === 'summary') {
        cell.font = { bold: true, size: 11, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
        setNumByVariant(cell, c, n, 'sum', variant)
      } else {
        cell.font = { size: 10, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
        if (k === 'data' && c > 0) {
          if (dataStripe % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
          }
        }
        setNumByVariant(cell, c, n, k, variant)
      }
    }

    if (k === 'data' && maxCols > 0 && cellStr(row[0]) !== '합계') {
      dataStripe += 1
    }
    if (k === 'title') {
      excelRow.height = 30
    } else if (k === 'head' || k === 'section') {
      excelRow.height = 22
    }
  })

  try {
    ws.mergeCells(1, 1, 1, maxCols)
  } catch {
    /* ignore */
  }
  matrix.forEach((_, r0) => {
    if (classify(r0, matrix) === 'section') {
      try {
        ws.mergeCells(r0 + 1, 1, r0 + 1, maxCols)
      } catch {
        /* ignore */
      }
    }
  })
  const widths = Array.from({ length: maxCols }, () => 12)
  matrix.forEach((row) => {
    for (let c = 0; c < maxCols; c += 1) {
      const len = cellStr(row[c]).length
      widths[c] = Math.min(50, Math.max(widths[c], len + 2))
    }
  })
  ws.columns = widths.map((w) => ({ width: w }))
}

const buildSummaryMatrix = (input: BeanSalesAnalysisExcelInput): (string | number)[][] => {
  const rows: (string | number)[][] = []
  rows.push([`[원두별 매출 분석] ${input.year}년`])
  const iso = input.createdAt.toISOString()
  const local = input.createdAt.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
  rows.push([`기준: 거래명세(납품일 ${input.year}년) / 입출고 생두`, `정렬: ${input.sortByLabel}`])
  rows.push([`생성: ${local} (${iso.slice(0, 19)}Z)`, ''])
  rows.push(['—'])
  rows.push(['■ 매출 요약 (매출 0인 품목 제외)'])
  const head = [
    '원두명',
    '매출액',
    '비율(%)',
    '수량(합)',
    '매출 평균단가',
    '최근주문(원/kg)',
    '원가(추정)',
    '이익(추정)',
    '스프레드(원)',
    '거래처 수',
    '거래 건수',
  ]
  rows.push(head)
  for (const d of input.summaryRows) {
    rows.push([
      d.beanName,
      Math.round(d.totalRevenue),
      d.sharePct,
      d.totalQuantity,
      Math.round(d.avgUnitPrice),
      d.latestGreenWonPerKg != null ? Math.round(d.latestGreenWonPerKg) : '—',
      d.estimatedCostAmount != null ? Math.round(d.estimatedCostAmount) : '—',
      d.estimatedProfitAmount != null ? Math.round(d.estimatedProfitAmount) : '—',
      d.spreadVsGreenOrder != null ? Math.round(d.spreadVsGreenOrder) : '—',
      d.clientCount,
      d.transactionCount,
    ])
  }
  if (input.summaryRows.length > 0) {
    const tr = input.summaryTotals.totalRevenue
    const tq = input.summaryTotals.totalQuantity
    const share = tr > 0 ? 100 : 0
    rows.push([
      '합계',
      Math.round(tr),
      share,
      tq,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ])
  }
  return rows
}

const buildNotInMatrix = (input: BeanSalesAnalysisExcelInput): (string | number)[][] => {
  const rows: (string | number)[][] = []
  rows.push([`[입고에 맞지 않은 품목] ${input.year}년`])
  rows.push([`기준: 거래명세 품목만`, ``, ``, ``, ``])
  rows.push(['—'])
  rows.push(['■ 입고 N. 품목명이 없는 거래(매출 일부)'])
  rows.push(['거래명세 품목', '매칭 시도 라벨', '매출액(합)', '수량(합)', '거래 건수'])
  for (const d of input.notInRows) {
    rows.push([d.itemName, d.mappedLabel, Math.round(d.totalRevenue), d.totalQuantity, d.transactionCount])
  }
  if (input.notInRows.length === 0) {
    rows.push(['(해당 없음)', '', '', '', ''])
  }
  return rows
}

const buildClientMatrix = (input: BeanSalesAnalysisExcelInput): (string | number)[][] => {
  const rows: (string | number)[][] = []
  rows.push([`[거래처별] ${input.year}년`])
  rows.push([`기준: 매출 요약 품목 → 거래처`, ``, ``, ``])
  rows.push(['—'])
  rows.push(['■ 품목·거래처별 수량·매출'])
  rows.push(['입고 품목(라벨)', '거래처', '수량(합)', '매출(합)'])
  for (const c of input.clientLines) {
    rows.push([c.beanName, c.clientName, c.quantity, Math.round(c.revenue)])
  }
  if (input.clientLines.length === 0) {
    rows.push(['(해당 없음)', '', '', ''])
  }
  return rows
}

/** 원두 매출: 매출요약(상단 녹색 제목) + 입고미매칭 + 거래처별, 생두주문/월마감과 유사한 테두리·헤드 색 */
export const exportStyledBeanSalesAnalysisExcel = async (input: BeanSalesAnalysisExcelInput) => {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 원두 매출'

  const m1 = buildSummaryMatrix(input)
  const ws1 = workbook.addWorksheet('매출요약', { properties: { defaultRowHeight: 20 } })
  applySheet(ws1, m1, 'summary')
  try {
    ws1.views = [{ showGridLines: true, state: 'frozen', ySplit: 6, topLeftCell: 'A7' }]
  } catch {
    /* ignore */
  }

  const m2 = buildNotInMatrix(input)
  const ws2 = workbook.addWorksheet('입고미매칭', { properties: { defaultRowHeight: 20 } })
  applySheet(ws2, m2, 'notIn')

  const m3 = buildClientMatrix(input)
  const ws3 = workbook.addWorksheet('거래처별', { properties: { defaultRowHeight: 20 } })
  applySheet(ws3, m3, 'client')

  const buffer = await workbook.xlsx.writeBuffer()
  const y = input.year
  const stamp = input.createdAt.toISOString().slice(0, 10)
  downloadBufferAsFile(buffer as ArrayBuffer, `원두별매출_${y}년_${stamp}.xlsx`)
}
