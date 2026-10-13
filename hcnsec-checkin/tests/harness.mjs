/**
 * 离线测试：用假的 ctx 跑两个 Egern 脚本，验证逻辑（不联网到真站点）。
 * 用法：node tests/harness.mjs
 * 需要先起模拟站点：MOCK_TURNSTILE=1 python3 tests/mock-server.py 8899 &
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.MOCK_BASE || 'http://127.0.0.1:8899';

// 每次运行前把模拟站点的状态清干净（跨模式连跑也不会互相污染）
try {
  const r = await fetch(BASE + '/__reset');
  const j = await r.json();
  process.env.MOCK_TURNSTILE = j.turnstile ? '1' : '0';
} catch (e) {
  console.error('无法连接模拟站点，请先运行：python3 tests/mock-server.py 8899 &');
  process.exit(2);
}

let failures = 0;
function check(name, cond, extra = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${extra ? ' — ' + extra : ''}`);
}

function makeCtx({ env = {}, store } = {}) {
  const notes = [];
  const mem = store || new Map();
  const storage = {
    get: (k) => (mem.has(k) ? mem.get(k) : null),
    set: (k, v) => mem.set(k, String(v)),
    getJSON: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
    setJSON: (k, v) => mem.set(k, JSON.stringify(v)),
    delete: (k) => mem.delete(k),
  };
  return {
    ctx: {
      env, script: { name: 'test' }, storage,
      notify: (o) => { notes.push(o); },
      http: {
        get: (u, o) => doFetch('GET', u, o),
        post: (u, o) => doFetch('POST', u, o),
        put: (u, o) => doFetch('PUT', u, o),
        delete: (u, o) => doFetch('DELETE', u, o),
      },
      _notes: notes,
      _mem: mem,
    },
    notes, mem, storage,
  };
}

async function doFetch(method, url, options = {}) {
  const { timeout, policy, policyDescriptor, ...rest } = options;
  return fetch(url, { method, ...rest, headers: rest.headers || {} });
}

const load = async (file) =>
  (await import(pathToFileURL(path.join(DIR, file)).href + `?t=${Date.now()}`)).default;

const last = (notes) => notes[notes.length - 1] || { title: '', body: '' };

/* ---------------- 抓取脚本 ---------------- */

console.log('== 1. http_request 抓取脚本（浏览器真实请求头） ==');
const capture = await load('hcnsec-auth-capture.js');
{
  const { ctx, notes, mem } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '1' } });
  await capture({
    request: {
      method: 'GET', url: 'https://api.hcnsec.cn/api/user/self',
      headers: { Cookie: 'session=abc123session; new_api_refresh=R1', 'New-Api-User': '42' },
    },
    env: ctx.env, storage: ctx.storage, notify: ctx.notify, http: ctx.http,
  });
  const snap = JSON.parse(mem.get('hcnsec_auth_snapshot') || '{}');
  check('抓到 Cookie', /session=abc123session/.test(snap.cookie), snap.cookie);
  check('抓到用户ID', snap.newApiUser === '42');
  check('有通知', notes.length === 1, last(notes).title);
}

console.log('== 2. 非本站请求放行 ==');
{
  const { ctx, mem } = makeCtx({ env: {} });
  await capture({ request: { url: 'https://other.com/api/x', headers: { cookie: 'session=x' } },
    env: ctx.env, storage: ctx.storage, notify: ctx.notify, http: ctx.http });
  check('未写入快照', mem.get('hcnsec_auth_snapshot') === undefined);
}

console.log('== 3. 单条模式：response 里同时拿请求头 + 响应体 ==');
{
  const { ctx, mem, notes } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '0', NOTIFY_ANY: '1' } });
  await capture({
    request: { method: 'GET', url: 'https://api.hcnsec.cn/api/user/self',
      headers: { Cookie: 'session=single', 'New-Api-User': '77' } },
    response: {
      url: 'https://api.hcnsec.cn/api/user/self', status: 200,
      headers: { getAll: () => [], get: () => null },
      text: async () => JSON.stringify({ success: true, data: { id: 77 } }),
    },
    env: ctx.env, storage: ctx.storage, notify: ctx.notify, http: ctx.http,
  });
  const snap = JSON.parse(mem.get('hcnsec_auth_snapshot') || '{}');
  check('单条模式抓到请求头', snap.cookie === 'session=single', snap.cookie);
  check('标记能看到请求头', mem.get('hcnsec_saw_request_headers') === '1');
  check('通知里显示模式', /响应\+请求头/.test(last(notes).body), last(notes).body.replace(/\n/g, ' | '));
}

console.log('== 4. 抓到浏览器签到请求里的 Turnstile token ==');
{
  const { ctx, mem } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '0', NOTIFY_CHECKIN: '0' } });
  await capture({
    request: { method: 'POST', url: 'https://api.hcnsec.cn/api/user/checkin?turnstile=0.abcXYZtoken123',
      headers: { Cookie: 'session=abc123session', 'New-Api-User': '42' } },
    env: ctx.env, storage: ctx.storage, notify: ctx.notify, http: ctx.http,
  });
  const ts = JSON.parse(mem.get('hcnsec_turnstile') || '{}');
  check('token 已留存', ts.token === '0.abcXYZtoken123', JSON.stringify(ts).slice(0, 80));
}

