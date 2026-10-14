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


test('account screen no longer displays the first-account-mayor notice', () => {
  const client = read('sorokiba2.html');
  assert.ok(!client.includes('O primeiro a criar conta é o Prefeito!'));
  assert.ok(!client.includes('id="mh"'));
  assert.ok(!client.includes("$('mh').hidden"));
  assert.match(client, /Criar conta e entrar/);
});


test('mobile gameplay requests landscape orientation and shows a rotate fallback', () => {
  const client = read('sorokiba2.html');
  assert.ok(client.includes("screen.orientation.lock('landscape')"));
  assert.ok(client.includes('id="rotatePrompt"'));
  assert.ok(client.includes('innerHeight>innerWidth'));
  assert.ok(client.includes('id="rotateRetry"'));
  assert.ok(client.includes('requestLandscapeMode()'));
});

test('cars stop at the player, the player collides with cars, and a horn is triggered', () => {
  const client = read('sorokiba2.html');
  assert.ok(client.includes('const vehicleHit=(x,y)=>cars.some'));
  assert.ok(client.includes('!vehicleHit(px+vx,py)'));
  assert.ok(client.includes('let playerBlocking=false,playerInside=false'));
  assert.ok(client.includes('if(playerInside){de=0;a.s=0}'));
  assert.ok(client.includes('playCarHorn();a.hornCooldown=2.15'));
  assert.ok(client.includes("c.fillText('BIP!'"));
});

test('cinematic CSS treatment and motion respect reduced-motion preferences', () => {
  const client = read('sorokiba2.html');
  assert.ok(client.includes('id="visualFx"'));
  assert.ok(client.includes('@keyframes cityLightSweep'));
  assert.ok(client.includes('filter:saturate(1.09) contrast(1.035)'));
  assert.ok(client.includes('@media(prefers-reduced-motion:reduce)'));
});


test('Parque Central has walkable paths, a pond, trees and usable sitting benches', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /const parkBenches=\[/);
  assert.match(client, /function drawBench\(c,b,t\)/);
  assert.match(client, /E · Sentar no banco/);
  assert.match(client, /E · Levantar do banco/);
  assert.match(client, /seated=!!o\.seated/);
  assert.match(client, /g\[y\]\[x\]=7/);
});

test('multiplayer shares a traffic snapshot and synchronizes sitting poses', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  assert.match(client, /function applyTrafficSnapshot\(snapshot,hard=false\)/);
  assert.match(client, /myId===trafficAuthorityId/);
  assert.match(client, /JSON\.stringify\(\{t:'v',c:snapshot\}\)/);
  assert.match(client, /else if\(m\.t=='v'\)/);
  assert.match(server, /let trafficState = null, trafficAuthority = 0/);
  assert.match(server, /if \(m\.t === 'v'\)/);
  assert.match(server, /toAll\(\{t:'v',c:clean\},me\)/);
  assert.match(server, /o\.seated \? 1 : 0/);
});


test('traffic uses adaptive following distance, smooth acceleration and progressive braking', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /const safeGap=2\.65\+a\.s\*\.55/);
  assert.match(client, /Math\.sqrt\(Math\.max\(0,2\*3\.8\*Math\.max\(0,freeGap-\.85\)\)\)/);
  assert.match(client, /Math\.max\(-8\.5\*dt,Math\.min\(2\.8\*dt,de-a\.s\)\)/);
  assert.match(client, /function detectTrafficCollisions\(\)/);
  assert.match(client, /registerTrafficCollision\(a,b,i,j\)/);
  assert.match(client, /a\.crashedUntil&&now<a\.crashedUntil/);
});

test('cars render with layered body reflections, detailed windows, animated lamps and brake glow', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /function carD\(c,a\)/);
  assert.match(client, /rgba\(255,255,255,\.35\)/);
  assert.match(client, /c\.shadowBlur=curD>\.1\?curD\*10:2/);
  assert.match(client, /c\.fillStyle=a\.br\?'#ff2929':'#922b31'/);
  assert.match(client, /const plate=hz\?P\(/);
  assert.match(client, /function wheel\(c,p,r\)/);
});
test('shared traffic collisions trigger evacuation, firefighters and ambulance transport', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  assert.match(client, /function activateAccident\(data\)/);
  assert.match(client, /function drawAccidentFire\(c,inc,t,elapsed\)/);
  assert.match(client, /function drawWaterStream\(c,inc,pose,t\)/);
  assert.match(client, /n\.state='fleeing'/);
  assert.match(client, /findRoadPath\(inc\.x,inc\.y,20\.5,16\.5\)/);
  assert.match(client, /victim\.state='recovering'/);
  assert.match(server, /if \(m\.t === 'x'\)/);
  assert.match(server, /activeAccidents\.push\(incident\)/);
  assert.match(server, /incidents: liveAccidents\(\)/);
});


test('traffic lights use a shared wall-clock phase across browsers', () => {
  const client = read('sorokiba2.html');
  assert.ok(client.includes('tl(Date.now())'));
  assert.ok(!client.includes('tl(performance.now())'));
});

