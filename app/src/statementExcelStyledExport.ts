import ExcelJS from 'exceljs'

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
}

const moneyFmt = '#,##0'

/** 생두·지출 엑셀과 동일 톤 */
const TITLE_BAR = 'FF166534'
const HEADER_FILL = 'FFDCEFE3'
const META_FILL = 'FFF1F5F9'
const STRIPE_FILL = 'FFF8FAFC'
const FOOTER_FILL = 'FFE8F5E9'

export type StatementSheetMerge0 = { s: { r: number; c: number }; e: { r: number; c: number } }

const maxColCount = (rows: (string | number)[][]) => Math.max(1, ...rows.map((r) => r.length))

/** 0-based 열 → A, B, …, AA */
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

const toArrayBuffer = (buffer: ArrayBuffer | Uint8Array): ArrayBuffer => {
  if (buffer instanceof ArrayBuffer) {
    return buffer
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

const applyMerges0 = (ws: ExcelJS.Worksheet, merges: StatementSheetMerge0[]) => {
  merges.forEach((m) => {
    try {
      ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1)
    } catch {
      /* ignore */
    }
  })
}

type InputRowKind = 'title' | 'meta' | 'tableHead' | 'data' | 'footerTotal'

const classifyStatementInputRow = (r: number, totalRows: number): InputRowKind => {
  if (r === 0) {
    return 'title'
  }
  if (r === 1) {
    return 'meta'
  }
  if (r === 2) {
    return 'tableHead'
  }
  if (r === totalRows - 1 && totalRows > 3) {
    return 'footerTotal'
  }
  return 'data'
}

/** 거래명세서 입력목록 시트 (제목·출력일 행·헤더·줄무늬·합계행) */
export const buildStyledStatementInputListBuffer = async (
  matrix: (string | number)[][],
  columnWidths: number[],
): Promise<ArrayBuffer> => {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 거래명세'
  const ws = workbook.addWorksheet('거래명세서_입력목록', {
    properties: { defaultRowHeight: 20 },
    views: [{ showGridLines: true, state: 'frozen', ySplit: 3, activeCell: 'A4', topLeftCell: 'A4' }],
  })

  const maxCols = maxColCount(matrix)
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classifyStatementInputRow(r, matrix.length)
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
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
      } else if (kind === 'footerTotal') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FOOTER_FILL } }
        cell.alignment = { vertical: 'middle', horizontal: isNumber ? 'right' : 'left' }
        if (isNumber) {
          cell.numFmt = moneyFmt
        }
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
      excelRow.height = 28
    } else if (kind === 'meta') {
      excelRow.height = 20
    } else if (kind === 'tableHead' || kind === 'footerTotal') {
      excelRow.height = 22
    }
  })

  applyMerges0(ws, [{ s: { r: 0, c: 0 }, e: { r: 0, c: maxCols - 1 } }])

  /** 헤더(3행)부터 합계 직전 행까지 (합계 행은 제외) */
  if (matrix.length >= 4) {
    const lastDataExcelRow = matrix.length - 1
    ws.autoFilter = `A3:${colToLetters(maxCols - 1)}${lastDataExcelRow}`
  }

  const widths =
    columnWidths.length >= maxCols
      ? columnWidths.slice(0, maxCols)
      : [...columnWidths, ...Array.from({ length: maxCols - columnWidths.length }, () => 10)]
  ws.columns = widths.map((w) => ({ width: Math.min(48, Math.max(6, w)) }))

  const raw = await workbook.xlsx.writeBuffer()
  return toArrayBuffer(raw as ArrayBuffer)
}

type SummaryRowKind = 'title' | 'spacer' | 'tableHead' | 'data' | 'footerTotal'

const classifyStatementSummaryRow = (r: number, totalRows: number): SummaryRowKind => {
  if (r === 0) {
    return 'title'
  }
  if (r === 1) {
    return 'spacer'
  }
  if (r === 2 || r === 3) {
    return 'tableHead'
  }
  if (r === totalRows - 1 && totalRows > 4) {
    return 'footerTotal'
  }
  return 'data'
}

/** 월별 납품현황 시트 (2단 헤더·머지·합계행) */
export const buildStyledStatementMonthlySummaryBuffer = async (
  matrix: (string | number)[][],
  merges: StatementSheetMerge0[],
  columnWidths: number[],
  sheetName: string,
): Promise<ArrayBuffer> => {
  const safeName = sheetName.replace(/[[\]*?:/\\]/g, '-').slice(0, 31) || '월별현황'

  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 거래명세'
  const ws = workbook.addWorksheet(safeName, {
    properties: { defaultRowHeight: 20 },
    views: [{ showGridLines: true, state: 'frozen', ySplit: 4, activeCell: 'A5', topLeftCell: 'A5' }],
  })

  const maxCols = maxColCount(matrix)
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classifyStatementSummaryRow(r, matrix.length)
    const excelRow = ws.getRow(r + 1)

    for (let c = 0; c < maxCols; c += 1) {
      const cell = excelRow.getCell(c + 1)
      const raw = row[c]
      const isNumber = typeof raw === 'number' && !Number.isNaN(raw)
      cell.value = raw === '' || raw === undefined || raw === null ? null : raw
      cell.border = BORDER as ExcelJS.Borders

      if (kind === 'title') {
        cell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BAR } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      } else if (kind === 'spacer') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      } else if (kind === 'tableHead') {
        cell.font = { bold: true, size: 9, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      } else if (kind === 'footerTotal') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FOOTER_FILL } }
        cell.alignment = { vertical: 'middle', horizontal: isNumber ? 'right' : 'left' }
        if (isNumber) {
          cell.numFmt = moneyFmt
        }
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
      excelRow.height = 26
    } else if (kind === 'spacer') {
      excelRow.height = 6
    } else if (kind === 'tableHead') {
      excelRow.height = 22
    } else if (kind === 'footerTotal') {
      excelRow.height = 22
    }
  })

  applyMerges0(ws, merges)

  /** 2단 헤더(4행)부터 합계 직전까지 */
  if (matrix.length >= 5) {
    const lastDataExcelRow = matrix.length - 1
    ws.autoFilter = `A4:${colToLetters(maxCols - 1)}${lastDataExcelRow}`
  }

  const widths =
    columnWidths.length >= maxCols
      ? columnWidths.slice(0, maxCols)
      : [...columnWidths, ...Array.from({ length: maxCols - columnWidths.length }, () => 10)]
  ws.columns = widths.map((w) => ({ width: Math.min(48, Math.max(6, w)) }))

  const raw = await workbook.xlsx.writeBuffer()
  return toArrayBuffer(raw as ArrayBuffer)
}

/** 너비 배열이 matrix보다 짧을 때 보조 (호출부에서 맞춰 넘기는 것이 일반적) */
export const statementInputListDefaultColumnWidths = (): number[] => [
  6, 10, 8, 26, 28, 12, 8, 12, 14, 12, 14, 14,
]
