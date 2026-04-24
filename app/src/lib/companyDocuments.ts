import { supabase } from './supabase'

export const COMPANY_DOCUMENT_KEYS = {
  expensePage: 'expense-page',
  statementPage: 'statement-page',
  statementInventoryMappings: 'statement-inventory-mappings',
  inventoryPage: 'inventory-page',
  beanNameAliases: 'bean-name-aliases',
  greenBeanOrderPage: 'green-bean-order-page',
  staffPayrollPage: 'staff-payroll-page',
  memoPage: 'memo-page',
  monthlyMeetingPage: 'monthly-meeting-page',
} as const

export type CompanyDocumentKey = (typeof COMPANY_DOCUMENT_KEYS)[keyof typeof COMPANY_DOCUMENT_KEYS]

type CompanyDocumentRow<T> = {
  payload: T
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

type CompanyDocumentRowWithMeta<T> = {
  payload: T
  updated_at: string
}

/** 클라이언트 병합·최신 여부 판단용 */
export async function loadCompanyDocumentWithMeta<T>(
  companyId: string,
  docKey: CompanyDocumentKey,
): Promise<{ payload: T; updatedAt: string } | null> {
  if (!supabase) {
    return null
  }
  const { data, error } = await supabase
    .from('company_documents')
    .select('payload, updated_at')
    .eq('company_id', companyId)
    .eq('doc_key', docKey)
    .maybeSingle<CompanyDocumentRowWithMeta<T>>()

  if (error) {
    throw error
  }
  if (!data?.payload) {
    return null
  }
  return { payload: data.payload, updatedAt: data.updated_at }
}

export async function saveCompanyDocument<T>(
  companyId: string,
  docKey: CompanyDocumentKey,
  payload: T,
  updatedBy?: string | null,
): Promise<string | null> {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('company_documents')
    .upsert(
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
    .select('updated_at')
    .single<{ updated_at: string }>()

  if (error) {
    throw error
  }
  return data?.updated_at ?? null
}
