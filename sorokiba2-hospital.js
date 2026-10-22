'use strict';
// Sorokiba 2 – Hospital. Mesma lógica do condomínio e do banco: tudo é decidido e gravado no servidor,
// o dinheiro só muda em transação (FOR UPDATE) e o painel é aberto pelos funcionários/áreas do prédio.
// Tabelas próprias (sk2_hospital_*). Persistente: o jogador pode sair do jogo no meio do atendimento.
//
// Fluxo do paciente (máquina de estados em sk2_hospital_visits.status):
//   registered (recepção) → triaged (triagem + espera por risco) → exams (consulta pediu exames)
//   → diagnosed (resultado + diagnóstico) → treating (sessões) → discharged (alta)
//   Consulta sem exames vai direto a diagnosed; consulta de quem está saudável termina em discharged.
const crypto = require('crypto');
const db = require('./sorokiba2-db');
const city = require('./sorokiba2-city');

// SK2_HOSPITAL_TIME_SCALE=0.01 comprime todos os tempos (exames, esperas, sessões) para testar. Em produção: 1.
const SCALE = (() => { const n = Number(process.env.SK2_HOSPITAL_TIME_SCALE); return n > 0 && n <= 1 ? n : 1; })();
const msOf = minutes => Math.max(1000, Math.round(minutes * 60e3 * SCALE));

/* ---------- regras (ajuste aqui) ---------- */
const HOSPITAL = Object.freeze({
  HEALTH_MAX: 100, WORK_MIN_HEALTH: 35, HEALTH_FLOOR: 5,
  CONSULT_FEE: 40,
  ROLL_MIN: 30,              // a cada 30 min reais há um "sorteio" de doença
  ILLNESS_CHANCE: 0.04,      // 4% por sorteio (doenças raras, como câncer, têm peso baixo no catálogo)
  MAX_ROLLS: 8,              // sorteios acumulados no máximo (quem some 1 semana não volta doente de tudo)
  WORSEN_AFTER_MIN: 360,     // sem tratamento, piora de gravidade a cada 6 h
  MAX_WORSEN: 2,
  DECAY_PER_HOUR: [1.5, 3, 5, 8],   // perda de saúde por hora, conforme a gravidade atual
  REGEN_PER_HOUR: 10,
  TRIAGE_WAIT_SEC: [90, 45, 20, 0], // espera por cor de risco (vermelho entra na hora)
  STALE_VISIT_HOURS: 6,
  LAST_VISIT_SHOW_MIN: 30,   // por quanto tempo o painel mostra o resumo do último atendimento
  MAX_MONEY: 2147483647,
  // Serviços para quem está saudável (e descontos para quem está doente)
  PLAN_PRICE: 250, PLAN_DAYS: 7, PLAN_DISCOUNT_PCT: 50, PLAN_RENEW_WINDOW_H: 24,   // plano de saúde: -50% em consulta, exames e sessões
  VACCINE_PRICE: 80, VACCINE_HOURS: 12, VACCINE_FACTOR: 0.25, VACCINE_RENEW_WINDOW_H: 2, // vacina: 1/4 da chance de adoecer
  SNACK_COOLDOWN_MIN: 5,   // máquina de lanches: intervalo entre compras
  DONATE_REWARD: 50, DONATE_XP: 20, DONATE_COOLDOWN_H: 6, DONATE_MIN_HEALTH: 70, DONATE_HEALTH_COST: 10,
});
// Máquina de lanches do hospital: pequena recuperação de saúde, com intervalo entre compras.
const SNACKS = Object.freeze({
  agua: { name: 'Água mineral', price: 3, heal: 2 },
  cafe: { name: 'Café', price: 5, heal: 1 },
  sanduiche: { name: 'Sanduíche natural', price: 9, heal: 4 },
});
const RISKS = Object.freeze([
  { id: 'verde', label: 'Verde · pouco urgente' },
  { id: 'amarelo', label: 'Amarelo · urgência moderada' },
  { id: 'laranja', label: 'Laranja · muito urgente' },
  { id: 'vermelho', label: 'Vermelho · emergência' },
]);

// site: onde o jogador precisa estar (o cliente leva o jogador até lá)
const EXAMS = Object.freeze({
  hemograma: { name: 'Hemograma completo', site: 'lab', price: 60, minutes: [60, 120] },
  raiox: { name: 'Raio-X', site: 'imaging', price: 90, minutes: [60, 90] },
  ultrassom: { name: 'Ultrassom', site: 'imaging', price: 120, minutes: [60, 100] },
  tomografia: { name: 'Tomografia', site: 'imaging', price: 220, minutes: [90, 120] },
  biopsia: { name: 'Biópsia', site: 'lab', price: 300, minutes: [90, 120] },
});

