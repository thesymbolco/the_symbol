import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAppRuntime,
  type CreateMemberInput,
  type TeamMember,
  type UpdateMemberInput,
} from './providers/AppRuntimeProvider'

const ROLE_LABEL: Record<string, string> = {
  owner: '관리자(Owner)',
  admin: '운영자(Admin)',
  member: '구성원(Member)',
}

const STATUS_LABEL: Record<string, string> = {
  active: '활성',
  inactive: '비활성',
}

/** 직책 드롭다운 옵션. 필요 시 여기에서 항목을 추가/수정. */
const TITLE_OPTIONS = [
  '대표',
  '이사',
  '매니저',
  '팀장',
  '바리스타',
  '로스터',
  '사원',
  '인턴',
] as const

type BusyState = null | { kind: 'create' } | { kind: 'member'; userId: string; action: string }

export default function TeamManagementPage() {
  const {
    mode,
    user: currentUser,
    activeCompany,
    listTeamMembers,
    createTeamMember,
    updateTeamMember,
    removeTeamMember,
    changeMemberPassword,
  } = useAppRuntime()

  const [members, setMembers] = useState<TeamMember[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<BusyState>(null)
  const [flash, setFlash] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [createForm, setCreateForm] = useState<CreateMemberInput>({
    username: '',
    password: '',
    displayName: '',
    phone: '',
    title: TITLE_OPTIONS[6],
    department: '',
    email: '',
    role: 'member',
  })
  const [editDrafts, setEditDrafts] = useState<Record<string, Partial<TeamMember>>>({})
  const [passwordDraft, setPasswordDraft] = useState('')

  const isOwner = useMemo(() => {
    const active = members.find((member) => member.userId === currentUser?.id)
    return (active?.role ?? activeCompany?.role) === 'owner'
  }, [activeCompany?.role, currentUser?.id, members])

  const loadMembers = useCallback(async () => {
    setIsLoading(true)
    const { members: nextMembers, error } = await listTeamMembers()
    setIsLoading(false)
    if (error) {
      setLoadError(error)
      return
    }
    setLoadError('')
    setMembers(
      [...nextMembers].sort((a, b) => {
        const roleOrder = (role: string) => (role === 'owner' ? 0 : role === 'admin' ? 1 : 2)
        const diff = roleOrder(a.role) - roleOrder(b.role)
        if (diff !== 0) return diff
        return (a.displayName || a.username).localeCompare(b.displayName || b.username, 'ko')
      }),
    )
  }, [listTeamMembers])

  useEffect(() => {
    if (mode !== 'cloud') return
    void loadMembers()
  }, [loadMembers, mode])

  const showFlash = (kind: 'info' | 'error', text: string) => {
    setFlash({ kind, text })
    if (kind === 'error') {
      console.error('[TeamManagementPage]', text)
    }
    // 오류 메시지는 사용자가 조치할 때까지 유지, info는 5초 후 소멸
    if (kind === 'info') {
      window.setTimeout(() => setFlash(null), 5000)
    }
  }

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy({ kind: 'create' })
    const error = await createTeamMember(createForm)
    setBusy(null)
    if (error) {
      showFlash('error', error)
      return
    }
    showFlash('info', `${createForm.displayName || createForm.username} 계정을 만들었습니다.`)
    setCreateForm({
      username: '',
      password: '',
      displayName: '',
      phone: '',
      title: TITLE_OPTIONS[6],
      department: '',
      email: '',
      role: 'member',
    })
    await loadMembers()
  }

  const beginEdit = (member: TeamMember) => {
    setEditDrafts((prev) => ({ ...prev, [member.userId]: { ...member } }))
  }

  const cancelEdit = (userId: string) => {
    setEditDrafts((prev) => {
      const next = { ...prev }
      delete next[userId]
      return next
    })
  }

  const saveEdit = async (member: TeamMember) => {
    const draft = editDrafts[member.userId]
    if (!draft) return
    const patch: UpdateMemberInput = { userId: member.userId }
    if (draft.displayName !== member.displayName) patch.displayName = draft.displayName ?? ''
    if (draft.phone !== member.phone) patch.phone = draft.phone ?? ''
    if (draft.title !== member.title) patch.title = draft.title ?? ''
    if (draft.department !== member.department) patch.department = draft.department ?? ''
    if (draft.email !== member.email) patch.email = draft.email ?? ''
    if (draft.role && draft.role !== member.role) patch.role = draft.role as 'owner' | 'admin' | 'member'
    if (draft.status && draft.status !== member.status) patch.status = draft.status as 'active' | 'inactive'
    setBusy({ kind: 'member', userId: member.userId, action: 'save' })
    const error = await updateTeamMember(patch)
    setBusy(null)
    if (error) {
      showFlash('error', error)
      return
    }
    showFlash('info', `${member.displayName || member.username} 정보를 저장했습니다.`)
    cancelEdit(member.userId)
    await loadMembers()
  }

  const handleRemove = async (member: TeamMember) => {
    if (!window.confirm(`${member.displayName || member.username} 님을 이 회사에서 제거할까요?`)) {
      return
    }
    setBusy({ kind: 'member', userId: member.userId, action: 'remove' })
    const error = await removeTeamMember(member.userId)
    setBusy(null)
    if (error) {
      showFlash('error', error)
      return
    }
    showFlash('info', '회사에서 제거했습니다.')
    await loadMembers()
  }

  const handleSelfPasswordChange = async () => {
    if (!currentUser) return
    if (!passwordDraft) {
      showFlash('error', '새 비밀번호를 입력해 주세요.')
      return
    }
    setBusy({ kind: 'member', userId: currentUser.id, action: 'password' })
    const error = await changeMemberPassword(currentUser.id, passwordDraft)
    setBusy(null)
    if (error) {
      showFlash('error', error)
      return
    }
    showFlash('info', '비밀번호를 변경했습니다.')
    setPasswordDraft('')
  }

  if (mode !== 'cloud') {
    return (
      <div className="team-page team-page-empty">
        <h2>팀 관리</h2>
        <p>클라우드 모드(Supabase 연결) 상태에서만 사용할 수 있는 기능입니다.</p>
      </div>
    )
  }

  return (
    <div className="team-page">
      <section className="team-section">
        <header className="team-section-head">
          <div>
            <h2>구성원</h2>
            <p className="muted">
              {activeCompany ? `${activeCompany.companyName} · ${members.length}명` : '회사를 선택해 주세요.'}
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={() => void loadMembers()} disabled={isLoading}>
            {isLoading ? '불러오는 중…' : '새로고침'}
          </button>
        </header>
        {loadError ? <p className="app-auth-error">{loadError}</p> : null}
        {flash ? (
          <p className={flash.kind === 'error' ? 'app-auth-error' : 'app-auth-status'}>{flash.text}</p>
        ) : null}
        <div className="team-table-wrap">
          <table className="team-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>아이디</th>
                <th>직책</th>
                <th>부서</th>
                <th>휴대폰</th>
                <th>이메일</th>
                <th>역할</th>
                <th>상태</th>
                <th aria-label="액션"></th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && !isLoading ? (
                <tr>
                  <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    구성원이 없습니다. 아래 폼에서 추가해 보세요.
                  </td>
                </tr>
              ) : null}
              {members.map((member) => {
                const draft = editDrafts[member.userId]
                const isEditing = Boolean(draft)
                const isSelf = member.userId === currentUser?.id
                const disableEdit = !isOwner && !isSelf
                return (
                  <tr key={member.userId} className={member.status !== 'active' ? 'is-inactive' : ''}>
                    <td>
                      {isEditing ? (
                        <input
                          value={draft?.displayName ?? ''}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], displayName: event.target.value },
                            }))
                          }
                        />
                      ) : (
                        <span>
                          {member.displayName || '—'}
                          {isSelf ? <span className="team-self-badge">나</span> : null}
                        </span>
                      )}
                    </td>
                    <td>
                      <code>{member.username || '—'}</code>
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          value={draft?.title ?? ''}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], title: event.target.value },
                            }))
                          }
                        >
                          <option value="">—</option>
                          {TITLE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                          {draft?.title && !TITLE_OPTIONS.includes(draft.title as (typeof TITLE_OPTIONS)[number]) ? (
                            <option value={draft.title}>{draft.title} (기존)</option>
                          ) : null}
                        </select>
                      ) : (
                        member.title || '—'
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          value={draft?.department ?? ''}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], department: event.target.value },
                            }))
                          }
                          placeholder="부서"
                        />
                      ) : (
                        member.department || '—'
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          value={draft?.phone ?? ''}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], phone: event.target.value },
                            }))
                          }
                        />
                      ) : (
                        member.phone || '—'
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          value={draft?.email ?? ''}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], email: event.target.value },
                            }))
                          }
                        />
                      ) : (
                        member.email || '—'
                      )}
                    </td>
                    <td>
                      {isEditing && isOwner ? (
                        <select
                          value={draft?.role ?? member.role}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], role: event.target.value },
                            }))
                          }
                        >
                          <option value="owner">owner</option>
                          <option value="admin">admin</option>
                          <option value="member">member</option>
                        </select>
                      ) : (
                        ROLE_LABEL[member.role] ?? member.role
                      )}
                    </td>
                    <td>
                      {isEditing && isOwner ? (
                        <select
                          value={draft?.status ?? member.status}
                          onChange={(event) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [member.userId]: { ...prev[member.userId], status: event.target.value },
                            }))
                          }
                        >
                          <option value="active">active</option>
                          <option value="inactive">inactive</option>
                        </select>
                      ) : (
                        STATUS_LABEL[member.status] ?? member.status
                      )}
                    </td>
                    <td className="team-actions">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="primary-button small"
                            onClick={() => void saveEdit(member)}
                            disabled={busy?.kind === 'member' && busy.userId === member.userId}
                          >
                            저장
                          </button>
                          <button type="button" className="ghost-button small" onClick={() => cancelEdit(member.userId)}>
                            취소
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() => beginEdit(member)}
                            disabled={disableEdit}
                          >
                            수정
                          </button>
                          {isOwner && !isSelf ? (
                            <button
                              type="button"
                              className="ghost-button small danger"
                              onClick={() => void handleRemove(member)}
                              disabled={busy?.kind === 'member' && busy.userId === member.userId}
                            >
                              제거
                            </button>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner ? (
        <section className="team-section">
          <header className="team-section-head">
            <div>
              <h2>새 계정 만들기</h2>
              <p className="muted">
                아이디와 비밀번호로 로그인할 수 있는 계정을 만들고 이 회사에 바로 연결합니다.
              </p>
            </div>
          </header>
          <form className="team-create-form" onSubmit={handleCreate}>
            <div className="team-create-grid">
              <label>
                이름 *
                <input
                  value={createForm.displayName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, displayName: event.target.value }))}
                  required
                />
              </label>
              <label>
                직책
                <select
                  value={createForm.title}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))}
                >
                  {TITLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                부서명
                <input
                  value={createForm.department}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, department: event.target.value }))}
                  placeholder="예: 로스팅팀 / 매장운영"
                />
              </label>
              <label>
                휴대폰번호
                <input
                  value={createForm.phone}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, phone: event.target.value }))}
                  placeholder="010-0000-0000"
                />
              </label>
              <label>
                실제 이메일
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))}
                  placeholder="name@company.com"
                />
              </label>
              <label>
                아이디 *
                <input
                  value={createForm.username}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, username: event.target.value }))}
                  placeholder="영문/숫자/._- 3~32자"
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label>
                비밀번호 *
                <input
                  type="text"
                  value={createForm.password}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, password: event.target.value }))}
                  placeholder="6자 이상"
                  required
                />
              </label>
              <label>
                역할
                <select
                  value={createForm.role}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      role: event.target.value as 'owner' | 'admin' | 'member',
                    }))
                  }
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
              </label>
            </div>
            <div className="team-create-actions">
              <button type="submit" className="primary-button" disabled={busy?.kind === 'create'}>
                {busy?.kind === 'create' ? '만드는 중…' : '계정 만들기'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="team-section">
        <header className="team-section-head">
          <div>
            <h2>내 비밀번호 변경</h2>
            <p className="muted">본인 계정의 비밀번호만 변경할 수 있습니다.</p>
          </div>
        </header>
        <div className="team-self-password">
          <input
            type="password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            placeholder="새 비밀번호 (6자 이상)"
            autoComplete="new-password"
          />
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleSelfPasswordChange()}
            disabled={busy?.kind === 'member' && busy.action === 'password'}
          >
            변경
          </button>
        </div>
      </section>
    </div>
  )
}
