function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function hexFromBuffer(buffer) {
  return [...new Uint8Array(buffer)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyStripeSignature(
  rawBody,
  signatureHeader,
  secret
) {
  if (!signatureHeader || !secret) {
    return false;
  }

  const parts = signatureHeader.split(',');

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');

    if (key === 't') {
      timestamp = value;
    }

    if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const age =
    Math.abs(Date.now() / 1000 - Number(timestamp));

  if (age > 300) {
    return false;
  }

  const signedPayload =
    `${timestamp}.${rawBody}`;

  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(signedPayload)
  );

  const expectedSignature =
    hexFromBuffer(signature);

  return signatures.includes(expectedSignature);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatProductName(productKey) {
  const productNames = {
    'black-s': 'Patent Leather Leg Sleeves · Black · Size S',
    'black-m': 'Patent Leather Leg Sleeves · Black · Size M',
    'black-l': 'Patent Leather Leg Sleeves · Black · Size L',

    'white-s': 'Patent Leather Leg Sleeves · White · Size S',
    'white-m': 'Patent Leather Leg Sleeves · White · Size M',
    'white-l': 'Patent Leather Leg Sleeves · White · Size L',

    'red-s': 'Patent Leather Leg Sleeves · Red · Size S',
    'red-m': 'Patent Leather Leg Sleeves · Red · Size M',
    'red-l': 'Patent Leather Leg Sleeves · Red · Size L'
  };

  return productNames[productKey] || productKey;
}

async function sendEmail(env, {
  to,
  subject,
  html,
  idempotencyKey
}) {
  if (!env.RESEND_API_KEY || !to) {
    return false;
  }

  try {
    const response = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({
          from: 'Leg Theory <hello@legtheory.com>',
          to: [to],
          subject,
          html
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Resend error:', error);
      return false;
    }

    return true;

  } catch (error) {
    console.error('Email sending failed:', error);
    return false;
  }
}

export async function onRequestPost({
  request,
  env
}) {
  if (!env.DB) {
    return json({
      error: 'Inventory database is not configured'
    }, 503);
  }

  if (
    !env.STRIPE_WEBHOOK_SECRET &&
    !env.STRIPE_TEST_WEBHOOK_SECRET
  ) {
    return json({
      error: 'Webhook secret is not configured'
    }, 503);
  }

  /*
    IMPORTANT:
    Stripe verification must use the raw body.
    Do not call request.json() before verification.
  */
  const rawBody = await request.text();

  const stripeSignature =
    request.headers.get('stripe-signature');

  const validLiveSignature =
    env.STRIPE_WEBHOOK_SECRET
      ? await verifyStripeSignature(
          rawBody,
          stripeSignature,
          env.STRIPE_WEBHOOK_SECRET
        )
      : false;

  const validTestSignature =
    env.STRIPE_TEST_WEBHOOK_SECRET
      ? await verifyStripeSignature(
          rawBody,
          stripeSignature,
          env.STRIPE_TEST_WEBHOOK_SECRET
        )
      : false;

  if (!validLiveSignature && !validTestSignature) {
    return json({
      error: 'Invalid Stripe signature'
    }, 400);
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({
      error: 'Invalid webhook payload'
    }, 400);
  }

  const supportedEvents = [
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded'
  ];

  if (!supportedEvents.includes(event.type)) {
    return json({
      received: true,
      ignored: true
    });
  }

  const session = event.data?.object;

  if (!session?.id) {
    return json({
      error: 'Stripe session missing'
    }, 400);
  }

  if (
    event.type === 'checkout.session.completed' &&
    session.payment_status !== 'paid'
  ) {
    return json({
      received: true,
      waiting_for_payment: true
    });
  }

  const alreadyProcessed = await env.DB
    .prepare(`
      SELECT event_id
      FROM processed_webhooks
      WHERE stripe_session_id = ?
      LIMIT 1
    `)
    .bind(session.id)
    .first();

  if (alreadyProcessed) {
    return json({
      received: true,
      already_processed: true
    });
  }

  const cartMetadata =
    session.metadata?.cart;

  if (!cartMetadata) {
    return json({
      error: 'Cart metadata missing'
    }, 400);
  }

  let cart;

  try {
    cart = JSON.parse(cartMetadata);
  } catch {
    return json({
      error: 'Invalid cart metadata'
    }, 400);
  }

  if (!Array.isArray(cart) || cart.length === 0) {
    return json({
      error: 'Cart metadata is empty'
    }, 400);
  }

  /*
    Validate everything before changing inventory.
  */
  for (const item of cart) {
    const quantity = Number(item.quantity);

    if (
      typeof item.product !== 'string' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      return json({
        error: 'Invalid cart item'
      }, 400);
    }

    const row = await env.DB
      .prepare(`
        SELECT stock
        FROM inventory
        WHERE product_key = ?
      `)
      .bind(item.product)
      .first();

    if (!row) {
      return json({
        error: `Inventory missing for ${item.product}`
      }, 400);
    }
  }

  /*
    Payment is confirmed.
    Reduce stock for each purchased SKU.
  */
  for (const item of cart) {
    const quantity = Number(item.quantity);

    await env.DB
      .prepare(`
        UPDATE inventory
        SET
          stock = MAX(stock - ?, 0),
          updated_at = CURRENT_TIMESTAMP
        WHERE product_key = ?
      `)
      .bind(
        quantity,
        item.product
      )
      .run();
  }

  /*
    Mark this Stripe Checkout Session as processed.
  */
  await env.DB
    .prepare(`
      INSERT INTO processed_webhooks (
        event_id,
        stripe_session_id
      )
      VALUES (?, ?)
    `)
    .bind(
      event.id,
      session.id
    )
    .run();

  /*
    Send order confirmation emails.
    Email failure must not invalidate an already-paid order.
  */

  const customerEmail =
    session.customer_details?.email ||
    session.customer_email ||
    '';

  const customerName =
    session.customer_details?.name ||
    'there';

  const safeCustomerName =
    escapeHtml(customerName);

  const orderLines = cart
    .map(item => {
      const friendlyProductName =
        escapeHtml(formatProductName(item.product));

      const quantity =
        Number(item.quantity);

      return `
        <li style="margin-bottom:8px;">
          ${friendlyProductName} × ${quantity}
        </li>
      `;
    })
    .join('');

  const total =
    typeof session.amount_total === 'number'
      ? `€${(session.amount_total / 100).toFixed(2)}`
      : '';

  /*
    CUSTOMER CONFIRMATION
  */
  if (customerEmail) {
    await sendEmail(env, {
      to: customerEmail,
      subject: 'Your Leg Theory order is confirmed ✨',
      idempotencyKey:
        `legtheory-customer-${session.id}`,
      html: `
        <div style="
          font-family:Arial,Helvetica,sans-serif;
          max-width:600px;
          margin:0 auto;
          padding:32px 20px;
          color:#111;
          line-height:1.6;
        ">

          <div style="
            font-size:13px;
            letter-spacing:0.18em;
            margin-bottom:36px;
          ">
            LEG THEORY
          </div>

          <h2 style="
            font-weight:400;
            margin-bottom:20px;
          ">
            Thank you for your order, ${safeCustomerName}.
          </h2>

          <p>
            Your payment was successful and we’ve received your order.
          </p>

          <p style="margin-top:24px;">
            <strong>Your order</strong>
          </p>

          <ul>
            ${orderLines}
          </ul>

          ${
            total
              ? `<p><strong>Total paid:</strong> ${total}</p>`
              : ''
          }

          <!-- TEMPORARY HOLIDAY DISPATCH NOTICE -->
          <div style="
            margin-top:28px;
            padding:18px;
            background:#f6f6f6;
            font-size:14px;
            line-height:1.7;
          ">
            <strong>A quick shipping note:</strong><br>
            Leg Theory is a one-person shop, and I’ll be away for a short holiday break.
            Orders placed 26 September–5 October will be dispatched from 7 October.
            I’ll follow up with your tracking details once your order is on the way.
          </div>

          <p style="margin-top:28px;">
            If you have any questions, simply reply to this email
            or message us on Instagram.
          </p>

          <p style="margin-top:32px;">
            Love,<br>
            Leg Theory
          </p>

        </div>
      `
    });
  }

  /*
    OWNER NOTIFICATION
  */
  if (env.ORDER_NOTIFICATION_EMAIL) {

    const shipping =
      session.shipping_details ||
      session.customer_details;

    const address =
      shipping?.address || {};

    const shippingAddress = [
      shipping?.name,
      address.line1,
      address.line2,
      address.postal_code,
      address.city,
      address.state,
      address.country
    ]
      .filter(Boolean)
      .map(escapeHtml)
      .join('<br>');

    await sendEmail(env, {
      to: env.ORDER_NOTIFICATION_EMAIL,
      subject: `New paid Leg Theory order${total ? ` — ${total}` : ''}`,
      idempotencyKey:
        `legtheory-owner-${session.id}`,
      html: `
        <div style="
          font-family:Arial,Helvetica,sans-serif;
          max-width:600px;
          margin:0 auto;
          padding:32px 20px;
          color:#111;
          line-height:1.6;
        ">

          <h2>
            New paid order 🎉
          </h2>

          <p>
            <strong>Customer:</strong>
            ${safeCustomerName}
          </p>

          <p>
            <strong>Email:</strong>
            ${escapeHtml(customerEmail || 'Not available')}
          </p>

          <p>
            <strong>Shipping address:</strong><br>
            ${shippingAddress || 'Not available'}
          </p>

          ${
            total
              ? `<p><strong>Total paid:</strong> ${total}</p>`
              : ''
          }

          <p>
            <strong>Items:</strong>
          </p>

          <ul>
            ${orderLines}
          </ul>

          <p>
            <strong>Stripe Checkout Session:</strong><br>
            ${escapeHtml(session.id)}
          </p>

        </div>
      `
    });
  }

  return json({
    received: true,
    inventory_updated: true
  });
}
