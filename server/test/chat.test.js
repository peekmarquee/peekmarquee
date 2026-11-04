import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, FakeCli, sseClient, sleep } from './helpers.js';
import { cleanChat } from '../src/app.js';

const post = (s, id, body, ip) => s.post(`/api/s/${id}/chat`, body, ip ? { 'x-forwarded-for': ip } : {});
let ipn = 10;
const fresh = () => `10.9.0.${ipn++}`;

test('chat: validation, HTML/control strip, address + link removal, profanity mask', async () => {
  const s = await startServer(); const st = await s.stream();
  try {
    let r = await post(s, st.id, { nick: 'bob', text: 'hi <b>there</b>\u0000‮!' }, fresh());
    assert.equal(r.status, 200); assert.equal(r.body.text, 'hi there !'); assert.equal(r.body.system, false); assert.ok(r.body.id);
    assert.equal((await post(s, st.id, { nick: 'x'.repeat(25), text: 'a' }, fresh())).status, 400);
    assert.equal((await post(s, st.id, { nick: 'ok', text: 'a'.repeat(281) }, fresh())).status, 400);
    assert.equal((await post(s, st.id, { nick: 'ok', text: '   ' }, fresh())).status, 400);
    assert.equal((await post(s, st.id, { nick: '<i></i>', text: 'a' }, fresh())).status, 400);
    assert.equal((await post(s, st.id, { nick: 'ok' }, fresh())).status, 400);
    assert.equal((await post(s, st.id, { nick: 'x'.repeat(24), text: 'a'.repeat(280) }, fresh())).status, 200);
    const cases = [
      ['send to 0x806a315f23C241692e16fcC563Ff67b4E11BEf73 now', 'send to [link removed] now'],
      ['ca 0x1234567890 ok', 'ca [link removed] ok'],
      ['short 0xabc12345 stays', 'short 0xabc12345 stays'],
      ['go https://evil.example/x?y=1 please', 'go [link removed] please'],
      ['visit www.scam.io and t.me/scam', 'visit [link removed] and [link removed]'],
      ['evil.xyz', '[link removed]'],
      ['site peekmarquee.live/s/abc', 'site [link removed]'],
      ['0x​1234567890abcdef', '[link removed]'],
      ['you fucker', 'you ******'],
      ['price is 1.5 ok', 'price is 1.5 ok'],
    ];
    for (const [i, o] of cases) assert.equal(cleanChat(i), o, i);
    r = await post(s, st.id, { nick: 'a', text: 'pay 0x806a315f23C241692e16fcC563Ff67b4E11BEf73 via evil.com' }, fresh());
    assert.equal(r.body.text, 'pay [link removed] via [link removed]');
    r = await post(s, st.id, { nick: 'evil.com', text: 'x' }, fresh());
    assert.equal(r.body.nick, '[link removed]');
    const g = await s.get(`/api/s/${st.id}/chat?limit=2`);
    assert.equal(g.body.messages.length, 2); assert.equal(g.body.on, true); assert.equal(g.body.slowSec, 0);
    assert.ok(!JSON.stringify(g.body).includes('0x806a'));
  } finally { await s.stop(); }
});

test('chat: rate limit 1/3s and 20/min per IP -> 429 (fake clock)', async () => {
  let t = Date.UTC(2026, 10, 5, 12);
  const s = await startServer({ now: () => t }); const st = await s.stream();
  try {
    assert.equal((await post(s, st.id, { nick: 'a', text: '1' }, '10.1.1.1')).status, 200);
    assert.equal((await post(s, st.id, { nick: 'a', text: '2' }, '10.1.1.1')).status, 429);
    assert.equal((await post(s, st.id, { nick: 'a', text: '2' }, '10.1.1.2')).status, 200);
    t += 3001;
    assert.equal((await post(s, st.id, { nick: 'a', text: '3' }, '10.1.1.1')).status, 200);
    for (let i = 0; i < 25; i++) { t += 3001; assert.equal((await post(s, st.id, { nick: 'a', text: 'm' + i }, '10.1.1.1')).status, 200); } // steady 1/3s never trips the 20/min cap
    assert.equal((await post(s, st.id, { nick: 'a', text: 'burst' }, '10.1.1.1')).status, 429);
    t += 61000;
    assert.equal((await post(s, st.id, { nick: 'a', text: 'later' }, '10.1.1.1')).status, 200);
  } finally { await s.stop(); }
});

