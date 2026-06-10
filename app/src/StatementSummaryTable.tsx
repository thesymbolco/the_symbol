import { useEffect, useMemo, useState } from 'react'

const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => `${index + 1}월`)
const currencyFormatter = new Intl.NumberFormat('ko-KR')

export type StatementSummaryMonthCell = {
  amount: number
  issueDate: string
  paymentDate: string
}

export type StatementSummaryTableRow = {
  clientName: string
  totalAmount: number
  share: number
  months: StatementSummaryMonthCell[]
}

export type StatementSummaryTableMode = 'amounts' | 'dates'

type DateField = 'issueDate' | 'paymentDate'

export type StatementSummaryDateEditKey = `${string}\0${number}\0${DateField}`

export const buildSummaryDateEditKey = (
  clientName: string,
  monthIndex: number,
  field: DateField,
): StatementSummaryDateEditKey => `${clientName}\0${monthIndex}\0${field}`

const formatCurrency = (value: number) => currencyFormatter.format(value)

const formatDateLabel = (value: string) => (value ? value.replaceAll('-', '.') : '')

const monthGroupTone = (monthIndex: number) => (monthIndex % 2 === 0 ? 'even' : 'odd')

const DATE_FIELD_LABEL: Record<DateField, string> = {
  issueDate: '발행일자',
  paymentDate: '입금일자',
}

const parseSummaryDateEditKey = (key: StatementSummaryDateEditKey) => {
  const [clientName, monthIndexText, field] = key.split('\0') as [string, string, DateField]
  return {
    clientName,
    monthIndex: Number(monthIndexText),
    field,
  }
}

type CalendarCell = { key: string; date?: string; day?: number }

const buildCalendarCells = (year: number, monthIndex: number): CalendarCell[] => {
  const month = monthIndex + 1
  const firstDay = new Date(year, monthIndex, 1)
  const daysInMonth = new Date(year, month, 0).getDate()
  const leadingBlanks = firstDay.getDay()
  const cells: CalendarCell[] = []
  for (let i = 0; i < leadingBlanks; i += 1) {
    cells.push({ key: `blank-${i}` })
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    cells.push({ key: dateIso, date: dateIso, day })
  }
  return cells
}

type Props = {
  rows: StatementSummaryTableRow[]
  visibleMonthIndexes: number[]
  monthlyTotals: number[]
  yearlyTotal: number
  selectedYear: string
  mode: StatementSummaryTableMode
  hideEmptyRows?: boolean
  singleMonthLayout?: boolean
  emptyMessage: string
  editingDateKey: StatementSummaryDateEditKey | null
  onEditingDateKeyChange: (key: StatementSummaryDateEditKey | null) => void
  onMonthDateChange: (
    clientName: string,
    monthIndex: number,
    field: DateField,
    value: string,
  ) => void
}

type DatePickerModalProps = {
  selectedYear: string
  clientName: string
  monthIndex: number
  field: DateField
  value: string
  onClose: () => void
  onMonthDateChange: Props['onMonthDateChange']
}

