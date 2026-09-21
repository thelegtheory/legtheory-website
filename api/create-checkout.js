export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { country, product, items } = req.body || {};

  const SHIPPING = {
    NL: { amount: 450, name: 'NL Shipping' },
    BE: { amount: 800, name: 'EU Shipping' },
    DE: { amount: 800, name: 'EU Shipping' },
    FR: { amount: 800, name: 'EU Shipping' }
  };

  const PRODUCTS = {
    'red-m': {
      name: 'Patent Leather Leg Sleeves - Red M',
      amount: 6500,
      maxQuantity: 1
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

  const shipping = SHIPPING[country];

  if (!shipping) {
    return res.status(400).json({
      error: 'Invalid shipping country'
    });
  }

  /*
    Supports BOTH:

    Old checkout:
    {
      country: "NL",
      product: "black-m"
    }

    New cart:
    {
      country: "NL",
      items: [
        { product: "black-m", quantity: 1 },
        { product: "white-l", quantity: 2 }
      ]
    }
  */

  let checkoutItems = [];

  if (Array.isArray(items) && items.length > 0) {
    checkoutItems = items;
  } else if (product) {
    checkoutItems = [
      {
        product,
        quantity: 1
      }
    ];
  } else {
    return res.status(400).json({
      error: 'No products selected'
    });
  }

  // Keep carts reasonably small
  if (checkoutItems.length > 20) {
    return res.status(400).json({
      error: 'Too many items'
    });
  }

  const validatedItems = [];

  for (const item of checkoutItems) {
    const selectedProduct = PRODUCTS[item.product];
    const quantity = Number(item.quantity);

    if (!selectedProduct) {
      return res.status(400).json({
        error: `Invalid product: ${item.product}`
      });
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      return res.status(400).json({
        error: 'Invalid quantity'
      });
    }

    if (
      selectedProduct.maxQuantity &&
      quantity > selectedProduct.maxQuantity
    ) {
      return res.status(400).json({
        error: `${selectedProduct.name} has limited stock`
      });
    }

    validatedItems.push({
      key: item.product,
      ...selectedProduct,
      quantity
    });
  }

  const params = new URLSearchParams();

  params.append('mode', 'payment');

  // IMPORTANT: no more Vercel
  params.append(
    'success_url',
    'https://legtheory.com/?checkout=success'
  );

  params.append(
    'cancel_url',
    'https://legtheory.com/?checkout=cancelled'
  );

  // Add every cart item to ONE Stripe Checkout session
  validatedItems.forEach((item, index) => {
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
  });

  // Customer may only enter the country they selected
  params.append(
    'shipping_address_collection[allowed_countries][0]',
    country
  );

  // Shipping is added ONCE for the entire order
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
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );

    const session = await response.json();

    if (!response.ok) {
      console.error('Stripe error:', session);

      return res.status(400).json(session);
    }

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {
    console.error('Checkout error:', error);

    return res.status(500).json({
      error: 'Checkout session could not be created'
    });
  }
}