test('chat: SSE broadcasts event chat, session seq untouched, reconnect gets last 100', async () => {
  const s = await startServer(); const st = await s.stream();
  try {
    const cli = new FakeCli(s, st); await cli.connect(); cli.send('text', { text: 'a' }); cli.send('text', { text: 'a2' }); await sleep(100);
    for (let i = 0; i < 105; i++) s.db.prepare('INSERT INTO chat(streamId,nick,text,system,t,hidden) VALUES(?,?,?,?,?,0)').run(st.id, 'n', 'old' + i, 0, Date.now());
    const v = sseClient(s.base, st.id); await v.opened; await sleep(100);
    const hist = v.events.filter((e) => e.event === 'chat');
    assert.equal(hist.length, 100); assert.equal(hist[99].data.text, 'old104'); assert.equal(hist[0].data.text, 'old5');
    assert.ok(hist.every((e) => e.id === undefined));
    const r = await post(s, st.id, { nick: 'bob', text: 'live one' }, fresh()); assert.equal(r.status, 200);
    cli.send('text', { text: 'b' }); await sleep(150);
    const live = v.events.filter((e) => e.event === 'chat').pop();
    assert.equal(live.data.text, 'live one'); assert.equal(live.data.nick, 'bob');
    assert.deepEqual(v.seqs(), [1, 2, 3]);
    v.close(); cli.close();
  } finally { await s.stop(); }
});

test('chat is never sent to the CLI websocket', async () => {
  const s = await startServer(); const st = await s.stream();
  try {
    const cli = new FakeCli(s, st); await cli.connect(); cli.send('hello', { cli: 'x' });
    const v = sseClient(s.base, st.id); await v.opened;
    for (let i = 0; i < 3; i++) assert.equal((await post(s, st.id, { nick: 'bob', text: 'SECRETCHATTEXT' + i }, fresh())).status, 200);
    await s.post(`/api/s/${st.id}/chat/settings`, { slowSec: 5 }, { 'x-manage-key': st.manageKey });
    await sleep(2300);
    assert.ok(v.events.filter((e) => e.event === 'chat').length >= 3);
    assert.ok(cli.msgs.length > 0);
    for (const m of cli.msgs) assert.ok(['viewers', 'ack', 'error'].includes(m.type), m.type);
    assert.ok(!JSON.stringify(cli.msgs).includes('SECRETCHATTEXT'));
    v.close(); cli.close();
  } finally { await s.stop(); }
});

