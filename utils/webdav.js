/**
 * WebDAV 客户端 —— 仅支持坚果云
 *
 * 为什么只支持一家:
 *   小程序的网络请求目标域名必须**发布期就登记**在后台"服务器域名"里,
 *   用户运行时填的任意地址访问不了。所以只能预置固定服务商。
 *   国内想要 WebDAV 同步的用户绝大多数用坚果云,且它满足全部硬条件:
 *   固定域名、HTTPS、有效证书、支持应用密码(不必交出主密码)。
 *
 * ⚠️ 上线前必须在小程序后台把 `dav.jianguoyun.com` 加进 request 合法域名,否则真机请求会被拦。
 *
 * 动词限制:wx.request 的 method 白名单里没有 PROPFIND / MKCOL。所以:
 *   - 列备份 → 自己维护 index.json 清单(每次上传时同步更新)
 *   - 建目录 → 做不到,要求用户先在坚果云里建好文件夹
 *   - 测连通 → 用 PUT 探针。WebDAV 对"父目录不存在"的 PUT 返回 409,
 *     正好用来区分"认证失败"和"目录没建"。
 */

const { bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } = require('./hash.js');

const PROVIDERS = {
  jianguoyun: {
    id: 'jianguoyun',
    name: '坚果云',
    host: 'https://dav.jianguoyun.com/dav',
    accountLabel: '坚果云账号(邮箱)',
    passwordLabel: '应用密码',
    // 坚果云的应用密码在网页版「账户信息 → 安全选项 → 添加应用」里生成
    helpText: '请在坚果云网页版「账户信息 → 安全选项 → 添加应用」生成应用密码,不要填登录密码。',
    // 免费版有流量与请求频率限制,频繁同步可能被限流(503)
    freeTierNote: '免费版每月上传 1GB / 下载 3GB,并有请求频率限制。',
  },
};

const INDEX_FILENAME = 'index.json';
const PROBE_FILENAME = '.otplab-probe';
const REQUEST_TIMEOUT = 15000;

function provider(id = 'jianguoyun') {
  const found = PROVIDERS[id];
  if (!found) throw new Error('不支持的服务商');
  return found;
}

function authHeader(config) {
  if (!config || !config.account || !config.appPassword) {
    throw new Error('请先配置坚果云账号和应用密码');
  }
  return 'Basic ' + bytesToBase64(utf8ToBytes(`${config.account}:${config.appPassword}`));
}

/**
 * 规范化坚果云文件夹地址。
 * 目录由用户直接填写在 WebDAV 地址中，例如
 * `https://dav.jianguoyun.com/dav/keyscan`，程序不再自动追加目录。
 */
function normalizeDirectory(directory) {
  let value = String(directory || '').trim();
  if (/^https?:\/\//i.test(value)) {
    const match = value.match(/^https?:\/\/[^/]+(\/.*)?$/i);
    value = match && match[1] ? match[1] : '';
    value = value.replace(/^\/dav(?:\/|$)/i, '');
  }
  return value.replace(/^\/+|\/+$/g, '');
}

function hasSpecificDirectory(directory) {
  return normalizeDirectory(directory).length > 0;
}

