// DOYUNGO MAPS API 2.0 - 모든 API를 이 파일 하나가 처리합니다.
const crypto = require("crypto");

const ENV = process.env;
const STYLES = { streets: "streets-v2", satellite: "satellite", terrain: "outdoor-v2", topo: "topo-v2" };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Upstash Redis (REST) ----------
async function cmd(...args) {
  const r = await fetch(ENV.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipeline(commands) {
  const r = await fetch(ENV.UPSTASH_REDIS_REST_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  return (await r.json()).map((x) => x.result);
}

// ---------- 인증 ----------
function isAdmin(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!ENV.ADMIN_TOKEN && token === ENV.ADMIN_TOKEN;
}

async function checkAndCount(req, url) {
  const required = String(ENV.MAPS_REQUIRE_API_KEY) === "true";
  const limit = parseInt(ENV.DAILY_TILE_LIMIT || "10000", 10);
  const key = req.headers["x-api-key"] || url.searchParams.get("key") || "";
  let id;
  if (required) {
    if (!key) return { status: 401, error: "API 키가 필요합니다." };
    const raw = await cmd("HGET", "apikeys", key);
    if (!raw) return { status: 401, error: "유효하지 않은 API 키입니다." };
    if (JSON.parse(raw).active === false) return { status: 403, error: "비활성화된 API 키입니다." };
    id = key;
  } else {
    id = key || "anon:" + (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  }
  const uk = `usage:${id}:${today()}`;
  const [count] = await pipeline([["INCR", uk], ["EXPIRE", uk, 172800]]);
  if (count > limit) return { status: 429, error: `하루 요청 한도(${limit})를 초과했습니다.` };
  return null;
}

// ---------- 핸들러들 ----------
function health(req, res) {
  res.status(200).json({
    ok: true, service: "DOYUNGO MAPS API", version: "2.0.0",
    maptiler: !!ENV.MAPTILER_KEY, redis: !!ENV.UPSTASH_REDIS_REST_URL,
    requireApiKey: String(ENV.MAPS_REQUIRE_API_KEY) === "true", time: new Date().toISOString(),
  });
}

async function tiles(req, res, url, m) {
  const [, style, z, x, y] = m;
  const mapId = STYLES[style];
  if (!mapId) return res.status(404).json({ error: "지원하지 않는 스타일입니다.", styles: Object.keys(STYLES) });
  if (!ENV.MAPTILER_KEY) return res.status(500).json({ error: "MAPTILER_KEY가 설정되지 않았습니다." });
  const blocked = await checkAndCount(req, url);
  if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  const up = await fetch(`https://api.maptiler.com/maps/${mapId}/${z}/${x}/${y}?key=${ENV.MAPTILER_KEY}`);
  if (!up.ok) return res.status(up.status).json({ error: "MapTiler 타일을 불러오지 못했습니다." });
  res.setHeader("Content-Type", up.headers.get("content-type") || "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
  res.status(200).send(Buffer.from(await up.arrayBuffer()));
}

async function keys(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: "관리자 토큰이 올바르지 않습니다." });
  if (req.method === "GET") {
    const flat = (await cmd("HGETALL", "apikeys")) || [];
    const list = [];
    for (let i = 0; i < flat.length; i += 2) list.push({ key: flat[i], ...JSON.parse(flat[i + 1]) });
    const usage = list.length ? await pipeline(list.map((k) => ["GET", `usage:${k.key}:${today()}`])) : [];
    list.forEach((k, i) => (k.usageToday = parseInt(usage[i] || "0", 10)));
    list.sort((a, b) => b.created.localeCompare(a.created));
    return res.status(200).json({ keys: list, dailyLimit: parseInt(ENV.DAILY_TILE_LIMIT || "10000", 10) });
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (req.method === "POST") {
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "키 이름을 입력하세요." });
    const key = "dyg_" + crypto.randomBytes(18).toString("hex");
    await cmd("HSET", "apikeys", key, JSON.stringify({ name, active: true, created: new Date().toISOString() }));
    return res.status(201).json({ key, name });
  }
  if (req.method === "PATCH") {
    const raw = await cmd("HGET", "apikeys", body.key);
    if (!raw) return res.status(404).json({ error: "키를 찾을 수 없습니다." });
    const v = JSON.parse(raw); v.active = !!body.active;
    await cmd("HSET", "apikeys", body.key, JSON.stringify(v));
    return res.status(200).json({ ok: true });
  }
  if (req.method === "DELETE") {
    await cmd("HDEL", "apikeys", body.key);
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "허용되지 않는 메서드" });
}

// ---------- 라우터 ----------
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "");
    let m;
    if (p === "/api/health") return health(req, res);
    if ((m = p.match(/^\/api\/tiles\/(\w+)\/(\d+)\/(\d+)\/(\d+\.(?:png|jpg|jpeg|webp))$/))) return await tiles(req, res, url, m);
    if (p === "/api/admin/keys") return await keys(req, res);
    res.status(404).json({ error: "존재하지 않는 주소입니다." });
  } catch (e) {
    res.status(500).json({ error: "서버 오류", detail: e.message });
  }
};