test('chat: report >=3 distinct IPs hides (same IP counts once); streamer delete / slow / off need manage key', async () => {
  const s = await startServer(); const st = await s.stream();
  try {
    const v = sseClient(s.base, st.id); await v.opened;
    const m = (await post(s, st.id, { nick: 'bad', text: 'spammy' }, fresh())).body;
    const rep = (ip) => s.post(`/api/s/${st.id}/chat/${m.id}/report`, {}, { 'x-forwarded-for': ip });
    await rep('10.2.0.1'); await rep('10.2.0.1'); await rep('10.2.0.2');
    assert.equal((await s.get(`/api/s/${st.id}/chat`)).body.messages.length, 1);
    assert.equal((await rep('10.2.0.3')).status, 200);
    assert.equal((await s.get(`/api/s/${st.id}/chat`)).body.messages.length, 0);
    await sleep(100); assert.ok(v.events.some((e) => e.event === 'chat_delete' && e.data.id === m.id));
    assert.equal((await s.post(`/api/s/${st.id}/chat/999/report`, {}, { 'x-forwarded-for': '10.2.0.5' })).status, 404);
    const m2 = (await post(s, st.id, { nick: 'x', text: 'delete me' }, fresh())).body;
    assert.equal((await s.del(`/api/s/${st.id}/chat/${m2.id}`)).status, 401);
    assert.equal((await s.del(`/api/s/${st.id}/chat/${m2.id}`, { 'x-manage-key': 'nope' })).status, 401);
    assert.equal((await s.del(`/api/s/${st.id}/chat/${m2.id}`, { 'x-manage-key': st.manageKey })).status, 200);
    assert.equal((await s.get(`/api/s/${st.id}/chat`)).body.messages.length, 0);
    assert.equal((await s.post(`/api/s/${st.id}/chat/settings`, { on: false })).status, 401);
    assert.equal((await s.post(`/api/s/${st.id}/chat/settings`, { slowSec: 9999 }, { 'x-manage-key': st.manageKey })).status, 400);
    let r = await s.post(`/api/s/${st.id}/chat/settings`, { slowSec: 30 }, { authorization: 'Bearer ' + st.ingestToken });
    assert.deepEqual(r.body, { on: true, slowSec: 30 });
    const ip = fresh();
    assert.equal((await post(s, st.id, { nick: 'a', text: '1' }, ip)).status, 200);
    r = await post(s, st.id, { nick: 'a', text: '2' }, ip); assert.equal(r.status, 429); assert.equal(r.body.error, 'slow_mode');
    assert.equal((await s.get(`/api/s/${st.id}`)).body.chatSlowSec, 30);
    r = await s.post(`/api/s/${st.id}/chat/settings`, { on: false, slowSec: 0 }, { 'x-manage-key': st.manageKey });
    assert.deepEqual(r.body, { on: false, slowSec: 0 });
    r = await post(s, st.id, { nick: 'a', text: '3' }, fresh()); assert.equal(r.status, 403); assert.equal(r.body.error, 'chat_off');
    await sleep(100); assert.ok(v.events.some((e) => e.event === 'chat_state' && e.data.on === false));
    v.close();
  } finally { await s.stop(); }
});

test('chat follows stream visibility: unknown 404, deleted 410 + rows gone, expired 410, no-replay wipes at end', async () => {
  let t = Date.UTC(2026, 10, 5, 12);
  const s = await startServer({ now: () => t });
  try {
    assert.equal((await s.get('/api/s/zzzzzzzzzz/chat')).status, 404);
    assert.equal((await post(s, 'zzzzzzzzzz', { nick: 'a', text: 'b' })).status, 404);
    const a = await s.stream();
    await post(s, a.id, { nick: 'a', text: 'b' }, fresh());
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM chat').get().c, 1);
    assert.equal((await s.del(`/api/streams/${a.id}`, { 'x-manage-key': a.manageKey })).status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM chat').get().c, 0);
    assert.equal((await s.get(`/api/s/${a.id}/chat`)).status, 410);
    assert.equal((await post(s, a.id, { nick: 'a', text: 'b' }, fresh())).status, 410);
    const p = await s.stream({ public: false });
    assert.equal((await post(s, p.id, { nick: 'a', text: 'b' }, fresh())).status, 200);
    const cli = new FakeCli(s, p); await cli.connect(); cli.send('text', { text: 'x' }); cli.send('end', { reason: 'ctrl_c' }); await sleep(200);
    assert.equal((await s.get(`/api/s/${p.id}/chat`)).body.messages.length, 1);
    assert.equal((await post(s, p.id, { nick: 'a', text: 'late' }, fresh())).status, 409);
    t += 25 * 3600e3; await s.sweep();
    assert.equal((await s.get(`/api/s/${p.id}/chat`)).status, 410);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM chat').get().c, 0);
    const n = await s.stream({ replay: false });
    await post(s, n.id, { nick: 'a', text: 'b' }, fresh());
    const c2 = new FakeCli(s, n); await c2.connect(); c2.send('text', { text: 'x' }); c2.send('end', { reason: 'ctrl_c' }); await sleep(200);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM chat WHERE streamId=?').get(n.id).c, 0);
  } finally { await s.stop(); }
});