function buildUrl(config, filename) {
  const base = String((config && config.url) || provider(config && config.provider).host).trim().replace(/\/+$/, '');
  // 只允许 https。Basic 认证是把「账号:应用密码」做 base64 放在请求头里,
  // base64 不是加密 —— 走 http 等于把凭据明文发出去。
  // 小程序线上环境本来就强制 https,但开发者工具可以勾掉校验,别在那儿留个口子。
  if (/^http:\/\//i.test(base)) throw new Error('WebDAV 地址必须使用 https://（http 会明文发送账号密码）');
  if (!/^https:\/\//i.test(base)) throw new Error('WebDAV 地址必须以 https:// 开头');
  // 用户填写的 url 已经是最终 WebDAV 根地址，不再自动追加目录。
  const path = filename;
  // 路径里的中文和空格必须编码,但斜杠要保留
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encoded}`;
}

/** 把 HTTP 状态码翻译成用户能照着做的提示 */
function describeStatus(status, context) {
  if (status === 401) return '账号或应用密码不正确。请确认填的是「应用密码」,不是坚果云登录密码。';
  if (status === 403) return '坚果云拒绝了访问,可能是应用密码权限不足或空间已满。';
  if (status === 404) return context === 'download' ? '备份文件不存在,可能已在坚果云里被删除。' : '路径不存在。';
  if (status === 409) return '坚果云上找不到这个文件夹。请先在坚果云里手动建好,小程序无法创建文件夹。';
  if (status === 423) return '文件被锁定,请稍后重试。';
  if (status === 503) return '坚果云限流了(免费版有请求频率限制),请过几分钟再试。';
  if (status === 507 || status === 413) return '坚果云空间或流量不足。';
  if (status >= 500) return `坚果云服务异常(${status}),请稍后重试。`;
  return `请求失败(${status})。`;
}

/**
 * 底层请求。wx.request 在小程序里可用;测试环境走 node https,便于本地联调。
 * @returns {Promise<{status:number, data:ArrayBuffer|string}>}
 */
function request({ url, method, header, data, responseType }) {
  return new Promise((resolve, reject) => {
    if (typeof wx !== 'undefined' && wx.request) {
      // wx.request 的 data 只收 string / object / ArrayBuffer。
      // Uint8Array 会被 JSON 序列化成 {"0":...} —— 云端备份文件直接坏掉。
      // 必须取底层 buffer(与 backup 页写本地文件的做法一致)。
      if (data instanceof Uint8Array) {
        data = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
      }
      wx.request({
        url,
        method,
        header,
        data,
        responseType: responseType || 'text',
        timeout: REQUEST_TIMEOUT,
        success: (res) => resolve({ status: res.statusCode, data: res.data }),
        fail: (err) => {
          const message = err && err.errMsg ? err.errMsg : '网络错误';
          // 域名没登记时,微信报的就是这个,单独提示,否则很难查
          if (/url not in domain list|不在以下 request 合法域名/i.test(message)) {
            reject(new Error('dav.jianguoyun.com 未加入小程序后台的 request 合法域名。'));
            return;
          }
          reject(new Error('网络请求失败:' + message));
        },
      });
      return;
    }

    // 测试环境
    const https = require('https');
    const { URL } = require('url');
    const target = new URL(url);
    const body = data instanceof Uint8Array ? Buffer.from(data) : data ? Buffer.from(data) : null;
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method,
        headers: Object.assign({}, header, body ? { 'Content-Length': body.length } : {}),
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            data: responseType === 'arraybuffer' ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) : buffer.toString('utf8'),
          });
        });
      }
    );
    req.on('error', (err) => reject(new Error('网络请求失败:' + err.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 测试连接。用 PUT 一个探针文件来验证"能认证 + 目录存在 + 可写",
 * 比只读探测靠得住 —— 毕竟备份要的是写权限。
 * @returns {Promise<{ok: true}>} 失败时抛错,错误信息可直接给用户看
 */
async function testConnection(config) {
  const url = buildUrl(config, PROBE_FILENAME);
  const payload = utf8ToBytes(`otplab probe ${Date.now()}`);
  const res = await request({
    url,
    method: 'PUT',
    header: { Authorization: authHeader(config), 'Content-Type': 'application/octet-stream' },
    data: payload,
  });
  if (res.status >= 200 && res.status < 300) {
    // 探针留着没意义,顺手删掉。删不掉也不算失败。
    try {
      await request({ url, method: 'DELETE', header: { Authorization: authHeader(config) } });
    } catch (e) { /* 忽略 */ }
    return { ok: true };
  }
  throw new Error(describeStatus(res.status, 'upload'));
}

/** 上传字节。name 是文件名,不含路径。 */
async function upload(config, name, bytes) {
  const res = await request({
    url: buildUrl(config, name),
    method: 'PUT',
    header: { Authorization: authHeader(config), 'Content-Type': 'application/octet-stream' },
    data: bytes,
  });
  if (res.status >= 200 && res.status < 300) return true;
  throw new Error(describeStatus(res.status, 'upload'));
}

/** 下载为 Uint8Array */
async function download(config, name) {
  const res = await request({
    url: buildUrl(config, name),
    method: 'GET',
    header: { Authorization: authHeader(config) },
    responseType: 'arraybuffer',
  });
  if (res.status >= 200 && res.status < 300) return new Uint8Array(res.data);
  throw new Error(describeStatus(res.status, 'download'));
}

/** 删除远端文件。404 视为已删除,不报错。 */
async function remove(config, name) {
  const res = await request({
    url: buildUrl(config, name),
    method: 'DELETE',
    header: { Authorization: authHeader(config) },
  });
  if ((res.status >= 200 && res.status < 300) || res.status === 404) return true;
  throw new Error(describeStatus(res.status, 'delete'));
}

// ---- index.json 清单:替代 PROPFIND ----

function emptyIndex() {
  return { format: 'otplab-webdav-index', version: 1, updatedAt: 0, backups: [] };
}

/**
 * 读清单。不存在(404)时返回空清单 —— 首次备份的正常情形。
 * 内容坏了也返回空清单而不抛错,否则用户会被一个坏文件卡住无法备份。
 */
async function readIndex(config) {
  let raw;
  try {
    raw = await download(config, INDEX_FILENAME);
  } catch (e) {
    if (/不存在/.test(e.message)) return emptyIndex();
    throw e;
  }
  try {
    const parsed = JSON.parse(bytesToUtf8(raw));
    if (!parsed || !Array.isArray(parsed.backups)) return emptyIndex();
    return parsed;
  } catch (e) {
    return emptyIndex();
  }
}

async function writeIndex(config, index) {
  const payload = Object.assign({}, index, { updatedAt: Date.now() });
  await upload(config, INDEX_FILENAME, utf8ToBytes(JSON.stringify(payload)));
  return payload;
}

/**
 * 上传一份备份并更新清单。
 * 顺序很关键:先传备份、再更新清单。反过来的话清单里会出现不存在的文件。
 * @param {{maxKeep?: number}} [options] 超出保留数时删掉最旧的
 */
async function uploadBackup(config, name, bytes, options = {}) {
  await upload(config, name, bytes);

  const index = await readIndex(config);
  index.backups = index.backups.filter((item) => item.name !== name);
  index.backups.unshift({
    name,
    size: bytes.length,
    createdAt: Date.now(),
    source: '微信小程序',
  });
  index.backups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const maxKeep = options.maxKeep || 20;
  const dropped = index.backups.slice(maxKeep);
  index.backups = index.backups.slice(0, maxKeep);

  await writeIndex(config, index);

  // 清单已经是准的了,旧文件删失败也不影响正确性,静默处理
  for (const item of dropped) {
    try { await remove(config, item.name); } catch (e) { /* 忽略 */ }
  }
  return index;
}

/** 列出远端备份(读清单) */
async function listBackups(config) {
  const index = await readIndex(config);
  return index.backups.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 删除一份备份,并从清单里摘掉 */
async function deleteBackup(config, name) {
  await remove(config, name);
  const index = await readIndex(config);
  index.backups = index.backups.filter((item) => item.name !== name);
  await writeIndex(config, index);
  return index;
}

module.exports = {
  PROVIDERS,
  provider,
  testConnection,
  upload,
  download,
  remove,
  readIndex,
  writeIndex,
  uploadBackup,
  listBackups,
  deleteBackup,
  INDEX_FILENAME,
  _internal: { buildUrl, describeStatus, normalizeDirectory, hasSpecificDirectory, authHeader },
};
