import { useState, type PropsWithChildren } from 'react'
import { useAppRuntime } from '../providers/AppRuntimeProvider'

export default function AppAuthGate({ children }: PropsWithChildren) {
  const {
    mode,
    isReady,
    session,
    memberships,
    activeCompanyId,
    errorMessage,
    signInWithOtp,
    createCompany,
    setActiveCompanyId,
  } = useAppRuntime()
  const [email, setEmail] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [status, setStatus] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (mode === 'local') {
    return <>{children}</>
  }

  if (!isReady) {
    return (
      <div className="app-auth-shell">
        <div className="app-auth-card">
          <h1>불러오는 중…</h1>
          <p>클라우드 연결과 로그인 상태를 확인하고 있습니다.</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="app-auth-shell">
        <form
          className="app-auth-card"
          onSubmit={async (event) => {
            event.preventDefault()
            setIsSubmitting(true)
            const message = await signInWithOtp(email)
            setStatus(message ?? '로그인 링크를 메일로 보냈습니다. 메일의 링크로 접속해 주세요.')
            setIsSubmitting(false)
          }}
        >
          <p className="eyebrow">다중기기 클라우드 모드</p>
          <h1>로그인</h1>
          <p className="app-auth-copy">
            이메일 링크 로그인으로 회사 공용 데이터를 여러 기기에서 함께 사용할 수 있습니다.
          </p>
          <label className="app-auth-field">
            이메일
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
          </label>
          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? '보내는 중…' : '로그인 링크 보내기'}
          </button>
          {status ? <p className="app-auth-status">{status}</p> : null}
          {errorMessage ? <p className="app-auth-error">{errorMessage}</p> : null}
        </form>
      </div>
    )
  }

  if (!activeCompanyId) {
    return (
      <div className="app-auth-shell">
        <div className="app-auth-card">
          <p className="eyebrow">클라우드 워크스페이스</p>
          <h1>회사 선택</h1>
          <p className="app-auth-copy">공용 데이터를 사용할 회사를 선택하거나 새 회사를 만드세요.</p>
          {memberships.length > 0 ? (
            <div className="app-auth-company-list">
              {memberships.map((membership) => (
                <button
                  key={membership.companyId}
                  type="button"
                  className="ghost-button app-auth-company-button"
                  onClick={() => setActiveCompanyId(membership.companyId)}
                >
                  <strong>{membership.companyName}</strong>
                  <span>{membership.role}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">아직 연결된 회사가 없습니다.</p>
          )}
          <form
            className="app-auth-create-company"
            onSubmit={async (event) => {
              event.preventDefault()
              setIsSubmitting(true)
              const message = await createCompany(companyName)
              setStatus(message ?? '회사를 만들었습니다.')
              if (!message) {
                setCompanyName('')
              }
              setIsSubmitting(false)
            }}
          >
            <label className="app-auth-field">
              새 회사 이름
              <input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="예: 이오도"
              />
            </label>
            <button type="submit" className="primary-button" disabled={isSubmitting}>
              {isSubmitting ? '만드는 중…' : '회사 만들기'}
            </button>
          </form>
          {status ? <p className="app-auth-status">{status}</p> : null}
          {errorMessage ? <p className="app-auth-error">{errorMessage}</p> : null}
        </div>
      </div>
    )
  }

  return <>{children}</>
}
