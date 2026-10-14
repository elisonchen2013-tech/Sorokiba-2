'use strict';
// Sorokiba 2 – servidor online. Encaixa no seu server.js com 2 linhas (veja LEIA-ME no chat).
// Leve de propósito (plano grátis 512 MB): o servidor só repassa posições e chat; carros e moradores são desenhados em cada navegador.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./sorokiba2-db');

const MW = 96, MH = 84, MAX_PLAYERS = 60;
const MAX_CONNECTIONS = 120, MAX_CONNECTIONS_PER_IP = 8;
const MISSIONS = Object.freeze({
  welcome: { event: 'npc:kiba', money: 250, xp: 100, label: 'Fale com Kiba' },
  hospital_visit: { event: 'building:✚ Hospital', money: 150, xp: 60, label: 'Visite o Hospital' },
  cityhall_notice: { event: 'spot:Prefeitura:Quadro de avisos', money: 200, xp: 80, label: 'Leia o quadro da Prefeitura' },
  library_visit: { event: 'building:Biblioteca', money: 150, xp: 60, label: 'Visite a Biblioteca' },
});
const CAREERS = Object.freeze([
  { id: 'hospital_reception', title: 'Recepcionista hospitalar', profession: 'Recepcionista', building: '✚ Hospital', skills: ['atendimento'], minExperience: 0, minXp: 100, vacancies: 2 },
  { id: 'library_assistant', title: 'Assistente de biblioteca', profession: 'Bibliotecária', building: 'Biblioteca', skills: ['organizacao'], minExperience: 0, minXp: 100, vacancies: 1 },
  { id: 'mechanic', title: 'Mecânico de oficina', profession: 'Mecânico', building: 'Oficina', skills: ['manutencao'], minExperience: 1, minXp: 250, vacancies: 1 },
  { id: 'restaurant_server', title: 'Atendente de restaurante', profession: 'Garçom', building: 'Restaurante', skills: ['atendimento'], minExperience: 0, minXp: 100, vacancies: 2 },
  { id: 'electrician', title: 'Eletricista de manutenção', profession: 'Eletricista', building: 'Fábrica', skills: ['manutencao'], minExperience: 1, minXp: 300, vacancies: 1 },
  { id: 'courier', title: 'Entregador urbano', profession: 'Entregador', building: 'Rodoviária', skills: ['organizacao'], minExperience: 0, minXp: 0, vacancies: 2 },
  { id: 'fastfood_counter', title: 'Atendente de fast-food', profession: 'Atendente de fast-food', building: 'Restaurante', skills: ['atendimento', 'organizacao'], minExperience: 0, minXp: 50, vacancies: 2 },
  { id: 'teacher_assistant', title: 'Assistente escolar', profession: 'Professor', building: 'Escola', skills: ['organizacao', 'comunicacao'], minExperience: 2, minXp: 400, vacancies: 1 },
]);
const CAREER_SKILLS = Object.freeze({
  atendimento: { label: 'Atendimento ao público', unlockXp: 0 },
  organizacao: { label: 'Organização', unlockXp: 0 },
  comunicacao: { label: 'Comunicação', unlockXp: 100 },
  manutencao: { label: 'Manutenção', unlockXp: 100 },
});
const INTERVIEW_QUESTIONS = Object.freeze({
  hospital_reception: [
    { id: 'greeting', prompt: 'Como você recebe um paciente nervoso?', options: ['Ignoro para ganhar tempo', 'Ouço, acolho e encaminho com clareza', 'Peço que volte outro dia'], correct: 1 },
    { id: 'privacy', prompt: 'O que fazer com dados de um paciente?', options: ['Compartilhar no chat', 'Guardar e compartilhar apenas com a equipe autorizada', 'Publicar no mural'], correct: 1 },
    { id: 'queue', prompt: 'A fila está atrasada. Qual é a melhor atitude?', options: ['Informar a situação e reorganizar prioridades', 'Esconder a fila', 'Atender apenas conhecidos'], correct: 0 },
  ],
  library_assistant: [
    { id: 'catalog', prompt: 'Como organizar livros recém-chegados?', options: ['Por cor apenas', 'Registrar e classificar no catálogo', 'Deixar em qualquer estante'], correct: 1 },
    { id: 'silence', prompt: 'Um visitante faz barulho. O que fazer?', options: ['Orientar com respeito', 'Expulsar sem conversar', 'Desligar as luzes'], correct: 0 },
    { id: 'search', prompt: 'Alguém procura um livro sem saber o título.', options: ['Fazer perguntas e buscar por assunto/autor', 'Dizer que não existe', 'Mandar procurar sozinho'], correct: 0 },
  ],
  mechanic: [
    { id: 'diagnosis', prompt: 'Antes de reparar uma máquina, você deve:', options: ['Diagnosticar e isolar o risco', 'Trocar qualquer peça', 'Acelerar o motor'], correct: 0 },
    { id: 'tools', prompt: 'Uma ferramenta está danificada. Você:', options: ['Usa assim mesmo', 'Sinaliza e substitui com segurança', 'Esconde na oficina'], correct: 1 },
    { id: 'customer', prompt: 'Como explicar um reparo ao cliente?', options: ['Usar termos claros e informar o custo', 'Não explicar nada', 'Prometer resultado impossível'], correct: 0 },
  ],
  restaurant_server: [
    { id: 'order', prompt: 'Como confirmar um pedido?', options: ['Repetir o pedido e as restrições', 'Adivinhar', 'Mandar o cliente para a cozinha'], correct: 0 },
    { id: 'rush', prompt: 'Durante o movimento, a prioridade é:', options: ['Organizar a fila e comunicar atrasos', 'Ignorar mesas', 'Servir apenas pedidos fáceis'], correct: 0 },
    { id: 'mistake', prompt: 'Um pedido saiu errado. Você:', options: ['Assume, corrige e informa o cliente', 'Culpa o cliente', 'Apaga o pedido'], correct: 0 },
  ],
  teacher_assistant: [
    { id: 'classroom', prompt: 'Uma turma está dispersa. Você:', options: ['Define uma instrução clara e uma atividade', 'Grita sem explicar', 'Cancela a aula'], correct: 0 },
    { id: 'inclusion', prompt: 'Um aluno precisa de apoio extra. Você:', options: ['Adapta a explicação e pede suporte', 'Ignora', 'Expõe o aluno'], correct: 0 },
    { id: 'planning', prompt: 'Para preparar uma aula, é importante:', options: ['Planejar objetivo, materiais e acompanhamento', 'Improvisar sempre', 'Evitar feedback'], correct: 0 },
  ],
  electrician: [
    { id: 'isolate', prompt: 'Antes de uma inspeção fictícia, qual é a atitude segura?', options: ['Isolar a área e seguir o procedimento do supervisor', 'Tocar no painel para testar', 'Pular a inspeção'], correct: 0 },
    { id: 'component', prompt: 'Qual componente o supervisor pediu para identificar?', options: ['Sinalizador azul', 'Componente vermelho indicado no roteiro', 'Qualquer fio'], correct: 1 },
    { id: 'report', prompt: 'Como registrar o resultado?', options: ['Relatar observações sem improvisar reparos', 'Esconder a falha', 'Alterar o relatório'], correct: 0 },
  ],
  courier: [
    { id: 'route', prompt: 'Como escolher uma rota de entrega?', options: ['Conferir destino e planejar a rota', 'Sair sem endereço', 'Entregar ao primeiro prédio'], correct: 0 },
    { id: 'package', prompt: 'Antes de sair com a encomenda, você deve:', options: ['Conferir identificação e integridade da embalagem', 'Abrir a embalagem', 'Trocar a etiqueta'], correct: 0 },
    { id: 'handoff', prompt: 'Na entrega, qual é a melhor prática?', options: ['Confirmar o destinatário e registrar a entrega', 'Deixar na rua', 'Ignorar o destino'], correct: 0 },
  ],
  fastfood_counter: [
    { id: 'assemble', prompt: 'Como montar um pedido?', options: ['Conferir itens e montar conforme a comanda', 'Escolher itens aleatórios', 'Omitir acompanhamentos'], correct: 0 },
    { id: 'allergen', prompt: 'Uma restrição foi informada. Você:', options: ['Confere a comanda e sinaliza à cozinha', 'Ignora a observação', 'Troca o pedido sem registrar'], correct: 0 },
    { id: 'handoff', prompt: 'Antes de entregar o pedido:', options: ['Conferir a comanda e o nome do cliente', 'Entregar sem olhar', 'Remover a identificação'], correct: 0 },
  ],
});
const careerById = id => CAREERS.find(job => job.id === id);
const questionById = (jobId, id) => INTERVIEW_QUESTIONS[jobId]?.find(question => question.id === id);
const publicQuestion = question => ({ id: question.id, prompt: question.prompt, options: question.options });
const WORK_TASKS = Object.freeze({
  hospital_reception: { type: 'patient_checkin', prompt: 'Registre corretamente 2 pacientes na recepção.', target: 2, money: 40, xp: 20, supervisor: 'Helena' },
  restaurant_server: { type: 'serve_orders', prompt: 'Sirva 3 pedidos e confirme cada um.', target: 3, money: 35, xp: 18, supervisor: 'Davi' },
  library_assistant: { type: 'catalog_books', prompt: 'Catalogue 4 livros novos no acervo.', target: 4, money: 30, xp: 16, supervisor: 'Clara' },
  electrician: { type: 'inspect_panel', supervisor: 'João', money: 55, xp: 28, stages: [
    { id: 'safety', prompt: 'Inspeção fictícia: escolha o procedimento seguro.', options: ['Isolar a área e seguir o roteiro', 'Tocar no painel', 'Improvisar'], correct: 0 },
    { id: 'identify', prompt: 'Identifique o componente indicado no roteiro.', options: ['Componente vermelho', 'Fio aleatório', 'Sinalizador azul'], correct: 0 },
    { id: 'report', prompt: 'Registre o resultado da inspeção.', options: ['Relatório objetivo', 'Ocultar observações', 'Alterar dados'], correct: 0 },
  ] },
  courier: { type: 'delivery_route', supervisor: 'Rosa', money: 45, xp: 24, stages: [
    { id: 'pickup', prompt: 'Pegue a encomenda conferindo identificação e destino.', options: ['Conferir etiqueta e lacre', 'Abrir embalagem', 'Trocar etiqueta'], correct: 0 },
    { id: 'route', prompt: 'Escolha o destino exibido para a entrega.', options: ['Biblioteca', 'Hospital', 'Praça central'], correct: 0 },
    { id: 'deliver', prompt: 'Confirme a entrega ao destinatário.', options: ['Confirmar destinatário e registrar', 'Deixar na rua', 'Ignorar a confirmação'], correct: 0 },
  ] },
  fastfood_counter: { type: 'assemble_order', supervisor: 'Davi', money: 42, xp: 22, stages: [
    { id: 'assemble', prompt: 'Monte o pedido conforme a comanda.', options: ['Conferir itens da comanda', 'Escolher itens aleatórios', 'Omitir o acompanhamento'], correct: 0 },
    { id: 'restriction', prompt: 'Confira a observação de restrição do cliente.', options: ['Sinalizar a restrição à cozinha', 'Ignorar a observação', 'Trocar sem registrar'], correct: 0 },
    { id: 'handoff', prompt: 'Faça a conferência final antes da entrega.', options: ['Conferir nome e comanda', 'Entregar sem olhar', 'Remover identificação'], correct: 0 },
  ] },
  mechanic: { type: 'vehicle_inspection', supervisor: 'João', money: 60, xp: 30, stages: [
    { id: 'inspect', prompt: 'Inicie a inspeção fictícia seguindo a ordem do serviço.', options: ['Conferir o roteiro e observar o veículo simulado', 'Pular a avaliação', 'Confirmar sem olhar'], correct: 0 },
    { id: 'identify', prompt: 'Selecione o componente indicado no relatório de simulação.', options: ['Componente marcado na ordem de serviço', 'Peça aleatória', 'Item não relacionado'], correct: 0 },
    { id: 'report', prompt: 'Finalize o serviço no sistema da oficina.', options: ['Registrar as observações e enviar o relatório', 'Ocultar o resultado', 'Marcar uma tarefa que não foi feita'], correct: 0 },
  ] },
  teacher_assistant: { type: 'classroom_support', supervisor: 'Lúcia', money: 38, xp: 22, stages: [
    { id: 'prepare', prompt: 'Prepare os materiais da atividade escolar.', options: ['Conferir a lista e separar os materiais pedidos', 'Levar materiais aleatórios', 'Começar sem verificar'], correct: 0 },
    { id: 'assist', prompt: 'Um aluno pede orientação na atividade simulada.', options: ['Explicar a próxima etapa com respeito', 'Ignorar o pedido', 'Fazer a atividade sem explicar'], correct: 0 },
    { id: 'record', prompt: 'Registre a atividade concluída.', options: ['Registrar o que foi feito com precisão', 'Inventar resultados', 'Apagar o registro'], correct: 0 },
  ] },
});
const CAREER_LADDERS = Object.freeze({
  hospital_reception: [{ title: 'Recepcionista', salary: 900, xp: 0, tasks: 0, performance: 0 }, { title: 'Recepcionista sênior', salary: 1200, xp: 60, tasks: 3, performance: 70 }, { title: 'Coordenador de recepção', salary: 1600, xp: 150, tasks: 8, performance: 80 }],
  restaurant_server: [{ title: 'Atendente', salary: 850, xp: 0, tasks: 0, performance: 0 }, { title: 'Atendente sênior', salary: 1100, xp: 60, tasks: 3, performance: 70 }, { title: 'Líder de salão', salary: 1450, xp: 150, tasks: 8, performance: 80 }],
  library_assistant: [{ title: 'Assistente', salary: 800, xp: 0, tasks: 0, performance: 0 }, { title: 'Assistente sênior', salary: 1050, xp: 60, tasks: 3, performance: 75 }, { title: 'Coordenador de acervo', salary: 1400, xp: 150, tasks: 8, performance: 85 }],
  electrician: [{ title: 'Eletricista trainee', salary: 1000, xp: 0, tasks: 0, performance: 0 }, { title: 'Eletricista', salary: 1350, xp: 60, tasks: 3, performance: 70 }, { title: 'Eletricista líder', salary: 1800, xp: 150, tasks: 8, performance: 85 }],
  courier: [{ title: 'Entregador', salary: 800, xp: 0, tasks: 0, performance: 0 }, { title: 'Entregador sênior', salary: 1050, xp: 60, tasks: 3, performance: 70 }, { title: ' líder de rotas', salary: 1400, xp: 150, tasks: 8, performance: 80 }],
  fastfood_counter: [{ title: 'Atendente', salary: 820, xp: 0, tasks: 0, performance: 0 }, { title: 'Atendente sênior', salary: 1080, xp: 60, tasks: 3, performance: 70 }, { title: 'Líder de turno', salary: 1450, xp: 150, tasks: 8, performance: 80 }],
  mechanic: [{ title: 'Auxiliar de oficina', salary: 950, xp: 0, tasks: 0, performance: 0 }, { title: 'Mecânico', salary: 1300, xp: 70, tasks: 4, performance: 72 }, { title: 'Mecânico sênior', salary: 1750, xp: 170, tasks: 10, performance: 85 }],
  teacher_assistant: [{ title: 'Auxiliar escolar', salary: 900, xp: 0, tasks: 0, performance: 0 }, { title: 'Assistente escolar', salary: 1200, xp: 70, tasks: 4, performance: 75 }, { title: 'Coordenador pedagógico', salary: 1650, xp: 170, tasks: 10, performance: 88 }],
});
const TRAINING = Object.freeze({
  1: { id: 'advanced_routine', title: 'Treinamento de rotina avançada', unlockXp: 40 },
  2: { id: 'leadership', title: 'Treinamento de liderança', unlockXp: 120 },
});
const publicTask = task => ({ id: task.id, type: task.task_type, prompt: task.task?.prompt, target: task.task?.target, stage: task.task?.stage, options: task.task?.options, status: task.status, createdAt: task.created_at });

