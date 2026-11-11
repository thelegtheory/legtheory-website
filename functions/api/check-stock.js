function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({
      error: 'Inventory database is not configured'
    }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: 'Invalid request'
    }, 400);
  }

  const product =
    typeof body?.product === 'string'
      ? body.product
      : '';

  const quantity =
    Number(body?.quantity);

  if (
    !product ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10
  ) {
    return json({
      error: 'Invalid stock request'
    }, 400);
  }

  /*
    PRE-ORDER (Nov 2026): keep in sync with create-checkout.js.
    No stock limit; the short version closes after the cut-off.
  */
  const PREORDER_KEYS = ['mesh-long', 'mesh-short', 'mesh-cream', 'leg-garters-white'];
  const SHORT_CLOSES_AT = Date.parse('2026-11-15T23:59:59+01:00');

  if (PREORDER_KEYS.includes(product)) {
    return json({
      available:
        product !== 'mesh-short' || Date.now() <= SHORT_CLOSES_AT
    });
  }

  const row = await env.DB
    .prepare(`
      SELECT stock
      FROM inventory
      WHERE product_key = ?
    `)
    .bind(product)
    .first();

  if (!row) {
    return json({
      available: false
    });
  }

  const stock =
    Number(row.stock);

  return json({
    available: quantity <= stock
  });
}
