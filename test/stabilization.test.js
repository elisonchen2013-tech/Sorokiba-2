'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = name => fs.readFileSync(require('node:path').join(__dirname, '..', name), 'utf8');

test('startup waits for database initialization before listening', () => {
  const standalone = read('sorokiba2-standalone.js');
  assert.match(standalone, /attachSorokiba2\(app, server\)\s*\.then/);
  assert.match(read('sorokiba2-server.js'), /async function attachSorokiba2/);
});

test('health and signal shutdown are wired', () => {
  const server = read('sorokiba2-server.js');
  assert.match(server, /app\.get\('\/health'/);
  assert.match(server, /SIGTERM/);
  assert.match(server, /SIGINT/);
  assert.match(server, /await db\.close\(\)/);
});

test('proxy headers and offline mode require explicit configuration', () => {
  const server = read('sorokiba2-server.js');
  const client = read('sorokiba2.html');
  assert.match(server, /opt\.trustProxy === true/);
  assert.match(client, /DEV_OFFLINE/);
  assert.match(client, /if\(!DEV_OFFLINE\)return/);
});

test('session, rate limits, payload validation and mission are wired', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /HttpOnly/);
  assert.match(server, /MAX_CONNECTIONS_PER_IP/);
  assert.match(server, /Number\.isFinite\(x\)/);
  assert.match(server, /mission\/complete/);
  assert.match(db, /completeWelcome/);
  assert.match(client, /restoreSession/);
  assert.match(client, /completeMission/);
});

test('reusable missions are server-validated and persisted atomically', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /hospital_visit/);
  assert.match(server, /cityhall_notice/);
  assert.match(server, /library_visit/);
  assert.match(server, /req\.body\?\.event !== mission\.event/);
  assert.match(db, /missions=jsonb_set/);
  assert.match(db, /NOT \(COALESCE\(missions/);
  assert.match(client, /building:✚ Hospital/);
  assert.match(client, /spot:Prefeitura:Quadro de avisos/);
});

test('career center persists validated resumes and unique applications', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /\/api\/sk2\/careers/);
  assert.match(server, /\/api\/sk2\/career\/resume/);
  assert.match(server, /\/api\/sk2\/career\/apply/);
  assert.match(server, /skills\.every/);
  assert.match(server, /job\.skills\.some/);
  assert.match(db, /sk2_career_applications/);
  assert.match(db, /PRIMARY KEY \(username, job_id\)/);
  assert.match(client, /Central de carreiras/);
  assert.match(client, /resumeSave/);
});

test('career interviews hide answers, validate progression and persist outcomes', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /career\/interview\/start/);
  assert.match(server, /career\/interview\/answer/);
  assert.match(server, /career\/interview\/finish/);
  assert.match(server, /questionById/);
  assert.match(server, /answerPoints/);
  assert.match(server, /status = score >= 75 \? 'hired'/);
  assert.match(server, /cooldownUntil/);
  assert.match(db, /interview_status/);
  assert.match(db, /finalizeInterview/);
  assert.match(db, /employment=\$2/);
  assert.match(client, /interviewPanel/);
  assert.match(client, /startInterview/);
  assert.match(client, /interview\/finish/);
});

test('work panel provides server-validated tasks and idempotent payment history', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /api\/sk2\/work/);
  assert.match(server, /api\/sk2\/work\/task\/complete/);
  assert.match(server, /WORK_TASKS/);
  assert.match(server, /Number\(req\.body\?\.count\)/);
  assert.match(server, /performance = Math\.min/);
  assert.match(db, /sk2_work_shifts/);
  assert.match(db, /sk2_work_history/);
  assert.match(db, /status='assigned'/);
  assert.match(db, /duplicate: true/);
  assert.match(client, /Meu trabalho/);
  assert.match(client, /completeWorkTask/);
});

test('professional minigames keep stages and answers server-side', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /electrician:/);
  assert.match(server, /courier:/);
  assert.match(server, /fastfood_counter:/);
  assert.match(server, /definition\.stages/);
  assert.match(server, /option !== stage\.correct/);
  assert.match(server, /advanceWorkTask/);
  assert.match(db, /async function advanceWorkTask/);
  assert.match(db, /status='assigned'/);
  assert.match(client, /data\.task\.options/);
  assert.match(client, /Etapa/);
});

test('career progression validates requirements and records promotions', () => {
  const server = read('sorokiba2-server.js');
  const db = read('sorokiba2-db.js');
  const client = read('sorokiba2.html');
  assert.match(server, /CAREER_LADDERS/);
  assert.match(server, /work\/promotion\/request/);
  assert.match(server, /work\/promotion\/confirm/);
  assert.match(server, /work\/training\/complete/);
  assert.match(server, /professionalXp/);
  assert.match(server, /avgPerformance/);
  assert.match(db, /sk2_work_promotions/);
  assert.match(db, /sk2_work_training/);
  assert.match(db, /confirmPromotion/);
  assert.match(client, /workPromotionRequest/);
  assert.match(client, /workProgress/);
  assert.match(client, /Treinamento/);
});