const V = (temp, sys, bpm, spo2) => ({ temp, sys, bpm, spo2 });
const DISEASES = Object.freeze({
  resfriado: { name: 'Resfriado', weight: 34, severity: 0, symptoms: ['coriza', 'tosse leve', 'espirros'],
    vitals: V([36.7, 37.8], [105, 125], [65, 90], [96, 99]), exams: [], findings: {},
    treatment: { site: 'ward', what: 'Medicação e repouso', sessions: 1, sessionPrice: 55, cooldownMin: 0 } },
  intoxicacao: { name: 'Intoxicação alimentar', weight: 22, severity: 1, symptoms: ['náusea', 'dor abdominal', 'diarreia'],
    vitals: V([36.6, 37.6], [100, 120], [80, 105], [96, 99]), exams: ['hemograma'], findings: { hemograma: 'Sinais de desidratação e inflamação intestinal' },
    treatment: { site: 'ward', what: 'Soro e antiemético', sessions: 1, sessionPrice: 90, cooldownMin: 0 } },
  gripe: { name: 'Gripe (influenza)', weight: 18, severity: 1, symptoms: ['febre alta', 'dor no corpo', 'calafrios'],
    vitals: V([38.0, 39.5], [105, 125], [85, 110], [94, 98]), exams: ['hemograma'], findings: { hemograma: 'Leucócitos alterados, compatível com infecção viral' },
    treatment: { site: 'ward', what: 'Antiviral e hidratação', sessions: 1, sessionPrice: 110, cooldownMin: 0 } },
  fratura: { name: 'Fratura', weight: 8, severity: 2, symptoms: ['dor intensa', 'inchaço', 'dificuldade de mover'],
    vitals: V([36.5, 37.4], [115, 140], [85, 112], [96, 99]), exams: ['raiox'], findings: { raiox: 'Linha de fratura visível no osso' },
    treatment: { site: 'er', what: 'Imobilização e analgesia', sessions: 1, sessionPrice: 180, cooldownMin: 0 } },
  pneumonia: { name: 'Pneumonia', weight: 7, severity: 2, symptoms: ['falta de ar', 'tosse com catarro', 'febre'],
    vitals: V([38.0, 39.6], [100, 125], [95, 120], [88, 94]), exams: ['hemograma', 'raiox'],
    findings: { hemograma: 'Infecção bacteriana provável', raiox: 'Área de consolidação no pulmão' },
    treatment: { site: 'ward', what: 'Antibiótico e oxigênio', sessions: 2, sessionPrice: 160, cooldownMin: 30 } },
  apendicite: { name: 'Apendicite', weight: 4, severity: 3, symptoms: ['dor forte do lado direito', 'náusea', 'febre baixa'],
    vitals: V([37.4, 38.6], [105, 135], [95, 125], [95, 99]), exams: ['ultrassom', 'hemograma'],
    findings: { ultrassom: 'Apêndice inflamado e aumentado', hemograma: 'Leucócitos muito elevados' },
    treatment: { site: 'er', what: 'Cirurgia (apendicectomia)', sessions: 1, sessionPrice: 650, cooldownMin: 0 } },
  cancer: { name: 'Câncer', weight: 2, severity: 2, symptoms: ['cansaço persistente', 'perda de peso', 'caroço ou mancha suspeita'],
    vitals: V([36.5, 37.6], [105, 130], [70, 100], [95, 99]), exams: ['hemograma', 'tomografia', 'biopsia'],
    findings: { hemograma: 'Anemia e marcadores alterados', tomografia: 'Massa suspeita identificada', biopsia: 'Células malignas confirmadas' },
    treatment: { site: 'ward', what: 'Quimioterapia', sessions: 3, sessionPrice: 350, cooldownMin: 180 } },
});
const HEALTHY_VITALS = V([36.2, 37.0], [105, 125], [62, 84], [97, 99]);
const BLOOD = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−'];

/* ---------- funções puras (testadas em test/hospital.test.js) ---------- */
function weightedPick(table, rand = Math.random) {
  const entries = Object.entries(table), total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [id, w] of entries) { if (r < w) return id; r -= w; }
  return entries[entries.length - 1][0];
}
const DISEASE_WEIGHTS = Object.fromEntries(Object.entries(DISEASES).map(([id, d]) => [id, d.weight]));
// `rolls` sorteios: devolve o id da primeira doença sorteada, ou null.
function rollIllness(rolls, rand = Math.random, chance = HOSPITAL.ILLNESS_CHANCE) {
  for (let i = 0; i < rolls; i++) if (rand() < chance) return weightedPick(DISEASE_WEIGHTS, rand);
  return null;
}
const effectiveSeverity = (base, elapsedMin) =>
  Math.min(3, base + Math.min(HOSPITAL.MAX_WORSEN, Math.max(0, Math.floor(elapsedMin / HOSPITAL.WORSEN_AFTER_MIN))));
function settleHealth(health, hours, sev) {
  const h = Math.max(0, Number(hours) || 0);
  if (sev === null || sev === undefined) return Math.min(HOSPITAL.HEALTH_MAX, Math.round(health + h * HOSPITAL.REGEN_PER_HOUR));
  return Math.max(HOSPITAL.HEALTH_FLOOR, Math.round(health - h * HOSPITAL.DECAY_PER_HOUR[sev]));
}
const lerp = ([lo, hi], r) => lo + (hi - lo) * r;
function makeVitals(diseaseId, sev, rand = Math.random) {
  const d = DISEASES[diseaseId], p = d ? d.vitals : HEALTHY_VITALS, bump = d ? Math.max(0, sev - d.severity) : 0;
  const sys = Math.round(lerp(p.sys, rand()));
  return {
    temp: Math.round((lerp(p.temp, rand()) + bump * .3) * 10) / 10,
    sys, dia: Math.round(sys * .62 + (rand() * 6 - 3)),
    bpm: Math.round(lerp(p.bpm, rand()) + bump * 6),
    spo2: Math.max(80, Math.round(lerp(p.spo2, rand()) - bump * 2)),
  };
}
function vitalFlags(v) {
  const f = [];
  if (v.temp >= 37.8) f.push('febre');
  if (v.bpm > 100) f.push('taquicardia');
  if (v.spo2 < 92) f.push('oxigenação baixa');
  if (v.sys >= 140) f.push('pressão alta');
  if (v.sys < 95) f.push('pressão baixa');
  return f;
}
const triageWaitMs = risk => HOSPITAL.TRIAGE_WAIT_SEC[risk] * 1000 * SCALE;
function examDurationMs(examId, rand = Math.random) {
  const [lo, hi] = EXAMS[examId].minutes;
  return msOf(lo + Math.floor(rand() * (hi - lo + 1)));
}
function plansFor(diseaseId) {
  const t = DISEASES[diseaseId].treatment;
  const plans = [{ id: 'padrao', name: 'Tratamento padrão', sessions: t.sessions, sessionPrice: t.sessionPrice, cooldownMin: t.cooldownMin }];
  if (t.sessions >= 2) plans.push({ id: 'intensivo', name: 'Tratamento intensivo', sessions: t.sessions - 1, sessionPrice: Math.round(t.sessionPrice * 1.8), cooldownMin: t.cooldownMin });
  return plans.map(p => ({ ...p, total: p.sessions * p.sessionPrice }));
}
// 1 verdadeira + 2 hipóteses falsas parecidas, embaralhadas
function hypotheses(diseaseId, rand = Math.random) {
  const sev = DISEASES[diseaseId].severity;
  const others = Object.keys(DISEASES).filter(id => id !== diseaseId)
    .sort((a, b) => Math.abs(DISEASES[a].severity - sev) - Math.abs(DISEASES[b].severity - sev) || rand() - .5);
  return [diseaseId, ...others.slice(0, 2)].map(id => ({ id, r: rand() })).sort((a, b) => a.r - b.r).map(x => DISEASES[x.id].name);
}
const examSite = id => EXAMS[id].site;
// Plano de saúde e subsídio da Prefeitura se combinam (aritmética inteira: servidor e tela dão o mesmo preço).
const discountPrice = (price, planOn, subsidyPct = 0) => {
  const sub = Math.min(100, Math.max(0, Math.floor(subsidyPct) || 0));
  if (!planOn && !sub) return price;
  return Math.max(1, Math.ceil(price * (planOn ? 100 - HOSPITAL.PLAN_DISCOUNT_PCT : 100) * (100 - sub) / 10000));
};
// Doação de sangue: só saudável, com saúde alta e respeitando o intervalo.
function donateStatus({ health, sick, nextAt, now }) {
  if (sick) return { ok: false, reason: 'Você está com sintomas: não pode doar sangue agora.' };
  if (health < HOSPITAL.DONATE_MIN_HEALTH) return { ok: false, reason: `Sua saúde precisa estar em ${HOSPITAL.DONATE_MIN_HEALTH}% ou mais para doar.` };
  if (nextAt && nextAt > now) return { ok: false, reason: `Você doou há pouco. Volte em ${fmtWait(nextAt - now)}.` };
  return { ok: true, reason: '' };
}
// Máquina de lanches: respeita o intervalo entre compras.
function snackStatus({ nextAt, now }) {
  if (nextAt && nextAt > now) return { ok: false, reason: `A máquina está reabastecendo. Volte em ${fmtWait(nextAt - now)}.` };
  return { ok: true, reason: '' };
}
// Renovação de plano/vacina: só quando está perto de vencer (evita pagar duas vezes à toa).
const canRenew = (untilMs, now, windowMin) => !untilMs || untilMs - now <= msOf(windowMin);
// O que o paciente pode fazer agora e onde. `now` em ms; datas em ms epoch.
function stageInfo(v, exams = [], now = Date.now()) {
  if (!v) return { step: 0, label: 'Sem atendimento', actions: [{ id: 'checkin', site: 'reception' }] };
  const left = t => Math.max(0, t - now);
  switch (v.status) {
    case 'registered': return { step: 1, label: 'Aguardando triagem', actions: [{ id: 'triage', site: 'triage' }] };
    case 'triaged': { const w = left(v.readyAt); return { step: 2, label: w ? 'Na espera pela consulta' : 'Aguardando consulta', waitMs: w, actions: w ? [] : [{ id: 'consult', site: 'consult1' }] }; }
    case 'exams': {
      const ordered = exams.filter(e => e.status === 'ordered'), running = exams.filter(e => e.status === 'running');
      if (ordered.length) return { step: 3, label: 'Exames a coletar', actions: ordered.map(e => ({ id: 'collect', exam: e.id, site: examSite(e.id) })) };
      const last = Math.max(0, ...running.map(e => e.readyAt)), w = left(last);
      return { step: 3, label: w ? 'Exames em análise' : 'Resultados prontos', waitMs: w, actions: w ? [] : [{ id: 'results', site: 'consult2' }] };
    }
    case 'diagnosed': return { step: 4, label: 'Diagnóstico pronto', actions: [{ id: 'plan', site: 'consult2' }] };
    case 'treating': { const w = left(v.nextSessionAt); return { step: 5, label: 'Em tratamento', waitMs: w, actions: w ? [] : [{ id: 'session', site: v.sessionSite }] }; }
    default: return { step: 6, label: 'Alta', actions: [] };
  }
}

