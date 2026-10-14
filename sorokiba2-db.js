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
    resume JSONB NOT NULL DEFAULT '{"summary":"","skills":[],"experience":0}',
    employment JSONB NOT NULL DEFAULT '{}',
    x REAL NOT NULL DEFAULT 27.5, y REAL NOT NULL DEFAULT 14.5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ);
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS mission_id TEXT NOT NULL DEFAULT 'welcome';
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS mission_done BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS missions JSONB NOT NULL DEFAULT '{}';
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS resume JSONB NOT NULL DEFAULT '{"summary":"","skills":[],"experience":0}';
  ALTER TABLE sk2_players ADD COLUMN IF NOT EXISTS employment JSONB NOT NULL DEFAULT '{}';
  CREATE TABLE IF NOT EXISTS sk2_career_applications (
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    job_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted',
    interview_status TEXT NOT NULL DEFAULT 'not_started',
    interview JSONB NOT NULL DEFAULT '{}',
    interview_score INT, interview_feedback TEXT, cooldown_until TIMESTAMPTZ, hired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (username, job_id));
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS interview_status TEXT NOT NULL DEFAULT 'not_started';
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS interview JSONB NOT NULL DEFAULT '{}';
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS interview_score INT;
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS interview_feedback TEXT;
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
  ALTER TABLE sk2_career_applications ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS sk2_work_shifts (
    id UUID PRIMARY KEY, username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    job_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_active_shift ON sk2_work_shifts(username) WHERE status='active';
  CREATE TABLE IF NOT EXISTS sk2_work_tasks (
    id UUID PRIMARY KEY, shift_id UUID NOT NULL REFERENCES sk2_work_shifts(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    job_id TEXT NOT NULL, task_type TEXT NOT NULL, task JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'assigned', reward_money INT NOT NULL DEFAULT 0,
    reward_xp INT NOT NULL DEFAULT 0, result JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_pending_task ON sk2_work_tasks(shift_id) WHERE status='assigned';
  CREATE TABLE IF NOT EXISTS sk2_work_history (
    id UUID PRIMARY KEY, username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    job_id TEXT NOT NULL, task_id UUID NOT NULL UNIQUE REFERENCES sk2_work_tasks(id) ON DELETE CASCADE,
    payment INT NOT NULL, professional_xp INT NOT NULL, performance INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
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

async function getResume(username) {
  const r = await q('SELECT resume FROM sk2_players WHERE username=$1', [username]);
  return r.rows[0]?.resume || { summary: '', skills: [], experience: 0 };
}

async function saveResume(username, resume) {
  const r = await q('UPDATE sk2_players SET resume=$2, last_seen=now() WHERE username=$1 RETURNING *', [username, JSON.stringify(resume)]);
  return r.rows[0] || null;
}

async function applyForCareer(username, jobId) {
  const r = await q(`INSERT INTO sk2_career_applications (username, job_id)
    VALUES ($1,$2) ON CONFLICT (username, job_id) DO NOTHING RETURNING username, job_id, status, created_at`, [username, jobId]);
  return r.rows[0] || null;
}

async function listApplications(username) {
  const r = await q(`SELECT job_id, status, interview_status, interview_score, interview_feedback,
    cooldown_until, hired_at, created_at FROM sk2_career_applications
    WHERE username=$1 ORDER BY created_at DESC`, [username]);
  return r.rows;
}

async function getApplication(username, jobId) {
  const r = await q('SELECT * FROM sk2_career_applications WHERE username=$1 AND job_id=$2', [username, jobId]);
  return r.rows[0] || null;
}

async function startInterview(username, jobId, interview) {
  const r = await q(`UPDATE sk2_career_applications SET interview_status='active', interview=$3
    WHERE username=$1 AND job_id=$2 AND status <> 'hired'
      AND (cooldown_until IS NULL OR cooldown_until <= now())
    RETURNING *`, [username, jobId, JSON.stringify(interview)]);
  return r.rows[0] || null;
}

async function answerInterview(username, jobId, sessionId, interview) {
  const r = await q(`UPDATE sk2_career_applications SET interview=$4
    WHERE username=$1 AND job_id=$2 AND interview_status='active'
      AND interview->>'sessionId'=$3 RETURNING *`, [username, jobId, sessionId, JSON.stringify(interview)]);
  return r.rows[0] || null;
}

async function finalizeInterview(username, jobId, sessionId, result, employment) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const app = await client.query(`UPDATE sk2_career_applications
      SET status=$4, interview_status=$4, interview_score=$5, interview_feedback=$6,
          cooldown_until=$7, hired_at=CASE WHEN $4='hired' THEN now() ELSE hired_at END
      WHERE username=$1 AND job_id=$2 AND interview_status='active' AND interview->>'sessionId'=$3
      RETURNING *`, [username, jobId, sessionId, result.status, result.score, result.feedback, result.cooldownUntil]);
    if (!app.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    if (result.status === 'hired') {
      await client.query('UPDATE sk2_players SET employment=$2, last_seen=now() WHERE username=$1', [username, JSON.stringify(employment)]);
    }
    await client.query('COMMIT');
    return app.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getWorkState(username) {
  const player = await q('SELECT * FROM sk2_players WHERE username=$1', [username]);
  const shift = await q(`SELECT s.*, t.id AS task_id, t.task_type, t.task, t.status AS task_status
    FROM sk2_work_shifts s LEFT JOIN sk2_work_tasks t ON t.shift_id=s.id AND t.status='assigned'
    WHERE s.username=$1 AND s.status='active' LIMIT 1`, [username]);
  const history = await q(`SELECT job_id, task_id, payment, professional_xp, performance, created_at
    FROM sk2_work_history WHERE username=$1 ORDER BY created_at DESC LIMIT 10`, [username]);
  return { player: player.rows[0] || null, shift: shift.rows[0] || null, history: history.rows };
}

async function startWorkShift(username, jobId) {
  const id = crypto.randomUUID();
  const r = await q(`INSERT INTO sk2_work_shifts (id, username, job_id)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`, [id, username, jobId]);
  if (r.rows[0]) return r.rows[0];
  const active = await q(`SELECT * FROM sk2_work_shifts WHERE username=$1 AND status='active' LIMIT 1`, [username]);
  return active.rows[0] || null;
}

async function assignWorkTask(username, shiftId, jobId, task) {
  const id = crypto.randomUUID();
  const r = await q(`INSERT INTO sk2_work_tasks
    (id, shift_id, username, job_id, task_type, task, reward_money, reward_xp)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8
    WHERE EXISTS (SELECT 1 FROM sk2_work_shifts WHERE id=$2 AND username=$3 AND status='active')
      AND NOT EXISTS (SELECT 1 FROM sk2_work_tasks WHERE shift_id=$2 AND status='assigned')
    RETURNING *`, [id, shiftId, username, jobId, task.type, JSON.stringify(task.payload), task.money, task.xp]);
  if (r.rows[0]) return r.rows[0];
  const existing = await q(`SELECT * FROM sk2_work_tasks WHERE shift_id=$1 AND status='assigned' LIMIT 1`, [shiftId]);
  return existing.rows[0] || null;
}

async function completeWorkTask(username, taskId, result) {
  return advanceWorkTask(username, taskId, {}, result, true);
}

async function advanceWorkTask(username, taskId, nextTask, result, complete) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const task = await client.query('SELECT * FROM sk2_work_tasks WHERE id=$1 AND username=$2 FOR UPDATE', [taskId, username]);
    if (!task.rowCount) { await client.query('ROLLBACK'); return null; }
    const current = task.rows[0];
    if (current.status === 'completed') {
      await client.query('COMMIT');
      return { duplicate: true, task: current };
    }
    if (!complete) {
      const updated = await client.query(`UPDATE sk2_work_tasks SET task=$3
        WHERE id=$1 AND username=$2 AND status='assigned' RETURNING *`,
        [taskId, username, JSON.stringify(nextTask)]);
      await client.query('COMMIT');
      return { duplicate: false, completed: false, task: updated.rows[0] };
    }
    const player = await client.query('SELECT * FROM sk2_players WHERE username=$1 FOR UPDATE', [username]);
    const employment = { ...(player.rows[0].employment || {}) };
    employment.completedTasks = Number(employment.completedTasks || 0) + 1;
    employment.totalEarned = Number(employment.totalEarned || 0) + current.reward_money;
    employment.professionalXp = Number(employment.professionalXp || 0) + current.reward_xp;
    const updated = await client.query(`UPDATE sk2_work_tasks SET status='completed', task=$3,
      result=$4, completed_at=now() WHERE id=$1 AND username=$2 AND status='assigned' RETURNING *`,
      [taskId, username, JSON.stringify(nextTask), JSON.stringify(result)]);
    if (!updated.rowCount) { await client.query('ROLLBACK'); return { duplicate: true, task: current }; }
    await client.query(`INSERT INTO sk2_work_history
      (id, username, job_id, task_id, payment, professional_xp, performance)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), username, current.job_id, taskId, current.reward_money, current.reward_xp, result.performance]);
    const updatedPlayer = await client.query(`UPDATE sk2_players
      SET money=money+$2, xp=xp+$3, employment=$4, last_seen=now() WHERE username=$1 RETURNING *`,
      [username, current.reward_money, current.reward_xp, JSON.stringify(employment)]);
    await client.query('COMMIT');
    return { duplicate: false, completed: true, task: updated.rows[0], player: updatedPlayer.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
const pub = row => ({
  name: row.name, role: row.role, ...cleanLook(row.look), money: row.money, xp: row.xp,
  mission: { id: row.mission_id || 'welcome', done: !!row.mission_done },
  missions: row.missions || {}, resume: row.resume || { summary: '', skills: [], experience: 0 },
  employment: row.employment || {}, x: row.x, y: row.y,
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

module.exports = { setPool, init, health, close, register, login, load, savePositions, completeWelcome, completeMission, getResume, saveResume, applyForCareer, listApplications, getApplication, startInterview, answerInterview, finalizeInterview, getWorkState, startWorkShift, assignWorkTask, completeWorkTask, advanceWorkTask, pub, sign, verifyToken, cleanLook, validName, validPass, validateConfig };
