const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)],
  encoder = new TextEncoder(),
  decoder = new TextDecoder();
const STORE = "tinyotp.web.v2",
  OLD_STORE = "tinyotp.web.v1",
  REMOTE = "tinyotp.remote.version";
let key = null,
  vaultSalt = null,
  vault = { tokens: [], passwords: [], trash: [], settings: { retention: 30 } },
  remoteVersion = Number(localStorage.getItem(REMOTE) || 0),
  activeTab = "otp";
const b64 = (b) => btoa(String.fromCharCode(...b)),
  unb64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
const note = (s, t, k = "") => {
  const e = $(s);
  if (e) {
    e.textContent = t;
    e.className = `message ${k}`;
  }
};
const safe = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function derive(password, salt) {
  const m = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 },
    m,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
function bundle() {
  try {
    return JSON.parse(
      localStorage.getItem(STORE) || localStorage.getItem(OLD_STORE),
    );
  } catch {
    return null;
  }
}
async function encrypt() {
  const old = bundle(),
    salt =
      vaultSalt ||
      (old?.salt ? unb64(old.salt) : crypto.getRandomValues(new Uint8Array(16))),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(vault)),
    );
  vaultSalt = salt;
  return {
    format: "tinyotp-web",
    version: 2,
    kdf: "PBKDF2-SHA256",
    iterations: 310000,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(cipher)),
    updatedAt: Date.now(),
  };
}
async function decrypt(data, password) {
  const salt = unb64(data.salt),
    k = await derive(password, salt),
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(data.iv) },
      k,
      unb64(data.ciphertext),
    ),
    value = JSON.parse(decoder.decode(plain));
  return {
    k,
    salt,
    value: {
      tokens: value.tokens || [],
      passwords: value.passwords || [],
      trash: value.trash || [],
      settings: { retention: 30, ...value.settings },
    },
  };
}
async function save() {
  localStorage.setItem(STORE, JSON.stringify(await encrypt()));
  localStorage.removeItem(OLD_STORE);
  renderAll();
}
function norm(v) {
  return String(v || "")
    .replace(/[\s=-]/g, "")
    .toUpperCase();
}
function base32(v) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buf = 0,
    bits = 0,
    out = [];
  for (const c of norm(v)) {
    const n = a.indexOf(c);
    if (n < 0) throw Error("密钥不是合法的 Base32");
    buf = (buf << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (!out.length) throw Error("密钥为空");
  return new Uint8Array(out);
}
async function totp(t, time = Date.now()) {
  const p = +t.period || 30,
    count = Math.floor(time / 1000 / p),
    data = new Uint8Array(8);
  let n = count;
  for (let i = 7; i >= 0; i--) {
    data[i] = n & 255;
    n = Math.floor(n / 256);
  }
  const k = await crypto.subtle.importKey(
      "raw",
      base32(t.secret),
      { name: "HMAC", hash: t.algorithm || "SHA-1" },
      false,
      ["sign"],
    ),
    h = new Uint8Array(await crypto.subtle.sign("HMAC", k, data)),
    o = h.at(-1) & 15,
    x =
      ((h[o] & 127) << 24) |
      ((h[o + 1] & 255) << 16) |
      ((h[o + 2] & 255) << 8) |
      (h[o + 3] & 255),
    d = +t.digits || 6;
  return String((x >>> 0) % 10 ** d).padStart(d, "0");
}
function parseUri(raw) {
  const u = new URL(raw.trim());
  if (u.protocol !== "otpauth:" || u.hostname.toLowerCase() !== "totp")
    throw Error("只支持 TOTP 二维码");
  const label = decodeURIComponent(u.pathname.slice(1)),
    parts = label.split(":"),
    issuer =
      u.searchParams.get("issuer") || (parts.length > 1 ? parts.shift() : ""),
    secret = norm(u.searchParams.get("secret"));
  base32(secret);
  return {
    issuer,
    account: parts.join(":") || label,
    secret,
    digits: +(u.searchParams.get("digits") || 6),
    period: +(u.searchParams.get("period") || 30),
    algorithm: (u.searchParams.get("algorithm") || "SHA1")
      .replace("SHA1", "SHA-1")
      .replace("SHA256", "SHA-256"),
  };
}
function purge() {
  const days = +vault.settings.retention;
  if (days)
    vault.trash = vault.trash.filter(
      (x) => Date.now() - x.deletedAt < days * 864e5,
    );
}
async function renderOtp() {
  const q = $("#otp-search").value.toLowerCase(),
    sort = $("#otp-sort").value;
  let items = vault.tokens.filter((t) =>
    `${t.issuer} ${t.account}`.toLowerCase().includes(q),
  );
  if (sort === "name")
    items.sort((a, b) =>
      `${a.issuer}${a.account}`.localeCompare(`${b.issuer}${b.account}`),
    );
  else items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $("#otp-empty").classList.toggle("hidden", vault.tokens.length > 0);
  const root = $("#tokens");
  root.innerHTML = "";
  for (const t of items) {
    let code = "错误";
    try {
      code = await totp(t);
    } catch {}
    const p = +t.period || 30,
      r = p - (Math.floor(Date.now() / 1000) % p),
      el = document.createElement("article");
    el.className = "token";
    el.innerHTML = `<div class="token-top"><div><h3>${safe(t.issuer || "未命名")}</h3><small>${safe(t.account)}</small></div><div><button class="edit icon-small">✎</button><button class="delete icon-small">×</button></div></div><div class="code">${code.replace(/(.{3})/g, "$1 ").trim()}</div><div class="progress"><i style="width:${(r / p) * 100}%"></i></div><small>${r} 秒后更新</small>`;
    el.querySelector(".code").onclick = () => copy(code, "验证码已复制");
    el.querySelector(".edit").onclick = () => openOtp(t);
    el.querySelector(".delete").onclick = () => moveTrash("otp", t.id);
    root.append(el);
  }
}
function renderPasswords() {
  const q = $("#password-search").value.toLowerCase(),
    items = vault.passwords.filter((p) =>
      `${p.name} ${p.account} ${p.url}`.toLowerCase().includes(q),
    );
  $("#password-empty").classList.toggle("hidden", vault.passwords.length > 0);
  $("#password-list").innerHTML = items
    .map(
      (p) =>
        `<article class="password-row" data-id="${p.id}"><div><h3>${safe(p.name || "未命名")}</h3><p>${safe(p.account || p.url || "无账号")}</p></div><div class="row-actions"><button class="ghost copy-account">复制账号</button><button class="ghost copy-password">复制密码</button><button class="ghost edit-password">编辑</button><button class="delete-password danger">删除</button></div></article>`,
    )
    .join("");
  $$(".password-row").forEach((el) => {
    const p = vault.passwords.find((x) => x.id === el.dataset.id);
    el.querySelector(".copy-account").onclick = () =>
      copy(p.account, "账号已复制");
    el.querySelector(".copy-password").onclick = () =>
      copy(p.password, "密码已复制");
    el.querySelector(".edit-password").onclick = () => openPassword(p);
    el.querySelector(".delete-password").onclick = () =>
      moveTrash("password", p.id);
  });
}
function renderTrash() {
  $("#trash-empty").classList.toggle("hidden", vault.trash.length > 0);
  $("#trash-list").innerHTML = vault.trash
    .map(
      (x) =>
        `<article class="password-row" data-trash="${x.id}"><div><h3>${safe(x.data.issuer || x.data.name || "未命名")}</h3><p>${x.type === "otp" ? "动态验证码" : "密码"} · ${new Date(x.deletedAt).toLocaleString()}</p></div><div class="row-actions"><button class="ghost restore">恢复</button><button class="danger destroy">彻底删除</button></div></article>`,
    )
    .join("");
  $$("[data-trash]").forEach((el) => {
    const x = vault.trash.find((v) => v.id === el.dataset.trash);
    el.querySelector(".restore").onclick = () => restore(x.id);
    el.querySelector(".destroy").onclick = async () => {
      vault.trash = vault.trash.filter((v) => v.id !== x.id);
      await save();
    };
  });
}
function renderAll() {
  purge();
  renderOtp();
  renderPasswords();
  renderTrash();
  $("#retention").value = String(vault.settings.retention);
}
async function copy(value, text) {
  await navigator.clipboard.writeText(value || "");
  note("#app-message", text, "success");
}
async function unlock() {
  const password = $("#master-password").value,
    data = bundle();
  if (password.length < 8) return note("#unlock-message", "主密码至少 8 位");
  try {
    if (data) {
      const opened = await decrypt(data, password);
      key = opened.k;
      vaultSalt = opened.salt;
      vault = opened.value;
    } else {
      if (password !== $("#master-confirm").value)
        return note("#unlock-message", "两次输入的密码不一致");
      vaultSalt = crypto.getRandomValues(new Uint8Array(16));
      key = await derive(password, vaultSalt);
      await save();
    }
    $("#locked").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#lock-button").classList.remove("hidden");
    renderAll();
  } catch {
    note("#unlock-message", "主密码错误，或保险箱文件已损坏");
  }
}
if (bundle()) {
  $("#unlock-title").textContent = "解锁本地保险箱";
  $("#unlock-help").textContent = "输入主密码。解密只发生在当前浏览器。";
  $("#confirm-wrap").classList.add("hidden");
  $("#unlock-button").textContent = "解锁";
}
$("#unlock-button").onclick = unlock;
$("#master-password").onkeydown = (e) => {
  if (e.key === "Enter") unlock();
};
$("#lock-button").onclick = () => location.reload();
function showTab(name) {
  activeTab = name;
  $$(".tabbar button").forEach((b) =>
    b.classList.toggle(
      "active",
      b.dataset.tab === name ||
        (name === "generator" && b.dataset.tab === "passwords") ||
        (name === "trash" && b.dataset.tab === "settings"),
    ),
  );
  $$(".pane").forEach((p) =>
    p.classList.toggle("hidden", p.dataset.pane !== name),
  );
  $("#main-add").classList.toggle("hidden", name !== "otp");
}
$$("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      showTab(b.dataset.tab);
      $("#more-menu")?.classList.add("hidden");
    }),
);
$("#more-button").onclick = () => $("#more-menu").classList.toggle("hidden");
$("[data-open='generator']").onclick = () => showTab("generator");
$(".back-tools").onclick = () => showTab("passwords");
function openOtp(t = null) {
  $("#otp-dialog-title").textContent = t ? "编辑验证码" : "添加验证码";
  $("#otp-id").value = t?.id || "";
  $("#issuer").value = t?.issuer || "";
  $("#otp-account").value = t?.account || "";
  $("#secret").value = t?.secret || "";
  $("#digits").value = t?.digits || 6;
  $("#period").value = t?.period || 30;
  $("#algorithm").value = t?.algorithm || "SHA-1";
  $("#uri").value = "";
  $("#otp-dialog").showModal();
}
$("#main-add").onclick = () => openOtp();
$("#add-otp").onclick = () => openOtp();
$("#otp-search").oninput = renderOtp;
$("#otp-sort").onchange = renderOtp;
$("#uri").onchange = () => {
  try {
    const t = parseUri($("#uri").value);
    $("#issuer").value = t.issuer;
    $("#otp-account").value = t.account;
    $("#secret").value = t.secret;
    $("#digits").value = t.digits;
    $("#period").value = t.period;
    $("#algorithm").value = t.algorithm;
    note("#otp-message", "二维码内容已识别", "success");
  } catch (e) {
    note("#otp-message", e.message);
  }
};
$("#save-otp").onclick = async (e) => {
  e.preventDefault();
  try {
    const id = $("#otp-id").value,
      t = $("#uri").value.trim()
        ? parseUri($("#uri").value)
        : {
            issuer: $("#issuer").value.trim(),
            account: $("#otp-account").value.trim(),
            secret: norm($("#secret").value),
            digits: +$("#digits").value,
            period: +$("#period").value,
            algorithm: $("#algorithm").value,
          };
    base32(t.secret);
    Object.assign(t, { id: id || crypto.randomUUID(), updatedAt: Date.now() });
    vault.tokens = id
      ? vault.tokens.map((x) => (x.id === id ? t : x))
      : [...vault.tokens, t];
    await save();
    $("#otp-dialog").close();
  } catch (err) {
    note("#otp-message", err.message);
  }
};
$("#qr-file").onchange = async (e) => {
  try {
    if (!window.BarcodeDetector)
      throw Error("当前浏览器不支持图片扫码，请粘贴二维码内容");
    const image = await createImageBitmap(e.target.files[0]),
      codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(image);
    if (!codes[0]) throw Error("没有识别到二维码");
    $("#uri").value = codes[0].rawValue;
    $("#uri").dispatchEvent(new Event("change"));
  } catch (err) {
    note("#otp-message", err.message);
  }
};
function openPassword(p = null) {
  $("#password-dialog-title").textContent = p ? "编辑密码" : "添加密码";
  $("#password-id").value = p?.id || "";
  $("#password-name").value = p?.name || "";
  $("#password-account").value = p?.account || "";
  $("#password-value").value = p?.password || "";
  $("#password-url").value = p?.url || "";
  $("#password-note").value = p?.note || "";
  $("#password-dialog").showModal();
}
$("#add-password").onclick = () => openPassword();
$("#password-search").oninput = renderPasswords;
$("#save-password").onclick = async (e) => {
  e.preventDefault();
  const id = $("#password-id").value,
    p = {
      id: id || crypto.randomUUID(),
      name: $("#password-name").value.trim(),
      account: $("#password-account").value.trim(),
      password: $("#password-value").value,
      url: $("#password-url").value.trim(),
      note: $("#password-note").value.trim(),
      updatedAt: Date.now(),
    };
  if (!p.name || !p.password)
    return note("#password-message", "请填写名称和密码");
  vault.passwords = id
    ? vault.passwords.map((x) => (x.id === id ? p : x))
    : [...vault.passwords, p];
  await save();
  $("#password-dialog").close();
};
function makePassword() {
  let chars = "";
  if ($("#use-upper").checked) chars += "ABCDEFGHJKLMNPQRSTUVWXYZ";
  if ($("#use-lower").checked) chars += "abcdefghijkmnopqrstuvwxyz";
  if ($("#use-number").checked) chars += "23456789";
  if ($("#use-symbol").checked) chars += "!@#$%^&*-_=+";
  if (!chars) return note("#app-message", "至少选择一种字符");
  const out = [],
    max = 256 - (256 % chars.length),
    bytes = new Uint8Array(128);
  while (out.length < +$("#password-length").value) {
    crypto.getRandomValues(bytes);
    for (const n of bytes)
      if (n < max && out.length < +$("#password-length").value)
        out.push(chars[n % chars.length]);
  }
  $("#generated-password").textContent = out.join("");
}
$("#password-length").oninput = (e) => {
  $("#length-value").textContent = e.target.value;
  makePassword();
};
$$(".checks input").forEach((x) => (x.onchange = makePassword));
$("#generate-password").onclick = makePassword;
$("#copy-generated").onclick = () =>
  copy($("#generated-password").textContent, "生成的密码已复制");
