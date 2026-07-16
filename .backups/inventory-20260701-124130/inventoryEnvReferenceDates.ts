import type { InventoryStatusState } from './inventoryStatusUtils'

const LEGACY_OVERLAY_KEYS = ['inventory-env-reference-dates-v1']

/**
 * 폴링으로 받은 본문(재고표 등)은 반영하고, 화면에 이미 선택된 기준일·실사일만 유지합니다.
 * 클라우드에는 날짜가 들어가지 않으므로 remote 쪽 플레이스홀더를 덮어씌웁니다.
 */
export function mergeKeepViewerReferenceDates(
  incomingFromRemote: InventoryStatusState,
  viewerDates: Pick<InventoryStatusState, 'referenceDate' | 'physicalCountDate'>,
): InventoryStatusState {
  return {
    ...incomingFromRemote,
    referenceDate: viewerDates.referenceDate,
    physicalCountDate: viewerDates.physicalCountDate,
  }
}

/** 예전 브라우저 전용 저장(재고도 동기 안 함) 레거시 키 제거 — 새 방식에서는 세션 안에서만 날 유지 */
export function clearLegacyViewerReferenceOverlayLocalStorage(
  mode: 'local' | 'cloud',
  companyId: string | null,
): void {
  if (typeof window === 'undefined') {
    return
  }
  if (mode === 'cloud' && companyId) {
    try {
      window.localStorage.removeItem(`${LEGACY_OVERLAY_KEYS[0]}::${companyId}`)
    } catch {
      /* ignore */
    }
  }
  try {
    window.localStorage.removeItem(LEGACY_OVERLAY_KEYS[0])
  } catch {
    /* ignore */
  }
}
