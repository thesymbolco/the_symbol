import ExcelJS from 'exceljs'
import type { GreenBeanExportLineBasisHighlight } from './GreenBeanOrderPage'
import { downloadBufferAsFile } from './monthlyMeetingExcelStyledExport'

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
}

const cellStr = (v: unknown) => (v === null || v === undefined ? '' : String(v))

type GreenBeanRowKind =
  | 'title'
  | 'priceMeta'
  | 'tableHead'
  | 'data'
  | 'footerTotal'
  | 'deduction'
  | 'deductionNet'

const classifyGreenBeanRow = (row: (string | number)[], rowIndex: number): GreenBeanRowKind => {
  if (rowIndex === 0) {
    return 'title'
  }
  const a = cellStr(row[0]).trim()
  if (a === '생두(1kg)' || a.startsWith('생두(1kg)')) {
    return 'priceMeta'
  }
  if (a === '구분') {
    return 'tableHead'
  }
  if (a === '총합') {
    return 'footerTotal'
  }
  if (a === '반영 총액') {
    return 'deductionNet'
  }
  if (a.includes('차감') || a === '기타 감면') {
    return 'deduction'
  }
  return 'data'
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

const moneyFmt = '#,##0'

export type GreenBeanOrderExcelExportOptions = {
  /** matrix 행 인덱스와 동일한 길이. 품목 행에서 총계 산출에 쓰인 공급처 단가 열을 GSC=노랑, 알마=다홍으로 표시 */
  lineBasisHighlightByRow?: (GreenBeanExportLineBasisHighlight | null)[]
}

/** 생두 주문 시트 1개: 제목 머지, 헤더·합계·감면 행 구분, 테두리·열 너비 */
export const exportStyledGreenBeanOrderExcel = async (
  matrix: (string | number)[][],
  downloadFileName: string,
  options?: GreenBeanOrderExcelExportOptions,
): Promise<void> => {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '더심볼 생두 주문'
  const ws = workbook.addWorksheet('생두주문', {
    properties: { defaultRowHeight: 20 },
    views: [{ showGridLines: true, state: 'frozen', ySplit: 3, activeCell: 'A4', topLeftCell: 'A4' }],
  })

  const maxCols = Math.max(1, ...matrix.map((r) => r.length))
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classifyGreenBeanRow(row, r)
    const excelRow = ws.getRow(r + 1)

    for (let c = 0; c < maxCols; c += 1) {
      const cell = excelRow.getCell(c + 1)
      const raw = row[c]
      const isNumber = typeof raw === 'number' && !Number.isNaN(raw)
      cell.value = raw === '' || raw === undefined || raw === null ? null : raw
      cell.border = BORDER as ExcelJS.Borders

      const isLastCol = c === maxCols - 1
      const isQtyCol = c === maxCols - 2

      if (kind === 'title') {
        cell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      } else if (kind === 'priceMeta') {
        cell.font = { size: 10, color: { argb: 'FF475569' }, italic: c > 0 && c < maxCols - 2 }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'center' }
      } else if (kind === 'tableHead') {
        cell.font = { bold: true, size: 10, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEFE3' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: c === 0 ? 'left' : 'right',
        }
      } else if (kind === 'footerTotal') {
        cell.font = { bold: true, size: 11, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
        if (isNumber && (isQtyCol || isLastCol)) {
          cell.numFmt = moneyFmt
        }
      } else if (kind === 'deduction') {
        cell.font = { size: 10, color: { argb: 'FF92400E' }, bold: c === 0 }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
        if (isNumber && isLastCol) {
          cell.numFmt = moneyFmt
        }
      } else if (kind === 'deductionNet') {
        cell.font = { bold: true, size: 11, color: { argb: 'FF14532D' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'right' }
        if (isNumber && isLastCol) {
          cell.numFmt = moneyFmt
        }
      } else {
        const basis = options?.lineBasisHighlightByRow?.[r] ?? null
        const isBasisCell = kind === 'data' && basis !== null && basis.col === c

        cell.alignment = {
          vertical: 'middle',
          horizontal: c === 0 ? 'left' : 'right',
        }
        if (isNumber) {
          cell.numFmt = moneyFmt
        }

        if (isBasisCell && basis.kind === 'gsc') {
          cell.font = { size: 10, bold: true, color: { argb: 'FF854D0E' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } }
        } else if (isBasisCell && basis.kind === 'alma') {
          cell.font = { size: 10, bold: true, color: { argb: 'FF9F1239' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE4E6' } }
        } else {
          cell.font = { size: 10, color: { argb: 'FF0F172A' } }
          if (dataStripe % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
          }
        }
      }
    }

    if (kind === 'data') {
      dataStripe += 1
    }

    if (kind === 'title') {
      excelRow.height = 30
    } else if (kind === 'tableHead' || kind === 'footerTotal' || kind === 'deductionNet') {
      excelRow.height = 22
    }
  })

  try {
    ws.mergeCells(1, 1, 1, maxCols)
  } catch {
    /* ignore */
  }

  const widths = columnCharWidths(matrix, maxCols)
  ws.columns = widths.map((width) => ({ width }))

  const buffer = await workbook.xlsx.writeBuffer()
  downloadBufferAsFile(buffer as ArrayBuffer, downloadFileName)
}
