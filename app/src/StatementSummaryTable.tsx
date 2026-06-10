import { useEffect } from 'react'

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

type Props = {
  rows: StatementSummaryTableRow[]
  visibleMonthIndexes: number[]
  monthlyTotals: number[]
  yearlyTotal: number
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
  editingDateKey,
  onEditingDateKeyChange,
  onMonthDateChange,
}: {
  clientName: string
  monthIndex: number
  field: DateField
  value: string
  editingDateKey: StatementSummaryDateEditKey | null
  onEditingDateKeyChange: (key: StatementSummaryDateEditKey | null) => void
  onMonthDateChange: Props['onMonthDateChange']
}) {
  const editKey = buildSummaryDateEditKey(clientName, monthIndex, field)
  const isEditing = editingDateKey === editKey

  if (isEditing) {
    return (
      <input
        type="date"
        className="statement-summary-date-input"
        value={value}
        autoFocus
        onChange={(event) => onMonthDateChange(clientName, monthIndex, field, event.target.value)}
        onBlur={() => onEditingDateKeyChange(null)}
      />
    )
  }

  return (
    <button
      type="button"
      className={`summary-date-read${value ? '' : ' summary-date-read--empty'}`}
      title="클릭하면 날짜를 입력·수정합니다"
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
  mode,
  hideEmptyRows = false,
  singleMonthLayout = false,
  emptyMessage,
  editingDateKey,
  onEditingDateKeyChange,
  onMonthDateChange,
}: Props) {
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
                          editingDateKey={editingDateKey}
                          onEditingDateKeyChange={onEditingDateKeyChange}
                          onMonthDateChange={onMonthDateChange}
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
                          editingDateKey={editingDateKey}
                          onEditingDateKeyChange={onEditingDateKeyChange}
                          onMonthDateChange={onMonthDateChange}
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
  )
}
