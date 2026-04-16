/**
 * Finance Alive — Tax Shield Middleware
 * Assets Alive LLC
 */

export type TransactionType =
  | 'owner_contribution'
  | 'revenue'
  | 'inter_entity_transfer'

export type BrandId =
  | 'assets_alive'
  | 'pipeline_alive'
  | 'inventory_alive'

export type TransactionStatus = 'pending' | 'cleared' | 'reconciled' | 'voided'

export interface Transaction {
  id?: string
  brand_id: BrandId
  transaction_type: TransactionType
  amount: number
  description?: string
  memo?: string
  reference_id?: string
  source_brand?: BrandId
  destination_brand?: BrandId
  equity_account?: string
  transacted_at?: Date
  status?: TransactionStatus
}

export interface TaxGhostResult {
  original_amount: number
  transaction_type: TransactionType
  brand_id: BrandId
  tax_ghost_reserve: number
  net_after_reserve: number
  is_taxable_income: boolean
  is_equity: boolean
  audit_note: string
}

export interface TaxPeriodSummar{
  brand_id: BrandId
  period: string
  gross_revenue: number
  total_tax_reserve: number
  net_revenue_after_reserve: number
  equity_contributions: number
  internal_transfers: number
  effective_tax_rate: number
}

export function calculateTaxGhost(transaction: Transaction): TaxGhostResult {
  const { amount, transaction_type, brand_id } = transaction

  if (amount <= 0) {
    throw new Error(`[TaxShield] Invalid amount: ${amount}. Transactions must be positive.`)
  }

  const TAX_RESERVE_RATE = 0.30

  switch (transaction_type) {

    case 'revenue': {
      const tax_ghost_reserve = round2(amount * TAX_RESERVE_RATE)
      return {
        original_amount: amount,
        transaction_type,
        brand_id,
        tax_ghost_reserve,
        net_after_reserve: round2(amount - tax_ghost_reserve),
        is_taxable_income: true,
        is_equity: false,
        audit_note:
          `TAXABLE REVENUE: $${amount.toFixed(2)} — ` +
          `30% reserve of $${tax_ghost_reserve.toFixed(2)} applied. ` +
        `Net spendable: $${round2(amount - tax_ghost_reserve).toFixed(2)}.`,
      }
    }

    case 'owner_contribution': {
      return {
        original_amount: amount,
        transaction_type,
        brand_id,
        tax_ghost_reserve: 0,
        net_after_reserve: amount,
        is_taxable_income: false,
        is_equity: true,
        audit_note:
          `OWNER EQUITY CONTRIBUTION: $${amount.toFixed(2)} — ` +
          `NOT taxable income. Recorded to equity account only. ` +
          `Protected under 2026 No Tax on Tips rules. ` +
          `EXCLUDED from all Gross Income calculations.`,
      }
    }

    case 'inter_entity_transfer': {
      if (!transaction.source_brand || !transaction.destination_brand) {
        throw new Error(
          `[TaxShield] inter_entity_transfer requires both source_brand and destination_brand.`
        )
      }
      if (transaction.source_brand === transaction.destination_brand) {
        throw new Error(
          `[TaxShield] inter_entity_transfer sourcand destination cannot be the same brand.`
        )
      }
      return {
        original_amount: amount,
        transaction_type,
        brand_id,
        tax_ghost_reserve: 0,
        net_after_reserve: amount,
        is_taxable_income: false,
        is_equity: false,
        audit_note:
          `INTER-ENTITY TRANSFER: $${amount.toFixed(2)} from ` +
          `${transaction.source_brand} to ${transaction.destination_brand}. ` +
          `NOT taxable revenue. Internal ledger entry only.`,
      }
    }

    default: {
      const _exhaustive: never = transaction_type
      throw new Error(`[TaxShield] Unknown transaction_type: ${_exhaustive}`)
    }
  }
}

export function aggregateTaxPeriod(
  transactions: Transaction[],
  brandId: BrandId,
  period: string
): TaxPeriodSummary {
  const branded = transactions.filter(
    (tx) => tx.brand_id === brandId && tx.status !== 'voided'
  )
  const revenue = branded.filter((tx) => tx.transaction_type === 'revenue')
  const contributions = branded.filter((tx) => tx.transaction_type === 'owner_contribution')
  const transfers = branded.filter((tx) => tx.transaction_type === 'inter_entity_transfer')
  const gross_revenue = revenue.reduce((sum, tx) => sum + tx.amount, 0)
  const total_tax_reserve = round2(gross_revenue * 0.30)
  const equity_contributions = contributions.reduce((sum, tx) => sum + tx.amount, 0)
  const internal_transfers = transfers.reduce((sum, tx) => sum + tx.amount, 0)
  return {
    brand_id: brandId,
    period,
    gross_revenue: round2(gross_revenue),
    total_tax_reserve,
    net_revenue_after_reserve: round2(gross_revenue - total_tax_reserve),
    equity_contributions: round2(equity_contributions),
    internal_transfers: round2(internal_transfers),
    effective_tax_rate: gross_revenue > 0 ? 0.30 : 0,
  }
}

export function validateTransaction(tx: Transaction): void {
  if (tx.amount <= 0) {
    throw new Error('[Validate] amount must be positive')
  }
  if (tx.transaction_type === 'inter_entity_transfer') {
    if (!tx.source_brand || !tx.destination_brand) {
      throw new Error('[Validate] Transfers require source_brand + destination_brand')
    }
    if (tx.source_brand === tx.destination_brand) {
      throw new Error('[Validate] Cannot transfer to the same brand')
    }
  }
  if (tx.transaction_type === 'owner_contribution' && tx.equity_account === undefined) {
    tx.equity_account = 'managing_member_equity'
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
