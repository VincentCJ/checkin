/**
 * api.hcnsec.cn（新疆幻城网安公益大模型网关）登录态抓取脚本 —— Egern
 *
 * 一个脚本文件，两种注册方式都可以：
 *
 *  【推荐 · 单条模式】只注册一条 http_response（body_required: true）
 *      Egern 官方文档明确说明 ctx.request 在 response 脚本里同样可用，
 *      所以这一条就能同时看到「出去的请求头」和「回来的响应体」：
 *        · 请求头 → Cookie / Authorization / X-Auth-Session / New-Api-User
 *        · 响应体 → Set-Cookie、access_token、refresh_token、sid
 *      签到脚本需要的登录态，一条钩子全部搞定。
 *      （代价：所有 /api/ 请求都会带上 body，用 max_size 限制大响应体即可）
 *
 *  【双条模式】http_request（抓请求头）+ http_response（抓刷新响应）
 *      与之前 freeapi.site 那套完全一致；若你发现某些机型/版本在
 *      response 脚本里读不到 ctx.request，就用这个更保险的形态。
 *      两条指向同一个脚本文件即可。
 *
 * 抓到的内容统一存成一份「认证快照」，签到脚本直接回放，不用你手填 token。
 *
 * 存储键（签到脚本会读）：
 *   hcnsec_auth_snapshot   认证快照 JSON（下面这些字段的合集）
 *   hcnsec_saved_at        最近一次抓取时间（毫秒）
 *   hcnsec_source          来源（request-header / response-body）
 *   hcnsec_header_names    本次抓到的头名列表（排错用）
 *
 * 环境变量：
 *   NOTIFY_ON_CAPTURE  "0" 关闭「抓到认证信息」通知（默认开）
 *   NOTIFY_ANY         "1" 即使没抓到也通知（排错用）
 *   DEBUG              "1" 在通知里带上命中的 URL（排错用）
 */

let ctx = null;

// 站点：主域 + 备用域（passkey_rp_ids 里出现的 api.iamhc.cn）
const API_RE = /^https?:\/\/(?:api\.hcnsec\.cn|api\.iamhc\.cn)\//i;
const AUTH_PATH_RE = /\/api\/user\/(?:login|auth\/refresh|auth\/session|register)\b/i;

// 要抄下来的认证相关头（大小写无关）
const WANT = ['cookie', 'authorization', 'x-auth-session', 'new-api-user', 'x-api-key'];

/* ---------------- 小工具 ---------------- */

// Egern 的 headers 是 Headers 对象（大小写无关、支持 get/getAll），
// 但也兼容普通对象 / 数组，方便本地测试。
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
    try { return Array.from(headers.keys()).map((x) => String(x).toLowerCase()); } catch (e) {};
  }
  return Object.keys(headers).map((x) => String(x).toLowerCase());
}