test('map is expanded and the employment center has an explorable interior', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  assert.match(client, /const MW=96,MH=84/);
  assert.match(server, /const MW = 96, MH = 84/);
  assert.match(client, /bd\('Centro de Empregos'/);
  assert.match(client, /family==='employment'/);
  assert.match(client, /career-center/);
  assert.match(client, /role==='Recrutador'/);
});

test('career XP thresholds are exposed to the interface and enforced on the server', () => {
  const server = read('sorokiba2-server.js');
  const client = read('sorokiba2.html');
  for (const [job, xp] of [['courier', 0], ['fastfood_counter', 50], ['hospital_reception', 100],
    ['restaurant_server', 100], ['library_assistant', 100], ['mechanic', 250], ['electrician', 300],
    ['teacher_assistant', 400]]) {
    assert.match(server, new RegExp("id: '" + job + "'.*minXp: " + xp));
  }
  assert.match(server, /currentXp: Number\(row\.xp\)\|\|0/);
  assert.match(server, /currentXp < job\.minXp/);
  assert.match(client, /careerXpTrack/);
  assert.match(client, /Faltam .* XP geral/);
});

test('every listed career has interview questions, work tasks and career progression', () => {
  const server = read('sorokiba2-server.js');
  const careers = server.slice(server.indexOf('const CAREERS = Object.freeze(['), server.indexOf(']);', server.indexOf('const CAREERS = Object.freeze([')));
  const tasks = server.slice(server.indexOf('const WORK_TASKS = Object.freeze({'), server.indexOf('});', server.indexOf('const WORK_TASKS = Object.freeze({')));
  const ladders = server.slice(server.indexOf('const CAREER_LADDERS = Object.freeze({'), server.indexOf('});', server.indexOf('const CAREER_LADDERS = Object.freeze({')));
  const questions = server.slice(server.indexOf('const INTERVIEW_QUESTIONS = Object.freeze({'), server.indexOf('});', server.indexOf('const INTERVIEW_QUESTIONS = Object.freeze({')));
  const jobs = [...careers.matchAll(/id: '([^']+)'/g)].map(m => m[1]);
  for (const job of jobs) {
    assert.match(tasks, new RegExp('^  ' + job + ':', 'm'), job + ' has work tasks');
    assert.match(ladders, new RegExp('^  ' + job + ':', 'm'), job + ' has progression');
    assert.match(questions, new RegExp('^  ' + job + ':', 'm'), job + ' has interview questions');
  }
});


test('an interview score of 53 can enter the training outcome', () => {
  const server = read('sorokiba2-server.js');
  assert.match(server, /const status = score >= 75 \? 'hired' : score >= 53 \? 'training' : 'rejected'/);
});


test('curriculum editor has readable high-contrast fields and preserves edits on refresh', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /#careerPanel textarea[^\{]*\{[^}]*color:#F5EFE3/);
  assert.match(client, /#careerPanel textarea[^\{]*\{[^}]*caret-color:#F2B84B/);
  assert.match(client, /function renderResume\(resume,force=false\)/);
  assert.match(client, /if\(resumeDirty&&!force\)return/);
  assert.match(client, /addEventListener\('keydown',e=>\{\s*const target=e\.target/);
});

test('employment center has separate walkable rooms and an interview NPC', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /dividers:family==='employment'/);
  assert.match(client, /const wallHit=\(room\.dividers\|\|\[\]\)\.some/);
  assert.match(client, /sign\('RECEPÇÃO'/);
  assert.match(client, /sign\('RECRUTAMENTO'/);
  assert.match(client, /sign\('ENTREVISTAS'/);
  assert.match(client, /'Carla','Entrevistadora'/);
  assert.match(client, /near\.o\.role==='Entrevistadora'/);
});


test('device detection enables a virtual joystick only for touch gameplay', () => {
  const client = read('sorokiba2.html');
  assert.ok(client.includes("matchMedia('(pointer: coarse)')"));
  assert.ok(client.includes('navigator.maxTouchPoints'));
  assert.ok(client.includes('id="mobileControls"'));
  assert.ok(client.includes('id="moveStick"'));
  assert.ok(client.includes("const active=touchDevice&&mode==='game'"));
  assert.ok(client.includes("addEventListener('pointerdown'"));
  assert.ok(client.includes('stickVector||tv'));
  assert.ok(client.includes('Use o joystick para andar'));
});

test('keyboard and virtual joystick inputs share the same movement logic', () => {
  const client = read('sorokiba2.html');
  assert.equal((client.match(/const moveVector=stickVector\|\|tv/g)||[]).length, 2);
  assert.ok(client.includes('keys[k]=1'));
  assert.ok(client.includes('resetStick()'));
});
