import {
  CLOUD_REFERENCE_DATE_PLACEHOLDER,
  withReferenceDateToday,
  type InventoryStatusState,
} from './inventoryStatusUtils'

const STORAGE_BASE = 'inventory-env-reference-dates-v1'

function scopedStorageKey(mode: 'local' | 'cloud', companyId: string | null): string {
  if (mode === 'cloud' && companyId) {
    return `${STORAGE_BASE}::${companyId}`
  }
  return STORAGE_BASE
}

const isoOk = (s: string) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

const isCloudPlaceholderDate = (s: string) => s === CLOUD_REFERENCE_DATE_PLACEHOLDER

function parseStored(raw: string | null): { referenceDate: string; physicalCountDate: string } | null {
  if (!raw) {
    return null
  }
  try {
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return null
    }
    const ref = String((o as { referenceDate?: unknown }).referenceDate ?? '').trim()
    const phys = String((o as { physicalCountDate?: unknown }).physicalCountDate ?? '').trim()
    if (isoOk(ref) && isoOk(phys)) {
      if (isCloudPlaceholderDate(ref) || isCloudPlaceholderDate(phys)) {
        return null
      }
      return { referenceDate: ref, physicalCountDate: phys }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 회사별(클라우드) 이 브라우저만의 기준일·실사 기준일. 클라우드 문서에는 올라가지 않습니다.
 */
export function readEnvironmentReferenceDates(
  mode: 'local' | 'cloud',
  companyId: string | null,
): { referenceDate: string; physicalCountDate: string } | null {
  if (typeof window === 'undefined' || mode !== 'cloud' || !companyId) {
    return null
  }
  const key = scopedStorageKey(mode, companyId)
  const raw = window.localStorage.getItem(key)
  const parsed = parseStored(raw)
  if (!parsed && raw) {
    try {
      const o = JSON.parse(raw) as { referenceDate?: unknown; physicalCountDate?: unknown }
      const ref = String(o?.referenceDate ?? '')
      const phys = String(o?.physicalCountDate ?? '')
      if (isCloudPlaceholderDate(ref) || isCloudPlaceholderDate(phys)) {
        window.localStorage.removeItem(key)
      }
    } catch {
      /* ignore */
    }
  }
  return parsed
}

export function persistEnvironmentReferenceDates(
  mode: 'local' | 'cloud',
  companyId: string | null,
  referenceDate: string,
  physicalCountDate: string,
): void {
  if (typeof window === 'undefined' || mode !== 'cloud' || !companyId) {
    return
  }
  if (
    !isoOk(referenceDate) ||
    !isoOk(physicalCountDate) ||
    isCloudPlaceholderDate(referenceDate) ||
    isCloudPlaceholderDate(physicalCountDate)
  ) {
    return
  }
  try {
    window.localStorage.setItem(
      scopedStorageKey(mode, companyId),
      JSON.stringify({ referenceDate, physicalCountDate }),
    )
  } catch {
    /* ignore quota */
  }
}

/**
 * 클라우드+회사: 로컬에 저장된 날짜가 있으면 그걸 쓰고, 없으면 오늘(로컬)로 맞춥니다.
 * 그 외 모드는 항상 `withReferenceDateToday` 로 기본값(오늘)을 적용합니다.
 */
export function applyEnvironmentReferenceDates(
  state: InventoryStatusState,
  mode: 'local' | 'cloud',
  companyId: string | null,
): InventoryStatusState {
  if (mode === 'cloud' && companyId) {
    const fromDisk = readEnvironmentReferenceDates(mode, companyId)
    if (fromDisk) {
      return {
        ...state,
        referenceDate: fromDisk.referenceDate,
        physicalCountDate: fromDisk.physicalCountDate,
      }
    }
  }
  return withReferenceDateToday(state)
}
