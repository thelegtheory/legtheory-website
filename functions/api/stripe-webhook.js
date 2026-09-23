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

  // Reject webhook requests older than 5 minutes
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

export async function onRequestPost({
  request,
  env
}) {
  if (!env.DB) {
    return json({
      error: 'Inventory database is not configured'
    }, 503);
  }

  if (!env.STRIPE_WEBHOOK_SECRET) {
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

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({
      error: 'Invalid webhook payload'
    }, 400);
  }

  /*
    We only care about successful Checkout payments.
  */
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

  /*
    For checkout.session.completed:
    only process immediately if Stripe says it is paid.

    Delayed payment methods may complete Checkout before
    the money actually succeeds. In that case we wait for
    checkout.session.async_payment_succeeded.
  */
  if (
    event.type === 'checkout.session.completed' &&
    session.payment_status !== 'paid'
  ) {
    return json({
      received: true,
      waiting_for_payment: true
    });
  }

  /*
    Prevent the same Checkout Session from deducting stock twice.
  */
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
    First validate everything before changing inventory.
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

  return json({
    received: true,
    inventory_updated: true
  });
}
