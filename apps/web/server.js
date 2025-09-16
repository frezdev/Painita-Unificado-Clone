import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import cors from 'cors';
import { calcularValorPrestamo } from '@painita/calc';
import { CRMClient } from '@painita/crm-client';
// import { createTumipayPayment, buildPaymentLink } from '@painita/tumipay';
// import { calcularDesglose } from './public/js/utils/finanzas.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import twilio from 'twilio';
import { tumiPay } from './services/index.js';
import { createNewTransaction, updateClient } from '../crm/db.js';
import { validateTumipaySignature } from '../crm/utils/validate-tumipay-signature.js';
import {
  PUBLIC_BASE_URL,
  TUMIPAY_NOTIFY_URL,
  TUMIPAY_PAYMENT_METHOD,
  TUMIPAY_RETURN_URL,
  CRM_BASE as CRM_BASE_URL,
  CRM_HOSTPORT,
  CRM_HOST,
  CRM_PORT,
  FETCH_TIMEOUT_MS,
  LEGACY_WEB_DIR,
  TUMIPAY_KEY,
  EXPIRED_TIME_LINK,
  DEV_OTP_CODE,
  OTP_BYPASS,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID,
  TWILIO_SERVICE_SID,
  DEFAULT_COUNTRY_CODE,
  LEGACY_INJECT_ADAPTER
} from './config/env.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(cors());
// Global no-cache headers to avoid stale content for clients
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});
// Allow larger JSON bodies for image data URLs from form step 6
app.use(bodyParser.json({ limit: '10mb' }));
// Static files with no-cache for HTML
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath && /\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
}));
// Avoid favicon 404 noise
app.get('/favicon.ico', (req, res) => res.status(204).end());

function resolveCrmBase() {
  if (CRM_BASE_URL) return CRM_BASE_URL;
  if (CRM_HOSTPORT) return `http://${CRM_HOSTPORT}`;
  if (CRM_HOST && CRM_PORT) return `http://${CRM_HOST}:${CRM_PORT}`;
  return 'http://localhost:4001';
}
const CRM_BASE = resolveCrmBase();
const crm = new CRMClient(CRM_BASE);

// Generic timeouts to avoid hanging on unreachable dependencies (Render env)
const DEFAULT_TIMEOUT_MS = Number(FETCH_TIMEOUT_MS || 8000);
function abortAfter(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, cancel: () => clearTimeout(id) };
}
async function fetchJsonWithTimeout(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  const { controller, cancel } = abortAfter(ms);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const d = await r.json().catch(() => ({}));
    return { r, d };
  } finally {
    cancel();
  }
}
function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, tag = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(tag)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

// OTP: Solo Twilio Verify

// Dev bypass: if OTP_BYPASS=1 or DEV_OTP_CODE is set, we'll skip Twilio Verify and accept a fixed code.
function isDevOtpEnabled() {
  return OTP_BYPASS === '1' || !!DEV_OTP_CODE;
}
function getDevOtpCode() {
  const raw = (DEV_OTP_CODE || '123456').toString();
  const digits = raw.replace(/\D/g, '');
  // ensure 6 digits (pad or slice)
  if (!digits) return '123456';
  return (digits + '000000').slice(0, 6);
}

function getTwilioClient() {
  const sid = TWILIO_ACCOUNT_SID;
  const token = TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try { return twilio(sid, token); } catch { return null; }
}

function getVerifyServiceSid() {
  const sid = TWILIO_VERIFY_SERVICE_SID || TWILIO_SERVICE_SID;
  if (!sid || !/^VA[a-z0-9]+/i.test(sid)) return null;
  return sid;
}

function normalizePhone(input) {
  const raw = String(input||'').trim();
  if (raw.startsWith('+')) return raw; // asumimos E.164 válido del cliente
  const digits = raw.replace(/\D/g,'');
  if (digits.length === 10) {
    const cc = DEFAULT_COUNTRY_CODE;
    return cc + digits;
  }
  // fallback simple: si tiene 11 y empieza por 1, asumimos +1
  if (digits.length === 11 && digits.startsWith('1')) return '+1' + digits.slice(1);
  return '+' + digits; // último recurso
}

