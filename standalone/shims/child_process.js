// not available in the browser (standalone edition): e-mail over SMTP and local PDF rendering need a server
const no = () => { throw new Error('Not available in the standalone edition'); };
module.exports = { connect: no, execFile: no, exec: no };
