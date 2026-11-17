// The port the ERP listens on, worked out exactly as server.js does: the PORT environment variable if it is set, else PORT from
// .env next to server.js (read by lib/envfile.js, as server.js does), else 3000.
// Used by Trigon-Start.bat (to set PORT for the server and the browser) and by scripts/update.js (stop / health check), so the
// launcher, the server and the updater always agree.   node scripts/port.js [system folder]  → prints the port
'use strict';
const path = require('node:path'), { read } = require('../lib/envfile.js');

function configuredPort(app, env = process.env) {
  const fromFile = (read(app).values || {}).PORT;                           // the same reader as server.js (any Windows encoding)
  const v = env.PORT !== undefined ? env.PORT : fromFile;                     // loadEnvFile never overrides a variable already set
  const n = Number(v || 3000);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}

if (require.main === module) console.log(configuredPort(path.resolve(process.argv[2] || path.join(__dirname, '..'))));
module.exports = { configuredPort };