// Send OTP SMS
app.post('/otp/send', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error:'invalid_phone' });
    const full = normalizePhone(phone);
    console.log('[otp] /otp/send request', { phone: full, dev: isDevOtpEnabled() });
    if (isDevOtpEnabled()) {
      const code = getDevOtpCode();
      console.log(`[otp/mock] sending code ${code} to ${full}`);
      return res.json({ ok: true, status: 'mocked' });
    }
    const client = getTwilioClient();
    const verifySid = getVerifyServiceSid();
    if (!client || !verifySid) return res.status(500).json({ error:'twilio_verify_not_configured', message: 'OTP no configurado en el servidor. Define TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_VERIFY_SERVICE_SID o activa OTP_BYPASS=1 para pruebas.' });

  const svc = client.verify.v2.services(verifySid);
  const resp = await withTimeout(svc.verifications.create({ to: full, channel: 'sms' }), DEFAULT_TIMEOUT_MS, 'twilio_timeout');
    return res.json({ ok: true, status: resp.status });
  } catch (e) {
    console.error('[otp] send error:', e);
    res.status(500).json({ error:'send_failed', code: e?.code, status: e?.status, message: e?.message || String(e) });
  }
});

// Verify OTP
app.post('/otp/verify', async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code) return res.status(400).json({ error:'invalid_input' });
    const full = normalizePhone(phone);
    console.log('[otp] /otp/verify request', { phone: full, dev: isDevOtpEnabled() });
    if (isDevOtpEnabled()) {
      if (String(code).trim() === getDevOtpCode()) return res.json({ ok: true });
      return res.status(400).json({ error: 'invalid_otp', reason: 'mock_code_mismatch' });
    }
    const client = getTwilioClient();
    const verifySid = getVerifyServiceSid();
    if (!client || !verifySid) return res.status(500).json({ error:'twilio_verify_not_configured', message: 'OTP no configurado en el servidor. Define TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_VERIFY_SERVICE_SID o activa OTP_BYPASS=1 para pruebas.' });

  const svc = client.verify.v2.services(verifySid);
  const resp = await withTimeout(svc.verificationChecks.create({ to: full, code: String(code).trim() }), DEFAULT_TIMEOUT_MS, 'twilio_timeout');
    if (resp.status === 'approved') return res.json({ ok:true });
    return res.status(400).json({ error:'invalid_otp', reason: resp.status });
  } catch (e) {
    console.error('[otp] verify error:', e);
    res.status(500).json({ error:'verify_failed', code: e?.code, status: e?.status, message: e?.message || String(e) });
  }
});

// Quick OTP health/config check for troubleshooting on Render
app.get('/otp/health', (req, res) => {
  const hasTwilio = !!getTwilioClient() && !!getVerifyServiceSid();
  res.json({
    ok: true,
    mode: isDevOtpEnabled() ? 'mock' : (hasTwilio ? 'twilio' : 'disabled'),
    hasTwilio,
    defaultCountry: DEFAULT_COUNTRY_CODE || '+57'
  });
});

// friendly route for static pages
function resolveLegacyDir(base) {
  if (!base || !fs.existsSync(base)) return null;
  const candidates = [
    '',
    'dist',
    'build',
    path.join('client','dist'),
    path.join('client','build'),
    'public'
  ];
  for (const rel of candidates) {
    const dir = path.join(base, rel);
    const indexPath = path.join(dir, 'index.html');
    if (fs.existsSync(indexPath)) return dir;
  }
  return null;
}

const LEGACY_BASE = LEGACY_WEB_DIR;
const LEGACY_DIR = resolveLegacyDir(LEGACY_BASE);