/* ---------- banco de dados ---------- */
async function init() {
  await db.query(`CREATE TABLE IF NOT EXISTS sk2_hospital_patients (
    username TEXT PRIMARY KEY REFERENCES sk2_players(username) ON DELETE CASCADE,
    health INT NOT NULL DEFAULT 100 CHECK (health BETWEEN 0 AND 100),
    health_at TIMESTAMPTZ NOT NULL DEFAULT now(), roll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    blood TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS sk2_hospital_conditions (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    disease_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cured')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(), cured_at TIMESTAMPTZ);
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_active_condition ON sk2_hospital_conditions(username) WHERE status='active';
  CREATE SEQUENCE IF NOT EXISTS sk2_hospital_ticket;
  CREATE TABLE IF NOT EXISTS sk2_hospital_visits (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    condition_id UUID, ticket INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered'
      CHECK (status IN ('registered','triaged','exams','diagnosed','treating','discharged','abandoned')),
    triage JSONB, risk INT, ready_at TIMESTAMPTZ, consult JSONB,
    plan TEXT, sessions_total INT, sessions_done INT NOT NULL DEFAULT 0, session_price INT, cooldown_min INT,
    next_session_at TIMESTAMPTZ, session_site TEXT,
    charges JSONB NOT NULL DEFAULT '[]', total INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_open_visit ON sk2_hospital_visits(username) WHERE status NOT IN ('discharged','abandoned');
  CREATE INDEX IF NOT EXISTS sk2_hospital_visits_user ON sk2_hospital_visits(username, created_at DESC);
  CREATE TABLE IF NOT EXISTS sk2_hospital_exams (
    id UUID PRIMARY KEY, visit_id UUID NOT NULL REFERENCES sk2_hospital_visits(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    exam_id TEXT NOT NULL, price INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','running','done')),
    ready_at TIMESTAMPTZ, result JSONB, notified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS sk2_hospital_exams_visit ON sk2_hospital_exams(visit_id);
  CREATE INDEX IF NOT EXISTS sk2_hospital_exams_ready ON sk2_hospital_exams(ready_at) WHERE status='running' AND notified=false;
  ALTER TABLE sk2_hospital_patients ADD COLUMN IF NOT EXISTS plan_until TIMESTAMPTZ;
  ALTER TABLE sk2_hospital_patients ADD COLUMN IF NOT EXISTS immune_until TIMESTAMPTZ;
  ALTER TABLE sk2_hospital_patients ADD COLUMN IF NOT EXISTS donated_at TIMESTAMPTZ;
  ALTER TABLE sk2_hospital_patients ADD COLUMN IF NOT EXISTS snack_at TIMESTAMPTZ;
  ALTER TABLE sk2_hospital_visits ADD COLUMN IF NOT EXISTS outcome TEXT;
  ALTER TABLE sk2_hospital_visits ADD COLUMN IF NOT EXISTS disease_id TEXT;`);
}

