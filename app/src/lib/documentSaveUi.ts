import { useCallback, useRef, useState } from 'react'

export type RuntimeMode = 'local' | 'cloud'
export type DocumentSaveState = 'saved' | 'dirty' | 'saving' | 'error'

type DocumentSaveLabelInput = {
  mode: RuntimeMode
  saveState: DocumentSaveState
  lastSavedAt?: string
}

export function formatDocumentSaveLabel({ mode, saveState, lastSavedAt }: DocumentSaveLabelInput): string {
  if (mode !== 'cloud') {
    return '브라우저 저장'
  }

  if (saveState === 'saving') {
    return '저장 중...'
  }

  if (saveState === 'dirty') {
    return '저장 필요'
  }

  if (saveState === 'error') {
    return '저장 실패'
  }

  if (!lastSavedAt) {
    return '저장됨'
  }

  return `저장됨 ${new Date(lastSavedAt).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

export function useDocumentSaveUi(mode: RuntimeMode) {
  const [saveState, setSaveState] = useState<DocumentSaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState('')
  const hasHydratedRef = useRef(false)

  const resetDocumentSaveUi = useCallback(() => {
    hasHydratedRef.current = false
    setSaveState('saved')
    setLastSavedAt('')
  }, [])

  const skipInitialDocumentSave = useCallback(() => {
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true
      return true
    }

    return false
  }, [])

  const markDocumentDirty = useCallback(() => {
    if (mode === 'cloud') {
      setSaveState('dirty')
    }
  }, [mode])

  const markDocumentSaving = useCallback(() => {
    if (mode === 'cloud') {
      setSaveState('saving')
    }
  }, [mode])

  const markDocumentSaved = useCallback(() => {
    if (mode === 'cloud') {
      setSaveState('saved')
      setLastSavedAt(new Date().toISOString())
    }
  }, [mode])

  const markDocumentError = useCallback(() => {
    if (mode === 'cloud') {
      setSaveState('error')
    }
  }, [mode])

  return {
    lastSavedAt,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    resetDocumentSaveUi,
    saveState,
    skipInitialDocumentSave,
  }
}
