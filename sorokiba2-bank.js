'use strict';
// Sorokiba 2 – Banco. Mesma lógica do condomínio: tudo é validado e gravado no servidor,
// o dinheiro só muda dentro de transação (FOR UPDATE) e o painel é aberto pelos NPCs/pontos do prédio.
// Tabelas próprias (sk2_bank_*): não altera nenhuma tabela de outro sistema.
const crypto = require('crypto');
const db = require('./sorokiba2-db');

/* ---------- regras (ajuste aqui) ---------- */
const BANK = Object.freeze({
  MAX_MONEY: 2147483647,        // limite do INT da carteira (sk2_players.money)
  SAVINGS_MAX: 1000000,         // teto da poupança
  INTEREST_BP_PER_DAY: 50,      // 0,5% ao dia (100 bp = 1%), só por dia completo
  INTEREST_BASE_MAX: 50000,     // o rendimento incide sobre no máximo este valor
  INTEREST_MAX_DAYS: 30,        // dias acumulados por visita (evita "banco esquecido" render sem fim)
  TRANSFER_MIN_XP: 100,         // contas novas não transferem (freia contas "laranja")
  TRANSFER_DAILY_LIMIT: 5000,   // por 24 h
  TRANSFER_FEE_BP: 200,         // tarifa de 2% (queimada: sai da economia)
  TRANSFER_FEE_MIN: 1,
  LOAN_MIN: 100, LOAN_MAX: 5000, LOAN_BASE: 300, LOAN_PER_XP: 5, LOAN_MIN_XP: 100,
  LOAN_BASE_RATE_BP: 1200,      // taxa de tabela: 12%
  LOAN_MIN_RATE_BP: 600,        // abaixo disso a gerente recusa na hora
  LOAN_TERM_DAYS: 7,
  NEGOTIATION_ROUNDS: 5,
  LEDGER_LIMIT: 20,
});

// sign: efeito no dinheiro da CARTEIRA (exceto rendimento, que cai na poupança)
const KINDS = Object.freeze({
  deposit: { label: 'Depósito na poupança', sign: -1 },
  withdraw: { label: 'Saque da poupança', sign: 1 },
  interest: { label: 'Rendimento da poupança', sign: 1, where: 'poupança' },
  transfer_out: { label: 'Transferência enviada', sign: -1 },
  transfer_in: { label: 'Transferência recebida', sign: 1 },
  transfer_fee: { label: 'Tarifa de transferência', sign: -1 },
  loan_in: { label: 'Empréstimo liberado', sign: 1 },
  loan_pay: { label: 'Pagamento de empréstimo', sign: -1 },
  loan_auto: { label: 'Cobrança automática do empréstimo', sign: -1 },
});

/* ---------- funções puras (testadas em test/bank.test.js) ---------- */
const toInt = v => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) ? n : null;
};
const amountOf = (v, max) => { const n = toInt(v); return n !== null && n >= 1 && n <= max ? n : null; };
const transferFee = amount => Math.max(BANK.TRANSFER_FEE_MIN, Math.ceil(amount * BANK.TRANSFER_FEE_BP / 10000));
function interestFor(savings, days) {
  const d = Math.min(Math.max(0, Math.floor(days) || 0), BANK.INTEREST_MAX_DAYS);
  const base = Math.min(Math.max(0, savings), BANK.INTEREST_BASE_MAX);
  const raw = Math.floor(base * BANK.INTEREST_BP_PER_DAY * d / 10000);
  return Math.max(0, Math.min(raw, BANK.SAVINGS_MAX - savings));
}
const loanLimit = xp => (Number(xp) || 0) < BANK.LOAN_MIN_XP ? 0
  : Math.min(BANK.LOAN_MAX, Math.floor((BANK.LOAN_BASE + xp * BANK.LOAN_PER_XP) / 50) * 50);
const loanTotal = (principal, rateBp) => principal + Math.ceil(principal * rateBp / 10000);