const fail = (err, status = 409) => ({ err, status });
const brl = n => 'R$ ' + Number(n).toLocaleString('pt-BR');
const epoch = d => (d ? new Date(d).getTime() : null);
const fmtWait = ms => { const s = Math.ceil(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min` : s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`; };

// Sorteia doença, aplica piora/regeneração da saúde pelo tempo real decorrido e devolve o estado do paciente.
async function settle(c, player) {
  const u = player.username;
  await c.query('INSERT INTO sk2_hospital_patients (username, blood) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u, BLOOD[crypto.randomInt(BLOOD.length)]]);
  const rec = (await c.query(`SELECT *, EXTRACT(EPOCH FROM (now() - health_at)) / 3600 AS dh, EXTRACT(EPOCH FROM (now() - roll_at)) / 60 AS dm,
    (plan_until IS NOT NULL AND plan_until > now()) AS plan_on, (immune_until IS NOT NULL AND immune_until > now()) AS immune
    FROM sk2_hospital_patients WHERE username=$1 FOR UPDATE`, [u])).rows[0];
  let cond = (await c.query(`SELECT *, EXTRACT(EPOCH FROM (now() - started_at)) / 60 AS em FROM sk2_hospital_conditions
    WHERE username=$1 AND status='active' FOR UPDATE`, [u])).rows[0] || null;
  const rolls = Math.min(HOSPITAL.MAX_ROLLS, Math.floor(Number(rec.dm) / HOSPITAL.ROLL_MIN));
  if (rolls >= 1 && !cond) {
    const id = rollIllness(rolls, Math.random, rec.immune ? HOSPITAL.ILLNESS_CHANCE * HOSPITAL.VACCINE_FACTOR : HOSPITAL.ILLNESS_CHANCE);
    if (id) cond = (await c.query(`INSERT INTO sk2_hospital_conditions (id, username, disease_id) VALUES ($1,$2,$3)
      RETURNING *, 0::float AS em`, [crypto.randomUUID(), u, id])).rows[0];
  }
  const d = cond && DISEASES[cond.disease_id];
  const sev = d ? effectiveSeverity(d.severity, Number(cond.em)) : null;
  const health = settleHealth(rec.health, Number(rec.dh), sev);
  await c.query(`UPDATE sk2_hospital_patients SET health=$2, health_at=now(), roll_at = CASE WHEN $3::boolean THEN now() ELSE roll_at END WHERE username=$1`, [u, health, rolls >= 1]);
  const subsidy = await city.policy(c, 'health_subsidy_pct');
  return { health, blood: rec.blood, cond, sev, planOn: !!rec.plan_on, immune: !!rec.immune, subsidy };
}

const loadVisit = async (c, username, lock = false) => {
  const v = (await c.query(`SELECT * FROM sk2_hospital_visits WHERE username=$1 AND status NOT IN ('discharged','abandoned') ${lock ? 'FOR UPDATE' : ''}`, [username])).rows[0] || null;
  if (!v) return null;
  const exams = (await c.query('SELECT * FROM sk2_hospital_exams WHERE visit_id=$1 ORDER BY created_at, exam_id', [v.id])).rows;
  return { row: v, exams };
};
const visitDto = (v, exams) => ({
  status: v.status, readyAt: epoch(v.ready_at), nextSessionAt: epoch(v.next_session_at), sessionSite: v.session_site,
});
const examDto = e => ({ id: e.exam_id, status: e.status, readyAt: epoch(e.ready_at) });

// Cobra uma etapa do atendimento (com o desconto do plano de saúde, se houver).
async function charge(c, player, visit, listPrice, label, planOn = false, subsidy = 0) {
  const amount = discountPrice(listPrice, planOn, subsidy);
  if (amount <= 0) return player;
  if (player.money < amount) return null;
  const p = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [player.username, amount])).rows[0];
  await c.query(`UPDATE sk2_hospital_visits SET charges = charges || $2::jsonb, total = total + $3, updated_at = now() WHERE id=$1`,
    [visit.id, JSON.stringify([{ label: `${label}${planOn ? ` (plano −${HOSPITAL.PLAN_DISCOUNT_PCT}%)` : ''}${subsidy ? ` (subsídio −${subsidy}%)` : ''}`, amount }]), amount]);
  await city.credit(c, 'hospital', amount, label);   // hospital público: a receita vai para o tesouro municipal
  return p;
}
// Cobra um serviço avulso (sem atendimento aberto).
async function payDirect(c, player, amount, note = 'Serviço do Hospital') {
  if (player.money < amount) return null;
  const p = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [player.username, amount])).rows[0];
  await city.credit(c, 'hospital', amount, note);
  return p;
}

