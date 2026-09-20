export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { country, product } = req.body || {};

  const SHIPPING = {
    NL: { amount: 450, name: 'NL Shipping' },
    BE: { amount: 800, name: 'EU Shipping' },
    DE: { amount: 800, name: 'EU Shipping' },
    FR: { amount: 800, name: 'EU Shipping' }
  };
  
  const shipping = SHIPPING[country];
  
  if (!shipping) {
    return res.status(400).json({ error: 'Invalid shipping country' });
  }
  
  const allowedCountries = [country];
  const shippingAmount = shipping.amount;
  const shippingName = shipping.name;

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

  const selectedProduct = PRODUCTS[product];

if (!selectedProduct) {
  return res.status(400).json({ error: 'Invalid product' });
}
  
  const params = new URLSearchParams();

  params.append('mode', 'payment');

  params.append(
    'success_url',
    'https://legtheory-website.vercel.app/?checkout=success'
  );

  params.append(
    'cancel_url',
    'https://legtheory-website.vercel.app/?checkout=cancelled'
  );

  params.append(
    'line_items[0][price_data][currency]',
    'eur'
  );

  params.append(
    'line_items[0][price_data][product_data][name]',
    selectedProduct.name
  );

  params.append(
    'line_items[0][price_data][unit_amount]',
    String(selectedProduct.amount)
  );

  params.append(
    'line_items[0][quantity]',
    '1'
  );

  allowedCountries.forEach((country, index) => {
    params.append(
      `shipping_address_collection[allowed_countries][${index}]`,
      country
    );
  });

  params.append(
    'shipping_options[0][shipping_rate_data][type]',
    'fixed_amount'
  );

  params.append(
    'shipping_options[0][shipping_rate_data][fixed_amount][amount]',
    String(shippingAmount)
  );

  params.append(
    'shipping_options[0][shipping_rate_data][fixed_amount][currency]',
    'eur'
  );

  params.append(
    'shipping_options[0][shipping_rate_data][display_name]',
    shippingName
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
      return res.status(400).json(session);
    }

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({
      error: 'Checkout session could not be created'
    });
  }
}
