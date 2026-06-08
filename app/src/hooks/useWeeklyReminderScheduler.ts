import { useCallback, useEffect, useRef } from 'react'
import {
  fireWeeklyReminders,
  loadWeeklyRemindersState,
  msUntilNextWeeklyReminderFire,
  saveWeeklyRemindersState,
  WEEKLY_REMINDERS_CHANGED_EVENT,
  WEEKLY_REMINDERS_STORAGE_KEY,
  weeklyRemindersScopedKey,
} from '../lib/weeklyReminders'

const POLL_MS = 5_000
const MAX_TIMEOUT_MS = 2_147_483_647

function lastFiredChanged(before: Record<string, string>, after: Record<string, string>): boolean {
  const beforeKeys = Object.keys(before)
  const afterKeys = Object.keys(after)
  if (beforeKeys.length !== afterKeys.length) {
    return true
  }
  return afterKeys.some((key) => before[key] !== after[key])
}

export function useWeeklyReminderScheduler(
  mode: 'local' | 'cloud',
  companyId: string | null,
  enabled = true,
) {
  const timeoutRef = useRef<number | null>(null)

  const runFire = useCallback(() => {
    const current = loadWeeklyRemindersState(mode, companyId)
    const next = fireWeeklyReminders(current)
    if (lastFiredChanged(current.lastFired, next.lastFired)) {
      saveWeeklyRemindersState(next, mode, companyId)
    }
    return next
  }, [mode, companyId])

  const scheduleNext = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (!enabled) {
      return
    }

    runFire()

    const state = loadWeeklyRemindersState(mode, companyId)
    const delay = msUntilNextWeeklyReminderFire(state)
    if (delay == null) {
      return
    }

    const safeDelay = Math.min(Math.max(0, delay), MAX_TIMEOUT_MS)
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      runFire()
      scheduleNext()
    }, safeDelay)
  }, [enabled, mode, companyId, runFire])

  useEffect(() => {
    scheduleNext()

    const intervalId = window.setInterval(() => {
      runFire()
    }, POLL_MS)

    const scopedKey = weeklyRemindersScopedKey(WEEKLY_REMINDERS_STORAGE_KEY, mode, companyId)
    const onStorage = (event: StorageEvent) => {
      if (event.key != null && event.key !== scopedKey) {
        return
      }
      scheduleNext()
    }
    const onChanged = () => {
      scheduleNext()
    }
    const onWake = () => {
      scheduleNext()
    }

    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('storage', onStorage)
    window.addEventListener(WEEKLY_REMINDERS_CHANGED_EVENT, onChanged)

    return () => {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(WEEKLY_REMINDERS_CHANGED_EVENT, onChanged)
    }
  }, [mode, companyId, enabled, runFire, scheduleNext])
}