async function snapshot(c, username) {
  const subsidy = await city.policy(c, 'health_subsidy_pct');
  const rec = (await c.query(`SELECT health, blood, plan_until, immune_until, donated_at, snack_at,
    (plan_until IS NOT NULL AND plan_until > now()) AS plan_on, (immune_until IS NOT NULL AND immune_until > now()) AS immune
    FROM sk2_hospital_patients WHERE username=$1`, [username])).rows[0];
  const cond = (await c.query(`SELECT *, EXTRACT(EPOCH FROM (now() - started_at)) / 60 AS em FROM sk2_hospital_conditions WHERE username=$1 AND status='active'`, [username])).rows[0] || null;
  const d = cond && DISEASES[cond.disease_id], sev = d ? effectiveSeverity(d.severity, Number(cond.em)) : null;
  const loaded = await loadVisit(c, username);
  let visit = null;
  if (loaded) {
    const v = loaded.row, exams = loaded.exams;
    const disease = v.condition_id && cond && cond.id === v.condition_id ? DISEASES[cond.disease_id] : null;
    const info = stageInfo(visitDto(v, exams), exams.map(examDto), Date.now());
    const revealed = ['diagnosed', 'treating'].includes(v.status);
    const ahead = (await c.query(`SELECT COUNT(*)::int AS n FROM sk2_hospital_visits WHERE status IN ('registered','triaged') AND ticket < $1`, [v.ticket])).rows[0].n;
    visit = {
      id: v.id, ticket: v.ticket, status: v.status, queueAhead: ahead, stage: info,
      risk: v.risk === null ? null : { index: v.risk, ...RISKS[v.risk] },
      triage: v.triage, readyAt: epoch(v.ready_at),
      consult: v.consult ? { healthy: !!v.consult.healthy, hypotheses: v.consult.hypotheses || [] } : null,
      exams: exams.map(e => ({ id: e.exam_id, name: EXAMS[e.exam_id].name, site: EXAMS[e.exam_id].site, price: e.price, status: e.status, readyAt: epoch(e.ready_at), result: e.result })),
      diagnosis: revealed && disease ? { id: cond.disease_id, name: disease.name } : null,
      plans: v.status === 'diagnosed' && disease ? plansFor(cond.disease_id) : null,
      treatment: v.status === 'treating' ? { plan: v.plan, sessionsTotal: v.sessions_total, sessionsDone: v.sessions_done, sessionPrice: v.session_price, nextAt: epoch(v.next_session_at), site: v.session_site, what: disease?.treatment.what || '' } : null,
      charges: v.charges, total: v.total,
    };
  }
  const hist = (await c.query(`SELECT id, ticket, status, outcome, disease_id, total, created_at, closed_at, consult FROM sk2_hospital_visits
    WHERE username=$1 AND status IN ('discharged','abandoned') ORDER BY closed_at DESC NULLS LAST, created_at DESC LIMIT 5`, [username])).rows;
  const nowMs = Date.now(), outcomeOf = h => h.outcome || (h.status === 'abandoned' ? 'abandoned' : h.consult?.healthy ? 'healthy' : 'discharged');
  const histDto = hist.map(h => ({ ticket: h.ticket, outcome: outcomeOf(h), diagnosis: h.disease_id && DISEASES[h.disease_id] ? DISEASES[h.disease_id].name : null, total: h.total, at: h.closed_at || h.created_at }));
  const last = hist[0], lastVisit = last && last.closed_at && nowMs - epoch(last.closed_at) < msOf(HOSPITAL.LAST_VISIT_SHOW_MIN) ? histDto[0] : null;
  const planUntil = epoch(rec.plan_until), immuneUntil = epoch(rec.immune_until);
  const nextDonate = rec.donated_at ? epoch(rec.donated_at) + msOf(HOSPITAL.DONATE_COOLDOWN_H * 60) : 0;
  const nextSnack = rec.snack_at ? epoch(rec.snack_at) + msOf(HOSPITAL.SNACK_COOLDOWN_MIN) : 0;
  const services = {
    snack: { items: Object.entries(SNACKS).map(([id, i]) => ({ id, ...i })), cooldownMin: HOSPITAL.SNACK_COOLDOWN_MIN, nextAt: nextSnack || null, ...snackStatus({ nextAt: nextSnack, now: nowMs }) },
    plan: { active: !!rec.plan_on, until: planUntil, price: HOSPITAL.PLAN_PRICE, days: HOSPITAL.PLAN_DAYS, discountPct: HOSPITAL.PLAN_DISCOUNT_PCT, canBuy: !rec.plan_on || canRenew(planUntil, nowMs, HOSPITAL.PLAN_RENEW_WINDOW_H * 60) },
    vaccine: { active: !!rec.immune, until: immuneUntil, price: HOSPITAL.VACCINE_PRICE, hours: HOSPITAL.VACCINE_HOURS, factorPct: Math.round(HOSPITAL.VACCINE_FACTOR * 100), canBuy: !rec.immune || canRenew(immuneUntil, nowMs, HOSPITAL.VACCINE_RENEW_WINDOW_H * 60) },
    donate: { reward: HOSPITAL.DONATE_REWARD, xp: HOSPITAL.DONATE_XP, minHealth: HOSPITAL.DONATE_MIN_HEALTH, cooldownH: HOSPITAL.DONATE_COOLDOWN_H, nextAt: nextDonate || null, ...donateStatus({ health: rec.health, sick: !!d, nextAt: nextDonate, now: nowMs }) },
  };
  return {
    serverNow: Date.now(),
    patient: {
      health: rec.health, blood: rec.blood, canWork: rec.health >= HOSPITAL.WORK_MIN_HEALTH, workMinHealth: HOSPITAL.WORK_MIN_HEALTH,
      sick: !!d, symptoms: d ? d.symptoms : [], riskNow: d ? RISKS[sev].id : null, sinceMin: cond ? Math.floor(Number(cond.em)) : 0,
    },
    visit, lastVisit, services, fees: { consult: discountPrice(HOSPITAL.CONSULT_FEE, rec.plan_on, subsidy), consultList: HOSPITAL.CONSULT_FEE, subsidyPct: subsidy }, risks: RISKS,
    history: histDto,
  };
}

// Toda operação: trava o jogador, atualiza saúde/doença pelo relógio, roda a regra e devolve o prontuário novo.
const run = (username, fn) => db.withTx(async c => {
  const locked = (await c.query('SELECT * FROM sk2_players WHERE username=$1 FOR UPDATE', [username])).rows[0];
  if (!locked) return fail('Jogador não encontrado', 404);
  const st = await settle(c, locked);
  const out = await fn(c, locked, st);
  if (out.err) return out;
  return { ...out, playerRow: out.player || locked, hospital: await snapshot(c, username) };
});
const noop = (_c, player) => ({ player });
const summary = username => run(username, noop);

