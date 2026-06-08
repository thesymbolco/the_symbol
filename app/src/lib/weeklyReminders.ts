export const WEEKLY_REMINDERS_STORAGE_KEY = 'weekly-reminders-v1'
export const WEEKLY_REMINDER_FIRED_EVENT = 'weekly-reminder-fired'
export const WEEKLY_REMINDERS_CHANGED_EVENT = 'weekly-reminders-changed'

export const WEEKDAY_OPTIONS = [
  { value: 1, label: '월요일' },
  { value: 2, label: '화요일' },
  { value: 3, label: '수요일' },
  { value: 4, label: '목요일' },
  { value: 5, label: '금요일' },
  { value: 6, label: '토요일' },
  { value: 0, label: '일요일' },
] as const

export type WeeklyReminder = {
  id: string
  weekday: number
  time: string
  title: string
  message: string
  enabled: boolean
}

export type WeeklyRemindersState = {
  reminders: WeeklyReminder[]
  masterEnabled: boolean
  lastFired: Record<string, string>
}

export type WeeklyReminderFiredDetail = {
  reminder: WeeklyReminder
  firedAt: string
}

const DEFAULT_STATE: WeeklyRemindersState = {
  reminders: [],
  masterEnabled: true,
  lastFired: {},
}

const FIRE_WINDOW_MS = 10 * 60 * 1000
const LAST_FIRED_RETENTION_DAYS = 14

export const weeklyRemindersScopedKey = (
  base: string,
  mode: 'local' | 'cloud',
  companyId: string | null,
) => (mode === 'cloud' && companyId ? `${base}::${companyId}` : base)

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_OPTIONS.find((option) => option.value === weekday)?.label ?? `${weekday}요일`
}

export function formatReminderSchedule(reminder: WeeklyReminder): string {
  return `${weekdayLabel(reminder.weekday)} ${reminder.time}`
}