$("#fill-generated").onclick = (e) => {
  e.preventDefault();
  makePassword();
  $("#password-value").value = $("#generated-password").textContent;
};
makePassword();
async function moveTrash(type, id) {
  if (!confirm("移入回收站？")) return;
  const list = type === "otp" ? vault.tokens : vault.passwords,
    data = list.find((x) => x.id === id);
  vault.trash.push({
    id: crypto.randomUUID(),
    type,
    data,
    deletedAt: Date.now(),
  });
  if (type === "otp") vault.tokens = list.filter((x) => x.id !== id);
  else vault.passwords = list.filter((x) => x.id !== id);
  await save();
}
async function restore(id) {
  const item = vault.trash.find((x) => x.id === id);
  if (item.type === "otp") vault.tokens.push(item.data);
  else vault.passwords.push(item.data);
  vault.trash = vault.trash.filter((x) => x.id !== id);
  await save();
}
$("#empty-trash").onclick = async () => {
  if (vault.trash.length && confirm("彻底清空回收站？此操作不能恢复。")) {
    vault.trash = [];
    await save();
  }
};
$("#retention").onchange = async (e) => {
  vault.settings.retention = +e.target.value;
  await save();
};
$("#export-button").onclick = () => {
  const blob = new Blob([localStorage.getItem(STORE)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tinyotp-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#import-file").onchange = async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (data.format !== "tinyotp-web") throw Error("不是 TinyOTP Web 备份");
    localStorage.setItem(STORE, JSON.stringify(data));
    localStorage.removeItem(OLD_STORE);
    location.reload();
  } catch (err) {
    note("#app-message", err.message);
  }
};
async function account(path, options = {}) {
  const r = await fetch(`https://account.tinylabpro.com${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    }),
    data = await r.json();
  if (!r.ok) throw Error(data.error || "账号服务不可用");
  return data;
}
async function checkAccount() {
  try {
    const r = await account("/v1/me");
    $("#account-state").textContent = r.user.email;
    $("#account-button").textContent = "账号";
    note("#account-message", "已连接账号，可以同步加密保险箱", "success");
    return true;
  } catch {
    note("#account-message", "还未登录，请先打开账号中心");
    return false;
  }
}
$("#account-button").onclick = () => $("#account-dialog").showModal();
$("#check-account").onclick = async (e) => {
  e.preventDefault();
  if (await checkAccount()) setTimeout(() => $("#account-dialog").close(), 500);
};
$("#sync-button").onclick = async () => {
  try {
    if (!(await checkAccount())) return $("#account-dialog").showModal();
    note("#app-message", "正在同步…");
    const remote = await account("/v1/sync/otp-web"),
      doc = remote.documents.find((d) => d.documentId === "vault");
    if (doc && doc.version > remoteVersion) {
      if (!confirm("云端有更新，要用云端保险箱替换本机吗？")) return;
      localStorage.setItem(STORE, JSON.stringify(doc.payload));
      localStorage.setItem(REMOTE, String(doc.version));
      return location.reload();
    }
    const data = await encrypt(),
      saved = await account("/v1/sync/otp-web/vault", {
        method: "PUT",
        body: JSON.stringify({
          baseVersion: remoteVersion,
          payload: data,
          encrypted: true,
        }),
      });
    remoteVersion = +saved.version;
    localStorage.setItem(REMOTE, String(remoteVersion));
    note("#app-message", "加密保险箱已同步", "success");
  } catch (err) {
    note("#app-message", err.message);
  }
};
checkAccount();
setInterval(() => {
  if (key && activeTab === "otp") renderOtp();
}, 1000);

let installPrompt = null;
const installButtons = $$(".install-action");
function setInstallAvailable(available) {
  installButtons.forEach((button) => button.classList.toggle("hidden", !available));
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  setInstallAvailable(true);
});
installButtons.forEach((button) => {
  button.onclick = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    setInstallAvailable(false);
    $("#more-menu")?.classList.add("hidden");
  };
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  setInstallAvailable(false);
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}
