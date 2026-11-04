import { createApp } from './app.js';
const s = await createApp();
const addr = await s.listen();
s.app.log.info({ addr, redact: s.redactSource() }, 'peekmarquee relay up');
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await s.close(); process.exit(0); });
