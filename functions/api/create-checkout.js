function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const { country, product, items } = body || {};

  const SHIPPING = {
    NL: { amount: 450, name: 'NL Shipping' },
    BE: { amount: 800, name: 'EU Shipping' },
    DE: { amount: 800, name: 'EU Shipping' },
    FR: { amount: 800, name: 'EU Shipping' }
  };

  const PRODUCTS = {
    'red-m': {
      name: 'Patent Leather Leg Sleeves - Red M',
      amount: 6500
    },
    'white-m': {
      name: 'Patent Leather Leg Sleeves - White M',
      amount: 6500
    },
    'white-l': {
      name: 'Patent Leather Leg Sleeves - White L',
      amount: 6500
    },
    'black-s': {
      name: 'Patent Leather Leg Sleeves - Black S',
      amount: 6500
    },
    'black-m': {
      name: 'Patent Leather Leg Sleeves - Black M',
      amount: 6500
    },
    'black-l': {
      name: 'Patent Leather Leg Sleeves - Black L',
      amount: 6500
    },
    'mesh-long': {
      name: 'Sheer Mesh Legwear - Long 95cm',
      amount: 3500
    }
  };

  if (
    typeof country !== 'string' ||
    !Object.prototype.hasOwnProperty.call(SHIPPING, country)
  ) {
    return json({ error: 'Invalid shipping country' }, 400);
  }

  if (!env.STRIPE_TEST_SECRET_KEY) {
    return json({ error: 'Checkout is not configured yet' }, 503);
  }

  if (!env.DB) {
    return json({ error: 'Inventory database is not configured' }, 503);
  }

  let requestedItems;

  if (Array.isArray(items) && items.length > 0) {
    requestedItems = items;
  } else if (typeof product === 'string') {
    requestedItems = [
      {
        product,
        quantity: 1
      }
    ];
  } else {
    return json({ error: 'Your cart is empty' }, 400);
  }

  if (requestedItems.length > 20) {
    return json({ error: 'Too many different items in cart' }, 400);
  }

  const quantities = new Map();

  for (const item of requestedItems) {
    if (
      !item ||
      typeof item.product !== 'string' ||
      !Object.prototype.hasOwnProperty.call(PRODUCTS, item.product)
    ) {
      return json({
        error: `Invalid product: ${item?.product || 'unknown'}`
      }, 400);
    }

    const quantity = Number(item.quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      return json({ error: 'Invalid quantity' }, 400);
    }

    const previousQuantity =
      quantities.get(item.product) || 0;

    quantities.set(
      item.product,
      previousQuantity + quantity
    );
  }

  const checkoutItems = [];

  for (const [productKey, quantity] of quantities.entries()) {
    const selectedProduct = PRODUCTS[productKey];

    const stockRow = await env.DB
      .prepare(
        'SELECT stock FROM inventory WHERE product_key = ?'
      )
      .bind(productKey)
      .first();

    if (!stockRow) {
      return json({
        error: `Inventory not found for ${selectedProduct.name}`
      }, 400);
    }

    const stock = Number(stockRow.stock);

    if (stock <= 0) {
      return json({
        error: `${selectedProduct.name} is sold out`
      }, 400);
    }

    if (quantity > stock) {
      return json({
        error: `Only ${stock} available for ${selectedProduct.name}`
      }, 400);
    }

    checkoutItems.push({
      ...selectedProduct,
      productKey,
      quantity
    });
  }

  const shipping = SHIPPING[country];
  const origin = new URL(request.url).origin;

  const params = new URLSearchParams();

  params.append('mode', 'payment');
  params.append(
    'metadata[cart]',
    JSON.stringify(
      checkoutItems.map(item => ({
        product: item.productKey,
        quantity: item.quantity
      }))
    )
  );
  params.append(
    'success_url': `${origin}/success.html`,
  );

  params.append(
    'cancel_url',
    `${origin}/collection.html?checkout=cancelled`
  );

  checkoutItems.forEach((item, index) => {
    params.append(
      `line_items[${index}][price_data][currency]`,
      'eur'
    );

    params.append(
      `line_items[${index}][price_data][product_data][name]`,
      item.name
    );

    params.append(
      `line_items[${index}][price_data][unit_amount]`,
      String(item.amount)
    );

    params.append(
      `line_items[${index}][quantity]`,
      String(item.quantity)
    );

    params.append(
      `line_items[${index}][price_data][product_data][metadata][product_key]`,
      item.productKey
    );
  });

  params.append(
    'shipping_address_collection[allowed_countries][0]',
    country
  );

  params.append(
    'shipping_options[0][shipping_rate_data][type]',
    'fixed_amount'
  );

  params.append(
    'shipping_options[0][shipping_rate_data][fixed_amount][amount]',
    String(shipping.amount)
  );

  params.append(
    'shipping_options[0][shipping_rate_data][fixed_amount][currency]',
    'eur'
  );

  params.append(
    'shipping_options[0][shipping_rate_data][display_name]',
    shipping.name
  );

  try {
    const response = await fetch(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_TEST_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );

    const session = await response.json();

    if (!response.ok) {
      console.error('Stripe error:', session);

      return json({
        error:
          session?.error?.message ||
          'Checkout could not be created. Please try again.'
      }, 502);
    }

    return json({
      url: session.url
    });

  } catch (error) {
    console.error('Checkout error:', error);

    return json({
      error: 'Checkout session could not be created'
    }, 502);
  }
}
