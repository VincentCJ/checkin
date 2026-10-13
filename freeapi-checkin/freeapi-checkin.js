/**
 * freeapi.site（露娜 AI API Gateway）每日签到 —— Egern 定时脚本
 *
 * 真实接口（从前端 bundle 提取）：
 *   GET  /api/v1/user/checkin  → { enabled, checked_in_today, today_amount,
 *                                  min_amount, max_amount, total_count,
 *                                  total_amount, recent[] }
 *   POST /api/v1/user/checkin  → { amount, checked_in_today, total_amount, ... }
 *
 * Token 来源（按优先级）：
 *   1. Egern 存储 freeapi_access_token —— 由 freeapi-token-capture.js 自动抓取
 *   2. env FREEAPI_TOKEN / FREEAPI_REFRESH_TOKEN —— 手动填
 *
 * access_token 过期时用 refresh_token 自动续期并回写存储。
 */

let ctx = null; // Egern 在执行时注入，此处为模块级引用
// 下面三个在导出函数执行时从 ctx.env 初始化（顶层无法访问 ctx）
let BASE = 'https://freeapi.site';
let VERBOSE = false;
let TIMEOUT = 20000;

/* ---------- 小工具 ---------- */

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick(o, ...ks) {
  for (const k of ks) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}

function flatten(obj, prefix = '', out = []) {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push(`${key}=${Array.isArray(v) ? `[${v.length}]` : v}`);
  }
  return out;
}

function tokenFromEnv(name) {
  const raw = ctx.env[name];
  return raw ? String(raw).trim().replace(/^Bearer\s+/i, '') : '';
}

/* ---------- 请求 ---------- */

async function req(method, path, { token, body, auth = true } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'zh-CN',
  };
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const opt = { headers, timeout: TIMEOUT };
  if (body) opt.body = body;

  let res;
  if (method === 'GET') {
    // 前端 GET 都会带上 timezone 参数，保持一致
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    const tz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; }
    })();
    res = await ctx.http.get(`${BASE}${path}${sep}timezone=${encodeURIComponent(tz)}`, opt);
  } else {
    res = await ctx.http.post(`${BASE}${path}`, opt);
  }

  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}

/* ---------- Token 获取 / 自动续期 ---------- */

function nowMs() { return Date.now(); }

function saveTokens(d) {
  if (!d) return;
  if (d.access_token) ctx.storage.set('freeapi_access_token', d.access_token);
  if (d.refresh_token) ctx.storage.set('freeapi_refresh_token', d.refresh_token);
  if (d.expires_in) {
    ctx.storage.set('freeapi_expires_at', String(nowMs() + Number(d.expires_in) * 1000));
  }
  ctx.storage.set('freeapi_token_saved_at', String(nowMs()));
}

function loadTokens() {
  const access = ctx.storage.get('freeapi_access_token') || '';
  const refresh = ctx.storage.get('freeapi_refresh_token') || '';
  const exp = num(ctx.storage.get('freeapi_expires_at'));
  const savedAt = num(ctx.storage.get('freeapi_token_saved_at'));
  return { access, refresh, exp, savedAt, source: 'storage' };
}

// 用 refresh_token 换新 access_token（前端 /auth/refresh 的 body 是 { refresh_token }）
async function refreshTokens(o) {
  const rt = o.refresh || tokenFromEnv('FREEAPI_REFRESH_TOKEN');
  if (!rt) return null;
  let r;
  try {
    r = await req('POST', '/api/v1/auth/refresh', { body: { refresh_token: rt }, auth: false });
  } catch (e) {
    return null;
  }
  const d = (r.body && r.body.data) || {};
  const access = d.access_token || d.accessToken;
  if (r.status === 200 && access) {
    saveTokens(d);
    return { access, refresh: d.refresh_token || rt, exp: num(d.expires_in) ? nowMs() + d.expires_in * 1000 : undefined };
  }
  return null;
}

async function getTokens() {
  // 手动 env 优先（便于临时替换某次会话的 token）
  const envAccess = tokenFromEnv('FREEAPI_TOKEN');
  let o = loadTokens();
  if (envAccess) o = { ...o, access: envAccess, refresh: o.refresh || tokenFromEnv('FREEAPI_REFRESH_TOKEN'), source: 'env' };

  if (!o.access) return { error: 'NO_TOKEN' };

  // 已知过期 → 先刷新
  if (o.exp) {
    const TOKEN_EXPIRED = 10061;
    if (o.exp <= nowMs() + TOKEN_EXPIRED) {
      const fresh = await refreshTokens(o);
      if (fresh) return { ...o, ...fresh };
      // 刷新失败，仍用旧 token 试一次（可能是 expires_in 计算误差）
    }
  }
  return o;
}

/* ---------- 主流程 ---------- */

