'use strict';
// Para testar o Sorokiba 2 sozinho (sem o Sorokiba 1):  DATABASE_URL=... SK2_SECRET=... node sorokiba2-standalone.js
const express = require('express'), http = require('http');
const app = express(), server = http.createServer(app);
const port = process.env.PORT || 3000;
require('./sorokiba2-server').attachSorokiba2(app, server)
  .then(() => server.listen(port, () => console.log('Sorokiba 2 em http://localhost:' + port + '/sorokiba2')))
  .catch(e => { console.error('[sk2] não foi possível iniciar:', e.message); process.exitCode = 1; });