function readSnapshot() {
  try {
    const raw = ctx.storage.get('hcnsec_auth_snapshot');
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
  return String(cookie)
    .split(';')
    .map((s) => s.split('=')[0].trim())
    .filter(Boolean);
}

// 把 Set-Cookie 合并进现有 Cookie 串（同名覆盖，保留顺序）
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
    sc = String(sc).split(';')[0]; // 只要 name=value 段
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

  // URL：request 模式取 request.url；某些响应上下文不保证带 request，逐级回退
  const url = String(
    rq.url ||
    rp.url ||
    (rp.request && rp.request.url) ||
    (rp.meta && rp.meta.url) ||
    ''
  );
  if (!API_RE.test(url) || !/\/api\//i.test(url)) return; // 不是本站 API，原样放行

  const snap = readSnapshot();
  const got = [];
  const before = JSON.stringify(snap);

  /* -------- A) 请求头里抄一套认证头（最关键的一步） -------- */
  // 单条 http_response 模式下，Egern 也会把原始请求挂在 ctx.request 上，
  // 所以这里照样能拿到 Cookie / New-Api-User。
  const rqHeaders = rq.headers || {};
  const present = hnames(rqHeaders);
  const sawRequest = !!rq.url && present.length > 0;
  for (const name of WANT) {
    const val = hget(rqHeaders, name);
    if (!val) continue;
    if (name === 'cookie') {
      snap.cookie = snap.cookie ? mergeCookie(snap.cookie, [val]) : String(val);
      if (!snap.cookie || snap.cookie.indexOf('session=') < 0) {
        // 请求里带的 Cookie 优先（那是浏览器当下真正在用的）
        snap.cookie = String(val);
      }
      if (got.indexOf('Cookie') < 0) got.push('Cookie');
    } else if (name === 'authorization') {
      if (snap.authorization !== val) {
        snap.authorization = String(val);
        got.push(/^Bearer\s+sk-/i.test(val) ? 'Authorization(系统令牌)' : 'Authorization');
      }
    } else if (name === 'x-auth-session') {
      if (snap.xAuthSession !== val) {
        snap.xAuthSession = String(val);
        got.push('X-Auth-Session');
      }
    } else if (name === 'new-api-user') {
      if (snap.newApiUser !== val) {
        snap.newApiUser = String(val);
        got.push('New-Api-User(用户ID)');
      }
    } else if (name === 'x-api-key') {
      if (snap.xApiKey !== val) {
        snap.xApiKey = String(val);
        got.push('X-Api-Key');
      }
    }
  }

  /* -------- B) 响应侧补抓：Set-Cookie / 新令牌 -------- */
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

    // 登录 / 刷新接口的响应体里可能带着新的会话或令牌
    if (AUTH_PATH_RE.test(url)) {
      let text = null;
      try {
        text = await rp.text();
      } catch (e) {
        // 读不到响应体，多半是没开 body_required —— 不是致命错误
      }
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
        if (tok && snap.accessToken !== tok) {
          snap.accessToken = tok;
          got.push('access_token(响应体)');
        }
        const rt = pick(d, ['refresh_token', 'refreshToken', 'session.refresh_token']);
        if (rt && snap.refreshToken !== rt) {
          snap.refreshToken = rt;
          got.push('refresh_token(响应体)');
        }
        const sid = pick(d, ['sid', 'session.sid', 'session_id']);
        if (sid && snap.sessionId !== sid) {
          snap.sessionId = sid;
          got.push('session id');
        }
        const uid = pick(d, ['id', 'user.id', 'user_id']);
        if (uid && String(snap.newApiUser || '') !== String(uid)) {
          snap.newApiUser = String(uid);
          got.push('用户ID(响应体)');
        }
      }
    }
  }

  /* -------- B2) 顺手记下浏览器带过来的 Turnstile token -------- */
  // 站点签到是 POST /api/user/checkin?turnstile=XXX。token 一次一用、约 5 分钟过期，
  // 所以这里只作为「签到脚本刚好赶在窗口内」的机会，并留下排错线索。
  let tsNew = false;
  try {
    const m = /[?&]turnstile=([^&#]+)/i.exec(url);
    const hdrTs = hget(rqHeaders, 'turnstile') || hget(rqHeaders, 'x-turnstile-token');
    const val = m ? decodeURIComponent(m[1]) : hdrTs;
    if (val && val.length > 10) {
      const prev = (function () { try { return JSON.parse(ctx.storage.get('hcnsec_turnstile') || '{}'); } catch (e) { return {}; } })();
      if (prev.token !== val) {
        ctx.storage.set('hcnsec_turnstile', JSON.stringify({ token: val, at: Date.now(), url }));
        tsNew = true;
      }
    }
  } catch (e) { /* 忽略 */ }

  /* -------- B3) 浏览器自己签到时，记下结果（顺便告诉你今天已签） -------- */
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

  /* -------- C) 落盘 + 通知 -------- */
  const changed = JSON.stringify(snap) !== before;
  if (changed || sawRequest) {
    if (changed) {
      snap.savedAt = Date.now();
      snap.lastUrl = url;
      ctx.storage.set('hcnsec_auth_snapshot', JSON.stringify(snap));
      ctx.storage.set('hcnsec_saved_at', String(snap.savedAt));
      ctx.storage.set('hcnsec_source', ctx.response ? 'response-body' : 'request-header');
    }
    // 记录本次是否能看到请求头 —— 用 NOTIFY_ANY 排错时一眼看出单条模式是否生效
    ctx.storage.set('hcnsec_saw_request_headers', sawRequest ? '1' : '0');
    ctx.storage.set('hcnsec_header_names', JSON.stringify(present));
  }

  /* -------- D) 通知 -------- */
  if (checkinDone != null && ctx.env.NOTIFY_CHECKIN !== '0') {
    ctx.notify({
      title: 'api.hcnsec.cn 今日签到已完成 ✅',
      body: `本次获得 ${checkinDone} 额度（浏览器里点的签到）\n时间：${stamp()}`,
      sound: false,
    });
    return;
  }
  if (got.length && NOTIFY) {    const bits = [];
    if (snap.newApiUser) bits.push(`用户ID ${snap.newApiUser}`);
    if (snap.cookie) bits.push(`Cookie ${parseCookieNames(snap.cookie).join('/')}`);
    ctx.notify({
      title: 'api.hcnsec.cn 认证信息已抓取',
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

  return; // 请求脚本：原样放行
}
