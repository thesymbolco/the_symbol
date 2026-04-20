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

/** 생두 주문 엑셀과 동일 톤: 제목 바, 헤더 연녹, 본문 줄무늬 */
const TITLE_BAR = 'FF166534'
const HEADER_FILL = 'FFDCEFE3'
const STRIPE_FILL = 'FFF8FAFC'

const maxColCount = (rows: (string | number)[][]) => Math.max(1, ...rows.map((r) => r.length))

const padTitleRow = (title: string, colCount: number): (string | number)[] => {
  const n = Math.max(1, colCount)
  return [title, ...Array(n - 1).fill('')]
}

const columnCharWidths = (matrix: (string | number)[][], maxCols: number) => {
  const widths = Array.from({ length: maxCols }, () => 10)
  matrix.forEach((row) => {
    for (let c = 0; c < maxCols; c += 1) {
      const len = cellStr(row[c]).length
      widths[c] = Math.min(48, Math.max(widths[c], Math.min(len + 2, 48)))
    }
  })
  return widths
}

const safeSheetName = (name: string) => name.replace(/[[\]*?:/\\]/g, '-').slice(0, 31) || 'Sheet'

type SimpleRowKind = 'title' | 'tableHead' | 'data'

const classifyRow = (rowIndex: number): SimpleRowKind => {
  if (rowIndex === 0) {
    return 'title'
  }
  if (rowIndex === 1) {
    return 'tableHead'
  }
  return 'data'
}

const fillStyledMatrix = (ws: ExcelJS.Worksheet, matrix: (string | number)[][]) => {
  const maxCols = maxColCount(matrix)
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classifyRow(r)
    const excelRow = ws.getRow(r + 1)

    for (let c = 0; c < maxCols; c += 1) {
      const cell = excelRow.getCell(c + 1)
      const raw = row[c]
      const isNumber = typeof raw === 'number' && !Number.isNaN(raw)
      cell.value = raw === '' || raw === undefined || raw === null ? null : raw
      cell.border = BORDER as ExcelJS.Borders

      if (kind === 'title') {
        cell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BAR } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      } else if (kind === 'tableHead') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: isNumber ? 'right' : 'left',
        }
      } else {
        cell.font = { size: 10, color: { argb: 'FF0F172A' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: isNumber ? 'right' : 'left',
        }
        if (isNumber) {
          cell.numFmt = moneyFmt
        }
        if (dataStripe % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE_FILL } }
        }
      }
    }

    if (kind === 'data') {
      dataStripe += 1
    }
    if (kind === 'title') {
      excelRow.height = 30
    } else if (kind === 'tableHead') {
      excelRow.height = 22
    }
  })

  try {
    ws.mergeCells(1, 1, 1, maxCols)
  } catch {
    /* ignore */
  }

  ws.columns = columnCharWidths(matrix, maxCols).map((width) => ({ width }))
  ws.views = [{ showGridLines: true, state: 'frozen', ySplit: 2, activeCell: 'A3', topLeftCell: 'A3' }]
}

export type StyledExpenseWorkbookInput = {
  downloadFileName: string
  /** 표시용 월 라벨 (예: 2026년 4월) — 제목 행에만 사용 */
  monthLabel: string
  detailRows: (string | number)[][]
  categoryRows: (string | number)[][]
  paymentRows: (string | number)[][]
}

/** 지출내역·요약 3시트, 생두 주문과 맞춘 녹색 제목·헤더·테두리·틀 고정 */
export const exportStyledExpenseWorkbook = async (input: StyledExpenseWorkbookInput): Promise<void> => {
  const { downloadFileName, monthLabel, detailRows, categoryRows, paymentRows } = input

  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 지출'

  const detailMatrix = [padTitleRow(`■ 지출 내역 · ${monthLabel}`, maxColCount(detailRows)), ...detailRows]
  const wsDetail = workbook.addWorksheet(safeSheetName('지출내역'), {
    properties: { defaultRowHeight: 20 },
  })
  fillStyledMatrix(wsDetail, detailMatrix)

  const catMatrix = [padTitleRow(`■ 카테고리 요약 · ${monthLabel}`, maxColCount(categoryRows)), ...categoryRows]
  const wsCat = workbook.addWorksheet(safeSheetName('카테고리요약'), {
    properties: { defaultRowHeight: 20 },
  })
  fillStyledMatrix(wsCat, catMatrix)

  const payMatrix = [padTitleRow(`■ 지급수단 요약 · ${monthLabel}`, maxColCount(paymentRows)), ...paymentRows]
  const wsPay = workbook.addWorksheet(safeSheetName('지급수단요약'), {
    properties: { defaultRowHeight: 20 },
  })
  fillStyledMatrix(wsPay, payMatrix)

  const buffer = await workbook.xlsx.writeBuffer()
  downloadBufferAsFile(buffer as ArrayBuffer, downloadFileName)
}
