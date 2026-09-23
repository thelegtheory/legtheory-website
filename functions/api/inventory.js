function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) {
    return json({
      error: 'Inventory database is not configured'
    }, 503);
  }

  try {
    const result = await env.DB
      .prepare(`
        SELECT product_key, stock
        FROM inventory
      `)
      .all();

    const inventory = {};

    for (const row of result.results) {
      inventory[row.product_key] = Number(row.stock);
    }

    return json(inventory);

  } catch (error) {
    console.error('Inventory error:', error);

    return json({
      error: 'Inventory could not be loaded'
    }, 500);
  }
}
