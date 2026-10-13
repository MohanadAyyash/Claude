// Entry point for hosts that start Node apps themselves (cPanel "Setup Node.js App" / Phusion Passenger, Plesk).
// Needs Node.js 22.13+ (node:sqlite without flags). Environment: DATA_DIR (keep it OUTSIDE the public web folder), TRUST_PROXY=1, SETUP_TOKEN.
process.env.TRUST_PROXY = process.env.TRUST_PROXY || '1';
require('./server.js').server.listen(process.env.PORT || 3000, process.env.HOST || '0.0.0.0');
