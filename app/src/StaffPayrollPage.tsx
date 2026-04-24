import { useEffect, useMemo, useState } from 'react'
import PageSaveStatus from './components/PageSaveStatus'
import { exportStyledStaffPayrollExcel } from './staffPayrollExcelStyledExport'
import { ADMIN_FOUR_DIGIT_PIN } from './adminPin'
import { useCloudDocumentRefreshPull } from './lib/cloudDocumentRefresh'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export const STAFF_PAYROLL_STORAGE_KEY = 'staff-payroll-v1'
export const STAFF_PAYROLL_SAVED_EVENT = 'staff-payroll-saved'

const today = new Date().toISOString().slice(0, 10)

export const STAFF_PAY_TYPES = ['월급', '시급', '일용직', '기타'] as const
export type StaffPayType = (typeof STAFF_PAY_TYPES)[number]

/** 미체크 시 입력 월급에 곱함: 원천징수 3.3% 반영(지급액 기준 단순 모델) */
const FACTOR_AFTER_3_3 = 1 - 0.033
/** 미체크 시 위 결과에 곱함: 4대보험 본인부담 대략 9.1% 추정(참고용) */
const FACTOR_AFTER_4INS_ROUGH = 1 - 0.091

export const adjustedMonthlyPay = (record: StaffPayrollRecord): number => {
  let v = Math.max(0, record.monthlyAmount)
  if (!record.excludeThreePointThree) {
    v *= FACTOR_AFTER_3_3
  }
  if (!record.excludeFourInsurances) {
    v *= FACTOR_AFTER_4INS_ROUGH
  }
  return Math.round(v)
}

export type StaffPayrollRecord = {
  id: string
  /** 근무 매장(지점) 구분 */
  storeName: string
  name: string
  /** 입금 계좌번호 */
  bankAccount: string
  /** 직함·담당 역할 (예: 매장관리, 바리스타) */
  jobTitle: string
  /** 소속 구역·팀 (예: 로스팅, 홀) */
  department: string
  payType: StaffPayType
  /** 월 기준 급여액(원). 시급이면 월 환산·근무시간은 메모에 적어두면 됩니다. */
  monthlyAmount: number
  /** 체크 시 3.3% 원천징수를 반영하지 않음(입력 금액 단계 유지) */
  excludeThreePointThree: boolean
  /** 체크 시 4대보험 본인부담 추정을 반영하지 않음 */
  excludeFourInsurances: boolean
  /** 매월 지급일 1–31, 미정이면 null */
  payDayOfMonth: number | null
  hireDate: string
  isActive: boolean
  memo: string
}

type StaffPayrollPageState = {
  records: StaffPayrollRecord[]
}

const currencyFormatter = new Intl.NumberFormat('ko-KR')
const formatMoney = (value: number) => `${currencyFormatter.format(value)}원`

const HAN_DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']

/** 1~9999 한자어 읽기(만·억 앞에 붙는 덩어리) */
const readChunkUnder10000 = (n: number): string => {
  if (n <= 0 || n > 9999) {
    return ''
  }
  let s = ''
  const d1000 = Math.floor(n / 1000)
  if (d1000 > 0) {
    s += d1000 === 1 ? '천' : `${HAN_DIGIT[d1000]}천`
  }
  n %= 1000
  const d100 = Math.floor(n / 100)
  if (d100 > 0) {
    s += d100 === 1 ? '백' : `${HAN_DIGIT[d100]}백`
  }
  n %= 100
  const d10 = Math.floor(n / 10)
  if (d10 > 0) {
    s += d10 === 1 ? '십' : `${HAN_DIGIT[d10]}십`
  }
  const d1 = n % 10
  if (d1 > 0) {
    s += HAN_DIGIT[d1]
  }
  return s
}

