import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { createEphemeralSupabaseClient, runtimeMode, supabase } from '../lib/supabase'

const ACTIVE_COMPANY_STORAGE_KEY = 'active-company-id-v1'

/** 아이디(username)→내부 이메일 규칙. Supabase auth는 이메일 기반이라 synthetic email을 쓴다. */
const INTERNAL_EMAIL_DOMAIN = 'thesymbol.local'
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/

export function usernameToInternalEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`
}

export type CompanyMembership = {
  companyId: string
  companyName: string
  role: string
  status: string
}

export type TeamMember = {
  userId: string
  companyId: string
  role: string
  status: string
  username: string
  displayName: string
  phone: string
  title: string
  department: string
  email: string
  createdAt: string
}

export type CreateMemberInput = {
  username: string
  password: string
  displayName: string
  phone: string
  title: string
  department: string
  email: string
  role: 'owner' | 'admin' | 'member'
}

export type UpdateMemberInput = {
  userId: string
  displayName?: string
  phone?: string
  title?: string
  department?: string
  email?: string
  role?: 'owner' | 'admin' | 'member'
  status?: 'active' | 'inactive'
}

type AppRuntimeContextValue = {
  mode: 'local' | 'cloud'
  isReady: boolean
  session: Session | null
  user: User | null
  memberships: CompanyMembership[]
  activeCompanyId: string | null
  activeCompany: CompanyMembership | null
  errorMessage: string
  signInWithPassword: (username: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  refreshMemberships: () => Promise<void>
  createCompany: (name: string) => Promise<string | null>
  setActiveCompanyId: (companyId: string) => void
  listTeamMembers: () => Promise<{ members: TeamMember[]; error: string | null }>
  createTeamMember: (input: CreateMemberInput) => Promise<string | null>
  updateTeamMember: (input: UpdateMemberInput) => Promise<string | null>
  removeTeamMember: (userId: string) => Promise<string | null>
  changeMemberPassword: (userId: string, newPassword: string) => Promise<string | null>
}

const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null)

const LOCAL_RUNTIME_VALUE: AppRuntimeContextValue = {
  mode: 'local',
  isReady: true,
  session: null,
  user: null,
  memberships: [],
  activeCompanyId: null,
  activeCompany: null,
  errorMessage: '',
  signInWithPassword: async () => null,
  signOut: async () => {},
  refreshMemberships: async () => {},
  createCompany: async () => null,
  setActiveCompanyId: () => {},
  listTeamMembers: async () => ({ members: [], error: null }),
  createTeamMember: async () => '로컬 모드에서는 팀 관리를 사용할 수 없습니다.',
  updateTeamMember: async () => '로컬 모드에서는 팀 관리를 사용할 수 없습니다.',
  removeTeamMember: async () => '로컬 모드에서는 팀 관리를 사용할 수 없습니다.',
  changeMemberPassword: async () => '로컬 모드에서는 팀 관리를 사용할 수 없습니다.',
}

function normalizeMembershipRows(rows: Array<Record<string, unknown>>): CompanyMembership[] {
  return rows
    .map((row) => {
      const companyId = String(row.company_id ?? '').trim()
      const role = String(row.role ?? '').trim()
      const status = String(row.status ?? '').trim()
      const companyRaw = row.companies
      const company =
        companyRaw && typeof companyRaw === 'object' ? (companyRaw as Record<string, unknown>) : undefined
      const companyName = String(company?.name ?? '').trim()
      if (!companyId || !companyName) {
        return null
      }
      return { companyId, companyName, role, status }
    })
    .filter((value): value is CompanyMembership => value !== null)
}

function describeSupabaseError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim()
    if (message) {
      return message
    }
  }
  return fallback
}

export function AppRuntimeProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null)
  const [memberships, setMemberships] = useState<CompanyMembership[]>([])
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(() =>
    window.localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY),
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [isReady, setIsReady] = useState(runtimeMode === 'local')
  const activeCompanyIdRef = useRef<string | null>(activeCompanyId)

  useEffect(() => {
    activeCompanyIdRef.current = activeCompanyId
  }, [activeCompanyId])

  const syncActiveCompany = useCallback((nextCompanyId: string | null, nextMemberships: CompanyMembership[]) => {
    if (nextMemberships.length === 0) {
      setActiveCompanyIdState(null)
      window.localStorage.removeItem(ACTIVE_COMPANY_STORAGE_KEY)
      return
    }

    const resolved =
      (nextCompanyId && nextMemberships.some((membership) => membership.companyId === nextCompanyId)
        ? nextCompanyId
        : nextMemberships[0]?.companyId) ?? null

    setActiveCompanyIdState(resolved)
    if (resolved) {
      window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, resolved)
    } else {
      window.localStorage.removeItem(ACTIVE_COMPANY_STORAGE_KEY)
    }
  }, [])

  const refreshMemberships = useCallback(async () => {
    if (!supabase) {
      return
    }

    const currentUser = session?.user
    if (!currentUser) {
      setMemberships([])
      syncActiveCompany(null, [])
      return
    }

    const { data, error } = await supabase
      .from('company_members')
      .select('company_id, role, status, companies:companies!inner(name)')
      .eq('user_id', currentUser.id)
      .eq('status', 'active')

    if (error) {
      setErrorMessage(describeSupabaseError(error, '회사 목록을 불러오지 못했습니다.'))
      throw error
    }

    const nextMemberships = normalizeMembershipRows((data ?? []) as Array<Record<string, unknown>>)
    setMemberships(nextMemberships)
    syncActiveCompany(activeCompanyIdRef.current, nextMemberships)
    setErrorMessage('')
  }, [session?.user, syncActiveCompany])

  useEffect(() => {
    if (!supabase) {
      return
    }
    const client = supabase

    let mounted = true

    const bootstrap = async () => {
      const {
        data: { session: nextSession },
      } = await client.auth.getSession()
      if (!mounted) {
        return
      }
      setSession(nextSession)
    }

    void bootstrap()

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (!nextSession?.user) {
        setMemberships([])
        syncActiveCompany(null, [])
        setIsReady(true)
        return
      }
    })

    return () => {
      mounted = false
      data.subscription.unsubscribe()
    }
  }, [syncActiveCompany])

  useEffect(() => {
    if (!supabase) {
      return
    }
    if (!session?.user) {
      setMemberships([])
      syncActiveCompany(null, [])
      setIsReady(true)
      return
    }

    let cancelled = false

    void refreshMemberships()
      .catch((error) => {
        if (cancelled) {
          return
        }
        setErrorMessage(describeSupabaseError(error, '회사 정보를 불러오지 못했습니다.'))
      })
      .finally(() => {
        if (!cancelled) {
          setIsReady(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [refreshMemberships, session?.user, syncActiveCompany])

  const signInWithPassword = useCallback(async (username: string, password: string) => {
    if (!supabase) {
      return null
    }
    const normalizedUsername = username.trim().toLowerCase()
    if (!normalizedUsername) {
      return '아이디를 입력해 주세요.'
    }
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      return '아이디는 영문/숫자/._- 조합 3~32자로 입력해 주세요.'
    }
    if (!password) {
      return '비밀번호를 입력해 주세요.'
    }
    const email = usernameToInternalEmail(normalizedUsername)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      // Supabase는 잘못된 자격증명에 대해 "Invalid login credentials" 로 응답. 한글 안내로 바꿔준다.
      if (/invalid login credentials/i.test(error.message)) {
        return '아이디 또는 비밀번호가 올바르지 않습니다.'
      }
      return error.message
    }
    return null
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) {
      return
    }
    await supabase.auth.signOut()
  }, [])

  const createCompany = useCallback(
    async (name: string) => {
      if (!supabase || !session?.user) {
        return '로그인이 필요합니다.'
      }
      const trimmed = name.trim()
      if (!trimmed) {
        return '회사 이름을 입력해 주세요.'
      }

      try {
        const { data: company, error: companyError } = await supabase
          .from('companies')
          .insert({
            name: trimmed,
            created_by: session.user.id,
          })
          .select('id')
          .single<{ id: string }>()

        if (companyError) {
          return describeSupabaseError(companyError, '회사 생성에 실패했습니다.')
        }

        const { error: memberError } = await supabase.from('company_members').insert({
          company_id: company.id,
          user_id: session.user.id,
          role: 'owner',
          status: 'active',
        })

        if (memberError) {
          return describeSupabaseError(memberError, '회사 사용자 연결에 실패했습니다.')
        }

        await refreshMemberships()
        syncActiveCompany(company.id, [
          ...memberships,
          { companyId: company.id, companyName: trimmed, role: 'owner', status: 'active' },
        ])
        setErrorMessage('')
        return null
      } catch (error) {
        const message = describeSupabaseError(error, '회사 생성 요청 중 네트워크 오류가 발생했습니다.')
        setErrorMessage(message)
        return message
      }
    },
    [memberships, refreshMemberships, session?.user, syncActiveCompany],
  )

  const setActiveCompanyId = useCallback(
    (companyId: string) => {
      syncActiveCompany(companyId, memberships)
    },
    [memberships, syncActiveCompany],
  )

  const listTeamMembers = useCallback(async (): Promise<{ members: TeamMember[]; error: string | null }> => {
    if (!supabase || !activeCompanyId) {
      return { members: [], error: null }
    }
    const { data: memberRows, error: memberError } = await supabase
      .from('company_members')
      .select('user_id, company_id, role, status, created_at')
      .eq('company_id', activeCompanyId)
    if (memberError) {
      return { members: [], error: describeSupabaseError(memberError, '구성원 목록을 불러오지 못했습니다.') }
    }
    const rows = (memberRows ?? []) as Array<Record<string, unknown>>
    const userIds = rows.map((row) => String(row.user_id ?? '')).filter(Boolean)
    let profileMap = new Map<string, Record<string, unknown>>()
    if (userIds.length > 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, username, display_name, phone, title, department, email')
        .in('user_id', userIds)
      if (profileError) {
        return { members: [], error: describeSupabaseError(profileError, '프로필을 불러오지 못했습니다.') }
      }
      profileMap = new Map(
        ((profileRows ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.user_id ?? ''), row]),
      )
    }
    const members: TeamMember[] = rows.map((row) => {
      const userId = String(row.user_id ?? '')
      const profile = profileMap.get(userId) ?? {}
      return {
        userId,
        companyId: String(row.company_id ?? ''),
        role: String(row.role ?? 'member'),
        status: String(row.status ?? 'active'),
        username: String(profile.username ?? ''),
        displayName: String(profile.display_name ?? ''),
        phone: String(profile.phone ?? ''),
        title: String(profile.title ?? ''),
        department: String(profile.department ?? ''),
        email: String(profile.email ?? ''),
        createdAt: String(row.created_at ?? ''),
      }
    })
    return { members, error: null }
  }, [activeCompanyId])

  const createTeamMember = useCallback(
    async (input: CreateMemberInput): Promise<string | null> => {
      if (!supabase || !activeCompanyId || !session?.user) {
        return '로그인 후 다시 시도해 주세요.'
      }
      const username = input.username.trim().toLowerCase()
      if (!USERNAME_PATTERN.test(username)) {
        return '아이디는 영문/숫자/._- 조합 3~32자로 입력해 주세요.'
      }
      if (input.password.length < 6) {
        return '비밀번호는 6자 이상이어야 합니다.'
      }
      if (!input.displayName.trim()) {
        return '이름을 입력해 주세요.'
      }

      const ephemeral = createEphemeralSupabaseClient()
      if (!ephemeral) {
        return 'Supabase 연결이 비활성화되어 있습니다.'
      }

      const signupEmail = usernameToInternalEmail(username)
      const { data: signUpData, error: signUpError } = await ephemeral.auth.signUp({
        email: signupEmail,
        password: input.password,
        options: {
          data: {
            username,
            display_name: input.displayName.trim(),
            phone: input.phone.trim(),
            title: input.title.trim(),
          },
        },
      })
      if (signUpError) {
        if (/already registered|already exists/i.test(signUpError.message)) {
          return '이미 사용 중인 아이디입니다.'
        }
        return describeSupabaseError(signUpError, '계정 생성에 실패했습니다.')
      }

      const newUserId = signUpData.user?.id
      if (!newUserId) {
        return '계정이 생성되었지만 ID를 확인하지 못했습니다. 관리자에게 문의해 주세요.'
      }

      // 1) 먼저 회사 소속을 연결 (이후 profile RLS 체크가 자연스럽게 통과됨)
      const { error: memberError } = await supabase.from('company_members').insert({
        company_id: activeCompanyId,
        user_id: newUserId,
        role: input.role,
        status: 'active',
      })
      if (memberError) {
        console.error('[createTeamMember] company_members insert failed', memberError)
        return `회사 연결 실패: ${describeSupabaseError(
          memberError,
          '권한(RLS)을 확인해 주세요. 현재 로그인 계정이 이 회사의 owner인지, 마이그레이션이 실행됐는지 확인 필요.',
        )} (Supabase Auth에 고아 계정이 남았을 수 있으니 대시보드에서 삭제 후 다시 시도)`
      }

      // 2) 프로필 저장
      const { error: profileError } = await supabase.from('profiles').insert({
        user_id: newUserId,
        username,
        display_name: input.displayName.trim(),
        phone: input.phone.trim(),
        title: input.title.trim(),
        department: input.department.trim(),
        email: input.email.trim(),
      })
      if (profileError) {
        console.error('[createTeamMember] profiles insert failed', profileError)
        return `프로필 저장 실패: ${describeSupabaseError(
          profileError,
          'SQL 마이그레이션(profiles 테이블/정책)이 실행되었는지 확인해 주세요.',
        )}`
      }

      return null
    },
    [activeCompanyId, session?.user],
  )

  const updateTeamMember = useCallback(
    async (input: UpdateMemberInput): Promise<string | null> => {
      if (!supabase || !activeCompanyId) {
        return '로그인이 필요합니다.'
      }
      if (!input.userId) {
        return '대상 사용자를 찾지 못했습니다.'
      }

      const profilePatch: Record<string, unknown> = {}
      if (input.displayName !== undefined) profilePatch.display_name = input.displayName.trim()
      if (input.phone !== undefined) profilePatch.phone = input.phone.trim()
      if (input.title !== undefined) profilePatch.title = input.title.trim()
      if (input.department !== undefined) profilePatch.department = input.department.trim()
      if (input.email !== undefined) profilePatch.email = input.email.trim()

      if (Object.keys(profilePatch).length > 0) {
        const { error } = await supabase.from('profiles').update(profilePatch).eq('user_id', input.userId)
        if (error) {
          return describeSupabaseError(error, '프로필 수정에 실패했습니다.')
        }
      }

      const memberPatch: Record<string, unknown> = {}
      if (input.role !== undefined) memberPatch.role = input.role
      if (input.status !== undefined) memberPatch.status = input.status

      if (Object.keys(memberPatch).length > 0) {
        const { error } = await supabase
          .from('company_members')
          .update(memberPatch)
          .eq('company_id', activeCompanyId)
          .eq('user_id', input.userId)
        if (error) {
          return describeSupabaseError(error, '구성원 정보 수정에 실패했습니다.')
        }
      }

      return null
    },
    [activeCompanyId],
  )

  const removeTeamMember = useCallback(
    async (userId: string): Promise<string | null> => {
      if (!supabase || !activeCompanyId) {
        return '로그인이 필요합니다.'
      }
      if (!userId) {
        return '대상 사용자를 찾지 못했습니다.'
      }
      if (userId === session?.user?.id) {
        return '본인 계정은 이 화면에서 삭제할 수 없습니다.'
      }
      const { error } = await supabase
        .from('company_members')
        .delete()
        .eq('company_id', activeCompanyId)
        .eq('user_id', userId)
      if (error) {
        return describeSupabaseError(error, '구성원 제거에 실패했습니다.')
      }
      return null
    },
    [activeCompanyId, session?.user?.id],
  )

  const changeMemberPassword = useCallback(
    async (userId: string, newPassword: string): Promise<string | null> => {
      // 타인의 비밀번호 변경은 service_role이 필요해 클라이언트에서 직접 불가.
      // 본인 비밀번호 변경만 허용한다.
      if (!supabase || !session?.user) {
        return '로그인이 필요합니다.'
      }
      if (userId !== session.user.id) {
        return '다른 사용자의 비밀번호는 변경할 수 없습니다. Supabase 대시보드에서 재설정해 주세요.'
      }
      if (newPassword.length < 6) {
        return '비밀번호는 6자 이상이어야 합니다.'
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) {
        return describeSupabaseError(error, '비밀번호 변경에 실패했습니다.')
      }
      return null
    },
    [session?.user],
  )

  const activeCompany = memberships.find((membership) => membership.companyId === activeCompanyId) ?? null

  const value = useMemo<AppRuntimeContextValue>(
    () =>
      runtimeMode === 'local'
        ? LOCAL_RUNTIME_VALUE
        : {
            mode: 'cloud',
            isReady,
            session,
            user: session?.user ?? null,
            memberships,
            activeCompanyId,
            activeCompany,
            errorMessage,
            signInWithPassword,
            signOut,
            refreshMemberships,
            createCompany,
            setActiveCompanyId,
            listTeamMembers,
            createTeamMember,
            updateTeamMember,
            removeTeamMember,
            changeMemberPassword,
          },
    [
      activeCompany,
      activeCompanyId,
      createCompany,
      errorMessage,
      isReady,
      memberships,
      refreshMemberships,
      session,
      setActiveCompanyId,
      signInWithPassword,
      signOut,
      listTeamMembers,
      createTeamMember,
      updateTeamMember,
      removeTeamMember,
      changeMemberPassword,
    ],
  )

  return <AppRuntimeContext.Provider value={value}>{children}</AppRuntimeContext.Provider>
}

export function useAppRuntime() {
  const context = useContext(AppRuntimeContext)
  if (!context) {
    throw new Error('useAppRuntime must be used within AppRuntimeProvider')
  }
  return context
}
