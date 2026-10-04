// The "server" is never listened on: the runtime calls the registered request handler directly.
exports.createServer = handler => { globalThis.__ERP_HANDLER = handler; return { listen() {}, close() {}, on() {} }; };
