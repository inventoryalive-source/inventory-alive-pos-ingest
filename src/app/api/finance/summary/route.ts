import { runWithTenantRls } from '../../../../db/runWithTenantRls';

type SummaryRow = {
  total_cash: number | string | null;
  tax_ghost: number | string | null;
};

export async function GET(req: Request & { ingestTenantId?: string }) {
  const tenantId = req.ingestTenantId;
  if (!tenantId) {
    return Response.json({ error: 'Access denied' }, { status: 403 });
  }

  try {
    const summary = await runWithTenantRls(tenantId, async (client: any) => {
      const result = await client.query(
        `SELECT
          COALESCE(SUM(amount), 0) AS total_cash,
          COALESCE(SUM(tax_ghost_reserve), 0) AS tax_ghost
        FROM finance_transactions
        WHERE brand_id = $1`,
        [tenantId]
      );

      const row = (result.rows?.[0] ?? {}) as SummaryRow;
      const totalCash = Number(row.total_cash ?? 0);
      const taxGhost = Number(row.tax_ghost ?? 0);
      const spendableCash = totalCash - taxGhost;

      return {
        total_cash: Number.isFinite(totalCash) ? totalCash : 0,
        tax_ghost: Number.isFinite(taxGhost) ? taxGhost : 0,
        spendable_cash: Number.isFinite(spendableCash) ? spendableCash : 0,
      };
    });

    return Response.json(summary, { status: 200 });
  } catch (error: any) {
    return Response.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}
