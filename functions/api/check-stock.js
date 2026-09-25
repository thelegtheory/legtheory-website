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
