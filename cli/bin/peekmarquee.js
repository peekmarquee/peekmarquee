#!/usr/bin/env node
import { main } from '../src/run.js';

const [maj] = process.versions.node.split('.').map(Number);
if (maj < 18) { console.error('peekmarquee needs Node 18 or newer.'); process.exit(2); }
main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`peekmarquee: ${e && e.message ? e.message : e}`); process.exit(1); });