// Optional adapter script to expose a simple API client in window
app.get('/adapter.js', (req, res) => {
  res.type('application/javascript').send(`(function(){
    function createSync(base){
      const key='painita_solicitud_id';
      const getId=()=>localStorage.getItem(key);
      const setId=(id)=>localStorage.setItem(key,String(id));
  return { 
        start: async ({phone,otp,password})=>{
          const r=await fetch(base+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,otp,password})});
          const d=await r.json(); setId(d.id); return d;
        },
        sync: async (stepKey,data,finalFlag)=>{
          const id=getId(); if(!id) throw new Error('no solicitud id');
          const r=await fetch(base+'/sync/'+id+'/step',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({stepKey,data,final:!!finalFlag})});
          return r.json();
        },
        getId
      };
    }
    window.PainitaFormSync=createSync(location.origin);
  })();`);
});

// If LEGACY dir is set, serve it with optional adapter injection
if (LEGACY_DIR) {
  console.log('[web] Serving legacy UI from:', LEGACY_DIR);
  app.use(express.static(LEGACY_DIR));
  app.get('/', (req, res, next) => {
    const indexPath = path.join(LEGACY_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) return next();
    if (LEGACY_INJECT_ADAPTER === '1') {
      try {
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace('</head>', '<script src="/adapter.js"></script></head>');
        res.type('html').send(html);
        return;
      } catch(e) { /* fall back */ }
    }
    res.sendFile(indexPath);
  });
  // SPA fallback: serve index.html for non-API routes without extension
  app.get('*', (req, res, next) => {
    const isApi = req.path.startsWith('/start') || req.path.startsWith('/sync') || req.path.startsWith('/payment') || req.path.startsWith('/status') || req.path.startsWith('/adapter.js');
    const hasExt = path.extname(req.path);
    if (!isApi && !hasExt && req.headers.accept && req.headers.accept.includes('text/html')) {
      const indexPath = path.join(LEGACY_DIR, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    }
    next();
  });
} else {
  // Servir página de login directamente ANTES del catch-all
  app.get('/login-we', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'login-we.html'));
  });
  
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  // SPA fallback: cualquier ruta no-API y sin extensión sirve la home
  app.get('*', (req, res, next) => {
    const isApi = req.path.startsWith('/otp') || req.path.startsWith('/start') || req.path.startsWith('/sync') || req.path.startsWith('/status') || req.path.startsWith('/form') || req.path.startsWith('/payment') || req.path.startsWith('/crm') || req.path.startsWith('/pago') || req.path.startsWith('/webhooks') || req.path.startsWith('/adapter.js');
    const hasExt = path.extname(req.path);
    if (!isApi && !hasExt && req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
  });
}
// Backward-compat redirect
app.get('/mi-solicitud', (req, res) => res.redirect(302, '/login-we'));

