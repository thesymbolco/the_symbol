import type { RealtimeChannel } from '@supabase/supabase-js'
import type { CompanyDocumentKey } from './companyDocuments'
import { supabase } from './supabase'

/** Realtime 보조 — 변경 없을 때 REST 폴백 간격 (기존 15초 → 60초) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_MS = 60_000

/** 여러 문서를 한 번에 받는 화면(원두별 매출 분석 등) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_SLOW_MS = 60_000

/** 부가 연동용(지출표 등) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_AUX_MS = 60_000

const REALTIME_POLL_DEBOUNCE_MS = 300

export function shouldRunCloudDocumentPoll(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState === 'visible'
}

type CloudPollController = {
  stop: () => void
}

type CloudDocumentSyncOptions = {
  poll: () => void | Promise<void>
  intervalMs?: number
  companyId?: string
  docKeys?: readonly CompanyDocumentKey[]
  realtimeSelect?: string[]
  /** 본인 저장 Realtime 이벤트는 스킵 (이미 로컬 반영됨) */
  currentUserId?: string | null
}

function subscribeCompanyDocumentChanges(
  companyId: string,
  docKeys: readonly CompanyDocumentKey[],
  onRemoteChange: () => void,
  realtimeSelect: string[] | undefined,
  currentUserId?: string | null,
): () => void {
  if (!supabase || docKeys.length === 0) {
    return () => {}
  }

  const docKeySet = new Set<string>(docKeys)
  let debounceId: number | undefined
  let channel: RealtimeChannel | null = null

  const schedulePoll = () => {
    if (debounceId !== undefined) {
      window.clearTimeout(debounceId)
    }
    debounceId = window.setTimeout(() => {
      debounceId = undefined
      onRemoteChange()
    }, REALTIME_POLL_DEBOUNCE_MS)
  }

  const changeConfig: {
    event: '*'
    schema: 'public'
    table: 'company_documents'
    filter: string
    select?: string[]
  } = {
    event: '*',
    schema: 'public',
    table: 'company_documents',
    filter: `company_id=eq.${companyId}`,
  }
  if (realtimeSelect && realtimeSelect.length > 0) {
    changeConfig.select = realtimeSelect
  }

  channel = supabase
    .channel(`company-documents:${companyId}:${docKeys.join('|')}`)
    .on(
      'postgres_changes',
      changeConfig,
      (payload) => {
        const row = payload.new as { doc_key?: unknown; updated_by?: unknown } | null | undefined
        const docKey = typeof row?.doc_key === 'string' ? row.doc_key : ''
        if (!docKeySet.has(docKey)) {
          return
        }
        const updatedBy = typeof row?.updated_by === 'string' ? row.updated_by : null
        if (currentUserId && updatedBy === currentUserId) {
          return
        }
        schedulePoll()
      },
    )
    .subscribe()

  return () => {
    if (debounceId !== undefined) {
      window.clearTimeout(debounceId)
    }
    if (channel && supabase) {
      void supabase.removeChannel(channel)
    }
    channel = null
  }
}

/**
 * Realtime(저장 시) + 느린 폴백 폴링 + 탭 복귀 시 1회 동기화.
 */
export function startCloudDocumentSync({
  poll,
  intervalMs = CLOUD_DOCUMENT_POLL_INTERVAL_MS,
  companyId,
  docKeys = [],
  realtimeSelect,
  currentUserId,
}: CloudDocumentSyncOptions): CloudPollController {
  let cancelled = false
  let inFlight = false

  const run = async () => {
    if (cancelled || inFlight || !shouldRunCloudDocumentPoll()) {
      return
    }
    inFlight = true
    try {
      await poll()
    } catch {
      /* retry next cycle */
    } finally {
      inFlight = false
    }
  }

  void run()
  const intervalId = window.setInterval(() => void run(), intervalMs)

  const onVisibilityChange = () => {
    if (!cancelled && shouldRunCloudDocumentPoll()) {
      void run()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  const unsubscribeRealtime =
    companyId && docKeys.length > 0
      ? subscribeCompanyDocumentChanges(companyId, docKeys, () => {
          if (!cancelled) {
            void run()
          }
        }, realtimeSelect, currentUserId)
      : () => {}

  return {
    stop: () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribeRealtime()
    },
  }
}

/** @deprecated startCloudDocumentSync 사용 */
export function startCloudDocumentPoll(
  poll: () => void | Promise<void>,
  intervalMs: number = CLOUD_DOCUMENT_POLL_INTERVAL_MS,
): CloudPollController {
  return startCloudDocumentSync({ poll, intervalMs })
}