function StatementSummaryDatePickerModal({
  selectedYear,
  clientName,
  monthIndex,
  field,
  value,
  onClose,
  onMonthDateChange,
}: DatePickerModalProps) {
  const year = Number(selectedYear)
  const [viewMonthIndex, setViewMonthIndex] = useState(monthIndex)
  const todayIso = new Date().toISOString().slice(0, 10)
  const calendarCells = useMemo(() => buildCalendarCells(year, viewMonthIndex), [year, viewMonthIndex])

  useEffect(() => {
    setViewMonthIndex(monthIndex)
  }, [monthIndex, clientName, field])

  const handleSelectDate = (dateIso: string) => {
    onMonthDateChange(clientName, monthIndex, field, dateIso)
    onClose()
  }

  const handleClearDate = () => {
    onMonthDateChange(clientName, monthIndex, field, '')
    onClose()
  }

  return (
    <div
      className="inventory-reset-dialog-backdrop statement-summary-date-picker-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="statement-summary-date-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="statement-summary-date-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="statement-summary-date-picker-title" className="statement-summary-date-picker-title">
          {DATE_FIELD_LABEL[field]} 선택
        </h2>
        <p className="statement-summary-date-picker-meta">
          <strong>{clientName}</strong>
          <span>·</span>
          <span>{selectedYear}년 {MONTH_LABELS[monthIndex]}</span>
        </p>
        <div className="statement-summary-date-picker-toolbar">
          <button
            type="button"
            className="ghost-button small"
            disabled={viewMonthIndex <= 0}
            onClick={() => setViewMonthIndex((current) => Math.max(0, current - 1))}
            aria-label="이전 달"
          >
            ◀
          </button>
          <strong>{selectedYear}년 {MONTH_LABELS[viewMonthIndex]}</strong>
          <button
            type="button"
            className="ghost-button small"
            disabled={viewMonthIndex >= 11}
            onClick={() => setViewMonthIndex((current) => Math.min(11, current + 1))}
            aria-label="다음 달"
          >
            ▶
          </button>
        </div>
        <div className="statement-summary-date-picker-grid" role="grid" aria-label={`${selectedYear}년 ${MONTH_LABELS[viewMonthIndex]} 달력`}>
          {['일', '월', '화', '수', '목', '금', '토'].map((dow) => (
            <div key={dow} className="statement-summary-date-picker-dow">
              {dow}
            </div>
          ))}
          {calendarCells.map((cell) => {
            if (!cell.date || cell.day == null) {
              return <div key={cell.key} className="statement-summary-date-picker-day is-blank" aria-hidden />
            }
            const isSelected = value === cell.date
            const isToday = cell.date === todayIso
            return (
              <button
                key={cell.key}
                type="button"
                className={[
                  'statement-summary-date-picker-day',
                  isSelected ? 'is-selected' : '',
                  isToday ? 'is-today' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => handleSelectDate(cell.date!)}
                aria-pressed={isSelected}
                aria-label={`${cell.day}일${isSelected ? ' 선택됨' : ''}`}
              >
                {cell.day}
              </button>
            )
          })}
        </div>
        <div className="statement-summary-date-picker-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="ghost-button" onClick={handleClearDate} disabled={!value}>
            날짜 지우기
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryAmountCell({ amount }: { amount: number }) {
  if (!amount) {
    return <span className="summary-amount-empty">—</span>
  }
  return <span className="summary-amount-value">{formatCurrency(amount)}</span>
}

function SummaryDateCell({
  clientName,
  monthIndex,
  field,
  value,
  onEditingDateKeyChange,
}: {
  clientName: string
  monthIndex: number
  field: DateField
  value: string
  onEditingDateKeyChange: (key: StatementSummaryDateEditKey | null) => void
}) {
  const editKey = buildSummaryDateEditKey(clientName, monthIndex, field)

  return (
    <button
      type="button"
      className={`summary-date-read${value ? '' : ' summary-date-read--empty'}`}
      title="클릭하면 달력에서 날짜를 선택합니다"
      onClick={() => onEditingDateKeyChange(editKey)}
    >
      {value ? formatDateLabel(value) : '—'}
    </button>
  )
}

export default function StatementSummaryTable({
  rows,
  visibleMonthIndexes,
  monthlyTotals,
  yearlyTotal,
  selectedYear,
  mode,
  hideEmptyRows = false,
  singleMonthLayout = false,
  emptyMessage,
  editingDateKey,
  onEditingDateKeyChange,
  onMonthDateChange,
}: Props) {
  const editingDateContext = useMemo(() => {
    if (!editingDateKey) {
      return null
    }
    const parsed = parseSummaryDateEditKey(editingDateKey)
    const row = rows.find((entry) => entry.clientName === parsed.clientName)
    const value = row?.months[parsed.monthIndex]?.[parsed.field] ?? ''
    return { ...parsed, value }
  }, [editingDateKey, rows])

  useEffect(() => {
    if (!editingDateKey) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEditingDateKeyChange(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editingDateKey, onEditingDateKeyChange])

  const displayRows = hideEmptyRows
    ? rows.filter((row) => visibleMonthIndexes.some((monthIndex) => row.months[monthIndex]?.amount > 0))
    : rows

  const columnCount =
    mode === 'amounts' ? 4 + visibleMonthIndexes.length : 4 + visibleMonthIndexes.length * 3

  const tableClassName = [
    'summary-table',
    mode === 'amounts' ? 'summary-table--amounts' : 'summary-table--dates',
    singleMonthLayout ? 'summary-table--single-month' : 'summary-table--all-months',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
    <table className={tableClassName}>
      <thead>
        {mode === 'amounts' ? (
          <tr>
            <th className="summary-sticky-col summary-sticky-no" scope="col">
              NO
            </th>
            <th className="summary-sticky-col summary-sticky-client" scope="col">
              거래처명
            </th>
            <th className="summary-col-total" scope="col">
              합계
            </th>
            <th className="summary-col-share" scope="col">
              점유율
            </th>
            {visibleMonthIndexes.map((monthIndex) => (
              <th
                key={MONTH_LABELS[monthIndex]}
                scope="col"
                className={`summary-month-head summary-month-head--${monthGroupTone(monthIndex)} summary-month-boundary-start`}
              >
                {MONTH_LABELS[monthIndex]}
              </th>
            ))}
          </tr>
        ) : (
          <>
            <tr>
              <th className="summary-sticky-col summary-sticky-no" rowSpan={2} scope="col">
                NO
              </th>
              <th className="summary-sticky-col summary-sticky-client" rowSpan={2} scope="col">
                거래처명
              </th>
              <th className="summary-col-total" rowSpan={2} scope="col">
                합계
              </th>
              <th className="summary-col-share" rowSpan={2} scope="col">
                점유율
              </th>
              {visibleMonthIndexes.map((monthIndex) => (
                <th
                  key={MONTH_LABELS[monthIndex]}
                  colSpan={3}
                  scope="colgroup"
                  className={`summary-month-head summary-month-head--${monthGroupTone(monthIndex)} summary-month-boundary-start`}
                >
                  {MONTH_LABELS[monthIndex]}
                </th>
              ))}
            </tr>
            <tr>
              {visibleMonthIndexes.flatMap((monthIndex) => [
                <th
                  key={`${MONTH_LABELS[monthIndex]}-amount`}
                  scope="col"
                  className={`summary-month-subhead summary-month-subhead--${monthGroupTone(monthIndex)} summary-month-boundary-start`}
                >
                  금액
                </th>,
                <th
                  key={`${MONTH_LABELS[monthIndex]}-issue`}
                  scope="col"
                  className={`summary-month-subhead summary-month-subhead--${monthGroupTone(monthIndex)}`}
                >
                  발행
                </th>,
                <th
                  key={`${MONTH_LABELS[monthIndex]}-payment`}
                  scope="col"
                  className={`summary-month-subhead summary-month-subhead--${monthGroupTone(monthIndex)}`}
                >
                  입금
                </th>,
              ])}
            </tr>
          </>
        )}
      </thead>
      <tbody>
        {displayRows.length === 0 ? (
          <tr>
            <td colSpan={columnCount} className="empty-state">
              {emptyMessage}
            </td>
          </tr>
        ) : (
          displayRows.map((row, index) => (
            <tr key={row.clientName}>
              <td className="summary-sticky-col summary-sticky-no">{index + 1}</td>
              <td className="summary-sticky-col summary-sticky-client" title={row.clientName}>
                {row.clientName}
              </td>
              <td className="summary-col-total">
                <SummaryAmountCell amount={row.totalAmount} />
              </td>
              <td className="summary-col-share">
                <span className="summary-share-wrap" title={`${row.share.toFixed(1)}%`}>
                  <span className="summary-share-track" aria-hidden>
                    <span className="summary-share-bar" style={{ width: `${Math.min(row.share, 100)}%` }} />
                  </span>
                  <span className="summary-share-label">{row.share.toFixed(1)}%</span>
                </span>
              </td>
              {mode === 'amounts'
                ? visibleMonthIndexes.map((monthIndex) => {
                    const month = row.months[monthIndex]!
                    return (
                      <td
                        key={`${row.clientName}-${monthIndex}-amount`}
                        className={`summary-amount-cell summary-month-cell summary-month-cell--${monthGroupTone(monthIndex)} summary-month-boundary-start`}
                      >
                        <SummaryAmountCell amount={month.amount} />
                      </td>
                    )
                  })
                : visibleMonthIndexes.flatMap((monthIndex) => {
                    const month = row.months[monthIndex]!
                    const tone = monthGroupTone(monthIndex)
                    return [
                      <td
                        key={`${row.clientName}-${monthIndex}-amount`}
                        className={`summary-amount-cell summary-month-cell summary-month-cell--${tone} summary-month-boundary-start`}
                      >
                        <SummaryAmountCell amount={month.amount} />
                      </td>,
                      <td
                        key={`${row.clientName}-${monthIndex}-issue`}
                        className={`summary-date-cell summary-month-cell summary-month-cell--${tone}`}
                      >
                        <SummaryDateCell
                          clientName={row.clientName}
                          monthIndex={monthIndex}
                          field="issueDate"
                          value={month.issueDate}
                          onEditingDateKeyChange={onEditingDateKeyChange}
                        />
                      </td>,
                      <td
                        key={`${row.clientName}-${monthIndex}-payment`}
                        className={`summary-date-cell summary-month-cell summary-month-cell--${tone}`}
                      >
                        <SummaryDateCell
                          clientName={row.clientName}
                          monthIndex={monthIndex}
                          field="paymentDate"
                          value={month.paymentDate}
                          onEditingDateKeyChange={onEditingDateKeyChange}
                        />
                      </td>,
                    ]
                  })}
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr className="summary-total-row">
          <td className="summary-sticky-col summary-sticky-no" colSpan={2}>
            합계
          </td>
          <td className="summary-col-total">
            <span className="summary-amount-value">{formatCurrency(yearlyTotal)}</span>
          </td>
          <td className="summary-col-share">100%</td>
          {mode === 'amounts'
            ? visibleMonthIndexes.map((monthIndex) => (
                <td
                  key={`total-${monthIndex}`}
                  className={`summary-amount-cell summary-month-cell summary-month-cell--${monthGroupTone(monthIndex)} summary-month-boundary-start`}
                >
                  <SummaryAmountCell amount={monthlyTotals[monthIndex] ?? 0} />
                </td>
              ))
            : visibleMonthIndexes.flatMap((monthIndex) => {
                const tone = monthGroupTone(monthIndex)
                return [
                  <td
                    key={`total-${monthIndex}-amount`}
                    className={`summary-amount-cell summary-month-cell summary-month-cell--${tone} summary-month-boundary-start`}
                  >
                    <SummaryAmountCell amount={monthlyTotals[monthIndex] ?? 0} />
                  </td>,
                  <td
                    key={`total-${monthIndex}-issue`}
                    className={`summary-month-cell summary-month-cell--${tone}`}
                  />,
                  <td
                    key={`total-${monthIndex}-payment`}
                    className={`summary-month-cell summary-month-cell--${tone}`}
                  />,
                ]
              })}
        </tr>
      </tfoot>
    </table>
    {editingDateContext ? (
      <StatementSummaryDatePickerModal
        selectedYear={selectedYear}
        clientName={editingDateContext.clientName}
        monthIndex={editingDateContext.monthIndex}
        field={editingDateContext.field}
        value={editingDateContext.value}
        onClose={() => onEditingDateKeyChange(null)}
        onMonthDateChange={onMonthDateChange}
      />
    ) : null}
    </>
  )
}
