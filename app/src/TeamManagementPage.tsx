import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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

const DEFAULT_CREATE_FORM: CreateMemberInput = {
  username: '',
  password: '',
  displayName: '',
  phone: '',
  title: TITLE_OPTIONS[6],
  department: '',
  email: '',
  role: 'member',
}

function initialsForMember(displayName: string, username: string): string {
  const base = (displayName || username).trim()
  if (!base) {
    return '?'
  }
  if (/^[가-힣]+$/.test(base) || /^[가-힣]/.test(base)) {
    return base.slice(0, 2)
  }
  const parts = base.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0][0] ?? ''
    const b = parts[1][0] ?? ''
    return `${a}${b}`.toUpperCase()
  }
  return base.slice(0, 2).toUpperCase()
}

function hueFromUserId(userId: string): number {
  let h = 0
  for (let i = 0; i < userId.length; i += 1) {
    h = (h + userId.charCodeAt(i) * 17) % 360
  }
  return h
}

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
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateMemberInput>(DEFAULT_CREATE_FORM)
  const [createPasswordConfirm, setCreatePasswordConfirm] = useState('')
  const [createModalError, setCreateModalError] = useState('')
  const [editDrafts, setEditDrafts] = useState<Record<string, Partial<TeamMember>>>({})
  const [passwordDraft, setPasswordDraft] = useState('')
  /** 카드 뒤집기: 뒷면에 상세·수정 */
  const [flippedMemberIds, setFlippedMemberIds] = useState<Set<string>>(() => new Set())

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

  useEffect(() => {
    if (!createModalOpen) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy?.kind !== 'create') {
        setCreateModalOpen(false)
        setCreateModalError('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy?.kind, createModalOpen])

  const openCreateModal = () => {
    setCreateForm(DEFAULT_CREATE_FORM)
    setCreatePasswordConfirm('')
    setCreateModalError('')
    setCreateModalOpen(true)
  }

  const closeCreateModal = () => {
    if (busy?.kind === 'create') {
      return
    }
    setCreateModalOpen(false)
    setCreateModalError('')
  }

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

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreateModalError('')
    const username = createForm.username.trim()
    const displayName = createForm.displayName.trim()
    if (!displayName) {
      setCreateModalError('이름을 입력해 주세요.')
      return
    }
    if (!username) {
      setCreateModalError('아이디를 입력해 주세요.')
      return
    }
    if (createForm.password.length < 6) {
      setCreateModalError('비밀번호는 6자 이상이어야 합니다.')
      return
    }
    if (createForm.password !== createPasswordConfirm) {
      setCreateModalError('비밀번호 확인이 일치하지 않습니다.')
      return
    }
    setBusy({ kind: 'create' })
    const error = await createTeamMember({ ...createForm, username, displayName })
    setBusy(null)
    if (error) {
      setCreateModalError(error)
      showFlash('error', error)
      return
    }
    showFlash('info', `${displayName || username} 계정을 만들었습니다.`)
    setCreateModalOpen(false)
    setCreateForm(DEFAULT_CREATE_FORM)
    setCreatePasswordConfirm('')
    await loadMembers()
  }

  const beginEdit = (member: TeamMember) => {
    setEditDrafts((prev) => ({ ...prev, [member.userId]: { ...member } }))
    setFlippedMemberIds((prev) => new Set(prev).add(member.userId))
  }

  const toggleMemberCardFlip = (userId: string) => {
    setFlippedMemberIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  /** 뒷면: 입력·버튼이 아닌 영역을 누르면 다시 앞면으로 */
  const maybeFlipTeamCardFromBackFace = (event: React.MouseEvent<HTMLElement>, userId: string) => {
    const raw = event.target
    if (!(raw instanceof Element)) {
      return
    }
    if (raw.closest('button, input, select, textarea, a, label')) {
      return
    }
    toggleMemberCardFlip(userId)
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
              {activeCompany
                ? `${activeCompany.companyName} · ${members.length}명 · 카드를 눌러 앞·뒷면 전환`
                : '회사를 선택해 주세요.'}
            </p>
          </div>
          <div className="team-section-head-actions">
            {isOwner ? (
              <button type="button" className="primary-button team-create-open-btn" onClick={openCreateModal}>
                계정 만들기
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={() => void loadMembers()} disabled={isLoading}>
              {isLoading ? '불러오는 중…' : '새로고침'}
            </button>
          </div>
        </header>
        {loadError ? <p className="app-auth-error">{loadError}</p> : null}
        {flash ? (
          <p className={flash.kind === 'error' ? 'app-auth-error' : 'app-auth-status'}>{flash.text}</p>
        ) : null}
        <div className="team-cards-wrap">
          {members.length === 0 && !isLoading ? (
            <p className="muted team-cards-empty">
              구성원이 없습니다.
              {isOwner ? ' 「계정 만들기」로 추가할 수 있습니다.' : null}
            </p>
          ) : (
            <div className="team-cards-grid">
              {members.map((member) => {
                const draft = editDrafts[member.userId]
                const isEditing = Boolean(draft)
                const isSelf = member.userId === currentUser?.id
                const disableEdit = !isOwner && !isSelf
                const isFlipped = flippedMemberIds.has(member.userId)
                const hue = hueFromUserId(member.userId)
                const initials = initialsForMember(member.displayName, member.username)
                return (
                  <div
                    key={member.userId}
                    className={`team-card-scene${isFlipped ? ' is-flipped' : ''}${member.status !== 'active' ? ' is-inactive' : ''}`}
                  >
                    <div className="team-card-inner">
                      <div className="team-card-face team-card-front">
                        <button
                          type="button"
                          className="team-card-front-hit"
                          onClick={() => toggleMemberCardFlip(member.userId)}
                          aria-expanded={isFlipped}
                          aria-label={`${member.displayName || member.username} 상세 보기`}
                        >
                          <div
                            className="team-card-avatar"
                            style={{
                              background: `linear-gradient(145deg, hsl(${hue}, 52%, 88%), hsl(${hue}, 45%, 78%))`,
                            }}
                            aria-hidden
                          >
                            <span className="team-card-avatar-initials">{initials}</span>
                          </div>
                          <div className="team-card-front-text">
                            <div className="team-card-name">
                              {member.displayName || member.username || '—'}
                              {isSelf ? <span className="team-self-badge">나</span> : null}
                            </div>
                            <div className="team-card-dept">{member.department?.trim() || '부서 미지정'}</div>
                          </div>
                        </button>
                      </div>

                      <div
                        className="team-card-face team-card-back"
                        onClick={(event) => maybeFlipTeamCardFromBackFace(event, member.userId)}
                        role="presentation"
                      >
                        <div className="team-card-back-body">
                          <dl className="team-card-dl">
                            <div>
                              <dt>이름</dt>
                              <dd>
                                {isEditing ? (
                                  <input
                                    className="team-card-field"
                                    value={draft?.displayName ?? ''}
                                    onChange={(event) =>
                                      setEditDrafts((prev) => ({
                                        ...prev,
                                        [member.userId]: { ...prev[member.userId], displayName: event.target.value },
                                      }))
                                    }
                                  />
                                ) : (
                                  <>
                                    {member.displayName || '—'}
                                    {isSelf ? <span className="team-self-badge">나</span> : null}
                                  </>
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>아이디</dt>
                              <dd>
                                <code>{member.username || '—'}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>직책</dt>
                              <dd>
                                {isEditing ? (
                                  <select
                                    className="team-card-field"
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
                                    {draft?.title &&
                                    !TITLE_OPTIONS.includes(draft.title as (typeof TITLE_OPTIONS)[number]) ? (
                                      <option value={draft.title}>{draft.title} (기존)</option>
                                    ) : null}
                                  </select>
                                ) : (
                                  member.title || '—'
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>부서</dt>
                              <dd>
                                {isEditing ? (
                                  <input
                                    className="team-card-field"
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
                              </dd>
                            </div>
                            <div>
                              <dt>휴대폰</dt>
                              <dd>
                                {isEditing ? (
                                  <input
                                    className="team-card-field"
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
                              </dd>
                            </div>
                            <div>
                              <dt>이메일</dt>
                              <dd>
                                {isEditing ? (
                                  <input
                                    className="team-card-field"
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
                              </dd>
                            </div>
                            <div>
                              <dt>역할</dt>
                              <dd>
                                {isEditing && isOwner ? (
                                  <select
                                    className="team-card-field"
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
                              </dd>
                            </div>
                            <div>
                              <dt>상태</dt>
                              <dd>
                                {isEditing && isOwner ? (
                                  <select
                                    className="team-card-field"
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
                              </dd>
                            </div>
                          </dl>
                          <div className="team-card-actions">
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
                                <button
                                  type="button"
                                  className="ghost-button small"
                                  onClick={() => cancelEdit(member.userId)}
                                >
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
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {createModalOpen && isOwner ? (
        <div
          className="inventory-reset-dialog-backdrop team-signup-modal-backdrop"
          onClick={closeCreateModal}
          role="presentation"
        >
          <form
            className="team-signup-modal app-auth-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-signup-modal-title"
            onSubmit={handleCreate}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow">팀 계정</p>
            <h2 id="team-signup-modal-title">새 계정 만들기</h2>
            <p className="app-auth-copy">
              로그인에 쓸 아이디·비밀번호와 프로필을 입력하면 이 회사에 바로 연결됩니다.
            </p>

            <fieldset className="team-signup-fieldset">
              <legend>로그인 정보</legend>
              <label className="app-auth-field">
                아이디
                <input
                  value={createForm.username}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, username: event.target.value }))}
                  placeholder="영문·숫자·._- (3~32자)"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </label>
              <div className="team-signup-field-row">
                <label className="app-auth-field">
                  비밀번호
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, password: event.target.value }))}
                    placeholder="6자 이상"
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label className="app-auth-field">
                  비밀번호 확인
                  <input
                    type="password"
                    value={createPasswordConfirm}
                    onChange={(event) => setCreatePasswordConfirm(event.target.value)}
                    placeholder="다시 입력"
                    autoComplete="new-password"
                    required
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="team-signup-fieldset">
              <legend>프로필</legend>
              <label className="app-auth-field">
                이름
                <input
                  value={createForm.displayName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, displayName: event.target.value }))}
                  placeholder="표시 이름"
                  autoComplete="name"
                  required
                />
              </label>
              <div className="team-signup-field-row">
                <label className="app-auth-field">
                  휴대폰
                  <input
                    value={createForm.phone}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, phone: event.target.value }))}
                    placeholder="010-0000-0000"
                    autoComplete="tel"
                  />
                </label>
                <label className="app-auth-field">
                  이메일
                  <input
                    type="email"
                    value={createForm.email}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))}
                    placeholder="name@company.com"
                    autoComplete="email"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="team-signup-fieldset">
              <legend>소속 · 권한</legend>
              <div className="team-signup-field-row">
                <label className="app-auth-field">
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
                <label className="app-auth-field">
                  부서
                  <input
                    value={createForm.department}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, department: event.target.value }))}
                    placeholder="예: 로스팅팀"
                  />
                </label>
              </div>
              <label className="app-auth-field">
                역할
                <select
                  value={createForm.role}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      role: event.target.value as CreateMemberInput['role'],
                    }))
                  }
                >
                  <option value="member">{ROLE_LABEL.member}</option>
                  <option value="admin">{ROLE_LABEL.admin}</option>
                  <option value="owner">{ROLE_LABEL.owner}</option>
                </select>
              </label>
            </fieldset>

            {createModalError ? <p className="app-auth-error">{createModalError}</p> : null}

            <div className="team-signup-modal-actions">
              <button type="button" className="ghost-button" onClick={closeCreateModal} disabled={busy?.kind === 'create'}>
                취소
              </button>
              <button type="submit" className="primary-button" disabled={busy?.kind === 'create'}>
                {busy?.kind === 'create' ? '만드는 중…' : '계정 만들기'}
              </button>
            </div>
            <p className="app-auth-hint">만든 계정으로 바로 로그인할 수 있습니다.</p>
          </form>
        </div>
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
