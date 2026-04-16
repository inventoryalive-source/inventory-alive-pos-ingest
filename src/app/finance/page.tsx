// @ts-nocheck
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { calculateTaxGhost } from '../../lib/finance/taxShield'

type FinanceSummary = {
  total_cash: number
  tax_ghost: number
  spendable_cash: number
}

const BRAND_ID = 'inventory_alive'

function asCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export default function FinancePage() {
  const [amount, setAmount] = useState<string>('')
  const [description, setDescription] = useState<string>('')
  const [summary, setSummary] = useState<FinanceSummary>({
    total_cash: 0,
    tax_ghost: 0,
    spendable_cash: 0,
  })
  const [message, setMessage] = useState<string>('')
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const loadSummary = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/finance/summary?brand_id=${BRAND_ID}`)
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load summary')
      }
      setSummary({
        total_cash: Number(data.total_cash || 0),
        tax_ghost: Number(data.tax_ghost || 0),
        spendable_cash: Number(data.spendable_cash || 0),
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load finance data')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  const totalForChart = useMemo(() => Math.max(summary.total_cash, summary.tax_ghost, 1), [summary])
  const totalCashWidth = `${Math.round((summary.total_cash / totalForChart) * 100)}%`
  const taxGhostWidth = `${Math.round((summary.tax_ghost / totalForChart) * 100)}%`

  async function handleLog(transactionType: 'owner_contribution' | 'revenue') {
    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setMessage('Enter a valid amount greater than 0.')
      return
    }

    const tax = calculateTaxGhost({
      brand_id: BRAND_ID,
      transaction_type: transactionType,
      amount: parsedAmount,
      description: description || undefined,
    })

    setIsSaving(true)
    setMessage('')

    try {
      const response = await fetch('/api/finance/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_id: BRAND_ID,
          transaction_type: transactionType,
          amount: parsedAmount,
          description: description || null,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save finance log')
      }

      setAmount('')
      setDescription('')
      await loadSummary()
      setMessage(
        transactionType === 'owner_contribution'
          ? `Equity logged. Tax ghost is ${asCurrency(tax.tax_ghost_reserve)}.`
          : `Revenue logged. Tax ghost reserved: ${asCurrency(tax.tax_ghost_reserve)}.`
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save finance log')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <main
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '1rem',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <h1 style={{ marginBottom: '0.75rem' }}>Finance Alive Dashboard</h1>

      <section
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 14,
          padding: '0.9rem',
          marginBottom: '1rem',
          background: '#fff',
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '1rem' }}>Cash vs Tax Ghost</h2>
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
            Total Cash: {asCurrency(summary.total_cash)}
          </div>
          <div style={{ height: 12, background: '#eef2ff', borderRadius: 999 }}>
            <div
              style={{
                width: totalCashWidth,
                height: '100%',
                borderRadius: 999,
                background: '#2563eb',
              }}
            />
          </div>
        </div>
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
            Tax Ghost: {asCurrency(summary.tax_ghost)}
          </div>
          <div style={{ height: 12, background: '#fee2e2', borderRadius: 999 }}>
            <div
              style={{
                width: taxGhostWidth,
                height: '100%',
                borderRadius: 999,
                background: '#dc2626',
              }}
            />
          </div>
        </div>
        <p style={{ marginBottom: 0, fontWeight: 600 }}>
          Spendable Cash: {asCurrency(summary.spendable_cash)}
        </p>
      </section>

      <section
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 14,
          padding: '0.9rem',
          background: '#fff',
        }}
      >
        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }} htmlFor="amount">
          Amount
        </label>
        <input
          id="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          style={{
            width: '100%',
            padding: '0.85rem',
            borderRadius: 12,
            border: '1px solid #d1d5db',
            marginBottom: '0.75rem',
            fontSize: '1rem',
          }}
        />

        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }} htmlFor="description">
          Note (optional)
        </label>
        <input
          id="description"
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Quick note"
          style={{
            width: '100%',
            padding: '0.85rem',
            borderRadius: 12,
            border: '1px solid #d1d5db',
            marginBottom: '0.9rem',
            fontSize: '1rem',
          }}
        />

        <div style={{ display: 'grid', gap: '0.6rem' }}>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleLog('owner_contribution')}
            style={{
              width: '100%',
              minHeight: 64,
              borderRadius: 14,
              border: 'none',
              background: '#111827',
              color: '#fff',
              fontSize: '1.05rem',
              fontWeight: 700,
            }}
          >
            Log Equity
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleLog('revenue')}
            style={{
              width: '100%',
              minHeight: 64,
              borderRadius: 14,
              border: 'none',
              background: '#16a34a',
              color: '#fff',
              fontSize: '1.05rem',
              fontWeight: 700,
            }}
          >
            Log Revenue
          </button>
        </div>

        <p style={{ marginTop: '0.9rem', marginBottom: 0, minHeight: 22, color: '#374151' }}>
          {isLoading ? 'Loading finance summary...' : message}
        </p>
      </section>
    </main>
  )
}
