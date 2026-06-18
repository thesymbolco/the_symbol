/** 클라우드 문서 폴링 기본 간격 — Egress 절감 (기존 2.5초 → 15초) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_MS = 15_000

/** 여러 문서를 한 번에 받는 화면(원두별 매출 분석 등) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_SLOW_MS = 20_000

/** 부가 연동용(지출표 등) */
export const CLOUD_DOCUMENT_POLL_INTERVAL_AUX_MS = 20_000

export function shouldRunCloudDocumentPoll(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState === 'visible'
}

type CloudPollController = {
  stop: () => void
}

/**
 * 탭이 보일 때만 주기적으로 poll을 실행합니다.
 * 탭이 다시 보이면 즉시 1회 동기화합니다.
 */
export function startCloudDocumentPoll(
  poll: () => void | Promise<void>,
  intervalMs: number = CLOUD_DOCUMENT_POLL_INTERVAL_MS,
): CloudPollController {
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

  return {
    stop: () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}