export function createWeeklyReminderId(): string {
  return `wr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createEmptyWeeklyReminder(): WeeklyReminder {
  return {
    id: createWeeklyReminderId(),
    weekday: new Date().getDay(),
    time: '09:00',
    title: '',
    message: '',
    enabled: true,
  }
}

export function normalizeReminderTime(value: unknown): string {
  if (typeof value !== 'string') {
    return '09:00'
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) {
    return '09:00'
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeTime(value: unknown): string {
  return normalizeReminderTime(value)
}

function normalizeWeekday(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 6) {
    return 1
  }
  return Math.floor(n)
}

function normalizeReminder(raw: unknown): WeeklyReminder | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const row = raw as Partial<WeeklyReminder>
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const message = typeof row.message === 'string' ? row.message.trim() : ''
  if (!title) {
    return null
  }
  return {
    id: typeof row.id === 'string' && row.id ? row.id : createWeeklyReminderId(),
    weekday: normalizeWeekday(row.weekday),
    time: normalizeTime(row.time),
    title,
    message,
    enabled: row.enabled !== false,
  }
}

export function normalizeWeeklyRemindersState(raw: unknown): WeeklyRemindersState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STATE, lastFired: {} }
  }
  const parsed = raw as Partial<WeeklyRemindersState>
  const reminders = Array.isArray(parsed.reminders)
    ? parsed.reminders.map(normalizeReminder).filter((row): row is WeeklyReminder => row != null)
    : []
  const lastFired =
    parsed.lastFired && typeof parsed.lastFired === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.lastFired).filter(
            ([key, value]) => typeof key === 'string' && typeof value === 'string',
          ),
        )
      : {}
  return {
    reminders,
    masterEnabled: parsed.masterEnabled !== false,
    lastFired: pruneLastFired(lastFired),
  }
}

export function loadWeeklyRemindersState(
  mode: 'local' | 'cloud',
  companyId: string | null,
): WeeklyRemindersState {
  try {
    const key = weeklyRemindersScopedKey(WEEKLY_REMINDERS_STORAGE_KEY, mode, companyId)
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return { ...DEFAULT_STATE, lastFired: {} }
    }
    return normalizeWeeklyRemindersState(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_STATE, lastFired: {} }
  }
}

export function saveWeeklyRemindersState(
  state: WeeklyRemindersState,
  mode: 'local' | 'cloud',
  companyId: string | null,
) {
  const key = weeklyRemindersScopedKey(WEEKLY_REMINDERS_STORAGE_KEY, mode, companyId)
  const payload: WeeklyRemindersState = {
    ...state,
    lastFired: pruneLastFired(state.lastFired),
  }
  window.localStorage.setItem(key, JSON.stringify(payload))
  window.dispatchEvent(new CustomEvent(WEEKLY_REMINDERS_CHANGED_EVENT, { detail: { key } }))
}

function todayLocalIsoDate(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function pruneLastFired(lastFired: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - LAST_FIRED_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(lastFired)) {
    const ts = Date.parse(value)
    if (Number.isFinite(ts) && ts >= cutoff) {
      next[key] = value
    }
  }
  return next
}

export function firedKeyForReminder(reminderId: string, dateIso: string): string {
  return `${reminderId}:${dateIso}`
}

function getReminderScheduleParts(reminder: WeeklyReminder): { hour: number; minute: number } | null {
  const [hourText, minuteText] = reminder.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null
  }
  return { hour, minute }
}

export type NextWeeklyReminder = {
  reminder: WeeklyReminder
  at: Date
}

export function getNextReminderOccurrence(
  reminder: WeeklyReminder,
  now: Date,
  lastFired: Record<string, string>,
): Date | null {
  if (!reminder.enabled) {
    return null
  }
  const parts = getReminderScheduleParts(reminder)
  if (!parts) {
    return null
  }

  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    if (candidate.getDay() !== reminder.weekday) {
      continue
    }
    candidate.setHours(parts.hour, parts.minute, 0, 0)
    const dateIso = todayLocalIsoDate(candidate)
    if (lastFired[firedKeyForReminder(reminder.id, dateIso)]) {
      continue
    }

    if (offset === 0) {
      const diff = now.getTime() - candidate.getTime()
      if (diff <= FIRE_WINDOW_MS) {
        return candidate
      }
      continue
    }

    if (candidate.getTime() > now.getTime()) {
      return candidate
    }
  }
  return null
}

export function msUntilNextWeeklyReminderFire(
  state: WeeklyRemindersState,
  now = new Date(),
): number | null {
  if (!state.masterEnabled) {
    return null
  }
  for (const reminder of state.reminders) {
    if (shouldFireWeeklyReminder(reminder, now, state.lastFired)) {
      return 0
    }
  }
  const next = getNextWeeklyReminder(state, now)
  if (!next) {
    return null
  }
  const ms = next.at.getTime() - now.getTime()
  if (ms <= 0) {
    return null
  }
  const maxDelay = 7 * 24 * 60 * 60 * 1000
  if (ms > maxDelay) {
    return null
  }
  return ms
}

export function getNextWeeklyReminder(
  state: WeeklyRemindersState,
  now = new Date(),
): NextWeeklyReminder | null {
  if (!state.masterEnabled) {
    return null
  }
  let best: NextWeeklyReminder | null = null
  for (const reminder of state.reminders) {
    const at = getNextReminderOccurrence(reminder, now, state.lastFired)
    if (!at) {
      continue
    }
    if (!best || at.getTime() < best.at.getTime()) {
      best = { reminder, at }
    }
  }
  return best
}

export function formatCurrentClock(now = new Date()): string {
  return now.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatNextWeeklyReminderAt(at: Date, now = new Date()): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const todayIso = todayLocalIsoDate(now)
  const atIso = todayLocalIsoDate(at)
  if (atIso === todayIso) {
    return `오늘 ${time}`
  }
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (atIso === todayLocalIsoDate(tomorrow)) {
    return `내일 ${time}`
  }
  const weekday = at.toLocaleDateString('ko-KR', { weekday: 'long' })
  const dayStart = (date: Date) => {
    const copy = new Date(date)
    copy.setHours(0, 0, 0, 0)
    return copy.getTime()
  }
  const daysDiff = Math.round((dayStart(at) - dayStart(now)) / 86_400_000)
  if (daysDiff >= 2 && daysDiff <= 6) {
    return `${weekday} ${time}`
  }
  return `${at.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ${time}`
}

export function shouldFireWeeklyReminder(
  reminder: WeeklyReminder,
  now: Date,
  lastFired: Record<string, string>,
): boolean {
  if (!reminder.enabled) {
    return false
  }
  if (now.getDay() !== reminder.weekday) {
    return false
  }
  const dateIso = todayLocalIsoDate(now)
  const key = firedKeyForReminder(reminder.id, dateIso)
  if (lastFired[key]) {
    return false
  }
  const [hourText, minuteText] = reminder.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false
  }
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  const diff = now.getTime() - scheduled.getTime()
  return diff >= 0 && diff <= FIRE_WINDOW_MS
}

export function collectDueWeeklyReminders(
  state: WeeklyRemindersState,
  now = new Date(),
): WeeklyReminder[] {
  if (!state.masterEnabled) {
    return []
  }
  return state.reminders.filter((reminder) => shouldFireWeeklyReminder(reminder, now, state.lastFired))
}

export function markWeeklyRemindersFired(
  state: WeeklyRemindersState,
  reminders: WeeklyReminder[],
  firedAt = new Date(),
): WeeklyRemindersState {
  if (reminders.length === 0) {
    return state
  }
  const dateIso = todayLocalIsoDate(firedAt)
  const iso = firedAt.toISOString()
  const lastFired = { ...state.lastFired }
  for (const reminder of reminders) {
    lastFired[firedKeyForReminder(reminder.id, dateIso)] = iso
  }
  return {
    ...state,
    lastFired: pruneLastFired(lastFired),
  }
}

export async function requestWeeklyReminderPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') {
    return 'unsupported'
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission
  }
  return Notification.requestPermission()
}

export function showWeeklyReminderBrowserNotification(
  reminder: WeeklyReminder,
  options?: { test?: boolean },
) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false
  }
  try {
    new Notification(reminder.title, {
      body: reminder.message || formatReminderSchedule(reminder),
      tag: options?.test ? `weekly-reminder-test-${Date.now()}` : reminder.id,
      silent: false,
    })
    return true
  } catch {
    return false
  }
}

export function previewWeeklyReminder(reminder: WeeklyReminder): { inApp: true; browser: boolean } {
  dispatchWeeklyReminderFired({ reminder, firedAt: new Date().toISOString() })
  const browser = showWeeklyReminderBrowserNotification(reminder, { test: true })
  return { inApp: true, browser }
}

export function dispatchWeeklyReminderFired(detail: WeeklyReminderFiredDetail) {
  window.dispatchEvent(new CustomEvent(WEEKLY_REMINDER_FIRED_EVENT, { detail }))
}

export function fireWeeklyReminders(
  state: WeeklyRemindersState,
  now = new Date(),
): WeeklyRemindersState {
  const due = collectDueWeeklyReminders(state, now)
  if (due.length === 0) {
    return state
  }
  const firedAt = now.toISOString()
  for (const reminder of due) {
    showWeeklyReminderBrowserNotification(reminder)
    dispatchWeeklyReminderFired({ reminder, firedAt })
  }
  return markWeeklyRemindersFired(state, due, now)
}