// Check if phone exists (proxy to CRM)
app.get('/phone/exists', async (req, res) => {
  try {
    const phone = String(req.query.phone||'').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
  const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/clientes/exists?phone=${encodeURIComponent(phone)}`);
  res.status(r.status).json(d);
  } catch (e) {
  console.error('[web] /phone/exists error:', e.message || e);
  res.status(502).json({ error: 'bad_gateway', message: 'No se pudo contactar al CRM' });
  }
});

// Login de cliente (para reanudar formulario existente)
app.post('/clientes/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ ok:false, error:'phone_password_required' });
    const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/clientes/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ phone, password }) });
    console.log('[web] /clientes/login → CRM', r.status);
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] /clientes/login proxy error:', e?.message || e);
    res.status(502).json({ ok:false, error:'bad_gateway', message:'No se pudo contactar al CRM' });
  }
});

// Crear solicitud (después de teléfono+otp+password) con timeout y manejo de errores
app.post('/start', async (req, res) => {
  try {
    const { phone, otp, password, monto, plazo } = req.body || {};
    if (!phone || !otp || !password) return res.status(400).json({ error: 'phone_otp_password_required' });
    const url = `${CRM_BASE}/solicitudes`;
    const { r, d } = await fetchJsonWithTimeout(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ phone, otp, password, monto, plazo }) });
    console.log('[web] /start → CRM /solicitudes', r.status);
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] /start proxy error:', e?.message || e);
    const timeout = /timeout|aborted|AbortError/i.test(String(e?.message || e));
    res.status(502).json({ error: timeout ? 'timeout' : 'bad_gateway', message: timeout ? 'Tiempo de espera agotado' : 'No se pudo contactar al CRM' });
  }
});

// Sincronizar paso
app.patch('/sync/:id/step', async (req, res) => {
  const { stepKey, data, final } = req.body;
  const d = await crm.syncStep(req.params.id, { stepKey, data, final });
  res.json(d);
});

// Obtener estado de una solicitud (proxy al CRM)
app.get('/status/:id', async (req, res) => {
  try {
    const d = await crm.getSolicitud(req.params.id);
    res.json(d);
  } catch (e) {
    res.status(502).json({ error: 'bad_gateway', message: String(e) });
  }
});

// Obtener estado de una solicitud (proxy al CRM)
app.get('/status/:id', async (req, res) => {
  try {
    const d = await crm.getSolicitud(req.params.id);
    res.json(d);
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

// Formularios proxy
app.post('/form/start', async (req, res) => {
  try {
    const { phone, monto, plazo, password } = req.body || {};
  const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/formularios/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ phone, monto, plazo, password }) });
    console.log('[web] /form/start → CRM', r.status);
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] /form/start proxy error:', e?.message || e);
    res.status(502).json({ error:'bad_gateway', message: 'No se pudo contactar al CRM' });
  }
});
app.patch('/form/:id/step', async (req, res) => {
  try {
    const { step, data } = req.body || {};
  const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/formularios/${encodeURIComponent(req.params.id)}/step`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ step, data }) });
    console.log('[web] /form/:id/step → CRM', r.status);
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] /form/:id/step proxy error:', e?.message || e);
    res.status(502).json({ error:'bad_gateway', message: 'No se pudo contactar al CRM' });
  }
});
app.get('/form/:id', async (req, res) => {
  try {
  const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/formularios/${encodeURIComponent(req.params.id)}`);
    console.log('[web] GET /form/:id → CRM', r.status);
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] GET /form/:id proxy error:', e?.message || e);
    res.status(502).json({ error:'bad_gateway', message: 'No se pudo contactar al CRM' });
  }
});

// Aceptación de cliente (flag en formulario)
app.patch('/form/:id/accept', async (req, res) => {
  try {
    const url = `${CRM_BASE}/formularios/${encodeURIComponent(req.params.id)}/accept`;
    const { r, d } = await fetchJsonWithTimeout(url, { method: 'PATCH' });
    res.status(r.status).json(d);
  } catch (e) {
    console.error('[web] PATCH /form/:id/accept proxy error:', e?.message || e);
    res.status(502).json({ error:'bad_gateway', message: 'No se pudo contactar al CRM' });
  }
});

// Proxy CRM health
app.get('/crm/health', async (req, res) => {
  try {
  const { r, d } = await fetchJsonWithTimeout(`${CRM_BASE}/health`);
    res.status(r.status).json(d);
  } catch (e) {
    res.status(502).json({ error:'bad_gateway', message:'No se pudo contactar al CRM' });
  }
});

// Generar link de pago Tumipay
app.post('/payment-link/:id', async (req, res) => {
  const { id } = req.params;
  const { monto, plazoMeses, tasa, plazoDias } = req.body || {};
  // Calcular cuota si aplica y total con nuestro desglose

  const cuota = (monto && plazoMeses && tasa) ? calcularValorPrestamo(monto, plazoMeses, tasa) : null;
  // const total = (()=>{ try { const d = calcularDesglose(Number(monto||0), Number(plazoDias||0)); return Math.round(d.totalPagar); } catch { return Math.round(Number(monto||0)); } })();
  // Opcional: enriquecer con datos del cliente para Tumipay (si el CRM responde)
  let customer = undefined;
  const publicBase = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    if (/^\d+$/.test(String(id))) {
      const { d: form } = await fetchJsonWithTimeout(`${CRM_BASE}/formularios/${encodeURIComponent(id)}`);
      if (form && typeof form === 'object') {
        const fullPhone = String(form.phone || form.celular || '').replace(/\D/g,'');
        let phone_code = '57'; let phone_number = fullPhone;
        if (fullPhone.length > 10) { phone_code = fullPhone.slice(0, fullPhone.length - 10); phone_number = fullPhone.slice(-10); }
        customer = {
          name: [form.first_name, form.last_name].filter(Boolean).join(' ') || undefined,
          email: form.email || undefined,
          phone_code,
          phone_number,
          document: form.document_number ? ({ type: form.document_type || 'CC', number: String(form.document_number) }) : undefined
        };
      }
    }
  } catch {}
  try {

  console.log('[web] creating payment link', { id, total: monto });

  const {ok, data} = await createNewTransaction({
    amount: monto,
    coustomer_email: customer.email,
    customer_id: id,
  })

  if (!ok) {
    throw new Error('Error al generar transacción')
  }

  const response = await tumiPay.createPaymentLink({
    reference: data.id,
    amount: monto,
    currency: 'COP',
    country: 'CO',
    customer_data: {
      email: customer.email,
      full_name: customer.name,
      legal_doc: customer.document.number,
      legal_doc_type: customer.document.type,
      phone_code: customer.phone_code,
      phone_number: customer.phone_number
    },
    description: 'Pago de cuota de Painita',
    expiration_time: EXPIRED_TIME_LINK,
    ipn_url: TUMIPAY_NOTIFY_URL || `${publicBase}/webhooks/tumipay`,
    payment_method: TUMIPAY_PAYMENT_METHOD,
    redirect_url: TUMIPAY_RETURN_URL || `${publicBase}/pago/exito`,
  })

  if (!response.data) {
    throw new Error('Error desconocido')
  }
  // const { link } = await createTumipayPayment(payload);
    res.json({ link: response.data.payment_url, cuota, monto });
  } catch (e) {
    const cause = e && (e.cause || e.reason);
    console.error('[web] /payment-link error:', e?.message || e, cause ? ('→ cause: ' + (cause.message || JSON.stringify(cause))) : '');
    // Fallback opcional para desarrollo si la API falla
    // if ((process.env.TUMIPAY_ALLOW_MOCK_ON_FAIL || '').toLowerCase() === '1' || (process.env.TUMIPAY_ALLOW_MOCK_ON_FAIL || '').toLowerCase() === 'true') {
    //   const link = buildPaymentLink({ id, amount: monto, installment: cuota || undefined });
    //   return res.json({ link, cuota, monto, mock: true });
    // }
    res.status(502).json({ error: 'payment_link_failed', message: 'No se pudo generar el link de pago.' });
  }
});

// Success/Cancel pages for payment redirects (basic messages)
app.get('/pago/exito', (req, res) => {
  res.type('html').send('<!doctype html><html><body><h3>Pago iniciado correctamente</h3><p>Puedes cerrar esta ventana.</p></body></html>');
});
app.get('/pago/cancelado', (req, res) => {
  res.type('html').send('<!doctype html><html><body><h3>Pago cancelado</h3><p>Puedes volver e intentarlo de nuevo.</p></body></html>');
});

// Webhook receiver (logs payload)
app.post('/webhooks/tumipay', (req, res) => {
  const {headers } = req
  try {
    if (headers['User-Agent'] !== 'Tumipay/1.1' && !headers['x-trx-signature']) {
      res.status(401).json({ message: 'Unauthorized' })
      return
    }
    const signature = headers['x-trx-signature']
    const isValid = validateTumipaySignature(req.body, signature, TUMIPAY_KEY)

    if (!isValid) return res.status(401).json({ message: 'Unauthorized' })

    const { top_status, top_reference } = req.body

    // TODO: actualizar el estado de transacción y/o solicitud
    res.status(200).json({ ok: true });
  } catch {
    res.status(500).json({ message: 'Internal Error' })
  }
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Web demo server running on http://${HOST}:${PORT}`))
  .on('error', (err) => {
    console.error('[web] listen error:', err.code || err.message);
    process.exit(1);
  });

process.on('uncaughtException', (e) => console.error('[web] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[web] unhandledRejection', e));
