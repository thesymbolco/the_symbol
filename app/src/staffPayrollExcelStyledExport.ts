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

const TITLE_BAR = 'FF166534'
const HEADER_FILL = 'FFDCEFE3'
const META_FILL = 'FFF1F5F9'
const STRIPE_FILL = 'FFF8FAFC'

const maxColCount = (rows: (string | number)[][]) => Math.max(1, ...rows.map((r) => r.length))

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

const colToLetters = (zeroBasedCol: number): string => {
  let n = zeroBasedCol + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

type RowKind = 'title' | 'meta' | 'tableHead' | 'data'

const classify = (r: number): RowKind => {
  if (r === 0) {
    return 'title'
  }
  if (r === 1) {
    return 'meta'
  }
  if (r === 2) {
    return 'tableHead'
  }
  return 'data'
}

const fillMatrix = (ws: ExcelJS.Worksheet, matrix: (string | number)[][]) => {
  const maxCols = maxColCount(matrix)
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classify(r)
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
      } else if (kind === 'meta') {
        cell.font = { size: 10, color: { argb: 'FF475569' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: META_FILL } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      } else if (kind === 'tableHead') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
        cell.alignment = { vertical: 'middle', horizontal: isNumber ? 'right' : 'left' }
      } else {
        cell.font = { size: 10, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: isNumber ? 'right' : 'left' }
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
    } else if (kind === 'meta') {
      excelRow.height = 20
    } else if (kind === 'tableHead') {
      excelRow.height = 22
    }
  })

  try {
    ws.mergeCells(1, 1, 1, maxCols)
  } catch {
    /* ignore */
  }

  if (matrix.length >= 4) {
    const lastRow = matrix.length
    ws.autoFilter = `A3:${colToLetters(maxCols - 1)}${lastRow}`
  }

  ws.columns = columnCharWidths(matrix, maxCols).map((width) => ({ width }))
  ws.views = [{ showGridLines: true, state: 'frozen', ySplit: 3, activeCell: 'A4', topLeftCell: 'A4' }]
}

/** 직원·급여 목록 1시트, 지출·생두와 같은 녹색 제목·헤더 */
export const exportStyledStaffPayrollExcel = async (
  matrix: (string | number)[][],
  downloadFileName: string,
): Promise<void> => {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 직원·급여'
  const ws = workbook.addWorksheet('직원급여', {
    properties: { defaultRowHeight: 20 },
  })
  fillMatrix(ws, matrix)
  const buffer = await workbook.xlsx.writeBuffer()
  downloadBufferAsFile(buffer as ArrayBuffer, downloadFileName)
}