export default async function (ctx_) {
  ctx = ctx_; // 供模块级辅助函数使用
  BASE = (ctx.env.FREEAPI_BASE || 'https://freeapi.site').replace(/\/+$/, '');
  VERBOSE = ctx.env.NOTIFY_VERBOSE === '1';
  TIMEOUT = Number(ctx.env.HTTP_TIMEOUT || 20000);

  const lines = [];
  let failed = false;

  let t = await getTokens();
  if (t.error === 'NO_TOKEN') {
    ctx.notify({
      title: 'freeapi.site 签到失败',
      body: '❌ 未找到 Token\n请在浏览器登录一次站点（由抓取脚本自动保存），或在脚本 env 中填写 FREEAPI_TOKEN。',
      sound: true,
      action: { type: 'openUrl', url: `${BASE}/login` },
    });
    return;
  }

  const tokenRef = { ...t };

  // 1) 查询今日状态
  let st;
  try {
    st = await req('GET', '/api/v1/user/checkin', { token: tokenRef.access });
  } catch (e) {
    ctx.notify({
      title: 'freeapi.site 签到失败',
      body: `❌ 网络请求异常：${(e && e.message) || e}`,
      sound: true,
    });
    return;
  }

  // 401 → 刷新后重试一次
  if (st.status === 401 && tokenRef.refresh) {
    const fresh = await refreshTokens(tokenRef);
    if (fresh) {
      Object.assign(tokenRef, fresh);
      try {
        st = await req('GET', '/api/v1/user/checkin', { token: tokenRef.access });
      } catch (e) { /* 落到下面统一处理 */ }
    }
  }

  if (st.status === 401 || st.status === 403) {
    ctx.notify({
      title: 'freeapi.site 签到失败',
      body: `❌ Token 无效或已过期\n请重新在浏览器打开站点登录一次，由抓取脚本自动更新。`,
      sound: true,
      action: { type: 'openUrl', url: `${BASE}/login` },
    });
    return;
  }

  if (st.status !== 200) {
    const msg = flatten(st.body || {}).slice(0, 4).join('\n') || `HTTP ${st.status}`;
    ctx.notify({
      title: 'freeapi.site 签到失败',
      body: `❌ 状态查询异常 HTTP ${st.status}\n${msg}`,
      sound: true,
    });
    return;
  }

  const d = (st.body && st.body.data) || {};
  const enabled = d.enabled !== false;
  // 注意：total_amount 是「累计签到获得的总额」，不是账户余额。
  // 账户余额需另查 /api/v1/auth/me，这里不冒充余额显示。
  const totalAmount = num(pick(d, 'total_amount', 'totalAmount'));
  const totalCount = num(pick(d, 'total_count', 'totalCount'));

  if (!enabled) {
    ctx.notify({
      title: 'freeapi.site 签到',
      body: 'ℹ️ 站点当前未开启签到功能',
      sound: false,
    });
    return;
  }

  const checkedToday = d.checked_in_today === true;
  const todayAmount = num(pick(d, 'today_amount', 'todayAmount'));

  const totalLine = totalAmount !== undefined ? `🎯 签到累计：${totalAmount}` : '🎯 签到累计：未知';

  // 2) 今日已签到 → 不重复请求
  if (checkedToday) {
    lines.push('✅ 今日已签到');
    if (todayAmount !== undefined) lines.push(`🎁 今日奖励：+${todayAmount}`);
    if (totalCount !== undefined) lines.push(`📅 累计签到：${totalCount} 天`);
    lines.push(totalLine);
    if (t.savedAt) lines.push(`🔑 Token：${t.source === 'env' ? 'env 提供' : '已抓取'} · ${hhmm(t.savedAt)}`);
    ctx.notify({
      title: 'freeapi.site 签到',
      body: lines.join('\n'),
      sound: false,
      action: { type: 'openUrl', url: `${BASE}/checkin` },
    });
    return;
  }

  // 3) 执行签到
  let ck;
  try {
    ck = await req('POST', '/api/v1/user/checkin', { token: tokenRef.access });
  } catch (e) {
    ctx.notify({
      title: 'freeapi.site 签到失败',
      body: `❌ 签到请求异常：${(e && e.message) || e}`,
      sound: true,
    });
    return;
  }

  if (ck.status === 401 && tokenRef.refresh) {
    const fresh = await refreshTokens(tokenRef);
    if (fresh) {
      Object.assign(tokenRef, fresh);
      try { ck = await req('POST', '/api/v1/user/checkin', { token: tokenRef.access }); } catch (e) {}
    }
  }

  const err = ck.body && ck.body.error;
  const cd = (ck.body && ck.body.data) || {};

  const ok = ck.status === 200 && !(typeof ck.body?.code === 'number' && ck.body.code !== 0);

  if (!ok) {
    failed = true;
    const rawMsg = (err && (err.message || err.code)) ||
                   (ck.body && (ck.body.message || ck.body.code)) ||
                   `HTTP ${ck.status}`;
    const msgStr = String(rawMsg);
    if (/已签到|already|重复|checked/i.test(msgStr)) {
      lines.push('✅ 今日已签到（已由其他方式完成）');
    } else {
      lines.push(`❌ 签到失败：${msgStr}`);
    }
    if (ck.status !== 200) lines.push(`HTTP ${ck.status}`);
    if (VERBOSE) lines.push(flatten(cd).slice(0, 5).join('\n'));
  } else {
    const amount = num(pick(cd, 'amount', 'rewardAmount', 'reward_amount', 'reward', 'checkin_amount'));
    const after = num(pick(cd, 'total_amount', 'totalAmount'));
    const cnt = num(pick(cd, 'total_count', 'totalCount'));

    lines.push('✅ 签到成功');
    if (amount !== undefined) lines.push(`🎁 今日奖励：+${amount}`);
    if (after !== undefined) lines.push(`🎯 签到累计：${after}`);
    else if (totalAmount !== undefined) lines.push(`🎯 签到累计：${totalAmount}`);
    if (cnt !== undefined) lines.push(`📅 累计签到：${cnt} 天`);

    // 字段名对不上时把返回体摊平显示，便于自行校正
    if (amount === undefined && after === undefined) {
      lines.push(flatten({ ...d, ...cd }).slice(0, 6).join('\n'));
    }
  }

  if (t.savedAt) lines.push(`🔑 Token：${t.source === 'env' ? 'env 提供' : '已抓取'} · ${hhmm(t.savedAt)}`);

  ctx.notify({
    title: failed ? 'freeapi.site 签到失败' : 'freeapi.site 签到',
    body: lines.join('\n'),
    sound: failed,
    action: { type: 'openUrl', url: `${BASE}/checkin` },
  });
}