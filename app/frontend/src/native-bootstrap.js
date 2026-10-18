/** Native shell entry: Buffer global must exist before any app chunk runs. */
import './buffer-polyfill.js';
await import('./main.js');
