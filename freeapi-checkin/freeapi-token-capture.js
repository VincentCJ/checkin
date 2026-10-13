/**
 * freeapi.site（露娜）Token 抓取脚本 —— Egern
 *
 * 这个脚本可以同时作为 http_request 和 http_response 两种类型使用：
 *   · 作为 http_request：从「请求头」里取 Authorization: Bearer xxx
 *       → 只要你开着 Egern 正常浏览站点（任何已认证请求都行），就能抓到
 *       → 不需要 body_required，可靠性最高
 *   · 作为 http_response：从 /auth/login、/auth/refresh 的「响应体」里取
 *       → 额外抓到 refresh_token，用于 access_token 过期后自动续期
 *
 * 存储键（签到脚本会直接读）：
 *   freeapi_access_token   访问令牌
 *   freeapi_refresh_token  刷新令牌
 *   freeapi_expires_at     过期时间戳（毫秒）
 *   freeapi_token_saved_at 最近一次抓取时间（毫秒）
 *   freeapi_token_source   来源（request-header / response-body）
 *
 * 环境变量：
 *   NOTIFY_ON_CAPTURE  "0" 关闭「抓到 token」的通知（默认开）
 *   NOTIFY_ANY         "1" 即使没抓到新 token 也通知（排错用）
 */

let ctx = null;

const API_RE = /^https?:\/\/[^/]*freeapi\.site\/api\/v1\//i;
const AUTH_RE = /\/api\/v1\/auth\/(login|refresh)\b/i;
const BEARER_RE = /^Bearer\s+(.+)$/i;

function saveAccess(tok) {
  const prev = ctx.storage.get('freeapi_access_token');
  if (prev === tok) return false;
  ctx.storage.set('freeapi_access_token', tok);
  ctx.storage.set('freeapi_token_saved_at', String(Date.now()));
  ctx.storage.set('freeapi_token_source', 'request-header');
  return true;
}

function saveRefresh(tok) {
  if (!tok) return false;
  const prev = ctx.storage.get('freeapi_refresh_token');
  if (prev === tok) return false;
  ctx.storage.set('freeapi_refresh_token', tok);
  ctx.storage.set('freeapi_token_saved_at', String(Date.now()));
  return true;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default async function (ctx_) {
  ctx = ctx_;
  const NOTIFY = ctx.env.NOTIFY_ON_CAPTURE !== '0';
  const NOTIFY_ANY = ctx.env.NOTIFY_ANY === '1';

  // URL 取值：http_request 模式下取 ctx.request，http_response 模式下
  // 某些上下文不保证带 request，所以依次回退到 response 侧的字段。
  // 全部拿不到时 url 为空，会被下面的 API_RE 挡掉（等于不处理）。
  const rq = ctx.request || {};
  const rp = ctx.response || {};
  const url = String(
    rq.url ||
    rp.url ||
    (rp.request && rp.request.url) ||
    (rp.meta && rp.meta.url) ||
    ''
  );
  if (!API_RE.test(url)) return; // 不是本站 API，原样放行

  let got = [];   // 本次抓到的东西
  let note = '';  // 没抓到时的原因（排错用）

  /* ---------- A) 请求头里的 access_token ---------- */
  // 任何已认证请求都会带 Authorization，最可靠
  const h = (ctx.request && ctx.request.headers) || {};
  const rawAuth = h['authorization'] || h['Authorization'];
  const authVal = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (authVal) {
    const m = BEARER_RE.exec(String(authVal).trim());
    if (m && m[1]) {
      if (saveAccess(m[1])) got.push('access_token（请求头）');
      else note = 'token 与已存的一致';
    }
  } else {
    note = '请求头没有 Authorization';
  }

  /* ---------- B) 响应体里的 refresh_token ---------- */
  if (ctx.response && AUTH_RE.test(url)) {
    let text = null;
    try {
      text = await ctx.response.text();
    } catch (e) {
      note = '读不到响应体 → 请把 body_required 设为 true';
    }
    if (text) {
      let body = null;
      try { body = JSON.parse(text); } catch (e) { body = null; }
      const d = (body && body.data) || {};
      if (d.access_token && saveAccess(d.access_token)) {
        ctx.storage.set('freeapi_token_source', 'response-body');
        got.push('access_token（响应体）');
      }
      if (saveRefresh(d.refresh_token)) got.push('refresh_token');
      if (d.expires_in) {
        ctx.storage.set('freeapi_expires_at', String(Date.now() + Number(d.expires_in) * 1000));
      }
      if (!d.access_token && !d.refresh_token) {
        note = '响应里没有 token 字段（可能登录失败/需要验证码）';
      }
    }
  }

  /* ---------- 通知 ---------- */
  if (got.length && NOTIFY) {
    ctx.notify({
      title: 'freeapi.site Token 已抓取',
      body: `✅ 已保存：${got.join('、')}\n时间：${stamp()}\n签到脚本可以直接用了`,
      sound: false,
    });
  } else if (NOTIFY_ANY) {
    ctx.notify({
      title: '抓取脚本已运行（未抓到）',
      body: `URL：${url.replace(/^https?:\/\//, '')}\n${note || '无新 token'}`,
      sound: false,
    });
  }

  return; // 请求脚本：原样放行
}