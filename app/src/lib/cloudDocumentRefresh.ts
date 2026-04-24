import { useEffect, useRef } from 'react'
import type { DocumentSaveState } from './documentSaveUi'

/**
 * `cloudDocRefreshTick`이 오를 때(탭 복귀, 주기) 클라우드 `company_documents`를 다시 읽어
 * 협업 화면이 최신을 따라가게 한다. `dirty`/`saving` 중엔 덮어쓰지 않는다(거래명세 `App`과 동일).
 */
export function useCloudDocumentRefreshPull({
  mode,
  activeCompanyId,
  cloudDocRefreshTick,
  saveState,
  onPull,
}: {
  mode: 'local' | 'cloud'
  activeCompanyId: string | null
  cloudDocRefreshTick: number
  saveState: DocumentSaveState
  onPull: (isCancelled: () => boolean) => Promise<void>
}) {
  const onPullRef = useRef(onPull)
  onPullRef.current = onPull

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId || cloudDocRefreshTick === 0) {
      return
    }
    if (saveState === 'dirty' || saveState === 'saving') {
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    void (async () => {
      try {
        await onPullRef.current(isCancelled)
      } catch (error) {
        console.error('클라우드 다시 읽기에 실패했습니다.', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, cloudDocRefreshTick, mode, saveState])
}
