import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''

export const isSupabaseEnabled = Boolean(supabaseUrl && supabaseAnonKey)
export const runtimeMode = isSupabaseEnabled ? ('cloud' as const) : ('local' as const)

export const supabase = isSupabaseEnabled
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

/**
 * 메인 세션에 영향을 주지 않고 1회성 signUp 등을 수행하기 위한 임시 Supabase 클라이언트.
 * 세션을 저장하지 않고 자동 갱신도 하지 않는다. 관리자가 팀원 계정을 만들 때 사용한다.
 */
export function createEphemeralSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseEnabled) {
    return null
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `sb-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  })
}
