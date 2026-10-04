// posix path subset
function normalize(p) {
  const abs = p.startsWith('/'), out = [];
  for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(seg); }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
exports.normalize = normalize;
exports.join = (...a) => normalize(a.filter(Boolean).join('/'));
exports.resolve = (...a) => normalize(a.filter(Boolean).join('/'));
exports.dirname = p => { const i = p.lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i); };
exports.basename = p => p.slice(p.lastIndexOf('/') + 1);
exports.extname = p => { const b = exports.basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
exports.sep = '/';
