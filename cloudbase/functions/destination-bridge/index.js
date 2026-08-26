const crypto = require('crypto');
const cloudbase = require('@cloudbase/js-sdk');

const BOARDS = 'taxi_driver_boards';
const MESSAGES = 'taxi_destination_messages';
const text = (value) => typeof value === 'string' ? value.trim() : '';
const fail = (message) => ({ ok: false, message });
const boardId = () => crypto.randomBytes(6).toString('hex').toUpperCase();
const token = () => crypto.randomBytes(24).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const dbFor = () => cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV }).rdb();

function safeDestination(value) {
  if (!value || text(value.address).length < 3) throw new Error('请提供有效目的地。');
  const lat = Number(value.lat), lng = Number(value.lng);
  const route = value.route && typeof value.route === 'object' ? {
    label: text(value.route.label).slice(0, 40),
    distanceText: text(value.route.distanceText).slice(0, 40),
    durationText: text(value.route.durationText).slice(0, 40),
    tollsText: text(value.route.tollsText).slice(0, 40),
    strategy: Number.isSafeInteger(Number(value.route.strategy)) ? Number(value.route.strategy) : null
  } : null;
  if (!route?.label || !route.distanceText || !route.durationText) throw new Error('请先规划并选择一条路线。');
  return { name: text(value.name || value.address).slice(0, 120), address: text(value.address).slice(0, 240), city: text(value.city).slice(0, 80), district: text(value.district).slice(0, 80), lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, route, note: text(value.note).slice(0, 120), receivedAt: Date.now() };
}

function point(value) { const [lng, lat] = String(value || '').split(',').map(Number); return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null; }

async function amapRequest(endpoint, params) {
  return amapRequestAt(`v3/${endpoint}`, params);
}

async function amapRequestAt(path, params) {
  const key = process.env.AMAP_WEB_KEY;
  if (!key) throw new Error('高德地图服务尚未配置。');
  const url = new URL(`https://restapi.amap.com/${path}`);
  url.searchParams.set('key', key);
  Object.entries(params).forEach(([name, value]) => { if (value) url.searchParams.set(name, value); });
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('地图服务暂时不可用。');
  const body = await response.json();
  if (body.status !== '1') throw new Error(body.info || '目的地解析失败。');
  return body;
}

const distanceText = (meters) => Number(meters) >= 1000 ? `${(Number(meters) / 1000).toFixed(1)} 公里` : `${Math.max(1, Math.round(Number(meters) || 0))} 米`;
const durationText = (seconds) => {
  const minutes = Math.max(1, Math.round(Number(seconds) / 60 || 0));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
};

async function routeOptions(origin, destination) {
  const from = { lng: Number(origin?.lng), lat: Number(origin?.lat) };
  const to = { lng: Number(destination?.lng), lat: Number(destination?.lat) };
  if (![from.lng, from.lat, to.lng, to.lat].every(Number.isFinite)) throw new Error('路线规划需要有效的当前位置和目的地坐标。');
  const strategies = [
    { value: 32, label: '高德推荐' },
    { value: 33, label: '躲避拥堵' },
    { value: 36, label: '少收费' }
  ];
  const originText = `${from.lng.toFixed(6)},${from.lat.toFixed(6)}`;
  const destinationText = `${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const results = await Promise.allSettled(strategies.map(async (strategy) => {
    const body = await amapRequestAt('v5/direction/driving', { origin: originText, destination: destinationText, strategy: strategy.value, show_fields: 'cost,navi' });
    const path = body.route?.paths?.[0];
    if (!path) throw new Error('路线服务未返回可用方案。');
    const tolls = Number(path.tolls || 0);
    return {
      label: strategy.label,
      strategy: strategy.value,
      distanceText: distanceText(path.distance),
      durationText: durationText(path.duration),
      tollsText: tolls > 0 ? `过路费约 ${tolls.toFixed(0)} 元` : ''
    };
  }));
  const seen = new Set();
  const routes = results.filter((result) => result.status === 'fulfilled').map((result) => result.value).filter((route) => {
    const key = `${route.distanceText}|${route.durationText}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });
  if (!routes.length) throw new Error('暂时无法规划路线，请稍后重试。');
  return { routes };
}

