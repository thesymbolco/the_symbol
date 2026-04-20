import { formatDocumentSaveLabel, type DocumentSaveState, type RuntimeMode } from '../lib/documentSaveUi'

type PageSaveStatusProps = {
  mode: RuntimeMode
  saveState: DocumentSaveState
  lastSavedAt?: string
  onSaveNow?: () => void
  saveButtonLabel?: string
  disabled?: boolean
  className?: string
}

export default function PageSaveStatus({
  mode,
  saveState,
  lastSavedAt,
  onSaveNow,
  saveButtonLabel = '변경 내용 저장',
  disabled = false,
  className = '',
}: PageSaveStatusProps) {
  const label = formatDocumentSaveLabel({ mode, saveState, lastSavedAt })
  const classes = ['page-savebox', className].filter(Boolean).join(' ')

  return (
    <div className={classes} role="status" aria-live="polite">
      <span className={`page-save-state page-save-state--${saveState}`}>{label}</span>
      {mode === 'cloud' && onSaveNow ? (
        <button type="button" className="primary-button page-save-button" onClick={onSaveNow} disabled={disabled}>
          {saveState === 'saving' ? '저장 중...' : saveButtonLabel}
        </button>
      ) : null}
    </div>
  )
}