// Negociação da taxa com a gerente (mesmo desenho da negociação do condomínio)
function makeDeal(amount, now, rand = Math.random) {
  const lo = BANK.LOAN_MIN_RATE_BP + 100, hi = BANK.LOAN_BASE_RATE_BP - 300;
  return { amount, ask: BANK.LOAN_BASE_RATE_BP, reserve: lo + Math.floor(rand() * (hi - lo + 1)), rounds: 0, accepted: null, expires: now + 15 * 60e3 };
}
function stepDeal(deal, { offer, accept } = {}) {
  const left = () => BANK.NEGOTIATION_ROUNDS - deal.rounds;
  if (accept) { deal.accepted = deal.ask; return { result: 'deal', rate: deal.accepted }; }
  const o = toInt(offer);
  if (!o) return { result: 'start', ask: deal.ask, remaining: left() };
  if (deal.rounds >= BANK.NEGOTIATION_ROUNDS) return { result: 'final', ask: deal.ask, remaining: 0 };
  deal.rounds++;
  if (o >= deal.reserve) { deal.accepted = Math.min(o, deal.ask); return { result: 'deal', rate: deal.accepted }; }
  if (o < BANK.LOAN_MIN_RATE_BP) return { result: 'low', ask: deal.ask, remaining: left() };
  deal.ask = Math.max(deal.reserve, Math.round(deal.ask - (deal.ask - o) * .4));
  return { result: deal.rounds >= BANK.NEGOTIATION_ROUNDS ? 'final' : 'counter', ask: deal.ask, remaining: left() };
}

/* ---------- banco de dados ---------- */
async function init() {
  await db.query(`CREATE TABLE IF NOT EXISTS sk2_bank_accounts (
    username TEXT PRIMARY KEY REFERENCES sk2_players(username) ON DELETE CASCADE,
    savings INT NOT NULL DEFAULT 0 CHECK (savings >= 0),
    interest_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS sk2_bank_ledger (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    kind TEXT NOT NULL, amount INT NOT NULL, savings_after INT NOT NULL, money_after INT NOT NULL,
    peer TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS sk2_bank_ledger_user ON sk2_bank_ledger(username, id DESC);
  CREATE TABLE IF NOT EXISTS sk2_bank_loans (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL REFERENCES sk2_players(username) ON DELETE CASCADE,
    principal INT NOT NULL, rate_bp INT NOT NULL, total_due INT NOT NULL,
    paid INT NOT NULL DEFAULT 0 CHECK (paid >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid')),
    due_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
  CREATE UNIQUE INDEX IF NOT EXISTS sk2_one_active_loan ON sk2_bank_loans(username) WHERE status='active';
  CREATE INDEX IF NOT EXISTS sk2_loans_overdue ON sk2_bank_loans(due_at) WHERE status='active';`);
}

const fail = (err, status = 409) => ({ err, status });
const brl = n => 'R$ ' + Number(n).toLocaleString('pt-BR');

