// Globals the server code expects from Node
export { Buffer } from 'buffer';
export const process = { env: {}, platform: 'browser', cwd: () => '/', argv: [], versions: {} };
