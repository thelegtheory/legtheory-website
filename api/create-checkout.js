export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { shippingZone } = req.body || {};

  const isNL = shippingZone === 'nl';

  const allowedCountries = isNL
    ? ['NL']
    : ['BE'];

  const shippingAmount = isNL ? 495 : 1100;
  const shippingName = isNL ? 'NL Shipping' : 'EU Shipping';

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
    'Leg Theory Test Product'
  );

  params.append(
    'line_items[0][price_data][unit_amount]',
    '100'
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