async function geocode(query) {
  const [tips, geocodes] = await Promise.allSettled([
    amapRequest('assistant/inputtips', { keywords: query, datatype: 'all' }),
    amapRequest('geocode/geo', { address: query })
  ]);
  const candidates = [];
  if (tips.status === 'fulfilled') for (const item of tips.value.tips || []) {
    const location = point(item.location); if (!location) continue;
    const district = text(item.district), address = text(item.address);
    candidates.push({ name: text(item.name) || query, address: [district, address].filter(Boolean).join(' ') || query, city: '', district, ...location, source: 'amap-poi' });
  }
  if (geocodes.status === 'fulfilled') for (const item of geocodes.value.geocodes || []) {
    const location = point(item.location); if (!location) continue;
    candidates.push({ name: text(item.formatted_address) || query, address: text(item.formatted_address) || query, city: text(item.city) || text(item.province), district: text(item.district), ...location, source: 'amap-address' });
  }
  if (!candidates.length && tips.status === 'rejected' && geocodes.status === 'rejected') throw new Error(geocodes.reason?.message || tips.reason?.message || '目的地解析失败。');
  const seen = new Set();
  return { candidates: candidates.filter((item) => { const id = `${item.lng.toFixed(6)},${item.lat.toFixed(6)}`; if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 8), message: candidates.length ? '' : '未找到匹配地点。请补充城市、区县或更完整的地点名称。' };
}

async function mapPreview(lng, lat, name) {
  const longitude = Number(lng), latitude = Number(lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new Error('该地点没有可预览的坐标。');
  const key = process.env.AMAP_WEB_KEY;
  if (!key) throw new Error('地图服务尚未配置。');
  const url = new URL('https://restapi.amap.com/v3/staticmap');
  url.searchParams.set('key', key);
  url.searchParams.set('location', `${longitude},${latitude}`);
  url.searchParams.set('zoom', '16');
  url.searchParams.set('size', '600*320');
  url.searchParams.set('markers', `mid,,A:${longitude},${latitude}`);
  url.searchParams.set('title', text(name).slice(0, 30));
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('地图预览暂不可用。');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 900000) throw new Error('地图预览过大，请稍后重试。');
  return { imageDataUrl: `data:${response.headers.get('content-type') || 'image/png'};base64,${bytes.toString('base64')}` };
}

async function getBoard(db, id) {
  const { data, error } = await db.from(BOARDS).select().eq('board_id', id).maybeSingle();
  if (error) throw new Error(error.message || '读取司机二维码失败。');
  return data || null;
}

async function getMessages(db, id) {
  const { data, error } = await db.from(MESSAGES).select().eq('board_id', id).order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(error.message || '读取目的地失败。');
  return (data || []).map((row) => ({ id: row.id, createdAt: Number(row.created_at), destination: row.destination }));
}

exports.main = async (event = {}) => {
  try {
    const db = dbFor();
    if (event.action === 'createBoard') {
      const id = boardId(), driverToken = token();
      const { error } = await db.from(BOARDS).insert({ board_id: id, driver_token_hash: hash(driverToken), created_at: Date.now() });
      if (error) throw new Error(error.message || '创建车载二维码失败。');
      return { ok: true, boardId: id, driverToken };
    }
    if (event.action === 'geocode') {
      const address = text(event.address);
      if (address.length < 2) return fail('请输入至少 2 个字的目的地信息。');
      return { ok: true, ...(await geocode(address)) };
    }
    if (event.action === 'mapPreview') return { ok: true, ...(await mapPreview(event.lng, event.lat, event.name)) };
    if (event.action === 'routeOptions') return { ok: true, ...(await routeOptions(event.origin, event.destination)) };

    const id = text(event.boardId).toUpperCase();
    const board = await getBoard(db, id);
    if (!board) return fail('未找到该司机二维码，请重新扫码或确认编号。');
    if (event.action === 'driverState') {
      if (hash(text(event.driverToken)) !== board.driver_token_hash) return fail('这台手机没有该二维码的接收权限。');
      return { ok: true, boardId: id, messages: await getMessages(db, id) };
    }
    if (event.action === 'deleteDestination') {
      if (hash(text(event.driverToken)) !== board.driver_token_hash) return fail('这台手机没有该二维码的接收权限。');
      const messageId = Number(event.messageId);
      if (!Number.isSafeInteger(messageId) || messageId < 1) return fail('无效的目的地记录。');
      const { error } = await db.from(MESSAGES).delete().eq('board_id', id).eq('id', messageId);
      if (error) throw new Error(error.message || '删除目的地失败。');
      return { ok: true, messages: await getMessages(db, id) };
    }
    if (event.action === 'sendDestination') {
      const destination = safeDestination(event.destination);
      const { error } = await db.from(MESSAGES).insert({ board_id: id, destination, created_at: Date.now() });
      if (error) throw new Error(error.message || '保存目的地失败。');
      return { ok: true };
    }
    return fail('不支持的操作。');
  } catch (error) {
    console.error(error);
    return fail(error.message || '云端服务暂时不可用。');
  }
};
