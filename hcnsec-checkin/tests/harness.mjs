/**
 * 离线测试：用假的 ctx 跑两个 Egern 脚本，验证逻辑（不联网到真站点）。
 * 用法：node tests/harness.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.MOCK_BASE || 'http://127.0.0.1:8899';

let failures = 0;
function check(name, cond, extra = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${extra ? ' — ' + extra : ''}`);
}

function makeCtx({ env = {}, store } = {}) {
  const notes = [];
  const mem = store || new Map();
  return {
    ctx: {
      env,
      script: { name: 'test' },
      storage: {
        get: (k) => (mem.has(k) ? mem.get(k) : null),
        set: (k, v) => mem.set(k, v),
        getJSON: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
        setJSON: (k, v) => mem.set(k, JSON.stringify(v)),
        delete: (k) => mem.delete(k),
      },
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
    notes,
    mem,
  };
}

async function doFetch(method, url, options = {}) {
  const { timeout, policy, policyDescriptor, ...rest } = options;
  return fetch(url, { method, ...rest, headers: rest.headers || {} });
}

const load = async (file) =>
  (await import(pathToFileURL(path.join(DIR, file)).href + `?t=${Date.now()}`)).default;

/* ---------------- 测试 ---------------- */

console.log('== 1. http_request 抓取脚本（浏览器真实请求头） ==');
const capture = await load('hcnsec-auth-capture.js');
const { ctx: c1, notes: n1, mem: m1 } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '1' } });
await capture({
  request: {
    method: 'GET',
    url: 'https://api.hcnsec.cn/api/user/self',
    headers: {
      Cookie: 'session=abc123session; theme=dark',
      'New-Api-User': '42',
      'Accept': 'application/json',
    },
  },
  env: c1.env,
  storage: c1.storage,
  notify: c1.notify,
  http: c1.http,
});
const snap1 = JSON.parse(m1.get('hcnsec_auth_snapshot') || '{}');
check('抓到 Cookie', snap1.cookie === 'session=abc123session; theme=dark', snap1.cookie);
check('抓到用户ID', snap1.newApiUser === '42');
check('有通知', n1.length === 1, n1[0] && n1[0].title);

console.log('== 2. 非本站请求应放行（不写存储） ==');
const { ctx: c2, mem: m2 } = makeCtx({ env: {} });
await capture({ request: { url: 'https://other.com/api/user/self', headers: { cookie: 'session=x' } }, env: c2.env, storage: c2.storage, notify: c2.notify, http: c2.http });
check('未写入快照', m2.get('hcnsec_auth_snapshot') === undefined);

console.log('== 3. http_response 抓取刷新接口（Set-Cookie + 新令牌） ==');
const { ctx: c3, mem: m3 } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '0' } });
await capture({
  request: { url: 'https://api.hcnsec.cn/api/user/auth/refresh', headers: { cookie: 'session=old' } },
  response: {
    url: 'https://api.hcnsec.cn/api/user/auth/refresh',
    status: 200,
    headers: {
      getAll: (k) => (k.toLowerCase() === 'set-cookie'
        ? ['session=newfresh; Path=/; HttpOnly', 'csrf=tok1; Path=/'] : []),
      get: (k) => (k.toLowerCase() === 'set-cookie' ? 'session=newfresh' : null),
    },
    text: async () => JSON.stringify({ success: true, data: { access_token: 'sk-new', refresh_token: 'rt-new', sid: 'sid-1', id: 42 } }),
  },
  env: c3.env, storage: c3.storage, notify: c3.notify, http: c3.http,
});
const snap3 = JSON.parse(m3.get('hcnsec_auth_snapshot') || '{}');
check('Set-Cookie 覆盖了旧 session', /session=newfresh/.test(snap3.cookie), snap3.cookie);
check('保留了其他 cookie', /csrf=tok1/.test(snap3.cookie), snap3.cookie);
check('抓到 access_token', snap3.accessToken === 'sk-new');
check('抓到 refresh_token', snap3.refreshToken === 'rt-new');
check('抓到 sid', snap3.sessionId === 'sid-1');

/* ---- 签到脚本 ---- */

async function runCheckin({ env = {}, seed = null } = {}) {
  const { ctx, notes, mem } = makeCtx({ env });
  if (seed) mem.set('hcnsec_auth_snapshot', JSON.stringify(seed));
  const fn = await load('hcnsec-checkin.js');
  const wrapped = {
    ...ctx,
    env: { ...env, HCN_API_BASE: env.HCN_API_BASE || BASE },
  };
  await fn(wrapped);
  return { notes, mem };
}

console.log('== 4. 正常签到（应报「签到成功」并带收益） ==');
// 重置模拟服务器状态：重启由外部控制，这里直接用未签到状态
let r = await runCheckin({ env: { NOTIFY_ALWAYS: '1' }, seed: { cookie: 'session=abc123session', newApiUser: '42' } });
let last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('标题为签到成功', /签到成功/.test(last.title), last.title);
check('包含收益', /\+¥0\.01|收益/.test(last.body), last.body.replace(/\n/g, ' | '));
check('包含用户', /幻城用户/.test(last.body), last.body.replace(/\n/g, ' | '));