console.log('== 5. 浏览器签到时通知「今日已签到」 ==');
{
  const { ctx, mem, notes } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '0' } });
  await capture({
    request: { method: 'POST', url: 'https://api.hcnsec.cn/api/user/checkin?turnstile=0.tok',
      headers: { Cookie: 'session=abc123session', 'New-Api-User': '42' } },
    response: {
      url: 'https://api.hcnsec.cn/api/user/checkin?turnstile=0.tok', status: 200,
      headers: { getAll: () => [], get: () => null },
      text: async () => JSON.stringify({ success: true, message: '签到成功',
        data: { quota_awarded: 8888, checkin_date: '2026-10-13' } }),
    },
    env: ctx.env, storage: ctx.storage, notify: ctx.notify, http: ctx.http,
  });
  check('通知签到完成', /今日签到已完成/.test(last(notes).title), last(notes).title);
  check('带上奖励额度', /8888/.test(last(notes).body), last(notes).body.replace(/\n/g, ' | '));
}

/* ---------------- 签到脚本 ---------------- */

async function runCheckin({ env = {}, seed = {}, ts = null } = {}) {
  const { ctx, notes, mem, storage } = makeCtx({ env });
  if (Object.keys(seed).length) storage.set('hcnsec_auth_snapshot', JSON.stringify(seed));
  if (ts) storage.set('hcnsec_turnstile', JSON.stringify(ts));
  const fn = await load('hcnsec-checkin.js');
  await fn({ ...ctx, env: { ...env, HCN_API_BASE: env.HCN_API_BASE || BASE } });
  return { notes, mem, last: last(notes) };
}

const CRED = { cookie: 'session=abc123session', newApiUser: '42' };

const TS_OFF = process.env.MOCK_TURNSTILE === '0'; // 由模拟站点 /__reset 回报的真实模式决定

console.log(`== 6. ${TS_OFF ? '站点关闭人机验证：无 token 也应直接签到成功' : '带 Turnstile 时无 token：应提示「需要手动签到」而不是失败'} ==`);
{
  const r = await runCheckin({ seed: CRED });
  if (TS_OFF) {
    check('自动签到成功', /签到成功/.test(r.last.title), r.last.title);
  } else {
    check('标题为需要手动签到', /需要手动签到/.test(r.last.title), r.last.title);
    check('通知带 openUrl 动作', !!(r.last.action && r.last.action.type === 'openUrl' && /^https?:\/\//.test(r.last.action.url)),
      JSON.stringify(r.last.action));
    check('记录标记 needsHuman', /"needsHuman":true/.test(r.mem.get('hcnsec_last_run') || ''), r.mem.get('hcnsec_last_run'));
  }
}

if (!TS_OFF) {
console.log('== 7. 提供有效 Turnstile token：应签到成功并报奖励 ==');
{
  const r = await runCheckin({ env: { HCN_TURNSTILE: '0.mock-turnstile-token' }, seed: CRED });
  check('标题为签到成功', /签到成功/.test(r.last.title), r.last.title);
  check('奖励来自 quota_awarded', /\+¥0\.01/.test(r.last.body) && /5000 额度/.test(r.last.body),
    r.last.body.replace(/\n/g, ' | '));
}

console.log('== 8. 今天已签到：直接报「今日已签到」，不再打签到接口 ==');
{
  const r = await runCheckin({ env: { HCN_TURNSTILE: '0.mock-turnstile-token' }, seed: CRED });
  check('标题为今日已签到', /今日已签到/.test(r.last.title), r.last.title);
  check('带累计签到信息', /累计签到/.test(r.last.body), r.last.body.replace(/\n/g, ' | '));
}

console.log('== 9. NOTIFY_ALWAYS=0 时已签到保持安静 ==');
{
  const r = await runCheckin({ env: { HCN_TURNSTILE: '0.mock-turnstile-token', NOTIFY_ALWAYS: '0' }, seed: CRED });
  check('未推送通知', r.notes.length === 0, JSON.stringify(r.notes));
  check('仍写运行记录', !!r.mem.get('hcnsec_last_run'));
}
} // end if (!TS_OFF)

console.log('== 10. 登录态失效 ==');
{
  const r = await runCheckin({ seed: { cookie: 'session=stale', newApiUser: '42' } });
  check('提示登录态失效', /登录态失效/.test(r.last.title), r.last.title);
}

console.log('== 11. 没有凭据 ==');
{
  const r = await runCheckin({});
  check('提示未执行', /未执行/.test(r.last.title), r.last.title);
}

console.log('== 12. DRY_RUN 只看不动 ==');
{
  const r = await runCheckin({ env: { HCN_DRY_RUN: '1' }, seed: CRED });
  check('提示试运行', /试运行/.test(r.last.title), r.last.title);
  check('报告人机验证开关', /人机验证：开启/.test(r.last.body), r.last.body.replace(/\n/g, ' | '));
}

console.log('== 13. 系统令牌模式 ==');
{
  const r = await runCheckin({ env: { HCN_ACCESS_TOKEN: 'Bearer sk-mocktoken', HCN_USER_ID: '42' } });
  check('令牌模式可用', /签到|已签到/.test(r.last.title), r.last.title);
}

console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
process.exit(failures ? 1 : 0);