test('the selected accident victim remains at the scene until ambulance pickup', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /Math\.hypot\(nearest\.x-vx,nearest\.y-vy\)<4\.5/);
  assert.match(client, /victim\.state='injured';victim\.injuredUntil=inc\.startedAt\+20000/);
  assert.match(client, /if\(n\.injuredUntil&&nowNpc<n\.injuredUntil\)/);
});


test('traffic slows to match a lead vehicle and brakes for accident scene obstacles', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /targetSpeed=b\.crashedUntil\?0:b\.s/);
  assert.match(client, /for\(const inc of accidents\)/);
  assert.match(client, /gap>4\.5/);
});


test('park seating uses a low, bent seated pose and bench-aligned interaction anchors', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /id:'park-bench-1',x:30\.5,y:78\.15,sitX:30\.5,sitY:78\.35/);
  assert.match(client, /if\(seated\)\{\s*c\.save\(\)/);
  assert.match(client, /c\.fillRect\(x-6,y-20,12,10\)/);
  assert.match(client, /near=\{t:'bench',o:b\}/);
});

test('ice-cream attendant, shop menu, purchase and eating animation are connected', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  const database = read('sorokiba2-db.js');
  assert.match(client, /role:'Atendente da sorveteria'/);
  assert.match(client, /E · Comprar sorvetes com /);
  assert.match(client, /function openIceCreamShop\(\)/);
  assert.match(client, /data-icecream-buy/);
  assert.match(client, /data-icecream-eat/);
  assert.match(client, /drawIceCreamSnack\(c,p\[0\]\+10,p\[1\]-24,t,iceCreamEatingFlavor\)/);
  assert.match(server, /app\.post\('\/api\/sk2\/icecream\/buy'/);
  assert.match(server, /app\.post\('\/api\/sk2\/icecream\/eat'/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS sk2_food_inventory/);
  assert.match(database, /async function buyIceCream/);
  assert.match(database, /async function eatIceCream/);
});

test('only the authenticated mayor can start a shared accident test', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  assert.match(client, /id="mayorTestAccident" class="mayorTool" hidden/);
  assert.match(client, /ws\.send\(JSON\.stringify\(\{t:'testAccident'\}\)\)/);
  assert.match(server, /if \(me\.lk\?\.role !== 'prefeito'\)/);
  assert.match(server, /t: 'accidentTestResult'/);
  assert.match(server, /test-'.*incidentSequence/);
});


test('local and remote seated avatars render at the height of the bench seat', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /P\(q\.x,q\.y,q\.o\.seated\?5:0\)/);
  assert.match(client, /P\(px,py,isSeated\?5:0\)/);
});


test('mayor control panel exposes protected city controls and global announcements', () => {
  const client = read('sorokiba2.html');
  const server = read('sorokiba2-server.js');
  assert.match(client, /id="mayorPanel"/);
  assert.match(client, /id="mayorStartAccident"/);
  assert.match(client, /id="mayorEndAccidents"/);
  assert.match(client, /id="mayorTrafficToggle"/);
  assert.match(client, /id="mayorSendAnnouncement"/);
  assert.match(client, /mayorAnnouncement/);
  assert.match(server, /if \(m\.t === 'mayorAction'\)/);
  assert.match(server, /me\.lk\?\.role !== 'prefeito'/);
  assert.match(server, /traffic_toggle/);
  assert.match(server, /mayorAnnouncement/);
});


test('courier missions require in-world pickup and delivery at a marked destination', () => {
  const server = read('sorokiba2-server.js');
  const client = read('sorokiba2.html');
  assert.match(server, /destinations: \[/);
  assert.match(server, /targetBuilding: 'Rodoviária'/);
  assert.match(server, /distance > 3\.1/);
  assert.match(server, /Number\(taskData\.stage\) === 0/);
  assert.match(server, /taskData\.destination/);
  assert.match(server, /livePlayer/);
  assert.match(client, /t:'workTarget'/);
  assert.match(client, /completeWorkTask\(near\.o\.id,null\)/);
  assert.match(client, /task\?\.type==='delivery_route'/);
  assert.match(client, /marcador dourado no minimapa/);
});


test('courier can toggle a delivery motorcycle and work dashboard is organized responsively', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /let deliveryBike=false/);
  assert.match(client, /function drawDeliveryBike/);
  assert.match(client, /deliveryBike\?1\.7:1/);
  assert.match(client, /Pegar moto de entrega/);
  assert.match(client, /Devolver moto de entrega/);
  assert.match(client, /workOverview/);
  assert.match(client, /workMissionCard/);
  assert.match(client, /@media\(max-width:760px\)\{#workPanel/);
});


test('delivery bike has improved layered rendering and route destination is visible on world and maps', () => {
  const client = read('sorokiba2.html');
  assert.match(client, /function drawDeliveryBike/);
  assert.match(client, /caixa de entrega visível na traseira/);
  assert.match(client, /workState\?\.task\?\.type==='delivery_route'/);
  assert.match(client, /strokeStyle='#fff4bf'/);
  assert.match(client, /fillText\('DESTINO'/);
  assert.match(client, /if\(!inside\)/);
});
