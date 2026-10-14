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
