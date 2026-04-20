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
import { runtimeMode, supabase } from '../lib/supabase'

const ACTIVE_COMPANY_STORAGE_KEY = 'active-company-id-v1'

export type CompanyMembership = {
  companyId: string
  companyName: string
  role: string
  status: string
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
  signInWithOtp: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
  refreshMemberships: () => Promise<void>
  createCompany: (name: string) => Promise<string | null>
  setActiveCompanyId: (companyId: string) => void
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
  signInWithOtp: async () => null,
  signOut: async () => {},
  refreshMemberships: async () => {},
  createCompany: async () => null,
  setActiveCompanyId: () => {},
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

  const signInWithOtp = useCallback(async (email: string) => {
    if (!supabase) {
      return null
    }
    const normalized = email.trim()
    if (!normalized) {
      return '이메일을 입력해 주세요.'
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) {
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
            signInWithOtp,
            signOut,
            refreshMemberships,
            createCompany,
            setActiveCompanyId,
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
      signInWithOtp,
      signOut,
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
