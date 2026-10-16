/**
 * us-3.nianhuaapi.com（年华 API 中转站）登录态抓取脚本 —— Egern
 *
 * 与 hcnsec 那套结构一致：同一个脚本文件，同时用于 http_request / http_response。
 * 抓到的内容存成「认证快照」，签到脚本直接回放，不用手填 token。
 *
 * 存储键（签到脚本会读，统一 nh_ 前缀）：
 *   nh_auth_snapshot   认证快照 JSON
 *   nh_saved_at        最近抓取时间（毫秒）
 *   nh_turnstile       顺手记下的 Turnstile token（约 5 分钟有效）
 *   nh_saw_request_headers  本次能否读到请求头（排错用）
 *
 * 环境变量：
 *   NOTIFY_ON_CAPTURE  "0" 抓到时静默（默认开）
 *   NOTIFY_ANY         "1" 没抓到也通知（排错用）
 *   NOTIFY_CHECKIN     "0" 关掉「浏览器里签到完成」的提示
 */

let ctx = null;

const API_RE = /^https?:\/\/[^/]*nianhuaapi\.com\//i;
const AUTH_PATH_RE = /\/api\/user\/(?:login|auth\/refresh|auth\/session|register)\b/i;

const WANT = ['cookie', 'authorization', 'x-auth-session', 'new-api-user', 'x-api-key'];

/* ---------------- 小工具 ---------------- */

function hget(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    try {
      const v = headers.get(name);
      return v === undefined ? null : v;
    } catch (e) { /* fallthrough */ }
  }
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v.join(', ') : v == null ? null : String(v);
    }
  }
  return null;
}

function hnames(headers) {
  if (!headers) return [];
  if (typeof headers.keys === 'function') {
    try { return Array.from(headers.keys()).map((x) => String(x).toLowerCase()); } catch (e) {}
  }
  return Object.keys(headers).map((x) => String(x).toLowerCase());
}

