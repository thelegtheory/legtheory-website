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

  const { country, product } = body || {};

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
    !Object.hasOwn(SHIPPING, country)
  ) {
    return json({ error: 'Invalid shipping country' }, 400);
  }

  if (
    typeof product !== 'string' ||
    !Object.hasOwn(PRODUCTS, product)
  ) {
    return json({ error: 'Invalid product' }, 400);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Checkout is not configured yet' }, 503);
  }

  const shipping = SHIPPING[country];
  const selectedProduct = PRODUCTS[product];
  const origin = new URL(request.url).origin;

  const params = new URLSearchParams({
    'mode': 'payment',
    'success_url': `${origin}/?checkout=success`,
    'cancel_url': `${origin}/collection.html?checkout=cancelled`,
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][product_data][name]':
      selectedProduct.name,
    'line_items[0][price_data][unit_amount]':
      String(selectedProduct.amount),
    'line_items[0][quantity]': '1',
    'shipping_address_collection[allowed_countries][0]':
      country,
    'shipping_options[0][shipping_rate_data][type]':
      'fixed_amount',
    'shipping_options[0][shipping_rate_data][fixed_amount][amount]':
      String(shipping.amount),
    'shipping_options[0][shipping_rate_data][fixed_amount][currency]':
      'eur',
    'shipping_options[0][shipping_rate_data][display_name]':
      shipping.name
  });

  try {
    const response = await fetch(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );

    const session = await response.json();

    if (!response.ok) {
      return json({
        error: 'Checkout could not be created. Please try again or contact us on Instagram.'
      }, 502);
    }

    return json({ url: session.url });
  } catch {
    return json({
      error: 'Checkout session could not be created'
    }, 502);
  }
}