console.log('== 5. 重复签到（应报「今日已签到」） ==');
r = await runCheckin({ env: { NOTIFY_ALWAYS: '1' }, seed: { cookie: 'session=abc123session', newApiUser: '42' } });
last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('识别重复签到', /已签到/.test(last.title) || /已经领过/.test(last.body), last.title);

console.log('== 5b. NOTIFY_ALWAYS=0 时重复签到保持安静 ==');
r = await runCheckin({ env: { NOTIFY_ALWAYS: '0' }, seed: { cookie: 'session=abc123session', newApiUser: '42' } });
check('未推送通知', r.notes.length === 0, JSON.stringify(r.notes));
check('但仍写入了运行记录', !!r.mem.get('hcnsec_last_run'));

console.log('== 6. 登录态失效（401） ==');
r = await runCheckin({ env: {}, seed: { cookie: 'session=stale', newApiUser: '42' } });
last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('提示登录态失效', /登录态失效/.test(last.title), last.title);
check('提示重新登录', /重新登录/.test(last.body), last.body.replace(/\n/g, ' | '));

console.log('== 7. 没有凭据 ==');
r = await runCheckin({ env: {} });
last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('提示未执行', /未执行/.test(last.title), last.title);

console.log('== 8. 系统访问令牌模式（sk-xxx + 用户ID） ==');
r = await runCheckin({ env: { HCN_ACCESS_TOKEN: 'sk-mocktoken', HCN_USER_ID: '42' } });
last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('令牌模式可用', /签到/.test(last.title) && !/失败/.test(last.title), last.title);

console.log('== 9. 试运行 DRY_RUN 不应改变额度 ==');
r = await runCheckin({ env: { HCN_DRY_RUN: '1' }, seed: { cookie: 'session=abc123session', newApiUser: '42' } });
last = r.notes[r.notes.length - 1] || { title: '', body: '' };
check('试运行提示', /试运行/.test(last.title), last.title);

console.log('== 10. 单条模式：http_response 里同时拿到请求头 + 响应体 ==');
const { ctx: c10, mem: m10, notes: n10 } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '0', NOTIFY_ANY: '1' } });
await capture({
  // 响应脚本里 Egern 也会挂上原始请求
  request: {
    method: 'GET',
    url: 'https://api.hcnsec.cn/api/user/self',
    headers: { Cookie: 'session=single-mode', 'New-Api-User': '77', 'sec-fetch-mode': 'cors' },
  },
  response: {
    url: 'https://api.hcnsec.cn/api/user/self',
    status: 200,
    headers: {
      getAll: (k) => (k.toLowerCase() === 'set-cookie' ? ['session=single-mode; Path=/'] : []),
      get: (k) => (k.toLowerCase() === 'set-cookie' ? 'session=single-mode' : null),
    },
    text: async () => JSON.stringify({ success: true, data: { id: 77, quota: 1 } }),
  },
  env: c10.env, storage: c10.storage, notify: c10.notify, http: c10.http,
});
const snap10 = JSON.parse(m10.get('hcnsec_auth_snapshot') || '{}');
check('单条模式下抓到请求头 Cookie', snap10.cookie === 'session=single-mode', snap10.cookie);
check('单条模式下抓到用户ID', snap10.newApiUser === '77');
check('记录了「能看到请求头」', m10.get('hcnsec_saw_request_headers') === '1');
check('未抓到时也提示运行模式', /响应\+请求头/.test((n10[n10.length - 1] || {}).body || ''), (n10[n10.length - 1] || {}).body.replace(/\n/g, ' | '));

console.log('== 11. 若某些版本 response 里没有 ctx.request，不应崩溃 ==');
const { ctx: c11, mem: m11, notes: n11 } = makeCtx({ env: { NOTIFY_ON_CAPTURE: '1', NOTIFY_ANY: '1' } });
let err11 = null;
try {
  await capture({
    response: {
      url: 'https://api.hcnsec.cn/api/user/auth/refresh',
      status: 200,
      headers: { getAll: () => [], get: () => null },
      text: async () => JSON.stringify({ success: true, data: { access_token: 'sk-from-refresh' } }),
    },
    env: c11.env, storage: c11.storage, notify: c11.notify, http: c11.http,
  });
} catch (e) { err11 = e; }
check('没有抛异常', !err11, err11 && String(err11));
const snap11 = JSON.parse(m11.get('hcnsec_auth_snapshot') || '{}');
check('仍从响应体抓到令牌', snap11.accessToken === 'sk-from-refresh', JSON.stringify(snap11));
check('标记为读不到请求头', m11.get('hcnsec_saw_request_headers') === '0');

console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
process.exit(failures ? 1 : 0);
