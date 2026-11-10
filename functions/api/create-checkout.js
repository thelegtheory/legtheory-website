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

  /*
    Shipping (amounts in cents).
    Orders of FREE_SHIPPING_FROM or more ship free to every country below.
  */
  const FREE_SHIPPING_FROM = 10000;

  const SHIPPING = {
    NL: { amount: 500, name: 'NL Shipping' },
    BE: { amount: 800, name: 'EU Shipping' },
    DE: { amount: 800, name: 'EU Shipping' },
    FR: { amount: 800, name: 'EU Shipping' },
    IT: { amount: 900, name: 'EU Shipping' }
  };

  /*
    UK ORDER (personal link, Nov 2026)
    Only reachable from the hidden page uk-personal-order-r8q4.html.
    - mesh legwear only (no sleeves); stock shared with the main shop
    - flat €6 tracked shipping from Amsterdam, never free
    - one pair of leg garters per pair of mesh added as a gift
      (not charged, but taken off the garters stock)
    - customer pays UK import VAT + Royal Mail fee on delivery
    To remove completely: delete this block, the GB checks below
    and the hidden page.
  */
  const UK_ORDER = {
    /*
      PAUSED (Nov 2026): UK orders are switched off for now.
      To turn them back on, set enabled to true here AND
      UK_ORDERS_OPEN to true in uk-personal-order-r8q4.html.
    */
    enabled: false,
    country: 'GB',
    amount: 600,
    name: 'UK tracked shipping (from Amsterdam)',
    allowedTypes: ['mesh'],
    giftGarters: 'leg-garters',
    page: '/uk-personal-order-r8q4.html'
  };

  if (country === UK_ORDER.country && !UK_ORDER.enabled) {
    return json({
      error: 'UK orders are paused for now. Follow us on Instagram for updates.'
    }, 400);
  }

  const isUkOneTime = UK_ORDER.enabled && country === UK_ORDER.country;

  /*
    type is used for the cart rules:
    - garters can only be bought together with mesh legwear in
      the same colour (never more pairs of garters than pairs of mesh)
  */
  const PRODUCTS = {
    'red-m': {
      name: 'Patent Leather Leg Sleeves - Red M',
      amount: 6500,
      type: 'sleeves'
    },
    'white-m': {
      name: 'Patent Leather Leg Sleeves - White M',
      amount: 6500,
      type: 'sleeves'
    },
    'white-l': {
      name: 'Patent Leather Leg Sleeves - White L',
      amount: 6500,
      type: 'sleeves'
    },
    'black-s': {
      name: 'Patent Leather Leg Sleeves - Black S',
      amount: 6500,
      type: 'sleeves'
    },
    'black-m': {
      name: 'Patent Leather Leg Sleeves - Black M',
      amount: 6500,
      type: 'sleeves'
    },
    'black-l': {
      name: 'Patent Leather Leg Sleeves - Black L',
      amount: 6500,
      type: 'sleeves'
    },
    'mesh-long': {
      name: 'Sheer Mesh Legwear - Black',
      amount: 3500,
      type: 'mesh',
      color: 'black'
    },
    'leg-garters': {
      name: 'Leg Garters - Black',
      amount: 200,
      type: 'garters',
      color: 'black'
    }
  };

  if (
    typeof country !== 'string' ||
    (
      !isUkOneTime &&
      !Object.prototype.hasOwnProperty.call(SHIPPING, country)
    )
  ) {
    return json({ error: 'Invalid shipping country' }, 400);
  }

  if (!env.STRIPE_SECRET_KEY) {
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

  /*
    Cart rules for the garters add-on.
  */
  const countByType = type =>
    [...quantities.entries()]
      .filter(([key]) => PRODUCTS[key].type === type)
      .reduce((sum, [, quantity]) => sum + quantity, 0);

  if (isUkOneTime) {
    for (const key of quantities.keys()) {
      if (!UK_ORDER.allowedTypes.includes(PRODUCTS[key].type)) {
        return json({
          error: 'The UK order is for the mesh legwear only (garters are included as a gift).'
        }, 400);
      }
    }
  }

  const meshCount = countByType('mesh');
  const gartersCount = countByType('garters');

  if (gartersCount > 0 && meshCount === 0) {
    return json({
      error: 'Leg garters are available together with the mesh legwear.'
    }, 400);
  }

  if (gartersCount > meshCount) {
    return json({
      error: 'You can add one pair of leg garters per pair of mesh legwear.'
    }, 400);
  }

  const countByTypeAndColor = (type, color) =>
    [...quantities.entries()]
      .filter(([key]) =>
        PRODUCTS[key].type === type &&
        PRODUCTS[key].color === color
      )
      .reduce((sum, [, quantity]) => sum + quantity, 0);

  for (const [key, quantity] of quantities.entries()) {
    const product = PRODUCTS[key];

    if (
      product.type === 'garters' &&
      quantity > countByTypeAndColor('mesh', product.color)
    ) {
      return json({
        error: 'Leg garters are available together with the mesh legwear in the same colour.'
      }, 400);
    }
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

  const lineItems = checkoutItems;

  /*
    UK order: gift garters go into the cart metadata only (so the
    webhook takes them off stock and lists them in the emails), not
    into the Stripe line items (so they are not charged).
    Skipped quietly if the garters are out of stock.
  */
  const metadataCart = checkoutItems.map(item => ({
    product: item.productKey,
    quantity: item.quantity
  }));

  if (isUkOneTime) {
    const meshPairs = countByType('mesh');

    const garterRow = await env.DB
      .prepare(
        'SELECT stock FROM inventory WHERE product_key = ?'
      )
      .bind(UK_ORDER.giftGarters)
      .first();

    const giftQuantity = Math.min(
      meshPairs,
      Math.max(Number(garterRow?.stock) || 0, 0)
    );

    if (giftQuantity > 0) {
      metadataCart.push({
        product: UK_ORDER.giftGarters,
        quantity: giftQuantity,
        gift: true
      });

      const meshLine = lineItems.find(item => item.type === 'mesh');

      if (meshLine) {
        meshLine.name = `${meshLine.name} (+ leg garters as a gift)`;
      }
    }
  }

  const subtotal = lineItems.reduce(
    (sum, item) => sum + item.amount * item.quantity,
    0
  );

  const qualifiesForFreeShipping =
    subtotal >= FREE_SHIPPING_FROM;

  const shipping = isUkOneTime
    ? { amount: UK_ORDER.amount, name: UK_ORDER.name }
    : qualifiesForFreeShipping
      ? { amount: 0, name: 'Free shipping' }
      : SHIPPING[country];

  const origin = new URL(request.url).origin;

  const params = new URLSearchParams();

  params.append('mode', 'payment');
  params.append(
    'metadata[cart]',
    JSON.stringify(metadataCart)
  );
  params.append(
  'success_url',
  `${origin}/success.html`
);

  params.append(
    'cancel_url',
    isUkOneTime
      ? `${origin}${UK_ORDER.page}?checkout=cancelled`
      : `${origin}/collection.html?checkout=cancelled`
  );

  lineItems.forEach((item, index) => {
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

  /*
    UK orders: phone number required, so Royal Mail can text the
    customer about import VAT (email is always collected by Stripe).
  */
  if (isUkOneTime) {
    params.append('phone_number_collection[enabled]', 'true');
  }

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
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
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
