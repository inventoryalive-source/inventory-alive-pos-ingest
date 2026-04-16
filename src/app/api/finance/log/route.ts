import { calculateTaxGhost } from '@/lib/finance/taxShield';
import { runWithTenantRls } from '../../../../db/runWithTenantRls';

type FinanceLogBody = {
  amount: number | string;
  transaction_type: string;
  description?: string;
};

export async function POST(req: Request & { ingestTenantId?: string }) {
  const tenantId = req.ingestTenantId;
  if (!tenantId) {
    return Response.json({ error: 'Access denied' }, { status: 403 });
  }

  let body: FinanceLogBody;
  try {
    body = (await req.json()) as FinanceLogBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const amount = Number(body.amount);
  const transactionType = body.transaction_type;
  const description = body.description ?? null;

  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: 'amount must be a positive number' }, { status: 400 });
  }

  if (!transactionType || typeof transactionType !== 'string') {
    return Response.json({ error: 'transaction_type is required' }, { status: 400 });
  }

  try {
    const taxResult = calculateTaxGhost({
      brand_id: tenantId as any,
      transaction_type: transactionType as any,
      amount,
      description: description ?? undefined,
    });

    const savedTransaction = await runWithTenantRls(tenantId, async (client: any) => {
      const result = await client.query(
        `INSERT INTO finance_transactions (
          brand_id,
          transaction_type,
          amount,
          tax_ghost_reserve,
          description
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [
          tenantId,
          transactionType,
          amount,
          taxResult.tax_ghost_reserve,
          description,
        ]
      );

      return result.rows[0];
    });

    return Response.json(savedTransaction, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}
