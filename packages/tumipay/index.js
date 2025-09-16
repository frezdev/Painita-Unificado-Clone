async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  try { const mod = await import('node-fetch'); return mod.default; } catch { throw new Error('fetch_unavailable'); }
}

export function buildPaymentLink({ id, amount, installment }) {
  // Fallback mock URL
  return `https://tumipay.mock/pay?ref=${encodeURIComponent(id)}&amount=${encodeURIComponent(amount)}&installment=${encodeURIComponent(installment||0)}`;
}

function joinUrl(base, path) {
  return String(base).replace(/\/$/, '') + (path.startsWith('/') ? path : ('/' + path));
}

function parseLink(json, headers) {
  if (!json || typeof json !== 'object') json = {};
  // Common keys across variants
  const candidates = [
    json?.data?.url_payment,
    json?.url_payment,
    json?.payment_url,
    json?.data?.payment_url,
    json?.link,
    json?.redirectUrl,
    json?.redirect_url,
    json?.paymentUrl,
    json?.payment_url,
    json?.url,
    json?.datos?.url_de_pago
  ];
  for (const v of candidates) if (v) return v;
  // Location header as a last resort
  if (headers && typeof headers.get === 'function') {
    const loc = headers.get('location') || headers.get('Location');
    if (loc) return loc;
  }
  return null;
}

export async function createTumipayPayment({ id, amount, installment, apiKey, apiBase, username, password, customer, returnUrl, cancelUrl, notifyUrl, paymentMethod }) {
  const base = apiBase || process.env.TUMIPAY_BASE;
  const token = apiKey || process.env.TUMIPAY_KEY || process.env.TUMIPAY_TOKEN;
  const user = username || process.env.TUMIPAY_USER;
  const pass = password || process.env.TUMIPAY_PASS;
  const authorization = process.env.TUMIPAY_AUTH || process.env.TUMIPAY_AUTHORIZATION;
  const payinPath = process.env.TUMIPAY_PAYIN_PATH || '/api/v1/payin';

  // If no config, return mock
  if (!base) return { link: buildPaymentLink({ id, amount, installment }) };

  const f = await getFetch();
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  // Prefer explicit Authorization from env
  if (authorization) headers['Authorization'] = authorization;
  // Some Tumipay deployments also accept Bearer or X-Api-Key
  if (!headers['Authorization'] && token) {
    // headers['Authorization'] = `Bearer ${token}`;
    headers['X-Api-Key'] = token;
    headers['Token-Top'] = token;
  }
  if (!headers['Authorization'] && user && pass) {
    headers['Token-Top'] = token;
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  const hasAuth = !!headers['Authorization'];

  console.log({headers})
  const payload = {
    reference: String(id),
    amount: Number(amount || 0),
    currency: 'COP',
    payment_method: paymentMethod || process.env.TUMIPAY_PAYMENT_METHOD || 'ALL_METHODS',
    description: 'Pago préstamo Painita',
    redirect_url: returnUrl,
    ipn_url: notifyUrl,
    customer_data: customer ? ({
      legal_doc: customer.document?.number,
      legal_doc_type: customer.document?.type || 'CC',
      phone_code: customer.phone_code,
      phone_number: customer.phone_number,
      email: customer.email,
      full_name: customer.name
    }) : undefined,
    // Some backends accept metadata
    metadata: { installment: Number(installment || 0) || undefined }
  };

  // Try a sequence of endpoints depending on available headers
  const attempts = [];
  // Connect PayIn (requires Token-Top typically)
  // PayIn path (si tu backend no requiere Token-Top, igual puede funcionar solo con Authorization)
  if (hasAuth) attempts.push({ url: joinUrl(base, payinPath), body: payload });
  // Connect initiate variants (often accept Authorization only)
  if (hasAuth) {
    attempts.push({ url: joinUrl(base, '/connect/payins/initiate'), body: {
      merchantReference: String(id), reference: String(id), amount: { currency: 'COP', value: Number(amount || 0) }, currency: 'COP', channel: 'LINK', redirectUrls: (returnUrl || cancelUrl) ? ({ returnUrl, cancelUrl }) : undefined, callbackUrl: notifyUrl, metadata: { installment: Number(installment || 0) || undefined }, customer: customer ? ({ name: customer.name, email: customer.email, phone: customer.phone_number ? (`+${customer.phone_code || ''}${customer.phone_number}`) : undefined, document: customer.document ? ({ type: customer.document.type || 'CC', number: customer.document.number }) : undefined }) : undefined
    }});
    attempts.push({ url: joinUrl(base, '/api/payins/initiate'), body: {
      merchantReference: String(id), reference: String(id), amount: { currency: 'COP', value: Number(amount || 0) }, currency: 'COP', channel: 'LINK', redirectUrls: (returnUrl || cancelUrl) ? ({ returnUrl, cancelUrl }) : undefined, callbackUrl: notifyUrl, metadata: { installment: Number(installment || 0) || undefined }
    }});
  }
  // Generic payment links (Bearer or X-Api-Key)
  if (token || (user && pass)) {
    attempts.push({ url: joinUrl(base, '/payment-links'), body: { reference: String(id), amount: Number(amount || 0), currency: 'COP', description: 'Pago préstamo Painita', metadata: { installment: Number(installment || 0) || undefined } } });
    attempts.push({ url: joinUrl(base, '/transactions/payment-link'), body: { reference: String(id), amount: Number(amount || 0), currency: 'COP', description: 'Pago préstamo Painita', channel: 'LINK' } });
    attempts.push({ url: joinUrl(base, '/create-payment-link'), body: { reference: String(id), amount: Number(amount || 0), currency: 'COP', description: 'Pago préstamo Painita' } });
  }

  const details = [];
  for (const at of attempts) {
    try {
      const resp = await f(at.url, { method: 'POST', headers, body: JSON.stringify(at.body) });
      const loc = typeof resp.headers?.get === 'function' ? (resp.headers.get('location') || resp.headers.get('Location')) : null;
      if (loc) return { link: loc };
      const txt = await resp.text();
      let js = {};
      try { js = txt ? JSON.parse(txt) : {}; } catch { js = {}; }
      if (resp.ok) {
        const link = parseLink(js, resp.headers);
        if (link) return { link };
      }
      details.push({ url: at.url, status: resp.status, body: txt || js });
    } catch (e) {
      details.push({ url: at.url, error: e?.message || String(e) });
    }
  }
  
  const err = new Error('tumipay_link_failed');
  err.cause = { attempts: details, headers: { hasAuth, hasToken: !!token, hasBasic: !!(user && pass) } };
  throw err;
}
