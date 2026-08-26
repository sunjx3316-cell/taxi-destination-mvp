/*
 * Demo server deliberately has no database or account system.
 * Each ride is an expiring, one-time session kept in memory.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 4173);
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();
const publicDir = path.join(__dirname, 'public');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      for (const client of session.listeners) client.end();
      sessions.delete(id);
    }
  }
}

function makeSessionId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function sendEvent(session, event) {
  session.lastEvent = event;
  const wire = `event: destination\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of session.listeners) client.write(wire);
}

function sessionFromDriverRequest(req, id) {
  // Browser EventSource does not permit custom headers, so the temporary
  // driver token is also accepted as a query parameter for this MVP.
  const token = req.headers['x-driver-token'] || new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now() || token !== session.driverToken) return null;
  return session;
}

async function amapRequest(endpoint, params) {
  const url = new URL(`https://restapi.amap.com/v3/${endpoint}`);
  url.searchParams.set('key', process.env.AMAP_WEB_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('地图服务暂时不可用');
  const result = await response.json();
  if (result.status !== '1') throw new Error(result.info || '目的地解析失败');
  return result;
}

function point(value) {
  const [lng, lat] = String(value || '').split(',').map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function geocode(query) {
  const key = process.env.AMAP_WEB_KEY;
  if (!key) {
    return {
      configured: false,
      candidates: [],
      message: '还没有配置高德 Web 服务 Key。请先按 README 创建 .env。'
    };
  }
  // A location may be a POI such as a shop, landmark, station, or building.
  // Input tips is better at POIs; geocoding is better at complete street addresses.
  // Merge the two so the passenger can choose a human-readable destination.
  const [tipsRequest, addressRequest] = await Promise.allSettled([
    amapRequest('assistant/inputtips', { keywords: query, datatype: 'all' }),
    amapRequest('geocode/geo', { address: query })
  ]);
  const candidates = [];
  if (tipsRequest.status === 'fulfilled') {
    for (const item of tipsRequest.value.tips || []) {
      const location = point(item.location);
      if (!location) continue;
      const district = text(item.district);
      const address = text(item.address);
      candidates.push({
        name: text(item.name) || query,
        address: [district, address].filter(Boolean).join(' ') || query,
        city: '', district, ...location, source: 'amap-poi'
      });
    }
  }
  if (addressRequest.status === 'fulfilled') {
    for (const item of addressRequest.value.geocodes || []) {
      const location = point(item.location);
      if (!location) continue;
      candidates.push({
        name: text(item.formatted_address) || query,
        address: text(item.formatted_address) || query,
        city: text(item.city) || text(item.province),
        district: text(item.district), ...location, source: 'amap-address'
      });
    }
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const fingerprint = `${candidate.lng.toFixed(6)},${candidate.lat.toFixed(6)}`;
    if (!seen.has(fingerprint)) { seen.add(fingerprint); unique.push(candidate); }
  }
  if (!unique.length && tipsRequest.status === 'rejected' && addressRequest.status === 'rejected') {
    throw new Error(addressRequest.reason?.message || tipsRequest.reason?.message || '目的地解析失败');
  }
  return { configured: true, candidates: unique.slice(0, 8), message: unique.length ? '' : '未找到匹配地点。请补充城市、区县或更完整的地点名称。' };
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  cleanExpiredSessions();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      let id = makeSessionId(); while (sessions.has(id)) id = makeSessionId();
      const session = { id, driverToken: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + SESSION_TTL_MS, listeners: new Set(), lastEvent: null };
      sessions.set(id, session);
      const baseUrl = process.env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      return json(res, 201, { sessionId: id, driverToken: session.driverToken, expiresAt: session.expiresAt, passengerUrl: `${baseUrl}/?session=${id}` });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'events') {
      const session = sessionFromDriverRequest(req, parts[2]);
      if (!session) return json(res, 401, { message: '司机会话不存在或已过期' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      session.listeners.add(res);
      req.on('close', () => session.listeners.delete(res));
      return;
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3) {
      const session = sessionFromDriverRequest(req, parts[2]);
      if (!session) return json(res, 401, { message: '司机会话不存在或已过期' });
      return json(res, 200, { sessionId: session.id, expiresAt: session.expiresAt, destination: session.lastEvent?.destination || null });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'destination') {
      const session = sessions.get(parts[2]);
      if (!session || session.expiresAt <= Date.now()) return json(res, 410, { message: '二维码已过期，请让司机重新展示二维码。' });
      const payload = await readJson(req);
      const destination = payload.destination;
      if (!destination || typeof destination.address !== 'string' || destination.address.trim().length < 3) return json(res, 400, { message: '请提供有效目的地。' });
      const safeDestination = {
        name: String(destination.name || destination.address).slice(0, 120),
        address: destination.address.trim().slice(0, 240),
        city: String(destination.city || '').slice(0, 80),
        district: String(destination.district || '').slice(0, 80),
        lat: Number.isFinite(destination.lat) ? destination.lat : null,
        lng: Number.isFinite(destination.lng) ? destination.lng : null,
        note: String(destination.note || '').slice(0, 120),
        receivedAt: Date.now()
      };
      sendEvent(session, { type: 'destination', destination: safeDestination });
      return json(res, 201, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/geocode') {
      const address = String(url.searchParams.get('address') || '').trim();
      if (address.length < 2) return json(res, 400, { message: '请输入至少 2 个字的目的地信息。' });
      return json(res, 200, await geocode(address));
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { message: error.message || '服务暂时不可用' });
  }
});

server.listen(PORT, () => console.log(`Taxi Destination MVP is running at http://localhost:${PORT}`));