function readSnapshot() {
  try {
    const raw = ctx.storage.get('nh_auth_snapshot');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseCookieNames(cookie) {
  if (!cookie) return [];
  return String(cookie).split(';').map((s) => s.split('=')[0].trim()).filter(Boolean);
}

function mergeCookie(oldCookie, setCookieValues) {
  const jar = new Map();
  const order = [];
  const push = (k, v) => {
    if (!k) return;
    if (!jar.has(k)) order.push(k);
    jar.set(k, v);
  };
  if (oldCookie) {
    for (const part of String(oldCookie).split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      push(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  for (let sc of [].concat(setCookieValues || [])) {
    if (!sc) continue;
    sc = String(sc).split(';')[0];
    const i = sc.indexOf('=');
    if (i < 0) continue;
    push(sc.slice(0, i).trim(), sc.slice(i + 1).trim());
  }
  return order.map((k) => `${k}=${jar.get(k)}`).join('; ');
}

/* ---------------- 主流程 ---------------- */

export default async function (ctx_) {
  ctx = ctx_;
  const NOTIFY = ctx.env.NOTIFY_ON_CAPTURE !== '0';
  const NOTIFY_ANY = ctx.env.NOTIFY_ANY === '1';
  const DEBUG = ctx.env.DEBUG === '1';

  const rq = ctx.request || {};
  const rp = ctx.response || {};

  const url = String(
    rq.url || rp.url || (rp.request && rp.request.url) || (rp.meta && rp.meta.url) || ''
  );
  if (!API_RE.test(url) || !/\/api\//i.test(url)) return;

  const snap = readSnapshot();
  const got = [];
  const before = JSON.stringify(snap);

  /* -------- A) 请求头里的认证信息 -------- */
  const rqHeaders = rq.headers || {};
  const present = hnames(rqHeaders);
  const sawRequest = !!rq.url && present.length > 0;

  for (const name of WANT) {
    const val = hget(rqHeaders, name);
    if (!val) continue;
    if (name === 'cookie') {
      snap.cookie = snap.cookie ? mergeCookie(snap.cookie, [val]) : String(val);
      if (!snap.cookie || snap.cookie.indexOf('session=') < 0) snap.cookie = String(val);
      if (got.indexOf('Cookie') < 0) got.push('Cookie');
    } else if (name === 'authorization') {
      if (snap.authorization !== val) {
        snap.authorization = String(val);
        got.push(/^Bearer\s+sk-/i.test(val) ? 'Authorization(系统令牌)' : 'Authorization');
      }
    } else if (name === 'x-auth-session') {
      if (snap.xAuthSession !== val) { snap.xAuthSession = String(val); got.push('X-Auth-Session'); }
    } else if (name === 'new-api-user') {
      if (snap.newApiUser !== val) { snap.newApiUser = String(val); got.push('New-Api-User(用户ID)'); }
    } else if (name === 'x-api-key') {
      if (snap.xApiKey !== val) { snap.xApiKey = String(val); got.push('X-Api-Key'); }
    }
  }

  /* -------- B) 响应侧：Set-Cookie / 刷新令牌 -------- */
  if (ctx.response) {
    const rpHeaders = rp.headers || {};
    let setCookie = null;
    if (typeof rpHeaders.getAll === 'function') {
      try { setCookie = rpHeaders.getAll('set-cookie'); } catch (e) { setCookie = null; }
    }
    if (!setCookie) setCookie = hget(rpHeaders, 'set-cookie');
    if (setCookie) {
      const names = parseCookieNames(setCookie.join ? setCookie.join('; ') : setCookie);
      const merged = mergeCookie(snap.cookie, setCookie);
      if (merged && merged !== snap.cookie) {
        snap.cookie = merged;
        got.push(`Set-Cookie(${names.join('/') || '更新'})`);
      }
    }

    if (AUTH_PATH_RE.test(url)) {
      let text = null;
      try { text = await rp.text(); } catch (e) { /* body_required 未开时读不到，不算错误 */ }
      if (text) {
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        const d = (body && (body.data || body)) || {};
        const pick = (o, keys) => {
          for (const k of keys) {
            const v = k.split('.').reduce((a, b) => (a == null ? a : a[b]), o);
            if (typeof v === 'string' && v) return v;
          }
          return null;
        };
        const tok = pick(d, ['access_token', 'accessToken', 'token', 'session.access_token']);
        if (tok && snap.accessToken !== tok) { snap.accessToken = tok; got.push('access_token(响应体)'); }
        const rt = pick(d, ['refresh_token', 'refreshToken', 'session.refresh_token']);
        if (rt && snap.refreshToken !== rt) { snap.refreshToken = rt; got.push('refresh_token(响应体)'); }
        const sid = pick(d, ['sid', 'session.sid', 'session_id']);
        if (sid && snap.sessionId !== sid) { snap.sessionId = sid; got.push('session id'); }
        const uid = pick(d, ['id', 'user.id', 'user_id']);
        if (uid && String(snap.newApiUser || '') !== String(uid)) { snap.newApiUser = String(uid); got.push('用户ID(响应体)'); }
      }
    }
  }

  /* -------- B2) 顺手记下 Turnstile token -------- */
  try {
    const m = /[?&]turnstile=([^&#]+)/i.exec(url);
    const hdrTs = hget(rqHeaders, 'turnstile') || hget(rqHeaders, 'x-turnstile-token');
    const val = m ? decodeURIComponent(m[1]) : hdrTs;
    if (val && val.length > 10) {
      let prev = {};
      try { prev = JSON.parse(ctx.storage.get('nh_turnstile') || '{}'); } catch (e) { prev = {}; }
      if (prev.token !== val) ctx.storage.set('nh_turnstile', JSON.stringify({ token: val, at: Date.now(), url }));
    }
  } catch (e) { /* 忽略 */ }

  /* -------- B3) 浏览器自己签到时记下结果 -------- */
  let checkinDone = null;
  if (ctx.response && /\/api\/user\/checkin\b/i.test(url) && /POST/i.test(String(rq.method || ''))) {
    try {
      const text = await rp.text();
      const body = text ? JSON.parse(text) : null;
      if (body && body.success && body.data && typeof body.data.quota_awarded === 'number') {
        checkinDone = body.data.quota_awarded;
      }
    } catch (e) { /* 忽略 */ }
  }

  /* -------- C) 落盘 -------- */
  const changed = JSON.stringify(snap) !== before;
  if (changed || sawRequest) {
    if (changed) {
      snap.savedAt = Date.now();
      snap.lastUrl = url;
      ctx.storage.set('nh_auth_snapshot', JSON.stringify(snap));
      ctx.storage.set('nh_saved_at', String(snap.savedAt));
    }
    ctx.storage.set('nh_saw_request_headers', sawRequest ? '1' : '0');
    ctx.storage.set('nh_header_names', JSON.stringify(present));
  }

  /* -------- D) 通知 -------- */
  if (checkinDone != null && ctx.env.NOTIFY_CHECKIN !== '0') {
    ctx.notify({
      title: '年华 API 今日签到已完成 ✅',
      body: `本次获得 ${checkinDone} 额度（浏览器里点的签到）\n时间：${stamp()}`,
      sound: false,
    });
    return;
  }
  if (got.length && NOTIFY) {
    const bits = [];
    if (snap.newApiUser) bits.push(`用户ID ${snap.newApiUser}`);
    if (snap.cookie) bits.push(`Cookie ${parseCookieNames(snap.cookie).join('/')}`);
    ctx.notify({
      title: '年华 API 认证信息已抓取',
      body: `✅ 已保存：${got.join('、')}\n${bits.join('  ')}\n时间：${stamp()}\n签到脚本可以直接用了`,
      sound: false,
    });
  } else if (NOTIFY_ANY) {
    ctx.notify({
      title: '抓取脚本已运行（未抓到新信息）',
      body: `${url.replace(/^https?:\/\//, '')}\n模式：${ctx.response ? (sawRequest ? '响应+请求头' : '仅响应（读不到请求头）') : '仅请求头'}\n头：${present.join(',') || '无'}${DEBUG ? `\n${changed ? '内容有变化' : '内容无变化'}` : ''}`,
      sound: false,
    });
  }

  return;
}
