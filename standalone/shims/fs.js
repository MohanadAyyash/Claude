// Virtual read-only file system: only the bundled brand pack files are visible (preloaded by the runtime into globalThis.__ERP_FILES).
const { Buffer } = require('buffer');
const files = () => globalThis.__ERP_FILES || {};
exports.existsSync = p => Object.prototype.hasOwnProperty.call(files(), p);
exports.readFileSync = p => { if (!exports.existsSync(p)) throw new Error('ENOENT: ' + p); return Buffer.from(files()[p]); };
exports.statSync = p => ({ isDirectory: () => false, size: exports.existsSync(p) ? files()[p].length : 0, mtimeMs: 0 });
exports.readdirSync = () => [];
exports.mkdirSync = () => {}; exports.rmSync = () => {}; exports.writeFileSync = () => {}; exports.mkdtempSync = p => p + 'x';