async function ledger(c, { username, kind, amount, savings, money, peer = null, note = null }) {
  await c.query(`INSERT INTO sk2_bank_ledger (username, kind, amount, savings_after, money_after, peer, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [username, kind, amount, savings, money, peer, note]);
}
const savingsOf = async (c, username) =>
  (await c.query('SELECT savings FROM sk2_bank_accounts WHERE username=$1', [username])).rows[0]?.savings ?? 0;

// Prelúdio de toda operação: abre a conta, credita o rendimento dos dias completos e cobra empréstimo vencido.
async function prep(c, player) {
  await c.query('INSERT INTO sk2_bank_accounts (username) VALUES ($1) ON CONFLICT DO NOTHING', [player.username]);
  let acc = (await c.query(`SELECT username, savings, interest_at,
      floor(extract(epoch FROM (now() - interest_at)) / 86400)::int AS days
    FROM sk2_bank_accounts WHERE username=$1 FOR UPDATE`, [player.username])).rows[0];
  if (acc.days >= 1) {
    const gain = interestFor(acc.savings, acc.days);
    acc = (await c.query(`UPDATE sk2_bank_accounts SET savings = savings + $2, interest_at = interest_at + make_interval(days => $3)
      WHERE username=$1 RETURNING username, savings, interest_at`, [player.username, gain, acc.days])).rows[0];
    if (gain > 0) await ledger(c, { username: player.username, kind: 'interest', amount: gain, savings: acc.savings, money: player.money });
  }
  const loan = (await c.query(`SELECT * FROM sk2_bank_loans WHERE username=$1 AND status='active' AND due_at < now() FOR UPDATE`, [player.username])).rows[0];
  if (loan) {
    const owed = loan.total_due - loan.paid;
    const fromSavings = Math.min(acc.savings, owed), fromMoney = Math.min(player.money, owed - fromSavings), taken = fromSavings + fromMoney;
    if (taken > 0) {
      acc = (await c.query('UPDATE sk2_bank_accounts SET savings = savings - $2 WHERE username=$1 RETURNING username, savings, interest_at', [player.username, fromSavings])).rows[0];
      player = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [player.username, fromMoney])).rows[0];
      const paid = loan.paid + taken, done = paid >= loan.total_due;
      await c.query(`UPDATE sk2_bank_loans SET paid=$2, status=$3::text, closed_at = CASE WHEN $3::text='paid' THEN now() ELSE NULL END WHERE id=$1`,
        [loan.id, paid, done ? 'paid' : 'active']);
      await ledger(c, { username: player.username, kind: 'loan_auto', amount: taken, savings: acc.savings, money: player.money, note: done ? 'Dívida quitada' : 'Ainda resta saldo devedor' });
    }
  }
  return { player, acc };
}

async function snapshot(c, player, acc) {
  const u = player.username, xp = Number(player.xp) || 0;
  const loan = (await c.query(`SELECT principal, rate_bp, total_due, paid, due_at, (due_at < now()) AS overdue
    FROM sk2_bank_loans WHERE username=$1 AND status='active'`, [u])).rows[0] || null;
  const used = (await c.query(`SELECT COALESCE(SUM(amount),0)::int AS n FROM sk2_bank_ledger
    WHERE username=$1 AND kind='transfer_out' AND created_at > now() - interval '24 hours'`, [u])).rows[0].n;
  const rows = (await c.query(`SELECT id, kind, amount, savings_after, peer, note, created_at FROM sk2_bank_ledger
    WHERE username=$1 ORDER BY id DESC LIMIT $2`, [u, BANK.LEDGER_LIMIT])).rows;
  return {
    playerRow: player,
    bank: {
      savings: acc.savings,
      interest: { bpPerDay: BANK.INTEREST_BP_PER_DAY, baseMax: BANK.INTEREST_BASE_MAX, savingsMax: BANK.SAVINGS_MAX },
      transfer: { minXp: BANK.TRANSFER_MIN_XP, locked: xp < BANK.TRANSFER_MIN_XP, dailyLimit: BANK.TRANSFER_DAILY_LIMIT, usedToday: used, feeBp: BANK.TRANSFER_FEE_BP, feeMin: BANK.TRANSFER_FEE_MIN },
      loan: {
        active: loan && { principal: loan.principal, rateBp: loan.rate_bp, totalDue: loan.total_due, paid: loan.paid, owed: loan.total_due - loan.paid, dueAt: loan.due_at, overdue: !!loan.overdue },
        limit: loanLimit(xp), minAmount: BANK.LOAN_MIN, minXp: BANK.LOAN_MIN_XP,
        baseRateBp: BANK.LOAN_BASE_RATE_BP, minRateBp: BANK.LOAN_MIN_RATE_BP, termDays: BANK.LOAN_TERM_DAYS,
      },
      ledger: rows.map(r => ({ id: String(r.id), label: KINDS[r.kind]?.label || r.kind, sign: KINDS[r.kind]?.sign || 1, where: KINDS[r.kind]?.where || 'carteira',
        amount: r.amount, savingsAfter: r.savings_after, peer: r.peer, note: r.note, at: r.created_at })),
    },
  };
}

// Executa uma operação de uma conta: trava a linha do jogador, prepara a conta, roda `fn` e devolve o extrato novo.
const run = (username, fn) => db.withTx(async c => {
  const locked = (await c.query('SELECT * FROM sk2_players WHERE username=$1 FOR UPDATE', [username])).rows[0];
  if (!locked) return fail('Jogador não encontrado', 404);
  const base = await prep(c, locked);
  const out = await fn(c, base.player, base.acc);
  if (out.err) return out;
  return { ...out, ...(await snapshot(c, out.player || base.player, out.acc || base.acc)) };
});
const noop = (_c, player, acc) => ({ player, acc });

const summary = username => run(username, noop);

const deposit = (username, amount) => run(username, async (c, p, a) => {
  if (p.money < amount) return fail('Você não tem esse dinheiro na carteira.');
  if (a.savings + amount > BANK.SAVINGS_MAX) return fail(`A poupança aceita no máximo ${brl(BANK.SAVINGS_MAX)}.`);
  const acc = (await c.query('UPDATE sk2_bank_accounts SET savings = savings + $2 WHERE username=$1 RETURNING username, savings, interest_at', [username, amount])).rows[0];
  const player = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [username, amount])).rows[0];
  await ledger(c, { username, kind: 'deposit', amount, savings: acc.savings, money: player.money });
  return { player, acc };
});

const withdraw = (username, amount) => run(username, async (c, p, a) => {
  if (a.savings < amount) return fail('Saldo insuficiente na poupança.');
  if (p.money + amount > BANK.MAX_MONEY) return fail('Sua carteira não comporta esse valor.');
  const acc = (await c.query('UPDATE sk2_bank_accounts SET savings = savings - $2 WHERE username=$1 RETURNING username, savings, interest_at', [username, amount])).rows[0];
  const player = (await c.query('UPDATE sk2_players SET money = money + $2 WHERE username=$1 RETURNING *', [username, amount])).rows[0];
  await ledger(c, { username, kind: 'withdraw', amount, savings: acc.savings, money: player.money });
  return { player, acc };
});

const transfer = (from, toRaw, amount) => db.withTx(async c => {
  const to = String(toRaw || '').trim().toLowerCase();
  if (!db.validName(to)) return fail('Informe o nome de usuário do destinatário.', 400);
  if (to === from) return fail('Você não pode transferir para você mesmo.', 400);
  // trava os dois jogadores sempre na mesma ordem (evita deadlock entre transferências cruzadas)
  const locked = (await c.query('SELECT * FROM sk2_players WHERE username = ANY($1::text[]) ORDER BY username FOR UPDATE', [[from, to]])).rows;
  const sender = locked.find(r => r.username === from), receiver = locked.find(r => r.username === to);
  if (!sender) return fail('Jogador não encontrado', 404);
  if (!receiver) return fail('Destinatário não encontrado.', 404);
  const base = await prep(c, sender);
  if (Number(base.player.xp) < BANK.TRANSFER_MIN_XP) return fail(`Transferências exigem ${BANK.TRANSFER_MIN_XP} XP.`, 403);
  const used = (await c.query(`SELECT COALESCE(SUM(amount),0)::int AS n FROM sk2_bank_ledger
    WHERE username=$1 AND kind='transfer_out' AND created_at > now() - interval '24 hours'`, [from])).rows[0].n;
  if (used + amount > BANK.TRANSFER_DAILY_LIMIT) return fail(`Limite diário de ${brl(BANK.TRANSFER_DAILY_LIMIT)} (restam ${brl(Math.max(0, BANK.TRANSFER_DAILY_LIMIT - used))}).`);
  const fee = transferFee(amount);
  if (base.player.money < amount + fee) return fail(`Saldo insuficiente: o valor mais a tarifa somam ${brl(amount + fee)}.`);
  if (receiver.money + amount > BANK.MAX_MONEY) return fail('A carteira do destinatário não comporta esse valor.');
  const player = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [from, amount + fee])).rows[0];
  const got = (await c.query('UPDATE sk2_players SET money = money + $2 WHERE username=$1 RETURNING money', [to, amount])).rows[0];
  await ledger(c, { username: from, kind: 'transfer_out', amount, savings: base.acc.savings, money: player.money + fee, peer: receiver.name });
  await ledger(c, { username: from, kind: 'transfer_fee', amount: fee, savings: base.acc.savings, money: player.money, peer: receiver.name });
  await ledger(c, { username: to, kind: 'transfer_in', amount, savings: await savingsOf(c, to), money: got.money, peer: sender.name });
  return { ...(await snapshot(c, player, base.acc)), amount, fee, toUser: to, toName: receiver.name, toMoney: got.money, fromName: sender.name };
});

const takeLoan = (username, amount, rateBp) => run(username, async (c, p) => {
  const xp = Number(p.xp) || 0, limit = loanLimit(xp);
  if (xp < BANK.LOAN_MIN_XP) return fail(`Empréstimos exigem ${BANK.LOAN_MIN_XP} XP.`, 403);
  if (amount < BANK.LOAN_MIN || amount > limit) return fail(`Seu limite agora é de ${brl(BANK.LOAN_MIN)} a ${brl(limit)}.`);
  if (!Number.isInteger(rateBp) || rateBp < BANK.LOAN_MIN_RATE_BP || rateBp > BANK.LOAN_BASE_RATE_BP) return fail('Taxa inválida.', 400);
  const has = await c.query(`SELECT 1 FROM sk2_bank_loans WHERE username=$1 AND status='active'`, [username]);
  if (has.rowCount) return fail('Você já tem um empréstimo ativo. Quite-o antes de pedir outro.');
  if (p.money + amount > BANK.MAX_MONEY) return fail('Sua carteira não comporta esse valor.');
  const total = loanTotal(amount, rateBp);
  await c.query(`INSERT INTO sk2_bank_loans (id, username, principal, rate_bp, total_due, due_at)
    VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))`, [crypto.randomUUID(), username, amount, rateBp, total, BANK.LOAN_TERM_DAYS]);
  const player = (await c.query('UPDATE sk2_players SET money = money + $2 WHERE username=$1 RETURNING *', [username, amount])).rows[0];
  const acc = { username, savings: await savingsOf(c, username) };
  await ledger(c, { username, kind: 'loan_in', amount, savings: acc.savings, money: player.money, note: `Taxa ${rateBp / 100}% · total ${brl(total)}` });
  return { player, acc, total };
});

const repayLoan = (username, amount) => run(username, async (c, p, a) => {
  const loan = (await c.query(`SELECT * FROM sk2_bank_loans WHERE username=$1 AND status='active' FOR UPDATE`, [username])).rows[0];
  if (!loan) return fail('Você não tem empréstimo ativo.');
  const owed = loan.total_due - loan.paid;
  if (amount > owed) return fail(`Você deve ${brl(owed)}; informe até esse valor.`);
  if (p.money < amount) return fail('Você não tem esse dinheiro na carteira.');
  const player = (await c.query('UPDATE sk2_players SET money = money - $2 WHERE username=$1 RETURNING *', [username, amount])).rows[0];
  const paid = loan.paid + amount, done = paid >= loan.total_due;
  await c.query(`UPDATE sk2_bank_loans SET paid=$2, status=$3::text, closed_at = CASE WHEN $3::text='paid' THEN now() ELSE NULL END WHERE id=$1`,
    [loan.id, paid, done ? 'paid' : 'active']);
  await ledger(c, { username, kind: 'loan_pay', amount, savings: a.savings, money: player.money, note: done ? 'Dívida quitada' : `Resta ${brl(owed - amount)}` });
  return { player, acc: a, done };
});

// Empréstimos vencidos são cobrados mesmo de quem nunca mais entra no banco.
async function sweepOverdue(limit = 50) {
  const r = await db.query(`SELECT username FROM sk2_bank_loans WHERE status='active' AND due_at < now() ORDER BY due_at LIMIT $1`, [limit]);
  for (const { username } of r.rows) {
    await db.withTx(async c => {
      const p = (await c.query('SELECT * FROM sk2_players WHERE username=$1 FOR UPDATE', [username])).rows[0];
      if (p) await prep(c, p);
      return {};
    });
  }
  return r.rowCount;
}
const activeLoan = async username => (await db.query(`SELECT 1 FROM sk2_bank_loans WHERE username=$1 AND status='active'`, [username])).rowCount > 0;

/* ---------- rotas ---------- */
function registerRoutes({ app, json, authUser, limited, userTries, addInterval, notify = () => {} }) {
  const deals = new Map();
  addInterval(() => { const now = Date.now(); for (const [k, d] of deals) if (d.expires < now) deals.delete(k); }, 5 * 60e3);
  addInterval(() => { sweepOverdue().catch(e => console.error('[sk2] banco (cobrança):', e.message)); }, 10 * 60e3);

  const guard = (fn, { bucket = 'bank', max = 60, message = 'Muitas ações no banco. Aguarde um minuto.' } = {}) => async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      if (limited(userTries, `${bucket}:${row.username}`, max)) return res.status(429).json({ err: message });
      await fn(req, res, row);
    } catch (e) {
      console.error('[sk2] banco:', e.message);
      if (!res.headersSent) res.status(500).json({ err: 'Não foi possível concluir a operação bancária.' });
    }
  };
  const done = (res, r, extra = {}) => {
    if (r.err) return res.status(r.status || 409).json({ err: r.err });
    res.json({ ok: 1, player: db.pub(r.playerRow), bank: r.bank, ...extra });
  };
  const badAmount = res => res.status(400).json({ err: 'Informe um valor inteiro maior que zero.' });

  app.get('/api/sk2/bank', guard(async (_req, res, row) => {
    res.set('Cache-Control', 'no-store');
    done(res, await summary(row.username));
  }));
  app.post('/api/sk2/bank/deposit', json, guard(async (req, res, row) => {
    const amount = amountOf(req.body?.amount, BANK.MAX_MONEY); if (!amount) return badAmount(res);
    const r = await deposit(row.username, amount);
    done(res, r, { message: `${brl(amount)} depositados na poupança.` });
  }));
  app.post('/api/sk2/bank/withdraw', json, guard(async (req, res, row) => {
    const amount = amountOf(req.body?.amount, BANK.MAX_MONEY); if (!amount) return badAmount(res);
    const r = await withdraw(row.username, amount);
    done(res, r, { message: `${brl(amount)} sacados da poupança.` });
  }));
  app.post('/api/sk2/bank/transfer', json, guard(async (req, res, row) => {
    const amount = amountOf(req.body?.amount, BANK.MAX_MONEY); if (!amount) return badAmount(res);
    const r = await transfer(row.username, req.body?.to, amount);
    if (!r.err) notify(r.toUser, { t: 'bank', m: `${r.fromName} enviou ${brl(amount)} para você pelo banco.`, money: r.toMoney });
    done(res, r, { message: `${brl(amount)} enviados para ${r.toName}. Tarifa: ${brl(r.fee)}.` });
  }, { bucket: 'bankx', max: 10, message: 'Muitas transferências seguidas. Aguarde um minuto.' }));

  app.post('/api/sk2/bank/loan/negotiate', json, guard(async (req, res, row) => {
    const xp = Number(row.xp) || 0, amount = amountOf(req.body?.amount, BANK.LOAN_MAX);
    if (!amount) return badAmount(res);
    if (xp < BANK.LOAN_MIN_XP) return res.status(403).json({ err: `Empréstimos exigem ${BANK.LOAN_MIN_XP} XP.` });
    if (amount < BANK.LOAN_MIN || amount > loanLimit(xp)) return res.status(409).json({ err: `Seu limite agora é de ${brl(BANK.LOAN_MIN)} a ${brl(loanLimit(xp))}.` });
    if (await activeLoan(row.username)) return res.status(409).json({ err: 'Você já tem um empréstimo ativo.' });
    const now = Date.now();
    let deal = deals.get(row.username);
    if (!deal || deal.expires < now || deal.amount !== amount) { deal = makeDeal(amount, now); deals.set(row.username, deal); }
    deal.expires = now + 15 * 60e3;
    const step = stepDeal(deal, { offer: req.body?.offer, accept: !!req.body?.accept });
    res.json({ ok: 1, amount, total: step.rate ? loanTotal(amount, step.rate) : undefined, ...step });
  }));
  app.post('/api/sk2/bank/loan/take', json, guard(async (req, res, row) => {
    const amount = amountOf(req.body?.amount, BANK.LOAN_MAX); if (!amount) return badAmount(res);
    const deal = deals.get(row.username);
    const rate = req.body?.deal && deal && deal.amount === amount && deal.accepted && deal.expires > Date.now() ? deal.accepted : BANK.LOAN_BASE_RATE_BP;
    const r = await takeLoan(row.username, amount, rate);
    if (!r.err) deals.delete(row.username);
    done(res, r, { message: `${brl(amount)} liberados. Você devolve ${brl(r.total)} em até ${BANK.LOAN_TERM_DAYS} dias.` });
  }));
  app.post('/api/sk2/bank/loan/repay', json, guard(async (req, res, row) => {
    const amount = amountOf(req.body?.amount, BANK.MAX_MONEY); if (!amount) return badAmount(res);
    const r = await repayLoan(row.username, amount);
    done(res, r, { message: r.done ? 'Empréstimo quitado!' : `${brl(amount)} pagos.` });
  }));
}

module.exports = {
  BANK, KINDS, init, registerRoutes, sweepOverdue, summary, deposit, withdraw, transfer, takeLoan, repayLoan,
  // puras (testes)
  toInt, amountOf, transferFee, interestFor, loanLimit, loanTotal, makeDeal, stepDeal,
};
