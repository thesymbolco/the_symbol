import ExcelJS from 'exceljs'

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
}

const cellStr = (v: unknown) => (v === null || v === undefined ? '' : String(v))

type RowKind = 'title' | 'section' | 'tableHead' | 'meta' | 'notes' | 'empty' | 'data'

const classifyRow = (row: (string | number)[]): RowKind => {
  const cells = row.map(cellStr)
  if (cells.every((x) => x === '')) {
    return 'empty'
  }
  const a = cells[0].trim()
  if (a.startsWith('[')) {
    return 'title'
  }
  if (a === '매장명') {
    return 'meta'
  }
  if (a === '월' && cells.length <= 4) {
    return 'meta'
  }
  if (a === '회의 요약' || a === '다음 액션') {
    return 'notes'
  }
  if (/^(1\.|1-1\.|1-4\.|1-2\.|1-3\.|2\.|3\.|4\.|5\.)/.test(a)) {
    return 'section'
  }
  if (a === '항목' || a === '거래처명' || (a === '번호' && (cells[1] === '항목' || cells[1] === '거래처명'))) {
    return 'tableHead'
  }
  if (a === '월' && cells.length > 4) {
    return 'tableHead'
  }
  return 'data'
}

const toArrayBuffer = (buffer: ArrayBuffer | Uint8Array) => {
  if (buffer instanceof ArrayBuffer) {
    return buffer
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

export const downloadBufferAsFile = (buffer: ArrayBuffer | Uint8Array, filename: string) => {
  const blob = new Blob([toArrayBuffer(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
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

/** 현재 선택 월 시트 1개, 색·테두리·머리글 구분 적용 */
export const exportStyledMeetingMonthExcel = async (
  sheetName: string,
  matrix: (string | number)[][],
  downloadFileName: string,
): Promise<void> => {
  const safeSheet = sheetName.replace(/[[\]*?:/\\]/g, '-').slice(0, 31) || '월마감'

  const workbook = new ExcelJS.Workbook()
  workbook.creator = '월 마감회의'
  const ws = workbook.addWorksheet(safeSheet, {
    properties: { defaultRowHeight: 18 },
    views: [{ showGridLines: true }],
  })

  const maxCols = Math.max(1, ...matrix.map((r) => r.length))
  let dataStripe = 0

  matrix.forEach((row, r) => {
    const kind = classifyRow(row)
    const excelRow = ws.getRow(r + 1)

    for (let c = 0; c < maxCols; c += 1) {
      const cell = excelRow.getCell(c + 1)
      const raw = row[c]
      cell.value = raw === '' || raw === undefined || raw === null ? null : raw
      cell.border = BORDER as ExcelJS.Borders

      if (kind === 'title') {
        cell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      } else if (kind === 'section') {
        cell.font = { bold: true, size: 11, color: { argb: 'FF1E3A8A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      } else if (kind === 'tableHead') {
        const headCells = row.map(cellStr)
        const isNumberedHead = headCells[0]?.trim() === '번호'
        cell.font = { bold: true, size: 10, color: { argb: 'FF334155' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: isNumberedHead && c === 0 ? 'center' : c === 0 ? 'left' : 'right',
        }
      } else if (kind === 'meta') {
        cell.font = { size: 10, color: { argb: 'FF475569' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.alignment = { vertical: 'middle', horizontal: c === 0 ? 'left' : 'left' }
      } else if (kind === 'notes') {
        if (c === 0) {
          cell.font = { bold: true, size: 10, color: { argb: 'FF1E40AF' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } }
        } else {
          cell.font = { size: 10, color: { argb: 'FF0F172A' } }
          cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' }
        }
      } else if (kind === 'empty') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      } else {
        const s0 = cellStr(row[0]).trim()
        const isLikelyIndexCol =
          c === 0 &&
          (s0 === '—' || /^[①-⑳]$/.test(s0) || /^\d+\.$/.test(s0))
        cell.font = { size: 10, color: { argb: 'FF0F172A' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: isLikelyIndexCol ? 'center' : c === 0 ? 'left' : 'right',
        }
        if (dataStripe % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } }
        }
      }
    }

    if (kind === 'data') {
      dataStripe += 1
    }

    if (kind === 'title') {
      excelRow.height = 28
    } else if (kind === 'section') {
      excelRow.height = 22
    } else if (kind === 'notes') {
      excelRow.height = 36
    }
  })

  try {
    ws.mergeCells(1, 1, 1, maxCols)
  } catch {
    /* ignore */
  }

  matrix.forEach((row, r) => {
    if (classifyRow(row) === 'section') {
      try {
        ws.mergeCells(r + 1, 1, r + 1, maxCols)
      } catch {
        /* ignore */
      }
    }
    if (classifyRow(row) === 'notes' && maxCols > 1) {
      try {
        ws.mergeCells(r + 1, 2, r + 1, maxCols)
      } catch {
        /* ignore */
      }
    }
  })

  const widths = columnCharWidths(matrix, maxCols)
  ws.columns = widths.map((width) => ({ width }))

  const buffer = await workbook.xlsx.writeBuffer()
  downloadBufferAsFile(buffer as ArrayBuffer, downloadFileName)
}

export const sanitizeExcelFileBaseName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60)
