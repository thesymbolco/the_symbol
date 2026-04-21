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
    signInWithPassword,
    createCompany,
    setActiveCompanyId,
  } = useAppRuntime()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
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
            setStatus('')
            const message = await signInWithPassword(username, password)
            if (message) {
              setStatus(message)
            } else {
              setStatus('')
              setPassword('')
            }
            setIsSubmitting(false)
          }}
        >
          <p className="eyebrow">다중기기 클라우드 모드</p>
          <h1>로그인</h1>
          <p className="app-auth-copy">
            관리자가 발급한 아이디와 비밀번호로 로그인하세요.
          </p>
          <label className="app-auth-field">
            아이디
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="예: park"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="app-auth-field">
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="비밀번호"
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? '로그인 중…' : '로그인'}
          </button>
          {status ? <p className="app-auth-error">{status}</p> : null}
          {errorMessage ? <p className="app-auth-error">{errorMessage}</p> : null}
          <p className="app-auth-hint">
            계정이 필요하신가요? 관리자에게 문의하세요.
          </p>
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
