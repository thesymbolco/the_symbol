import { supabase } from './supabase'

export const COMPANY_DOCUMENT_KEYS = {
  expensePage: 'expense-page',
  statementPage: 'statement-page',
  statementInventoryMappings: 'statement-inventory-mappings',
  inventoryPage: 'inventory-page',
  inventoryPageCore: 'inventory-page-core',
  inventoryPageMonths: 'inventory-page-months',
  inventoryPageTemplate: 'inventory-page-template',
  inventoryPageHistory: 'inventory-page-history',
  beanNameAliases: 'bean-name-aliases',
  greenBeanOrderPage: 'green-bean-order-page',
  staffPayrollPage: 'staff-payroll-page',
  memoPage: 'memo-page',
  monthlyMeetingPage: 'monthly-meeting-page',
} as const

export type CompanyDocumentKey = (typeof COMPANY_DOCUMENT_KEYS)[keyof typeof COMPANY_DOCUMENT_KEYS]

type CompanyDocumentRow<T> = {
  payload: T
  updated_at?: string | null
}

export async function loadCompanyDocumentUpdatedAt(
  companyId: string,
  docKey: CompanyDocumentKey,
): Promise<string | null> {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('company_documents')
    .select('updated_at')
    .eq('company_id', companyId)
    .eq('doc_key', docKey)
    .maybeSingle<{ updated_at: string | null }>()

  if (error) {
    throw error
  }
  return data?.updated_at ?? null
}

export type CompanyDocumentUpdatedAtMap = Partial<Record<CompanyDocumentKey, string | null>>

export async function loadCompanyDocumentsUpdatedAt(
  companyId: string,
  docKeys: readonly CompanyDocumentKey[],
): Promise<CompanyDocumentUpdatedAtMap> {
  if (!supabase || docKeys.length === 0) {
    return {}
  }

  const { data, error } = await supabase
    .from('company_documents')
    .select('doc_key, updated_at')
    .eq('company_id', companyId)
    .in('doc_key', [...docKeys])

  if (error) {
    throw error
  }

  const out: CompanyDocumentUpdatedAtMap = {}
  for (const row of data ?? []) {
    const key = String((row as { doc_key?: unknown }).doc_key ?? '') as CompanyDocumentKey
    if (docKeys.includes(key)) {
      out[key] = ((row as { updated_at?: string | null }).updated_at ?? null) as string | null
    }
  }
  return out
}

export function isCompanyDocumentUpdatedAtUnchanged(
  remoteUpdatedAt: string | null | undefined,
  lastRemoteUpdatedAt: string | null | undefined,
): boolean {
  if (remoteUpdatedAt == null && lastRemoteUpdatedAt == null) {
    return true
  }
  if (!remoteUpdatedAt || !lastRemoteUpdatedAt) {
    return false
  }
  return remoteUpdatedAt === lastRemoteUpdatedAt
}

export async function loadCompanyDocument<T>(
  companyId: string,
  docKey: CompanyDocumentKey,
): Promise<T | null> {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('company_documents')
    .select('payload')
    .eq('company_id', companyId)
    .eq('doc_key', docKey)
    .maybeSingle<CompanyDocumentRow<T>>()

  if (error) {
    throw error
  }
  return data?.payload ?? null
}

export async function saveCompanyDocument<T>(
  companyId: string,
  docKey: CompanyDocumentKey,
  payload: T,
  updatedBy?: string | null,
) {
  if (!supabase) {
    return
  }

  const { error } = await supabase.from('company_documents').upsert(
    {
      company_id: companyId,
      doc_key: docKey,
      payload,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'company_id,doc_key',
    },
  )

  if (error) {
    throw error
  }
}