const checkin = username => run(username, async (c, p, st) => {
  await c.query(`UPDATE sk2_hospital_visits SET status='abandoned', outcome='abandoned', closed_at=now() WHERE username=$1
    AND status IN ('registered','triaged') AND updated_at < now() - make_interval(hours => $2)`, [username, HOSPITAL.STALE_VISIT_HOURS]);
  if ((await c.query(`SELECT 1 FROM sk2_hospital_visits WHERE username=$1 AND status NOT IN ('discharged','abandoned')`, [username])).rowCount)
    return fail('Você já tem um atendimento aberto. Continue de onde parou.');
  const ticket = Number((await c.query(`SELECT nextval('sk2_hospital_ticket') AS n`)).rows[0].n);
  await c.query('INSERT INTO sk2_hospital_visits (id, username, condition_id, ticket) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), username, st.cond ? st.cond.id : null, ticket]);
  return { player: p, event: { kind: 'checkin', ticket }, message: `Ficha aberta. Sua senha é ${ticket}. Siga para a Triagem.` };
});

const requireVisit = async (c, username, statuses) => {
  const loaded = await loadVisit(c, username, true);
  if (!loaded) return { err: 'Você não tem atendimento aberto. Abra a ficha na Recepção.', status: 409 };
  if (!statuses.includes(loaded.row.status)) return { err: 'Esta etapa não é a próxima do seu atendimento.', status: 409 };
  return loaded;
};

const triage = (username, rand = Math.random) => run(username, async (c, p, st) => {
  const v = await requireVisit(c, username, ['registered']); if (v.err) return v;
  const diseaseId = st.cond ? st.cond.disease_id : null, sev = st.sev ?? 0;
  const vitals = makeVitals(diseaseId, sev, rand), flags = vitalFlags(vitals);
  const risk = diseaseId ? sev : 0;
  await c.query(`UPDATE sk2_hospital_visits SET status='triaged', triage=$2, risk=$3, ready_at = now() + ($4::int * interval '1 millisecond'), updated_at=now() WHERE id=$1`,
    [v.row.id, JSON.stringify({ vitals, flags }), risk, Math.round(triageWaitMs(risk))]);
  return { player: p, event: { kind: 'triage', vitals, flags, risk: RISKS[risk].id },
    message: !diseaseId ? 'Triagem concluída: seus sinais vitais estão normais.' : risk === 3 ? 'Classificação vermelha: você passa na frente!' : `Triagem concluída: ${RISKS[risk].label}.` };
});

const consult = (username, rand = Math.random) => run(username, async (c, p, st) => {
  const v = await requireVisit(c, username, ['triaged']); if (v.err) return v;
  const now = Date.now(), wait = epoch(v.row.ready_at) - now;
  if (wait > 0) return fail(`Aguarde a sua vez: faltam ${fmtWait(wait)}.`);
  const paid = await charge(c, p, v.row, HOSPITAL.CONSULT_FEE, 'Consulta médica', st.planOn, st.subsidy);
  if (!paid) return fail(`A consulta custa ${brl(discountPrice(HOSPITAL.CONSULT_FEE, st.planOn, st.subsidy))} e você não tem esse saldo.`);
  const d = st.cond && DISEASES[st.cond.disease_id];
  if (!d) {
    await c.query(`UPDATE sk2_hospital_visits SET status='discharged', outcome='healthy', consult=$2, closed_at=now(), updated_at=now() WHERE id=$1`, [v.row.id, JSON.stringify({ healthy: true })]);
    return { player: paid, event: { kind: 'consult', healthy: true }, message: 'A médica não encontrou nada de errado: você está saudável e recebeu alta.' };
  }
  const hyp = hypotheses(st.cond.disease_id, rand);
  await c.query('UPDATE sk2_hospital_visits SET consult=$2, updated_at=now() WHERE id=$1', [v.row.id, JSON.stringify({ hypotheses: hyp })]);
  if (!d.exams.length) {
    await c.query(`UPDATE sk2_hospital_visits SET status='diagnosed', updated_at=now() WHERE id=$1`, [v.row.id]);
    return { player: paid, event: { kind: 'consult', exams: 0 }, message: 'Diagnóstico direto: não foram pedidos exames.' };
  }
  for (const examId of d.exams)
    await c.query('INSERT INTO sk2_hospital_exams (id, visit_id, username, exam_id, price) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), v.row.id, username, examId, EXAMS[examId].price]);
  await c.query(`UPDATE sk2_hospital_visits SET status='exams', updated_at=now() WHERE id=$1`, [v.row.id]);
  return { player: paid, event: { kind: 'consult', exams: d.exams.length }, message: `A médica pediu ${d.exams.length} exame(s). Faça a coleta nas salas indicadas.` };
});

const collectExam = (username, examId, rand = Math.random) => run(username, async (c, p, st) => {
  if (!EXAMS[examId]) return fail('Exame inválido.', 400);
  const v = await requireVisit(c, username, ['exams']); if (v.err) return v;
  const exam = v.exams.find(e => e.exam_id === examId && e.status === 'ordered');
  if (!exam) return fail('Esse exame não está pendente de coleta.');
  const paid = await charge(c, p, v.row, exam.price, EXAMS[examId].name, st.planOn, st.subsidy);
  if (!paid) return fail(`${EXAMS[examId].name} custa ${brl(discountPrice(exam.price, st.planOn, st.subsidy))} e você não tem esse saldo.`);
  const dur = Math.round(examDurationMs(examId, rand));
  await c.query(`UPDATE sk2_hospital_exams SET status='running', ready_at = now() + ($2::int * interval '1 millisecond') WHERE id=$1`, [exam.id, dur]);
  return { player: paid, event: { kind: 'exam', exam: examId, site: EXAMS[examId].site },
    message: `${EXAMS[examId].name} coletado. O resultado sai em ${fmtWait(dur)}; você pode sair e voltar depois.` };
});

const results = username => run(username, async (c, p, st) => {
  const v = await requireVisit(c, username, ['exams']); if (v.err) return v;
  if (v.exams.some(e => e.status === 'ordered')) return fail('Ainda faltam exames para coletar.');
  const now = Date.now(), pending = v.exams.filter(e => e.status === 'running' && epoch(e.ready_at) > now);
  if (pending.length) return fail(`Exames em análise: faltam ${fmtWait(Math.max(...pending.map(e => epoch(e.ready_at) - now)))}.`);
  const d = st.cond && DISEASES[st.cond.disease_id];
  if (!d) return fail('Não foi possível interpretar os resultados.');
  for (const e of v.exams)
    await c.query(`UPDATE sk2_hospital_exams SET status='done', result=$2 WHERE id=$1`, [e.id, JSON.stringify({ flag: 'alterado', finding: d.findings[e.exam_id] || 'Alterações compatíveis com o quadro' })]);
  await c.query(`UPDATE sk2_hospital_visits SET status='diagnosed', updated_at=now() WHERE id=$1`, [v.row.id]);
  return { player: p, event: { kind: 'results' }, message: `Resultados lidos. Diagnóstico: ${d.name}.` };
});

const setPlan = (username, planId) => run(username, async (c, p, st) => {
  const v = await requireVisit(c, username, ['diagnosed']); if (v.err) return v;
  if (!st.cond || st.cond.id !== v.row.condition_id) return fail('Seu quadro mudou; abra um novo atendimento.');
  const plan = plansFor(st.cond.disease_id).find(x => x.id === planId);
  if (!plan) return fail('Plano de tratamento inválido.', 400);
  const t = DISEASES[st.cond.disease_id].treatment;
  await c.query(`UPDATE sk2_hospital_visits SET status='treating', plan=$2, sessions_total=$3, sessions_done=0, session_price=$4, cooldown_min=$5,
    next_session_at=now(), session_site=$6, updated_at=now() WHERE id=$1`, [v.row.id, plan.id, plan.sessions, plan.sessionPrice, plan.cooldownMin, t.site]);
  return { player: p, event: { kind: 'plan' }, message: `${plan.name}: ${plan.sessions} sessão(ões) de ${brl(plan.sessionPrice)}.` };
});

const session = username => run(username, async (c, p, st) => {
  const v = await requireVisit(c, username, ['treating']); if (v.err) return v;
  const wait = epoch(v.row.next_session_at) - Date.now();
  if (wait > 0) return fail(`A próxima sessão libera em ${fmtWait(wait)}.`);
  const paid = await charge(c, p, v.row, v.row.session_price, `Sessão ${v.row.sessions_done + 1}/${v.row.sessions_total}`, st.planOn, st.subsidy);
  if (!paid) return fail(`A sessão custa ${brl(discountPrice(v.row.session_price, st.planOn, st.subsidy))} e você não tem esse saldo.`);
  const done = v.row.sessions_done + 1, last = done >= v.row.sessions_total;
  if (last) {
    await c.query(`UPDATE sk2_hospital_conditions SET status='cured', cured_at=now() WHERE id=$1`, [v.row.condition_id]);
    await c.query(`UPDATE sk2_hospital_patients SET health=$2, health_at=now() WHERE username=$1`, [username, HOSPITAL.HEALTH_MAX]);
    await c.query(`UPDATE sk2_hospital_visits SET status='discharged', outcome='cured', disease_id=$3, sessions_done=$2, closed_at=now(), updated_at=now() WHERE id=$1`, [v.row.id, done, st.cond.disease_id]);
    return { player: paid, event: { kind: 'session', site: v.row.session_site, cured: true }, message: 'Tratamento concluído. Você está curado e recebeu alta!' };
  }
  const heal = Math.min(HOSPITAL.HEALTH_MAX, st.health + Math.ceil((HOSPITAL.HEALTH_MAX - st.health) / (v.row.sessions_total - v.row.sessions_done)));
  await c.query(`UPDATE sk2_hospital_patients SET health=$2, health_at=now() WHERE username=$1`, [username, heal]);
  await c.query(`UPDATE sk2_hospital_visits SET sessions_done=$2, next_session_at = now() + ($3::int * interval '1 millisecond'), updated_at=now() WHERE id=$1`,
    [v.row.id, done, msOf(v.row.cooldown_min)]);
  return { player: paid, event: { kind: 'session', site: v.row.session_site, cured: false }, message: `Sessão ${done}/${v.row.sessions_total} concluída. Descanse até a próxima.` };
});

const leave = username => run(username, async (c, p) => {
  const loaded = await loadVisit(c, username, true);
  if (!loaded) return fail('Você não tem atendimento aberto.');
  await c.query(`UPDATE sk2_hospital_visits SET status='abandoned', outcome='abandoned', closed_at=now(), updated_at=now() WHERE id=$1`, [loaded.row.id]);
  return { player: p, event: { kind: 'leave' }, message: 'Atendimento encerrado. Os valores já pagos não são devolvidos.' };
});

// ---- Serviços para quem está saudável ----
const buyPlan = username => run(username, async (c, p) => {
  const row = (await c.query('SELECT plan_until FROM sk2_hospital_patients WHERE username=$1', [username])).rows[0];
  if (!canRenew(epoch(row.plan_until), Date.now(), HOSPITAL.PLAN_RENEW_WINDOW_H * 60)) return fail('Seu plano ainda tem mais de 24 horas de validade. Renove perto do vencimento.');
  const paid = await payDirect(c, p, HOSPITAL.PLAN_PRICE);
  if (!paid) return fail(`O plano custa ${brl(HOSPITAL.PLAN_PRICE)} e você não tem esse saldo.`);
  await c.query(`UPDATE sk2_hospital_patients SET plan_until = GREATEST(now(), COALESCE(plan_until, now())) + ($2::double precision * interval '1 millisecond') WHERE username=$1`,
    [username, msOf(HOSPITAL.PLAN_DAYS * 24 * 60)]);
  return { player: paid, event: { kind: 'plan_buy' }, message: `Plano de saúde ativo por ${HOSPITAL.PLAN_DAYS} dias: ${HOSPITAL.PLAN_DISCOUNT_PCT}% de desconto em consultas, exames e sessões.` };
});

const vaccinate = username => run(username, async (c, p) => {
  const row = (await c.query('SELECT immune_until FROM sk2_hospital_patients WHERE username=$1', [username])).rows[0];
  if (!canRenew(epoch(row.immune_until), Date.now(), HOSPITAL.VACCINE_RENEW_WINDOW_H * 60)) return fail('Você já está imunizado. Volte perto do vencimento da proteção.');
  const paid = await payDirect(c, p, HOSPITAL.VACCINE_PRICE);
  if (!paid) return fail(`A vacina custa ${brl(HOSPITAL.VACCINE_PRICE)} e você não tem esse saldo.`);
  await c.query(`UPDATE sk2_hospital_patients SET immune_until = now() + ($2::double precision * interval '1 millisecond') WHERE username=$1`, [username, msOf(HOSPITAL.VACCINE_HOURS * 60)]);
  return { player: paid, event: { kind: 'vaccine', site: 'ward' }, message: `Vacinado! Por ${HOSPITAL.VACCINE_HOURS} horas a chance de adoecer cai para ${Math.round(HOSPITAL.VACCINE_FACTOR * 100)}%.` };
});

const buySnack = (username, itemId) => run(username, async (c, p, st) => {
  const item = SNACKS[itemId];
  if (!item) return fail('Item inválido.', 400);
  const row = (await c.query('SELECT snack_at FROM sk2_hospital_patients WHERE username=$1', [username])).rows[0];
  const nextAt = row.snack_at ? epoch(row.snack_at) + msOf(HOSPITAL.SNACK_COOLDOWN_MIN) : 0;
  const s = snackStatus({ nextAt, now: Date.now() });
  if (!s.ok) return fail(s.reason);
  const paid = await payDirect(c, p, item.price);
  if (!paid) return fail(`${item.name} custa ${brl(item.price)} e você não tem esse saldo.`);
  const health = Math.min(HOSPITAL.HEALTH_MAX, st.health + item.heal);
  await c.query('UPDATE sk2_hospital_patients SET health=$2, health_at=now(), snack_at=now() WHERE username=$1', [username, health]);
  return { player: paid, event: { kind: 'snack', item: itemId }, message: health > st.health ? `${item.name}: +${health - st.health} de saúde.` : `${item.name}. Gostoso! Sua saúde já estava no máximo.` };
});

const donateBlood = username => run(username, async (c, p, st) => {
  const row = (await c.query('SELECT donated_at FROM sk2_hospital_patients WHERE username=$1', [username])).rows[0];
  const nextAt = row.donated_at ? epoch(row.donated_at) + msOf(HOSPITAL.DONATE_COOLDOWN_H * 60) : 0;
  const s = donateStatus({ health: st.health, sick: !!st.cond, nextAt, now: Date.now() });
  if (!s.ok) return fail(s.reason);
  if (p.money + HOSPITAL.DONATE_REWARD > HOSPITAL.MAX_MONEY) return fail('Sua carteira não comporta esse valor.');
  const player = (await c.query('UPDATE sk2_players SET money = money + $2, xp = xp + $3 WHERE username=$1 RETURNING *', [username, HOSPITAL.DONATE_REWARD, HOSPITAL.DONATE_XP])).rows[0];
  await c.query('UPDATE sk2_hospital_patients SET health=$2, health_at=now(), donated_at=now() WHERE username=$1', [username, Math.max(HOSPITAL.HEALTH_FLOOR, st.health - HOSPITAL.DONATE_HEALTH_COST)]);
  return { player, event: { kind: 'donate', site: 'lab' }, message: `Obrigado por doar sangue (tipo ${st.blood})! Você recebeu ${brl(HOSPITAL.DONATE_REWARD)} e ${HOSPITAL.DONATE_XP} XP.` };
});

// Integração: quem está debilitado não começa turno de trabalho (usada por /api/sk2/work/start).
async function workGate(username) {
  const r = await db.withTx(async c => {
    const p = (await c.query('SELECT * FROM sk2_players WHERE username=$1 FOR UPDATE', [username])).rows[0];
    if (!p) return {};
    return { health: (await settle(c, p)).health };
  });
  return r.health !== undefined && r.health < HOSPITAL.WORK_MIN_HEALTH
    ? `Você está debilitado (saúde ${r.health}%). Procure o Hospital antes de trabalhar.` : null;
}

// Avisa quem tem exame pronto (mesmo fora do hospital).
async function sweepExams(notify) {
  const r = await db.query(`UPDATE sk2_hospital_exams SET notified=true WHERE status='running' AND notified=false AND ready_at <= now() RETURNING username, exam_id`);
  const by = new Map();
  for (const row of r.rows) by.set(row.username, [...(by.get(row.username) || []), EXAMS[row.exam_id]?.name || row.exam_id]);
  for (const [u, names] of by) notify(u, { t: 'hospital', m: `Resultado pronto no Hospital: ${names.join(', ')}.` });
  return r.rowCount;
}

/* ---------- rotas ---------- */
function registerRoutes({ app, json, authUser, limited, userTries, addInterval, notify = () => {} }) {
  addInterval(() => { sweepExams(notify).catch(e => console.error('[sk2] hospital (avisos):', e.message)); }, 60e3);
  const guard = fn => async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      if (limited(userTries, `hospital:${row.username}`, 60)) return res.status(429).json({ err: 'Muitas ações no hospital. Aguarde um minuto.' });
      await fn(req, res, row);
    } catch (e) {
      console.error('[sk2] hospital:', e.message);
      if (!res.headersSent) res.status(500).json({ err: 'Não foi possível concluir o atendimento.' });
    }
  };
  const done = (res, r) => {
    if (r.err) return res.status(r.status || 409).json({ err: r.err });
    res.json({ ok: 1, player: db.pub(r.playerRow), hospital: r.hospital, event: r.event || null, message: r.message || '' });
  };
  app.get('/api/sk2/hospital', guard(async (_req, res, row) => { res.set('Cache-Control', 'no-store'); done(res, await summary(row.username)); }));
  app.post('/api/sk2/hospital/checkin', json, guard(async (_q, res, row) => done(res, await checkin(row.username))));
  app.post('/api/sk2/hospital/triage', json, guard(async (_q, res, row) => done(res, await triage(row.username))));
  app.post('/api/sk2/hospital/consult', json, guard(async (_q, res, row) => done(res, await consult(row.username))));
  app.post('/api/sk2/hospital/exams/collect', json, guard(async (req, res, row) => {
    const exam = typeof req.body?.exam === 'string' && Object.prototype.hasOwnProperty.call(EXAMS, req.body.exam) ? req.body.exam : null;
    if (!exam) return res.status(400).json({ err: 'Exame inválido.' });
    done(res, await collectExam(row.username, exam));
  }));
  app.post('/api/sk2/hospital/exams/results', json, guard(async (_q, res, row) => done(res, await results(row.username))));
  app.post('/api/sk2/hospital/treatment/plan', json, guard(async (req, res, row) => {
    const plan = req.body?.plan;
    if (plan !== 'padrao' && plan !== 'intensivo') return res.status(400).json({ err: 'Plano de tratamento inválido.' });
    done(res, await setPlan(row.username, plan));
  }));
  app.post('/api/sk2/hospital/treatment/session', json, guard(async (_q, res, row) => done(res, await session(row.username))));
  app.post('/api/sk2/hospital/leave', json, guard(async (_q, res, row) => done(res, await leave(row.username))));
  app.post('/api/sk2/hospital/service/plan', json, guard(async (_q, res, row) => done(res, await buyPlan(row.username))));
  app.post('/api/sk2/hospital/service/vaccine', json, guard(async (_q, res, row) => done(res, await vaccinate(row.username))));
  app.post('/api/sk2/hospital/service/snack', json, guard(async (req, res, row) => {
    const item = typeof req.body?.item === 'string' && Object.prototype.hasOwnProperty.call(SNACKS, req.body.item) ? req.body.item : null;
    if (!item) return res.status(400).json({ err: 'Item inválido.' });
    done(res, await buySnack(row.username, item));
  }));
  app.post('/api/sk2/hospital/service/donate', json, guard(async (_q, res, row) => done(res, await donateBlood(row.username))));
}

module.exports = {
  HOSPITAL, RISKS, EXAMS, DISEASES, SCALE, init, registerRoutes, workGate, sweepExams, summary, settle,
  checkin, triage, consult, collectExam, results, setPlan, session, leave, buyPlan, vaccinate, donateBlood, buySnack, SNACKS, snackStatus,
  // puras (testes)
  weightedPick, rollIllness, discountPrice, donateStatus, canRenew, effectiveSeverity, settleHealth, makeVitals, vitalFlags, triageWaitMs, examDurationMs, plansFor, hypotheses, stageInfo, examSite,
};
