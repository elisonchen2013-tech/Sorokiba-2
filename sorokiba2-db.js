'use strict';
// Sorokiba 2 – banco de dados. Usa as próprias tabelas (sk2_*), sem mexer nas do Sorokiba 1.
const crypto = require('crypto');

let pool = null;
function setPool(p) { pool = p; }               // opcional: reaproveitar o Pool que você já tem
function isProduction() { return process.env.NODE_ENV === 'production'; }
function validateConfig() {
  const missing = ['DATABASE_URL', 'SK2_SECRET'].filter(k => !process.env[k]);
  if (isProduction() && missing.length) {
    throw new Error(`Configuração de produção incompleta: defina ${missing.join(' e ')} antes de iniciar o Sorokiba 2.`);
  }
  if (!process.env.DATABASE_URL) console.warn('[sk2] Desenvolvimento: DATABASE_URL não definida; configure um banco para iniciar.');
  if (!process.env.SK2_SECRET) console.warn('[sk2] Desenvolvimento: SK2_SECRET não definida; os logins caem a cada reinício do servidor.');
}
function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida. Em desenvolvimento, configure essa variável para conectar ao banco.');
  pool = new Pool({
    connectionString: url,
    max: 3,                                      // pouco: o plano grátis tem 512 MB
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  return pool;
}
const q = (sql, p) => getPool().query(sql, p);

const SECRET = process.env.SK2_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SK2_SECRET && !isProduction()) console.warn('[sk2] Desenvolvimento: SK2_SECRET não definida; os logins caem a cada reinício do servidor.');

// scrypt usa ~16 MB por senha: fazemos uma de cada vez para não estourar a memória
let chain = Promise.resolve();
function hashPw(pw, salt) {
  const run = () => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? no(e) : ok(k.toString('hex')))));
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function cleanLook(l) {
  l = l || {};
  return {
    col: hex(l.col) ? l.col : '#2DD4BF', skin: hex(l.skin) ? l.skin : '#f1c7a0',
    hr: hex(l.hr) ? l.hr : '#2b1b12', pn: hex(l.pn) ? l.pn : '#2a2f45',
    body: l.body === 'f' ? 'f' : 'm',
    st: [0, 1, 2, 3].includes(l.st) ? l.st : 0,
    ac: [0, 1, 2, 3, 4].includes(l.ac) ? l.ac : 0,
    dr: l.dr ? 1 : 0,
  };
}
const validName = n => typeof n === 'string' && /^[A-Za-z0-9_]{3,14}$/.test(n);
const validPass = p => typeof p === 'string' && p.length >= 4 && p.length <= 64;

async function init() {
  validateConfig();
  await q(`CREATE TABLE IF NOT EXISTS sk2_players (
    username TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cidadão', look JSONB NOT NULL DEFAULT '{}',
    money INT NOT NULL DEFAULT 100, xp INT NOT NULL DEFAULT 0,
    mission_id TEXT NOT NULL DEFAULT 'welcome', mission_done BOOLEAN NOT NULL DEFAULT false,
    missions JSONB NOT NULL DEFAULT '{}',
    x REAL NOT NULL DEFAULT 27.5, y REAL NOT NULL DEFAULT 14.5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ);
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS mission_id TEXT NOT NULL DEFAULT 'welcome';
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS mission_done BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS missions JSONB NOT NULL DEFAULT '{}';
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_mayor ON sk2_players(role) WHERE role = 'prefeito';`);
}
async function health() {
  await q('SELECT 1');
  return true;
}
async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// O primeiro a criar conta vira Prefeito. O índice único garante que só exista um, mesmo com cadastros simultâneos.
async function register(name, pass, look) {
  const k = name.toLowerCase(), salt = crypto.randomBytes(16).toString('hex'), hash = await hashPw(pass, salt), lk = cleanLook(look);
  const mayorSql = `INSERT INTO sk2_players (username,name,salt,hash,role,look,money)
    SELECT $1,$2,$3,$4,'prefeito',$5,1000 WHERE NOT EXISTS (SELECT 1 FROM sk2_players WHERE role='prefeito') RETURNING *`;
  const citizenSql = `INSERT INTO sk2_players (username,name,salt,hash,role,look,money) VALUES ($1,$2,$3,$4,'cidadão',$5,100) RETURNING *`;
  const args = [k, name, salt, hash, JSON.stringify(lk)];
  try {
    let r = await q(mayorSql, args);
    if (!r.rowCount) r = await q(citizenSql, args);
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') {
      const ex = await q('SELECT 1 FROM sk2_players WHERE username=$1', [k]);
      if (ex.rowCount) throw Object.assign(new Error('Esse usuário já existe'), { status: 409 });
      return (await q(citizenSql, args)).rows[0];   // perdeu a corrida pelo cargo de prefeito
    }
    throw e;
  }
}

async function login(name, pass) {
  const r = await q('SELECT * FROM sk2_players WHERE username=$1', [name.toLowerCase()]);
  const row = r.rows[0];
  const h = await hashPw(pass, row ? row.salt : '0'.repeat(32));   // gasta o mesmo tempo mesmo se o usuário não existir
  if (!row) return null;
  const a = Buffer.from(h), b = Buffer.from(row.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? row : null;
}

async function load(username) {
  const r = await q('SELECT * FROM sk2_players WHERE username=$1', [username]);
  return r.rows[0] || null;
}

// Salva várias posições de uma vez (uma única consulta)
async function savePositions(list) {
  if (!list.length) return;
  await q(`UPDATE sk2_players p SET x=v.x, y=v.y, last_seen=now()
    FROM (SELECT unnest($1::text[]) AS u, unnest($2::real[]) AS x, unnest($3::real[]) AS y) v WHERE p.username=v.u`,
    [list.map(o => o.u), list.map(o => o.x), list.map(o => o.y)]);
}

async function completeWelcome(username) {
  return completeMission(username, 'welcome', 250, 100);
}

async function completeMission(username, id, money, xp) {
  const r = await q(`UPDATE sk2_players
    SET mission_done=CASE WHEN $2='welcome' THEN true ELSE mission_done END,
        missions=jsonb_set(COALESCE(missions, '{}'::jsonb), ARRAY[$2], 'true'::jsonb),
        money=money+$3, xp=xp+$4, last_seen=now()
    WHERE username=$1 AND NOT (COALESCE(missions, '{}'::jsonb) ? $2)
      AND ($2<>'welcome' OR mission_done=false)
    RETURNING *`, [username, id, money, xp]);
  return r.rows[0] || null;
}

const pub = row => ({
  name: row.name, role: row.role, ...cleanLook(row.look), money: row.money, xp: row.xp,
  mission: { id: row.mission_id || 'welcome', done: !!row.mission_done },
  missions: row.missions || {}, x: row.x, y: row.y,
});

function sign(u) {
  const b = Buffer.from(JSON.stringify({ u, e: Date.now() + 7 * 864e5 })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verifyToken(t) {
  const [b, s] = String(t || '').split('.');
  if (!b || !s) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.e > Date.now() ? o.u : null; } catch (e) { return null; }
}

module.exports = { setPool, init, health, close, register, login, load, savePositions, completeWelcome, completeMission, pub, sign, verifyToken, cleanLook, validName, validPass, validateConfig };