async function attachSorokiba2(app, server, opt = {}) {
  if (opt.pool) db.setPool(opt.pool);
  const htmlFile = opt.htmlFile || path.join(__dirname, 'sorokiba2.html');
  const initPromise = db.init().then(() => console.log('[sk2] banco pronto'));

  /* ---------- páginas e contas ---------- */
  const json = express.json({ limit: '8kb' });
  const tries = new Map();
  const userTries = new Map();
  const trustProxy = opt.trustProxy;
  const ipOf = req => {
    const forwarded = trustProxy === true || (typeof trustProxy === 'function' && trustProxy(req))
      ? req.headers['x-forwarded-for'] : '';
    return String(forwarded || req.socket.remoteAddress || '').split(',')[0].trim();
  };
  const limited = (store, key, max = 10) => {
    const n = Date.now(), a = (store.get(key) || []).filter(t => n - t < 6e4);
    a.push(n); store.set(key, a); return a.length > max;
  };
  const intervals = [];
  const addInterval = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); intervals.push(timer); return timer; };
  addInterval(() => {
    const n = Date.now();
    for (const store of [tries, userTries]) for (const [k, a] of store) if (!a.some(t => n - t < 6e4)) store.delete(k);
  }, 6e4);

  const readCookie = (req, name) => String(req.headers.cookie || '').split(';').map(v => v.trim())
    .find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
  const sessionToken = req => readCookie(req, 'sk2_session');
  const setSession = (req, res, token) => {
    const secure = req.secure || (trustProxy === true && req.headers['x-forwarded-proto'] === 'https');
    res.setHeader('Set-Cookie', `sk2_session=${token}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  };
  const clearSession = res => res.setHeader('Set-Cookie', 'sk2_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
  const authUser = async req => {
    const username = db.verifyToken(sessionToken(req) || req.headers.authorization?.replace(/^Bearer\s+/i, ''));
    return username ? db.load(username) : null;
  };

  app.get(['/', '/sorokiba2', '/sorokiba2.html'], (req, res) => res.sendFile(htmlFile));
  app.get('/health', async (req, res) => {
    try {
      await initPromise;
      await db.health();
      res.status(200).json({ status: 'ok', database: 'ok' });
    } catch (e) {
      res.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  const reply = (req, res, row) => {
    const token = db.sign(row.username);
    setSession(req, res, token);
    res.json({ ok: 1, token, player: db.pub(row) });
  };
  const check = (req, res) => {
    const { name, pass } = req.body || {};
    const ip = ipOf(req), userKey = `${ip}:${String(name || '').toLowerCase()}`;
    if (limited(tries, ip) || limited(userTries, userKey)) {
      res.status(429).json({ err: 'Muitas tentativas. Aguarde um minuto.' }); return null;
    }
    if (!db.validName(name)) { res.status(400).json({ err: 'Usuário: 3 a 14 letras, números ou _' }); return null; }
    if (!db.validPass(pass)) { res.status(400).json({ err: 'A senha precisa ter de 4 a 64 caracteres' }); return null; }
    return { name, pass };
  };
  app.post('/api/sk2/register', json, async (req, res) => {
    const c = check(req, res); if (!c) return;
    try { reply(req, res, await db.register(c.name, c.pass, req.body.look)); }
    catch (e) { res.status(e.status || 500).json({ err: e.status ? e.message : 'Erro no servidor' }); if (!e.status) console.error('[sk2]', e.message); }
  });
  app.post('/api/sk2/login', json, async (req, res) => {
    const c = check(req, res); if (!c) return;
    try { const row = await db.login(c.name, c.pass); row ? reply(req, res, row) : res.status(401).json({ err: 'Usuário ou senha incorretos' }); }
    catch (e) { res.status(500).json({ err: 'Erro no servidor' }); console.error('[sk2]', e.message); }
  });
  app.get('/api/sk2/session', async (req, res) => {
    try {
      const row = await authUser(req);
      row ? res.json({ ok: 1, player: db.pub(row) }) : res.status(401).json({ err: 'Sessão expirada' });
    } catch (e) { res.status(503).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/logout', (req, res) => { clearSession(res); res.json({ ok: 1 }); });
  app.post('/api/sk2/mission/complete', json, async (req, res) => {
    const mission = MISSIONS[req.body?.id];
    if (!mission || req.body?.event !== mission.event) return res.status(400).json({ err: 'Objetivo de missão inválido' });
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const updated = await db.completeMission(row.username, req.body.id, mission.money, mission.xp);
      res.json({
        ok: 1, completed: !!updated, id: req.body.id, label: mission.label,
        player: db.pub(updated || row), reward: updated ? { money: mission.money, xp: mission.xp } : null,
      });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.get('/api/sk2/careers', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const applications = await db.listApplications(row.username);
      const applied = new Map(applications.map(item => [item.job_id, item]));
      res.json({
        currentXp: Number(row.xp)||0,
        careers: CAREERS.map(job => ({
          ...job,
          currentXp: Number(row.xp)||0,
          xpEligible: (Number(row.xp)||0) >= job.minXp,
          missingXp: Math.max(0,job.minXp-(Number(row.xp)||0)),
          xpProgress: job.minXp ? Math.min(100,Math.round((Number(row.xp)||0)/job.minXp*100)) : 100,
          requiredSkills: job.skills.map(skill => CAREER_SKILLS[skill].label),
          applied: applied.has(job.id) ? applied.get(job.id).status : null,
          application: applied.get(job.id) || null,
        })),
        applications,
        resume: row.resume || { summary: '', skills: [], experience: 0 },
      });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.put('/api/sk2/career/resume', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const body = req.body || {};
      const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 280) : '';
      const skills = Array.isArray(body.skills) ? [...new Set(body.skills)] : [];
      const unlocked = skills.every(skill => typeof skill === 'string'
        && Object.prototype.hasOwnProperty.call(CAREER_SKILLS, skill)
        && row.xp >= CAREER_SKILLS[skill].unlockXp);
      const maxExperience = Math.min(20, Math.floor(Math.max(0, Number(row.xp) || 0) / 100));
      const experience = Number.isInteger(body.experience) ? body.experience : 0;
      if (!unlocked || skills.length > 4 || experience < 0 || experience > maxExperience) {
        return res.status(400).json({ err: 'Currículo contém habilidades ou experiência ainda não desbloqueadas', maxExperience });
      }
      const updated = await db.saveResume(row.username, { summary, skills, experience });
      res.json({ ok: 1, resume: updated.resume, player: db.pub(updated), maxExperience });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/career/apply', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const job = careerById(req.body?.jobId);
      const resume = row.resume || { summary: '', skills: [], experience: 0 };
      if (!job) return res.status(400).json({ err: 'Vaga inválida' });
      const currentXp = Math.max(0, Number(row.xp)||0);
      if (currentXp < job.minXp) return res.status(403).json({ err: `Esta profissão exige ${job.minXp} XP geral; você possui ${currentXp}.`, requiredXp: job.minXp, currentXp, missingXp: job.minXp-currentXp });
      if (job.skills.some(skill => !resume.skills.includes(skill)) || resume.experience < job.minExperience) {
        return res.status(400).json({ err: 'Atualize seu currículo com as habilidades e experiência exigidas' });
      }
      const application = await db.applyForCareer(row.username, job.id);
      if (!application) return res.status(409).json({ err: 'Você já se candidatou a esta vaga' });
      res.status(201).json({ ok: 1, application, job });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/career/interview/start', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const job = careerById(req.body?.jobId), questions = INTERVIEW_QUESTIONS[req.body?.jobId];
      if (!job || !questions) return res.status(400).json({ err: 'Vaga sem entrevista configurada' });
      const application = await db.getApplication(row.username, job.id);
      if (!application) return res.status(404).json({ err: 'Candidate-se antes de iniciar a entrevista' });
      if (application.status === 'hired') return res.status(409).json({ err: 'Você já foi contratado para esta vaga' });
      if (application.interview_status === 'active' && application.interview?.sessionId) {
        const current = questionById(job.id, application.interview.questionIds[application.interview.index]);
        return res.json({ ok: 1, resumed: true, status: 'active', sessionId: application.interview.sessionId, index: application.interview.index, total: application.interview.questionIds.length, done: !current, question: current ? publicQuestion(current) : null });
      }
      if (application.cooldown_until && new Date(application.cooldown_until) > new Date()) {
        return res.status(429).json({ err: 'Aguarde o fim do cooldown para tentar novamente', retryAt: application.cooldown_until });
      }
      const questionIds = questions.map(question => question.id).sort(() => Math.random() - .5);
      const interview = { sessionId: crypto.randomUUID(), questionIds, index: 0, answers: {}, startedAt: new Date().toISOString() };
      const started = await db.startInterview(row.username, job.id, interview);
      if (!started) return res.status(409).json({ err: 'Não foi possível iniciar esta entrevista agora' });
      return res.status(201).json({ ok: 1, status: 'active', sessionId: interview.sessionId, index: 0, total: questionIds.length, question: publicQuestion(questionById(job.id, questionIds[0])) });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/career/interview/answer', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const job = careerById(req.body?.jobId), application = job ? await db.getApplication(row.username, job.id) : null;
      const { sessionId, questionId, answer } = req.body || {};
      if (!job || !application || application.interview_status !== 'active' || application.interview?.sessionId !== sessionId) {
        return res.status(409).json({ err: 'Entrevista inválida ou expirada' });
      }
      const state = application.interview, expectedId = state.questionIds[state.index];
      if (questionId !== expectedId || !Number.isInteger(answer)) return res.status(400).json({ err: 'Resposta inválida para a pergunta atual' });
      const question = questionById(job.id, questionId);
      if (!question || answer < 0 || answer >= question.options.length) return res.status(400).json({ err: 'Opção de resposta inválida' });
      const next = { ...state, answers: { ...state.answers, [questionId]: answer }, index: state.index + 1 };
      const saved = await db.answerInterview(row.username, job.id, sessionId, next);
      if (!saved) return res.status(409).json({ err: 'Entrevista atualizada por outra sessão' });
      const nextQuestion = questionById(job.id, next.questionIds[next.index]);
      res.json({ ok: 1, index: next.index, total: next.questionIds.length, done: !nextQuestion, question: nextQuestion ? publicQuestion(nextQuestion) : null });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/career/interview/finish', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const job = careerById(req.body?.jobId), application = job ? await db.getApplication(row.username, job.id) : null;
      const { sessionId } = req.body || {};
      if (!job || !application || application.interview_status !== 'active' || application.interview?.sessionId !== sessionId) {
        return res.status(409).json({ err: 'Entrevista inválida ou expirada' });
      }
      const state = application.interview, questions = INTERVIEW_QUESTIONS[job.id];
      if (state.index !== questions.length || Object.keys(state.answers || {}).length !== questions.length) {
        return res.status(400).json({ err: 'Responda todas as perguntas antes de finalizar' });
      }
      const correct = questions.filter(question => state.answers[question.id] === question.correct).length;
      const answerPoints = Math.round(correct / questions.length * 70);
      const skillPoints = job.skills.every(skill => (row.resume?.skills || []).includes(skill)) ? 20 : 0;
      const experiencePoints = row.resume?.experience >= job.minExperience ? 10 : 0;
      const score = answerPoints + skillPoints + experiencePoints;
      const status = score >= 75 ? 'hired' : score >= 55 ? 'training' : 'rejected';
      const feedback = `Pontuação: ${score}/100 (respostas ${answerPoints}/70, currículo ${skillPoints}/20, experiência ${experiencePoints}/10). ${
        status === 'hired' ? 'Aprovado e contratado.' : status === 'training' ? 'Aprovado para treinamento antes da contratação.' : 'Não aprovado; revise o currículo e tente novamente após o cooldown.'
      }`;
      const cooldownUntil = status === 'hired' ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const ladder = CAREER_LADDERS[job.id] || [{ title: job.title, salary: 0, xp: 0, tasks: 0, performance: 0 }];
      const employment = { jobId: job.id, title: ladder[0].title, profession: job.profession, building: job.building, rank: 0, salary: ladder[0].salary, professionalXp: 0, completedTasks: 0, totalEarned: 0, hiredAt: new Date().toISOString() };
      const result = await db.finalizeInterview(row.username, job.id, sessionId, { status, score, feedback, cooldownUntil }, employment);
      if (!result) return res.status(409).json({ err: 'Entrevista já finalizada' });
      const updated = await db.load(row.username);
      res.json({ ok: 1, status, score, feedback, cooldownUntil, application: { jobId: job.id, status }, player: db.pub(updated) });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.get('/api/sk2/work', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const state = await db.getWorkState(row.username);
      const employment = state.player?.employment || {};
      const job = employment.jobId ? careerById(employment.jobId) : null;
      const ladder = job ? CAREER_LADDERS[job.id] : null;
      const rank = Number(employment.rank || 0), next = ladder?.[rank + 1] || null;
      const avgPerformance = state.history.length ? Math.round(state.history.reduce((sum, item) => sum + item.performance, 0) / state.history.length) : 0;
      const training = await db.listTraining(row.username, employment.jobId || '');
      res.json({
        player: db.pub(row),
        employment: db.pub(row).employment,
        job,
        supervisor: job ? WORK_TASKS[job.id]?.supervisor : null,
        progression: { rank, title: ladder?.[rank]?.title || employment.title, salary: ladder?.[rank]?.salary || employment.salary || 0, professionalXp: Number(employment.professionalXp || 0), avgPerformance, completedTasks: Number(employment.completedTasks || 0), next: next ? { title: next.title, xp: next.xp, tasks: next.tasks, performance: next.performance } : null },
        training: Object.values(TRAINING).map(item => ({ ...item, unlocked: Number(employment.professionalXp || 0) >= item.unlockXp, completed: training.some(done => done.training_id === item.id) })),
        shift: state.shift ? { id: state.shift.id, status: state.shift.status, startedAt: state.shift.started_at } : null,
        task: state.shift?.task_id ? publicTask({ id: state.shift.task_id, task_type: state.shift.task_type, task: state.shift.task, status: state.shift.task_status }) : null,
        history: state.history,
      });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/training/complete', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const employment = row.employment || {}, training = TRAINING[Number(req.body?.rank)];
      if (!employment.jobId || !training || training.id !== req.body?.trainingId || Number(employment.professionalXp || 0) < training.unlockXp) return res.status(400).json({ err: 'Treinamento ainda não desbloqueado' });
      const done = await db.completeTraining(row.username, employment.jobId, training.id);
      res.json({ ok: 1, completed: !!done, training: { ...training, completed: true } });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/promotion/request', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const employment = row.employment || {}, ladder = CAREER_LADDERS[employment.jobId], rank = Number(employment.rank || 0), next = ladder?.[rank + 1];
      if (!next) return res.status(409).json({ err: 'Você já está no cargo máximo desta carreira' });
      const history = await db.getWorkState(row.username), avg = history.history.length ? history.history.reduce((sum, item) => sum + item.performance, 0) / history.history.length : 0;
      const requirements = { xp: next.xp, tasks: next.tasks, performance: next.performance };
      if (Number(employment.professionalXp || 0) < next.xp || Number(employment.completedTasks || 0) < next.tasks || avg < next.performance) return res.status(400).json({ err: 'Requisitos de promoção ainda não atingidos', requirements, progress: { xp: employment.professionalXp || 0, tasks: employment.completedTasks || 0, performance: Math.round(avg) } });
      const promotion = await db.requestPromotion(row.username, employment.jobId, rank, rank + 1, requirements);
      if (!promotion) return res.status(409).json({ err: 'Promoção já solicitada' });
      res.status(201).json({ ok: 1, promotion: { id: promotion.id, status: promotion.status, requirements } });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/promotion/confirm', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const employment = row.employment || {}, ladder = CAREER_LADDERS[employment.jobId], rank = Number(employment.rank || 0), next = ladder?.[rank + 1];
      const state = await db.getWorkState(row.username), avg = state.history.length ? state.history.reduce((sum, item) => sum + item.performance, 0) / state.history.length : 0;
      if (!next || Number(employment.professionalXp || 0) < next.xp || Number(employment.completedTasks || 0) < next.tasks || avg < next.performance) return res.status(400).json({ err: 'Requisitos de promoção não estão mais válidos' });
      const promotion = await db.getPendingPromotion(row.username, employment.jobId)
        || await db.requestPromotion(row.username, employment.jobId, rank, rank + 1, { xp: next.xp, tasks: next.tasks, performance: next.performance });
      const updated = promotion && await db.confirmPromotion(row.username, employment.jobId, promotion.id, { ...employment, rank: rank + 1, title: next.title, salary: next.salary });
      if (!updated) return res.status(409).json({ err: 'Promoção já confirmada ou indisponível' });
      res.json({ ok: 1, promoted: true, player: db.pub(updated), message: `Promoção confirmada: ${next.title}.` });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/supervisor', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const jobId = row.employment?.jobId, task = WORK_TASKS[jobId];
      if (!task) return res.status(409).json({ err: 'Você ainda não tem um emprego jogável' });
      res.json({ ok: 1, supervisor: task.supervisor, message: `Olá! Sou ${task.supervisor}. Inicie o turno para receber sua próxima tarefa.` });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/start', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const jobId = row.employment?.jobId;
      if (!WORK_TASKS[jobId]) return res.status(409).json({ err: 'Seu emprego ainda não tem tarefas jogáveis' });
      const shift = await db.startWorkShift(row.username, jobId);
      if (!shift) return res.status(409).json({ err: 'Não foi possível iniciar o turno' });
      res.status(201).json({ ok: 1, shift: { id: shift.id, status: shift.status, startedAt: shift.started_at }, supervisor: WORK_TASKS[jobId].supervisor });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/task', async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const jobId = row.employment?.jobId, definition = WORK_TASKS[jobId];
      if (!definition) return res.status(409).json({ err: 'Seu emprego ainda não tem tarefas jogáveis' });
      const state = await db.getWorkState(row.username);
      if (!state.shift || state.shift.status !== 'active') return res.status(409).json({ err: 'Inicie um turno primeiro' });
      if (state.shift.task_id) return res.json({ ok: 1, task: publicTask({ id: state.shift.task_id, task_type: state.shift.task_type, task: state.shift.task, status: state.shift.task_status }) });
      const rank = Number(row.employment?.rank || 0), multiplier = 1 + rank * .2;
      const task = await db.assignWorkTask(row.username, state.shift.id, jobId, {
        type: definition.type,
        payload: definition.stages
          ? { stage: 0, stageId: definition.stages[0].id, prompt: definition.stages[0].prompt, options: definition.stages[0].options }
          : { prompt: definition.prompt, target: definition.target },
        money: Math.round(definition.money * multiplier),
        xp: definition.xp,
      });
      res.status(201).json({ ok: 1, task: publicTask(task) });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });
  app.post('/api/sk2/work/task/complete', json, async (req, res) => {
    try {
      const row = await authUser(req);
      if (!row) return res.status(401).json({ err: 'Sessão expirada' });
      const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
      const count = Number(req.body?.count);
      const state = await db.getWorkState(row.username);
      if (!state.shift?.task_id || state.shift.task_id !== taskId) return res.status(409).json({ err: 'Tarefa inválida ou não é a próxima tarefa' });
      const definition = WORK_TASKS[row.employment?.jobId];
      if (definition?.stages) {
        const option = Number(req.body?.option);
        const stageIndex = Number(state.shift.task?.stage);
        const stage = definition.stages[stageIndex];
        if (!stage || !Number.isInteger(option) || option < 0 || option >= stage.options.length) {
          return res.status(400).json({ err: 'Etapa ou opção inválida' });
        }
        if (option !== stage.correct) {
          return res.status(400).json({ err: 'Essa escolha não atende ao procedimento da tarefa. Tente novamente.' });
        }
        const nextIndex = stageIndex + 1, done = nextIndex >= definition.stages.length;
        const nextStage = definition.stages[nextIndex];
        const nextTask = done ? { ...state.shift.task, stage: nextIndex, stageId: stage.id, prompt: stage.prompt, options: stage.options } :
          { stage: nextIndex, stageId: nextStage.id, prompt: nextStage.prompt, options: nextStage.options };
        const advanced = await db.advanceWorkTask(row.username, taskId, nextTask, { option }, done);
        if (!advanced) return res.status(404).json({ err: 'Tarefa não encontrada' });
        if (advanced.duplicate) return res.json({ ok: 1, duplicate: true, message: 'Tarefa já contabilizada; nenhum pagamento duplicado.' });
        return res.json(done
          ? { ok: 1, completed: true, payment: advanced.task.reward_money, professionalXp: advanced.task.reward_xp, performance: 100, player: db.pub(advanced.player) }
          : { ok: 1, completed: false, task: publicTask(advanced.task), message: 'Etapa concluída. Próxima etapa liberada.' });
      }
      const target = Number(state.shift.task?.target);
      if (!Number.isInteger(count) || count < target) return res.status(400).json({ err: `Conclua pelo menos ${target} unidade(s) da tarefa` });
      const performance = Math.min(100, Math.round(count === target ? 100 : target / count * 100));
      const result = await db.completeWorkTask(row.username, taskId, { count, performance });
      if (!result) return res.status(404).json({ err: 'Tarefa não encontrada' });
      if (result.duplicate) return res.json({ ok: 1, duplicate: true, message: 'Tarefa já contabilizada; nenhum pagamento duplicado.' });
      res.json({ ok: 1, completed: true, payment: result.task.reward_money, professionalXp: result.task.reward_xp, performance, player: db.pub(result.player) });
    } catch (e) { res.status(500).json({ err: 'Erro no servidor' }); }
  });

  await initPromise;

  /* ---------- mundo online (WebSocket) ---------- */
  const wss = new WebSocketServer({ server, path: '/sk2ws', maxPayload: 1024 });
  const P = new Map();               // id -> jogador conectado
  const connectionsByIp = new Map();
  let activeConnections = 0;
  let nid = 1;
  const pub = o => ({ id: o.id, n: o.n, x: o.x, y: o.y, lk: o.lk });
  const send = (o, m) => { if (o.ws.readyState === 1) o.ws.send(JSON.stringify(m)); };
  const toAll = (m, except) => { const s = JSON.stringify(m); for (const o of P.values()) if (o !== except && o.ws.readyState === 1) o.ws.send(s); };
  const flush = list => db.savePositions(list.map(o => ({ u: o.u, x: o.x, y: o.y }))).catch(e => console.error('[sk2] salvar:', e.message));

  wss.on('connection', (ws, req) => {
    const ip = ipOf(req), count = connectionsByIp.get(ip) || 0;
    if (activeConnections >= MAX_CONNECTIONS || count >= MAX_CONNECTIONS_PER_IP) return ws.close(1013, 'Limite de conexões');
    activeConnections++;
    connectionsByIp.set(ip, count + 1);
    let me = null, joining = false;
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    const timer = setTimeout(() => { if (!me) ws.close(); }, 8000);
    ws.on('error', () => {});
    ws.on('message', async raw => {
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return ws.close(1003, 'Payload inválido');
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return ws.close(1003, 'Payload inválido'); }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return ws.close(1003, 'Payload inválido');
      if (!me) {
        if (m.t !== 'hi' || joining) return;
        joining = true;
        const u = db.verifyToken(String(m.token || '').slice(0, 512)) || db.verifyToken(sessionToken(req));
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
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(m.d) || !Number.isInteger(m.f) || !(x > 0 && x < MW && y > 0 && y < MH)) return;
        if (Math.hypot(x - me.x, y - me.y) > 8 * dt + 2) return;       // limite de velocidade
        me.x = x; me.y = y; me.d = (m.d | 0) & 3; me.f = (m.f | 0) & 3; me.last = now; me.dirty = true; me.moved = true;
      } else if (m.t === 'c') {
        const now = Date.now(); if (now - me.lc < 1200) return; me.lc = now;
        if (typeof m.m !== 'string') return;
        const msg = m.m.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!msg) return;
        const s = JSON.stringify({ t: 'c', id: me.id, n: me.n, m: msg });
        for (const o of P.values()) if (Math.hypot(o.x - me.x, o.y - me.y) < 30 && o.ws.readyState === 1) o.ws.send(s);
      }
    });
    ws.on('close', () => {
      activeConnections--;
      const left = (connectionsByIp.get(ip) || 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left); else connectionsByIp.delete(ip);
      clearTimeout(timer);
      if (me && P.get(me.id) === me) { P.delete(me.id); flush([me]); toAll({ t: 'l', id: me.id }); }
    });
  });

  // 5 vezes por segundo: manda só quem se mexeu
  addInterval(() => {
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
  addInterval(() => {
    const d = [...P.values()].filter(o => o.dirty);
    d.forEach(o => { o.dirty = false; });
    flush(d);
  }, 20000);

  // mantém as conexões vivas e derruba as mortas
  addInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 25000);

  let shuttingDown = null;
  const shutdown = () => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      intervals.forEach(clearInterval);
      await flush([...P.values()]);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
      await db.close();
    })().catch(e => console.error('[sk2] erro ao encerrar:', e.message));
    return shuttingDown;
  };
  if (opt.handleSignals !== false) {
    const onSignal = () => shutdown().finally(() => process.exit(0));
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  return { online: () => P.size, shutdown, ready: initPromise };
}

module.exports = { attachSorokiba2 };
