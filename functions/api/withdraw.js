function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

export async function onRequestPost({ request, env }) {

  if (!env.DB) {
    return json({
      error: 'Database is not configured.'
    }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: 'Invalid request.'
    }, 400);
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const orderDate = String(body.orderDate || '').trim();
  const scope = String(body.scope || '').trim();
  const items = String(body.items || '').trim();
  const message = String(body.message || '').trim();

  if (!name || name.length > 150) {
    return json({
      error: 'Please enter your name.'
    }, 400);
  }

  if (!email || !isValidEmail(email) || email.length > 254) {
    return json({
      error: 'Please enter a valid email address.'
    }, 400);
  }

  if (!orderDate) {
    return json({
      error: 'Please enter the approximate order date.'
    }, 400);
  }

  if (
    scope !== 'entire-order' &&
    scope !== 'part-of-order'
  ) {
    return json({
      error: 'Please select what you would like to withdraw.'
    }, 400);
  }

  if (!items || items.length > 2000) {
    return json({
      error: 'Please enter the item or order details.'
    }, 400);
  }

  if (message.length > 3000) {
    return json({
      error: 'Your message is too long.'
    }, 400);
  }

  const requestId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  try {
    await env.DB
      .prepare(`
        INSERT INTO withdrawal_requests (
          request_id,
          submitted_at,
          customer_name,
          customer_email,
          order_date,
          withdrawal_scope,
          items,
          message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        requestId,
        submittedAt,
        name,
        email,
        orderDate,
        scope,
        items,
        message || null
      )
      .run();

  } catch (error) {
    console.error('Withdrawal database error:', error);

    return json({
      error: 'Your withdrawal could not be recorded. Please try again.'
    }, 500);
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeOrderDate = escapeHtml(orderDate);
  const safeItems = escapeHtml(items);
  const safeMessage = escapeHtml(message);

  const scopeLabel =
    scope === 'entire-order'
      ? 'Entire order'
      : 'Part of the order';

  const submittedDisplay =
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      dateStyle: 'long',
      timeStyle: 'short'
    }).format(new Date(submittedAt));

  const customerEmailSent = await sendEmail(env, {
    to: email,
    subject: 'Your Leg Theory withdrawal has been received',

    idempotencyKey: `legtheory-withdraw-customer-${requestId}`,

    html: `
      <div style="
        font-family: Arial, Helvetica, sans-serif;
        max-width: 620px;
        margin: 0 auto;
        padding: 40px 24px;
        color: #111;
      ">

        <div style="
          font-size: 13px;
          letter-spacing: 0.18em;
          margin-bottom: 36px;
        ">
          LEG THEORY
        </div>

        <h1 style="
          font-size: 28px;
          font-weight: 400;
          margin: 0 0 24px;
        ">
          Withdrawal received
        </h1>

        <p style="line-height:1.7;">
          Hi ${safeName},
        </p>

        <p style="line-height:1.7;">
          We have received and registered your withdrawal.
        </p>

        <div style="
          margin: 30px 0;
          padding: 22px 0;
          border-top: 1px solid #ddd;
          border-bottom: 1px solid #ddd;
          line-height: 1.8;
        ">

          <strong>Submitted</strong><br>
          ${escapeHtml(submittedDisplay)}
          <br><br>

          <strong>Order date</strong><br>
          ${safeOrderDate}
          <br><br>

          <strong>Withdrawal</strong><br>
          ${escapeHtml(scopeLabel)}
          <br><br>

          <strong>Item(s)</strong><br>
          ${safeItems.replaceAll('\n', '<br>')}

        </div>

        <p style="line-height:1.7;">
          If your order has not yet been handed to the carrier, we will cancel the shipment
          and process the next steps accordingly.
        </p>
        
        <p style="line-height:1.7;">
          If your order has already been handed to the carrier, we may not be able to stop
          delivery. We will let you know the appropriate next step. Depending on the carrier
          and delivery status, you may be able to refuse delivery or return the parcel after receipt.
        </p>
        
        <p style="line-height:1.7;">
          For returned goods, reimbursement may be withheld until we receive the goods back
          or you provide evidence that they have been sent back.
        </p>
        
        <p style="line-height:1.7;">
          Please do not send anything back before receiving the return instructions from us.
        </p>
        <p style="
          line-height:1.7;
          margin-top:32px;
        ">
          If you have any questions, simply reply to this email or message us on Instagram.
        </p>

        <p style="margin-top:30px;">
          Love,<br>
          Leg Theory
        </p>

      </div>
    `
  });

  let ownerEmailSent = false;

  if (env.ORDER_NOTIFICATION_EMAIL) {

    ownerEmailSent = await sendEmail(env, {
      to: env.ORDER_NOTIFICATION_EMAIL,

      subject: 'New Leg Theory withdrawal received',

      idempotencyKey: `legtheory-withdraw-owner-${requestId}`,

      html: `
        <div style="
          font-family: Arial, Helvetica, sans-serif;
          max-width: 620px;
          margin: 0 auto;
          padding: 40px 24px;
          color: #111;
        ">

          <div style="
            font-size: 13px;
            letter-spacing: 0.18em;
            margin-bottom: 36px;
          ">
            LEG THEORY
          </div>

          <h1 style="
            font-size: 26px;
            font-weight: 400;
            margin-bottom: 26px;
          ">
            ↩ New withdrawal received
          </h1>

          <p style="line-height:1.8;">
            <strong>Customer</strong><br>
            ${safeName}
          </p>

          <p style="line-height:1.8;">
            <strong>Email</strong><br>
            ${safeEmail}
          </p>

          <p style="line-height:1.8;">
            <strong>Submitted</strong><br>
            ${escapeHtml(submittedDisplay)}
          </p>

          <p style="line-height:1.8;">
            <strong>Order date</strong><br>
            ${safeOrderDate}
          </p>

          <p style="line-height:1.8;">
            <strong>Withdrawal</strong><br>
            ${escapeHtml(scopeLabel)}
          </p>

          <p style="line-height:1.8;">
            <strong>Item(s)</strong><br>
            ${safeItems.replaceAll('\n', '<br>')}
          </p>

          ${
            safeMessage
              ? `
                <p style="line-height:1.8;">
                  <strong>Additional information</strong><br>
                  ${safeMessage.replaceAll('\n', '<br>')}
                </p>
              `
              : ''
          }

          <p style="
            margin-top:30px;
            font-size:12px;
            color:#777;
            line-height:1.7;
          ">
            Request ID: ${escapeHtml(requestId)}
          </p>

        </div>
      `
    });
  }

  return json({
    received: true,
    request_id: requestId,
    customer_email_sent: customerEmailSent,
    owner_email_sent: ownerEmailSent
  });
}