/** 정수 원화를 한글 읽기 문자열로 (예: 1_000_000 → 일백만원) */
export const wonAmountToHangul = (won: number): string => {
  const n = Math.max(0, Math.round(won))
  if (n === 0) {
    return '영원'
  }
  const chunks: number[] = []
  let rest = n
  while (rest > 0) {
    chunks.push(rest % 10000)
    rest = Math.floor(rest / 10000)
  }
  let out = ''
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const v = chunks[i]
    if (v === 0) {
      continue
    }
    if (i === 0) {
      out += readChunkUnder10000(v)
      continue
    }
    if (i === 1) {
      if (v === 1) {
        out += '만'
      } else if (v === 100 && chunks.length === 2) {
        out += '일백만'
      } else if (v === 100) {
        out += '백만'
      } else {
        out += `${readChunkUnder10000(v)}만`
      }
      continue
    }
    const bigUnit = ['', '', '억', '조', '해', '자'][i] ?? '자'
    out += `${readChunkUnder10000(v)}${bigUnit}`
  }
  return `${out}원`
}

const defaultState = (): StaffPayrollPageState => ({ records: [] })

const parseNumber = (value: unknown) => {
  const n = Number(String(value ?? '').replaceAll(',', ''))
  return Number.isFinite(n) ? n : 0
}

const clampPayDay = (n: number | null): number | null => {
  if (n === null || !Number.isFinite(n)) {
    return null
  }
  const v = Math.round(n)
  if (v < 1 || v > 31) {
    return null
  }
  return v
}

const normalizeRecord = (raw: unknown): StaffPayrollRecord | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const o = raw as Record<string, unknown>
  const payType = STAFF_PAY_TYPES.includes(o.payType as StaffPayType) ? (o.payType as StaffPayType) : '월급'
  const hireDate = typeof o.hireDate === 'string' ? o.hireDate.slice(0, 10) : ''
  return {
    id: typeof o.id === 'string' && o.id ? o.id : crypto.randomUUID(),
    storeName: typeof o.storeName === 'string' ? o.storeName : '',
    name: typeof o.name === 'string' ? o.name : '',
    bankAccount: typeof o.bankAccount === 'string' ? o.bankAccount : '',
    jobTitle: typeof o.jobTitle === 'string' ? o.jobTitle : '',
    department: typeof o.department === 'string' ? o.department : '',
    payType,
    monthlyAmount: Math.max(0, parseNumber(o.monthlyAmount)),
    excludeThreePointThree: o.excludeThreePointThree === true,
    excludeFourInsurances: o.excludeFourInsurances === true,
    payDayOfMonth: clampPayDay(o.payDayOfMonth === null || o.payDayOfMonth === '' ? null : Number(o.payDayOfMonth)),
    hireDate,
    isActive: o.isActive !== false,
    memo: typeof o.memo === 'string' ? o.memo : '',
  }
}

const normalizePageState = (raw: unknown): StaffPayrollPageState => {
  if (!raw || typeof raw !== 'object') {
    return defaultState()
  }
  const o = raw as Record<string, unknown>
  const records = Array.isArray(o.records)
    ? (o.records.map(normalizeRecord).filter(Boolean) as StaffPayrollRecord[])
    : []
  return { records }
}

const readStaffPayrollPageStateFromStorage = (): StaffPayrollPageState => {
  const saved = window.localStorage.getItem(STAFF_PAYROLL_STORAGE_KEY)
  if (!saved) {
    return defaultState()
  }
  try {
    return normalizePageState(JSON.parse(saved))
  } catch {
    return defaultState()
  }
}

const writeStaffPayrollPageStateToStorage = (state: StaffPayrollPageState) => {
  try {
    window.localStorage.setItem(STAFF_PAYROLL_STORAGE_KEY, JSON.stringify(state))
    window.dispatchEvent(new Event(STAFF_PAYROLL_SAVED_EVENT))
  } catch {
    // ignore
  }
}

const newEmptyRow = (): StaffPayrollRecord => ({
  id: crypto.randomUUID(),
  storeName: '',
  name: '',
  bankAccount: '',
  jobTitle: '',
  department: '',
  payType: '월급',
  monthlyAmount: 0,
  excludeThreePointThree: false,
  excludeFourInsurances: false,
  payDayOfMonth: 25,
  hireDate: '',
  isActive: true,
  memo: '',
})

