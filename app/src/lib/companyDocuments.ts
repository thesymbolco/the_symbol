import { supabase } from './supabase'

export const COMPANY_DOCUMENT_KEYS = {
  expensePage: 'expense-page',
  statementPage: 'statement-page',
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
