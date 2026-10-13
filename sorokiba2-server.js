'use strict';
// Sorokiba 2 – servidor online. Encaixa no seu server.js com 2 linhas (veja LEIA-ME no chat).
// Leve de propósito (plano grátis 512 MB): o servidor só repassa posições e chat; carros e moradores são desenhados em cada navegador.
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./sorokiba2-db');

const MW = 96, MH = 68, MAX_PLAYERS = 60;

function attachSorokiba2(app, server, opt = {}) {
  if (opt.pool) db.setPool(opt.pool);
  const htmlFile = opt.htmlFile || path.join(__dirname, 'sorokiba2.html');
  db.init().then(() => console.log('[sk2] banco pronto')).catch(e => console.error('[sk2] erro no banco:', e.message));

  /* ---------- páginas e contas ---------- */
  const json = express.json({ limit: '8kb' });
  const tries = new Map();
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const limited = ip => { const n = Date.now(), a = (tries.get(ip) || []).filter(t => n - t < 6e4); a.push(n); tries.set(ip, a); return a.length > 10; };
  setInterval(() => { const n = Date.now(); for (const [k, a] of tries) if (!a.some(t => n - t < 6e4)) tries.delete(k); }, 6e4).unref();

  app.get(['/', '/sorokiba2', '/sorokiba2.html'], (req, res) => res.sendFile(htmlFile));

  const reply = (res, row) => res.json({ ok: 1, token: db.sign(row.username), player: db.pub(row) });
  const check = (req, res) => {
    const { name, pass } = req.body || {};
    if (limited(ipOf(req))) { res.status(429).json({ err: 'Muitas tentativas. Aguarde um minuto.' }); return null; }
    if (!db.validName(name)) { res.status(400).json({ err: 'Usuário: 3 a 14 letras, números ou _' }); return null; }
    if (!db.validPass(pass)) { res.status(400).json({ err: 'A senha precisa ter de 4 a 64 caracteres' }); return null; }
    return { name, pass };
  };
  app.post('/api/sk2/register', json, async (req, res) => {
    const c = check(req, res); if (!c) return;
    try { reply(res, await db.register(c.name, c.pass, req.body.look)); }
    catch (e) { res.status(e.status || 500).json({ err: e.status ? e.message : 'Erro no servidor' }); if (!e.status) console.error('[sk2]', e.message); }
  });
  app.post('/api/sk2/login', json, async (req, res) => {
    const c = check(req, res); if (!c) return;
    try { const row = await db.login(c.name, c.pass); row ? reply(res, row) : res.status(401).json({ err: 'Usuário ou senha incorretos' }); }
    catch (e) { res.status(500).json({ err: 'Erro no servidor' }); console.error('[sk2]', e.message); }
  });

  /* ---------- mundo online (WebSocket) ---------- */
  const wss = new WebSocketServer({ server, path: '/sk2ws', maxPayload: 1024 });
  const P = new Map();               // id -> jogador conectado
  let nid = 1;
  const pub = o => ({ id: o.id, n: o.n, x: o.x, y: o.y, lk: o.lk });
  const send = (o, m) => { if (o.ws.readyState === 1) o.ws.send(JSON.stringify(m)); };
  const toAll = (m, except) => { const s = JSON.stringify(m); for (const o of P.values()) if (o !== except && o.ws.readyState === 1) o.ws.send(s); };
  const flush = list => db.savePositions(list.map(o => ({ u: o.u, x: o.x, y: o.y }))).catch(e => console.error('[sk2] salvar:', e.message));

  wss.on('connection', ws => {
    let me = null, joining = false;
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    const timer = setTimeout(() => { if (!me) ws.close(); }, 8000);
    ws.on('error', () => {});
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (!me) {
        if (m.t !== 'hi' || joining) return;
        joining = true;
        const u = db.verifyToken(m.token);
        if (!u) return ws.close();
        if (P.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'f' })); return ws.close(); }
        let row; try { row = await db.load(u); } catch (e) { return ws.close(); }
        if (!row) return ws.close();
        for (const o of [...P.values()]) if (o.u === u) { P.delete(o.id); flush([o]); toAll({ t: 'l', id: o.id }); o.ws.close(); }   // um login por conta
        me = { id: nid++, u, n: row.name, lk: { ...db.cleanLook(row.look), role: row.role }, x: row.x, y: row.y, d: 0, f: 0, ws, dirty: false, moved: false, lc: 0, last: Date.now() };
        send(me, { t: 'r', id: me.id, p: [...P.values()].map(pub) });
        toAll({ t: 'j', p: pub(me) }, me);
        P.set(me.id, me);
        return;
      }
      if (m.t === 'p') {
        const x = +m.x, y = +m.y, now = Date.now(), dt = Math.max(.05, (now - me.last) / 1000);
        if (!(x > 0 && x < MW && y > 0 && y < MH)) return;
        if (Math.hypot(x - me.x, y - me.y) > 8 * dt + 2) return;       // limite de velocidade
        me.x = x; me.y = y; me.d = (m.d | 0) & 3; me.f = (m.f | 0) & 3; me.last = now; me.dirty = true; me.moved = true;
      } else if (m.t === 'c') {
        const now = Date.now(); if (now - me.lc < 1200) return; me.lc = now;
        const msg = String(m.m || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!msg) return;
        const s = JSON.stringify({ t: 'c', id: me.id, n: me.n, m: msg });
        for (const o of P.values()) if (Math.hypot(o.x - me.x, o.y - me.y) < 30 && o.ws.readyState === 1) o.ws.send(s);
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (me && P.get(me.id) === me) { P.delete(me.id); flush([me]); toAll({ t: 'l', id: me.id }); }
    });
  });

  // 5 vezes por segundo: manda só quem se mexeu
  setInterval(() => {
    const moved = [...P.values()].filter(o => o.moved);
    if (!moved.length) return;
    const all = moved.map(o => [o.id, Math.round(o.x * 100), Math.round(o.y * 100), o.d, o.f]);
    for (const o of P.values()) {
      const p = all.filter(a => a[0] !== o.id);
      if (p.length) send(o, { t: 's', p });
    }
    moved.forEach(o => { o.moved = false; });
  }, 200);

  // a cada 20 s: grava posições no banco (uma consulta só)
  setInterval(() => {
    const d = [...P.values()].filter(o => o.dirty);
    d.forEach(o => { o.dirty = false; });
    flush(d);
  }, 20000);

  // mantém as conexões vivas e derruba as mortas
  setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 25000);

  // ao reiniciar (deploy), salva todo mundo antes de sair
  process.once('SIGTERM', () => { flush([...P.values()]).finally(() => process.exit(0)); });

  return { online: () => P.size };
}

module.exports = { attachSorokiba2 };