function StaffPayrollPage() {
  const { mode, activeCompanyId, user, cloudDocRefreshTick } = useAppRuntime()
  const [pageState, setPageState] = useState<StaffPayrollPageState>(defaultState)
  const [statusMessage, setStatusMessage] = useState('이 브라우저에만 자동 저장됩니다.')
  const [isStorageReady, setIsStorageReady] = useState(false)
  const [isCloudReady, setIsCloudReady] = useState(mode === 'local')
  const {
    lastSavedAt,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    resetDocumentSaveUi,
    saveState,
    skipInitialDocumentSave,
  } = useDocumentSaveUi(mode)
  const [isEditUnlocked, setIsEditUnlocked] = useState(false)
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false)
  const [unlockPin, setUnlockPin] = useState('')
  const [unlockError, setUnlockError] = useState('')
  const [externalSyncTick, setExternalSyncTick] = useState(0)

  useEffect(() => {
    const onExternalSync = () => setExternalSyncTick((n) => n + 1)
    window.addEventListener(STAFF_PAYROLL_SAVED_EVENT, onExternalSync)
    return () => {
      window.removeEventListener(STAFF_PAYROLL_SAVED_EVENT, onExternalSync)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId || externalSyncTick === 0) {
      return
    }
    let cancelled = false
    const syncFromCloud = async () => {
      try {
        const remoteState = await loadCompanyDocument<StaffPayrollPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.staffPayrollPage,
        )
        if (cancelled || !remoteState) {
          return
        }
        setPageState(normalizePageState(remoteState))
      } catch (error) {
        console.error('직원·급여 외부 동기화 실패', error)
      }
    }
    void syncFromCloud()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, externalSyncTick, mode])

  useEffect(() => {
    let cancelled = false

    setIsStorageReady(false)
    setIsCloudReady(mode === 'local')
    resetDocumentSaveUi()

    const applyState = (nextState: StaffPayrollPageState, source: 'local' | 'cloud', hasRemote: boolean) => {
      if (cancelled) {
        return
      }
      setPageState(nextState)
      setStatusMessage(
        source === 'cloud'
          ? '클라우드에서 직원·급여 목록을 불러왔습니다.'
          : hasRemote
            ? '저장된 직원·급여 목록을 불러왔습니다.'
            : '브라우저 직원·급여 목록을 불러왔습니다. 아직 클라우드 문서는 없습니다.',
      )
      setIsStorageReady(true)
      setIsCloudReady(true)
    }

    const loadState = async () => {
      const localState = readStaffPayrollPageStateFromStorage()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyState(localState, 'local', true)
        return
      }

      try {
        const remoteState = await loadCompanyDocument<StaffPayrollPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.staffPayrollPage,
        )
        if (remoteState) {
          const next = normalizePageState(remoteState)
          applyState(next, 'cloud', true)
          if (activeCompanyId) {
            writeStaffPayrollPageStateToStorage(next)
          }
        } else {
          applyState(localState, 'local', false)
        }
      } catch (error) {
        console.error('직원·급여 클라우드 문서를 읽지 못했습니다.', error)
        applyState(localState, 'local', true)
      }
    }

    void loadState()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode, resetDocumentSaveUi])

  useCloudDocumentRefreshPull({
    mode,
    activeCompanyId,
    cloudDocRefreshTick,
    saveState,
    onPull: async (isCancelled) => {
      if (mode !== 'cloud' || !activeCompanyId) {
        return
      }
      try {
        const remoteState = await loadCompanyDocument<StaffPayrollPageState>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.staffPayrollPage,
        )
        if (isCancelled()) {
          return
        }
        if (remoteState) {
          const next = normalizePageState(remoteState)
          setPageState(next)
          writeStaffPayrollPageStateToStorage(next)
          setStatusMessage('클라우드에서 직원·급여 목록을 다시 불러왔습니다.')
        } else {
          const localState = readStaffPayrollPageStateFromStorage()
          setPageState(localState)
          setStatusMessage('클라우드에 문서가 없어 이 브라우저 사본을 표시합니다.')
        }
      } catch (error) {
        console.error('직원·급여: 협업용 클라우드 다시 읽기에 실패했습니다.', error)
      }
    },
  })

  useEffect(() => {
    if (!isStorageReady) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      writeStaffPayrollPageStateToStorage(pageState)
      return
    }
    if (!isCloudReady) {
      return
    }
    if (skipInitialDocumentSave()) {
      return
    }

    markDocumentDirty()

    const timeoutId = window.setTimeout(() => {
      markDocumentSaving()
      void saveCompanyDocument(
        activeCompanyId,
        COMPANY_DOCUMENT_KEYS.staffPayrollPage,
        pageState,
        user?.id,
      )
        .then(() => {
          writeStaffPayrollPageStateToStorage(pageState)
          markDocumentSaved()
        })
        .catch((error) => {
          console.error('직원·급여 클라우드 저장에 실패했습니다.', error)
          markDocumentError()
        })
    }, 600)

    return () => window.clearTimeout(timeoutId)
  }, [
    activeCompanyId,
    isCloudReady,
    isStorageReady,
    mode,
    pageState,
    user?.id,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    skipInitialDocumentSave,
  ])

  const activeRecords = useMemo(() => pageState.records.filter((r) => r.isActive), [pageState.records])
  const monthlyInputTotalActive = useMemo(
    () => activeRecords.reduce((s, r) => s + r.monthlyAmount, 0),
    [activeRecords],
  )
  const monthlyAdjustedTotalActive = useMemo(
    () => activeRecords.reduce((s, r) => s + adjustedMonthlyPay(r), 0),
    [activeRecords],
  )

  const updateRecord = (id: string, patch: Partial<StaffPayrollRecord>) => {
    if (!isEditUnlocked) {
      setStatusMessage('수정하려면 0402 비밀번호로 잠금을 해제하세요.')
      return
    }
    setPageState((prev) => ({
      ...prev,
      records: prev.records.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }))
  }

  const addRow = () => {
    if (!isEditUnlocked) {
      setStatusMessage('행 추가 전 잠금 해제가 필요합니다.')
      setIsUnlockDialogOpen(true)
      return
    }
    setPageState((prev) => ({ ...prev, records: [...prev.records, newEmptyRow()] }))
    setStatusMessage('행을 추가했습니다.')
  }

  const removeRow = (id: string) => {
    if (!isEditUnlocked) {
      setStatusMessage('삭제하려면 잠금을 먼저 해제하세요.')
      return
    }
    setPageState((prev) => ({ ...prev, records: prev.records.filter((r) => r.id !== id) }))
    setStatusMessage('행을 삭제했습니다.')
  }

  const openUnlockDialog = () => {
    setUnlockPin('')
    setUnlockError('')
    setIsUnlockDialogOpen(true)
  }

  const closeUnlockDialog = () => {
    setIsUnlockDialogOpen(false)
    setUnlockPin('')
    setUnlockError('')
  }

  const confirmUnlock = () => {
    if (unlockPin !== ADMIN_FOUR_DIGIT_PIN) {
      setUnlockError('비밀번호가 다릅니다.')
      return
    }
    setIsEditUnlocked(true)
    setStatusMessage('직원·급여 편집 잠금 해제됨')
    closeUnlockDialog()
  }

  const buildExportMatrix = (): (string | number)[][] => {
    const colCount = 14
    const padTitle = (title: string) => [title, ...Array(colCount - 1).fill('')]
    return [
      padTitle('■ 직원·급여·근무'),
      [
        '출력일',
        today,
        '재직 인원',
        activeRecords.length,
        '반영월급합',
        monthlyAdjustedTotalActive,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      [
        '매장명',
        '이름',
        '계좌번호',
        '직책',
        '부서',
        '구분',
        '월급여(원)',
        '3.3%제외',
        '4대보험제외',
        '반영월급(원)',
        '매월지급일',
        '입사일',
        '재직',
        '메모',
      ],
      ...pageState.records.map((r) => [
        r.storeName,
        r.name,
        r.bankAccount,
        r.jobTitle,
        r.department,
        r.payType,
        r.monthlyAmount,
        r.excludeThreePointThree ? '예' : '',
        r.excludeFourInsurances ? '예' : '',
        adjustedMonthlyPay(r),
        r.payDayOfMonth ?? '',
        r.hireDate || '',
        r.isActive ? '재직' : '퇴사',
        r.memo,
      ]),
    ]
  }

  const handleExportExcel = async () => {
    try {
      await exportStyledStaffPayrollExcel(buildExportMatrix(), `직원급여목록_${today}.xlsx`)
      setStatusMessage('엑셀 파일을 내려받았습니다.')
    } catch (error) {
      console.error(error)
      setStatusMessage(error instanceof Error ? error.message : '엑셀 저장에 실패했습니다.')
    }
  }

  return (
    <div className="meeting-layout staff-payroll-page">
      <section className="panel expense-work-section">
        <div className="staff-payroll-snapshot-metrics no-print" aria-label="급여 요약">
          <div className="metric-card">
            <span>재직 인원</span>
            <strong>{activeRecords.length}명</strong>
          </div>
          <div className="metric-card">
            <span>재직 반영 월급 합계</span>
            <strong>{formatMoney(monthlyAdjustedTotalActive)}</strong>
          </div>
          <div className="metric-card">
            <span>입력 월급 합계(참고)</span>
            <strong>{formatMoney(monthlyInputTotalActive)}</strong>
          </div>
        </div>
        <div className="panel-header">
          <div>
            <h2>직원 목록</h2>
            <p className="muted">
              「3.3% 제외」「4대보험 제외」에 체크하면 해당 차감을 하지 않습니다. 미체크 시 월급여에 3.3% 원천징수,
              이어서 약 9.1% 4대 본인부담(추정)을 곱해 반영 월급을 계산합니다.
            </p>
          </div>
        </div>

        <div className="inventory-actions">
          <button type="button" className="ghost-button expense-toolbar-btn" onClick={addRow}>
            행 추가
          </button>
          <button
            type="button"
            className="ghost-button expense-toolbar-btn"
            onClick={isEditUnlocked ? () => {
              setIsEditUnlocked(false)
              setStatusMessage('직원·급여 편집 잠금')
            } : openUnlockDialog}
          >
            {isEditUnlocked ? '수정 잠금' : '수정 잠금 해제'}
          </button>
          <button type="button" className="ghost-button expense-toolbar-btn" onClick={handleExportExcel}>
            엑셀 저장
          </button>
        </div>

        <div className="page-status-bar">
          <p className="page-status-message" role="status" aria-live="polite">
            {statusMessage}
          </p>
          <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
        </div>
        {!isEditUnlocked ? <p className="staff-payroll-lock-hint">수정 잠금 상태입니다. 「수정 잠금 해제」를 눌러주세요.</p> : null}

        <div className="meeting-grid expense-work-grid">
          <div className="meeting-card">
            <div className="meeting-card-header">
              <div className="expense-list-heading">
                <h3>입력 목록</h3>
              </div>
            </div>
            <div className={isEditUnlocked ? 'table-wrapper' : 'table-wrapper staff-payroll-table-wrapper--locked'}>
            <table className="meeting-table expense-table staff-payroll-table">
              <thead>
                <tr>
                  <th scope="col">매장명</th>
                  <th scope="col">이름</th>
                  <th scope="col">계좌번호</th>
                  <th scope="col">직책</th>
                  <th scope="col">부서</th>
                  <th scope="col">구분</th>
                  <th scope="col">월급여(원)</th>
                  <th scope="col" className="staff-payroll-col-check" title="체크 시 3.3% 원천징수를 반영하지 않음">
                    3.3% 제외
                  </th>
                  <th scope="col" className="staff-payroll-col-check" title="체크 시 4대보험 본인부담 추정을 반영하지 않음">
                    4대보험 제외
                  </th>
                  <th scope="col">반영 월급</th>
                  <th scope="col">매월 지급일</th>
                  <th scope="col">입사일</th>
                  <th scope="col">재직</th>
                  <th scope="col">메모</th>
                  <th scope="col" className="staff-payroll-col-action">
                    -
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageState.records.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="staff-payroll-empty">
                      등록된 직원이 없습니다. 「행 추가」로 입력하세요.
                    </td>
                  </tr>
                ) : (
                  pageState.records.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.storeName}
                          onChange={(e) => updateRecord(record.id, { storeName: e.target.value })}
                          placeholder="매장·지점"
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.name}
                          onChange={(e) => updateRecord(record.id, { name: e.target.value })}
                          placeholder="이름"
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.bankAccount}
                          onChange={(e) => updateRecord(record.id, { bankAccount: e.target.value })}
                          placeholder="예: 123-45-678901"
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.jobTitle}
                          onChange={(e) => updateRecord(record.id, { jobTitle: e.target.value })}
                          placeholder="예: 매장관리, 바리스타"
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.department}
                          onChange={(e) => updateRecord(record.id, { department: e.target.value })}
                          placeholder="예: 홀, 로스팅"
                        />
                      </td>
                      <td>
                        <select
                          className="expense-cell-input"
                          value={record.payType}
                          onChange={(e) => updateRecord(record.id, { payType: e.target.value as StaffPayType })}
                        >
                          {STAFF_PAY_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          type="text"
                          inputMode="numeric"
                          value={record.monthlyAmount ? String(record.monthlyAmount) : ''}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^\d]/g, '')
                            updateRecord(record.id, { monthlyAmount: v ? Number(v) : 0 })
                          }}
                          placeholder="0"
                        />
                      </td>
                      <td className="staff-payroll-col-check">
                        <input
                          type="checkbox"
                          className="expense-checkbox"
                          checked={record.excludeThreePointThree}
                          onChange={(e) => updateRecord(record.id, { excludeThreePointThree: e.target.checked })}
                          title="체크 시 3.3% 원천징수를 반영하지 않음"
                          aria-label="3.3% 제외"
                        />
                      </td>
                      <td className="staff-payroll-col-check">
                        <input
                          type="checkbox"
                          className="expense-checkbox"
                          checked={record.excludeFourInsurances}
                          onChange={(e) => updateRecord(record.id, { excludeFourInsurances: e.target.checked })}
                          title="체크 시 4대보험 본인부담 추정을 반영하지 않음"
                          aria-label="4대보험 제외"
                        />
                      </td>
                      <td>
                        <div className="staff-payroll-adjusted-stack">
                          <span className="staff-payroll-adjusted-cell">
                            {formatMoney(adjustedMonthlyPay(record))}
                          </span>
                          <span className="staff-payroll-adjusted-hangul">
                            {wonAmountToHangul(adjustedMonthlyPay(record))}
                          </span>
                        </div>
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          value={record.payDayOfMonth === null ? '' : String(record.payDayOfMonth)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, '')
                            if (!v) {
                              updateRecord(record.id, { payDayOfMonth: null })
                              return
                            }
                            const n = Number(v)
                            updateRecord(record.id, { payDayOfMonth: clampPayDay(n) })
                          }}
                          placeholder="1–31"
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          type="date"
                          value={record.hireDate}
                          onChange={(e) => updateRecord(record.id, { hireDate: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          className="expense-checkbox"
                          checked={record.isActive}
                          onChange={(e) => updateRecord(record.id, { isActive: e.target.checked })}
                          aria-label={`${record.name || '직원'} 재직`}
                        />
                      </td>
                      <td>
                        <input
                          className="expense-cell-input"
                          value={record.memo}
                          onChange={(e) => updateRecord(record.id, { memo: e.target.value })}
                          placeholder="근무시간, 시급 단가 등"
                        />
                      </td>
                      <td className="staff-payroll-col-action">
                        <button type="button" className="ghost-button staff-payroll-delete-btn" onClick={() => removeRow(record.id)}>
                          -
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </section>
      {isUnlockDialogOpen ? (
        <div className="staff-payroll-lock-backdrop" role="dialog" aria-modal="true" aria-labelledby="staff-payroll-lock-title">
          <div className="staff-payroll-lock-dialog">
            <h3 id="staff-payroll-lock-title" className="staff-payroll-lock-title">
              수정 잠금 해제
            </h3>
            <p className="staff-payroll-lock-body">직원·급여 입력 목록 수정은 비밀번호 4자리를 입력해야 가능합니다.</p>
            <label className="staff-payroll-lock-field">
              <span>비밀번호</span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={unlockPin}
                onChange={(e) => setUnlockPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    confirmUnlock()
                  }
                }}
                autoFocus
              />
            </label>
            {unlockError ? <p className="staff-payroll-lock-error">{unlockError}</p> : null}
            <div className="staff-payroll-lock-actions">
              <button type="button" className="ghost-button" onClick={closeUnlockDialog}>
                취소
              </button>
              <button type="button" className="primary-button" onClick={confirmUnlock}>
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default StaffPayrollPage
