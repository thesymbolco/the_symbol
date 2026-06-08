import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createEmptyWeeklyReminder,
  createWeeklyReminderId,
  formatCurrentClock,
  formatNextWeeklyReminderAt,
  getNextWeeklyReminder,
  loadWeeklyRemindersState,
  normalizeWeeklyRemindersState,
  normalizeReminderTime,
  previewWeeklyReminder,
  requestWeeklyReminderPermission,
  saveWeeklyRemindersState,
  WEEKDAY_OPTIONS,
  type WeeklyReminder,
  type WeeklyRemindersState,
} from './lib/weeklyReminders'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export default function WeeklyReminderPage() {
  const { mode, activeCompanyId } = useAppRuntime()
  const [state, setState] = useState<WeeklyRemindersState>(() =>
    loadWeeklyRemindersState(mode, activeCompanyId),
  )
  const [draft, setDraft] = useState<WeeklyReminder>(() => createEmptyWeeklyReminder())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('브라우저에 자동 저장됩니다.')
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const [previewReminder, setPreviewReminder] = useState<WeeklyReminder | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const syncNow = () => setNow(new Date())
    syncNow()
    const id = window.setInterval(syncNow, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const nextReminder = useMemo(() => getNextWeeklyReminder(state, now), [state, now])

  const persist = useCallback(
    (next: WeeklyRemindersState) => {
      const normalized = normalizeWeeklyRemindersState(next)
      setState(normalized)
      saveWeeklyRemindersState(normalized, mode, activeCompanyId)
    },
    [mode, activeCompanyId],
  )

  useEffect(() => {
    setState(loadWeeklyRemindersState(mode, activeCompanyId))
    setEditingId(null)
    setDraft(createEmptyWeeklyReminder())
  }, [mode, activeCompanyId])

  const sortedReminders = useMemo(
    () =>
      [...state.reminders].sort((a, b) => {
        const order = (weekday: number) => (weekday === 0 ? 7 : weekday)
        return order(a.weekday) - order(b.weekday) || a.time.localeCompare(b.time)
      }),
    [state.reminders],
  )

  const remindersByWeekday = useMemo(() => {
    const map = new Map<number, WeeklyReminder[]>()
    for (const option of WEEKDAY_OPTIONS) {
      map.set(option.value, [])
    }
    for (const reminder of sortedReminders) {
      const bucket = map.get(reminder.weekday) ?? []
      bucket.push(reminder)
      map.set(reminder.weekday, bucket)
    }
    return map
  }, [sortedReminders])

  const resetDraft = () => {
    setDraft(createEmptyWeeklyReminder())
    setEditingId(null)
  }

  const upsertDraft = () => {
    const title = draft.title.trim()
    if (!title) {
      setStatusMessage('할 일 제목을 입력해 주세요.')
      return
    }
    const nextReminder: WeeklyReminder = {
      ...draft,
      id: editingId ?? createWeeklyReminderId(),
      title,
      message: draft.message.trim(),
      time: normalizeReminderTime(draft.time),
    }
    const nextReminders = editingId
      ? state.reminders.map((row) => (row.id === editingId ? nextReminder : row))
      : [...state.reminders, nextReminder]
    persist({ ...state, reminders: nextReminders })
    setStatusMessage(editingId ? '알림을 수정했습니다.' : '알림을 추가했습니다.')
    resetDraft()
  }

  const startEdit = (reminder: WeeklyReminder) => {
    setDraft({ ...reminder })
    setEditingId(reminder.id)
    setStatusMessage('수정 중입니다. 아래에서 저장하세요.')
  }

  const removeReminder = (id: string) => {
    persist({ ...state, reminders: state.reminders.filter((row) => row.id !== id) })
    if (editingId === id) {
      resetDraft()
    }
    setStatusMessage('알림을 삭제했습니다.')
  }

  const toggleReminder = (id: string) => {
    persist({
      ...state,
      reminders: state.reminders.map((row) =>
        row.id === id ? { ...row, enabled: !row.enabled } : row,
      ),
    })
  }

  const toggleMaster = () => {
    persist({ ...state, masterEnabled: !state.masterEnabled })
    setStatusMessage(state.masterEnabled ? '주간 알림을 껐습니다.' : '주간 알림을 켰습니다.')
  }

  const requestPermission = async () => {
    const result = await requestWeeklyReminderPermission()
    setNotificationPermission(result)
    if (result === 'granted') {
      setStatusMessage('브라우저 알림 권한이 허용되었습니다.')
    } else if (result === 'denied') {
      setStatusMessage('브라우저 알림이 차단되었습니다. 브라우저 설정에서 허용해 주세요.')
    } else if (result === 'unsupported') {
      setStatusMessage('이 브라우저는 알림을 지원하지 않습니다. 화면 안내로 대체됩니다.')
    } else {
      setStatusMessage('알림 권한 요청이 취소되었습니다.')
    }
  }

  const sendTestNotification = () => {
    const sample: WeeklyReminder = {
      id: `test-${Date.now()}`,
      weekday: new Date().getDay(),
      time: '09:00',
      title: draft.title.trim() || '주간 알림 테스트',
      message: draft.message.trim() || '설정한 시간에 이런 알림이 뜹니다.',
      enabled: true,
    }
    const { browser } = previewWeeklyReminder(sample)
    setPreviewReminder(sample)
    setStatusMessage(
      browser
        ? '테스트 알림을 보냈습니다. 화면 왼쪽 하단 미리보기도 확인해 주세요.'
        : '화면 왼쪽 하단에 미리보기를 표시했습니다. 브라우저 알림은 탭이 열려 있거나 집중 모드일 때 안 보일 수 있습니다.',
    )
  }

  return (
    <section className="weekly-reminder-page">
      <header className="weekly-reminder-page-head">
        <div>
          <h3>요일별 주간 알림</h3>
          <p className="muted">
            매주 같은 요일·시간에 할 일 알림을 띄웁니다. 이 브라우저 탭이 열려 있어야 예약 시간에
            알림이 울립니다. 요일은 오늘(
            {WEEKDAY_OPTIONS.find((option) => option.value === now.getDay())?.label ?? ''}) 기준으로 맞춰 주세요.
          </p>
        </div>
        <div className="weekly-reminder-page-head-actions">
          <label className="weekly-reminder-master-toggle">
            <input type="checkbox" checked={state.masterEnabled} onChange={toggleMaster} />
            <span>알림 사용</span>
          </label>
          <span className="weekly-reminder-status muted tiny">{statusMessage}</span>
          <span className="weekly-reminder-clock muted tiny">
            현재 {formatCurrentClock(now)}
            {nextReminder
              ? ` · 다음 알림 ${formatNextWeeklyReminderAt(nextReminder.at, now)} · ${nextReminder.reminder.title}`
              : state.reminders.length > 0 && !state.masterEnabled
                ? ' · 알림 사용이 꺼져 있습니다'
                : state.reminders.length > 0
                  ? ' · 예정된 다음 알림 없음'
                  : ''}
          </span>
        </div>
      </header>

      <div className="weekly-reminder-permission-card">
        <div>
          <strong>브라우저 알림</strong>
          <p className="muted tiny">
            {notificationPermission === 'granted'
              ? '허용됨 — 예약 시간에 OS 알림이 뜹니다.'
              : notificationPermission === 'denied'
                ? '차단됨 — 화면 안내(토스트)만 표시됩니다.'
                : notificationPermission === 'unsupported'
                  ? '미지원 — 화면 안내(토스트)만 표시됩니다.'
                  : '아직 허용 전 — 권한을 허용하면 OS 알림을 받을 수 있습니다.'}
          </p>
        </div>
        <div className="weekly-reminder-permission-actions">
          <button type="button" className="ghost-button small-hit" onClick={() => void requestPermission()}>
            권한 요청
          </button>
          <button type="button" className="ghost-button small-hit" onClick={sendTestNotification}>
            테스트
          </button>
        </div>
      </div>

      {previewReminder ? (
        <div className="weekly-reminder-preview-card" role="status" aria-live="polite">
          <strong>방금 보낸 미리보기</strong>
          <p>{previewReminder.title}</p>
          {previewReminder.message ? <p className="muted tiny">{previewReminder.message}</p> : null}
          <p className="muted tiny">
            예약 시간에도 화면 왼쪽 하단에 이렇게 표시됩니다. OS 알림은 브라우저·집중 모드 설정에 따라
            따로 뜨지 않을 수 있습니다.
          </p>
        </div>
      ) : null}

      <div className="weekly-reminder-layout">
        <section className="weekly-reminder-form-card">
          <h4>{editingId ? '알림 수정' : '알림 추가'}</h4>
          <div className="weekly-reminder-form-grid">
            <label>
              요일
              <select
                value={draft.weekday}
                onChange={(event) => setDraft((current) => ({ ...current, weekday: Number(event.target.value) }))}
              >
                {WEEKDAY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              시간
              <input
                type="time"
                value={draft.time}
                onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))}
              />
            </label>
            <label className="weekly-reminder-form-span">
              할 일
              <input
                type="text"
                value={draft.title}
                placeholder="예: 입출고 현황 점검"
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
            <label className="weekly-reminder-form-span">
              메모 (선택)
              <textarea
                rows={2}
                value={draft.message}
                placeholder="알림 본문에 함께 표시됩니다."
                onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
              />
            </label>
          </div>
          <div className="weekly-reminder-form-actions">
            {editingId ? (
              <button type="button" className="ghost-button small-hit" onClick={resetDraft}>
                취소
              </button>
            ) : null}
            <button type="button" className="primary-button small-hit" onClick={upsertDraft}>
              {editingId ? '저장' : '추가'}
            </button>
          </div>
        </section>

        <section className="weekly-reminder-list-card">
          <h4>등록된 알림 {state.reminders.length}건</h4>
          {state.reminders.length === 0 ? (
            <p className="weekly-reminder-empty muted">아직 등록된 알림이 없습니다.</p>
          ) : (
            <div className="weekly-reminder-weekday-grid">
              {WEEKDAY_OPTIONS.map((option) => {
                const rows = remindersByWeekday.get(option.value) ?? []
                return (
                  <div key={option.value} className="weekly-reminder-weekday-block">
                    <div className="weekly-reminder-weekday-label">{option.label}</div>
                    {rows.length === 0 ? (
                      <p className="weekly-reminder-weekday-empty muted tiny">없음</p>
                    ) : (
                      <ul className="weekly-reminder-items">
                        {rows.map((reminder) => (
                          <li
                            key={reminder.id}
                            className={`weekly-reminder-item${reminder.enabled ? '' : ' is-disabled'}`}
                          >
                            <div className="weekly-reminder-item-main">
                              <strong>{reminder.time}</strong>
                              <span>{reminder.title}</span>
                              {reminder.message ? (
                                <p className="muted tiny">{reminder.message}</p>
                              ) : null}
                            </div>
                            <div className="weekly-reminder-item-actions">
                              <label className="weekly-reminder-item-toggle" title="사용 여부">
                                <input
                                  type="checkbox"
                                  checked={reminder.enabled}
                                  onChange={() => toggleReminder(reminder.id)}
                                />
                              </label>
                              <button
                                type="button"
                                className="ghost-button tiny-hit"
                                onClick={() => startEdit(reminder)}
                              >
                                수정
                              </button>
                              <button
                                type="button"
                                className="ghost-button tiny-hit danger-text"
                                onClick={() => removeReminder(reminder.id)}
                              >
                                삭제
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  )
}
