const app = document.querySelector('#app');
const query = new URLSearchParams(location.search);
const state = { boardId: query.get('board'), driver: null, candidate: null, route: null, messages: [] };
const API_BASE_URL = String(window.DESTINATION_API_BASE_URL || '').replace(/\/$/, '');
const CLOUDBASE_ENV = String(window.DESTINATION_CLOUDBASE_ENV || '').trim();
const PUBLIC_WEB_URL = String(window.DESTINATION_PUBLIC_WEB_URL || '').replace(/\/$/, '');
const AMAP_JS_KEY = String(window.DESTINATION_AMAP_JS_KEY || '').trim();
const AMAP_JS_SECURITY_CODE = String(window.DESTINATION_AMAP_JS_SECURITY_CODE || '').trim();
const DRIVER_BOARD_STORAGE = 'daonaer-driver-board-v1';
let bridgePromise = null;
let amapJsPromise = null;
let arrivalAudio = null;

const esc = (value = '') => String(value).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[c]));
const brand = () => '<div class="brand"><span class="brand-mark">⌁</span><span>到哪儿</span></div>';
const passengerUrl = (id) => `${PUBLIC_WEB_URL || location.origin}/?board=${encodeURIComponent(id)}`;

async function bridge() {
  if (!CLOUDBASE_ENV) return null;
  if (!bridgePromise) bridgePromise = (async () => {
    if (!window.cloudbase) throw new Error('CloudBase SDK 加载失败，请检查网络后重试。');
    const client = window.cloudbase.init({ env: CLOUDBASE_ENV });
    const auth = client.auth();
    if (!(await auth.getSession())?.data?.session) {
      const login = await auth.signInAnonymously({});
      if (login?.error) throw new Error(login.error.message || '匿名登录失败，请稍后重试。');
    }
    return async (data) => {
      const result = (await client.callFunction({ name: 'destination-bridge', data }))?.result;
      if (!result || result.ok === false) throw new Error(result?.message || '云端服务暂时不可用。');
      return result;
    };
  })();
  return bridgePromise;
}

function cloudPayload(url, options = {}) {
  const target = new URL(url, location.origin), body = options.body ? JSON.parse(options.body) : {};
  const parts = target.pathname.split('/').filter(Boolean);
  if (options.method === 'POST' && target.pathname === '/api/boards') return { action: 'createBoard' };
  if (target.pathname === '/api/geocode') return { action: 'geocode', address: target.searchParams.get('address') || '' };
  if (target.pathname === '/api/map-preview') return { action: 'mapPreview', lng: target.searchParams.get('lng'), lat: target.searchParams.get('lat'), name: target.searchParams.get('name') || '' };
  if (options.method === 'POST' && target.pathname === '/api/routes') return { action: 'routeOptions', origin: body.origin, destination: body.destination };
  if (options.method === 'POST' && target.pathname === '/api/route-preview') return { action: 'routeMapPreview', polyline: body.polyline };
  if (options.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'boards' && parts[3] === 'destination' && parts[4]) return { action: 'deleteDestination', boardId: parts[2], messageId: parts[4], driverToken: options.headers?.['x-driver-token'] || '' };
  if (parts[0] === 'api' && parts[1] === 'boards' && parts.length === 3) return { action: 'driverState', boardId: parts[2], driverToken: options.headers?.['x-driver-token'] || '' };
  if (options.method === 'POST' && parts[0] === 'api' && parts[1] === 'boards' && parts[3] === 'destination') return { action: 'sendDestination', boardId: parts[2], destination: body.destination };
  throw new Error('不支持的云端操作。');
}

async function request(url, options = {}) {
  const call = await bridge();
  if (call) return call(cloudPayload(url, options));
  const response = await fetch(url.startsWith('/api/') ? `${API_BASE_URL}${url}` : url, { headers: { 'Content-Type':'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '请求失败，请稍后重试。');
  return data;
}

function savedBoard() { try { return JSON.parse(localStorage.getItem(DRIVER_BOARD_STORAGE) || 'null'); } catch { return null; } }

function renderHome() {
  const existing = savedBoard();
  app.innerHTML = `${brand()}<p class="eyebrow">目的地一键交接</p><h1>目的地，<br>直接到导航。</h1><p class="lead">乘客发送目的地，司机点一下就能打开自己的导航软件。</p><div class="role-grid"><button class="role" id="driver-start"><span class="role-icon">🚕</span><strong>${existing ? '打开我的车载二维码' : '我是司机'}</strong><span>${existing ? '二维码长期有效，查看新目的地' : '生成可贴在后座的长期二维码'}</span></button><button class="role" id="passenger-start"><span class="role-icon">📍</span><strong>我是乘客</strong><span>扫码或输入司机编号，发送目的地</span></button></div><p class="footer-note">司机二维码长期有效；司机需要手动点击地图按钮，系统不会擅自开始导航。</p>`;
  document.querySelector('#driver-start').onclick = openDriverBoard;
  document.querySelector('#passenger-start').onclick = () => renderCodeEntry();
}

async function openDriverBoard() {
  enableDriverAlerts();
  const existing = savedBoard();
  if (existing?.boardId && existing?.driverToken) {
    state.driver = existing; state.boardId = existing.boardId; renderDriver(); return pollDriver();
  }
  app.innerHTML = `${brand()}<section class="card"><h2>正在生成车载二维码…</h2><p class="muted">生成一次即可，之后可以贴在后座长期使用。</p></section>`;
  try {
    const board = await request('/api/boards', { method: 'POST', body: '{}' });
    board.passengerUrl = passengerUrl(board.boardId);
    state.driver = board; state.boardId = board.boardId;
    localStorage.setItem(DRIVER_BOARD_STORAGE, JSON.stringify(board));
    renderDriver(); pollDriver();
  } catch (error) { renderError(error.message); }
}

function renderDriver() {
  const board = state.driver;
  app.innerHTML = `${brand()}<p class="eyebrow">司机端 · 长期车载二维码</p><h1>请让乘客扫码</h1><p class="lead">把这个二维码贴在后座即可。它不会自动刷新或失效，乘客发来的目的地会显示在下方。</p><section class="card"><div id="qrcode" class="qr-wrap"></div><p class="session-code">${esc(board.boardId)}</p><p class="countdown">长期有效 · 保留此页面即可接收</p><button class="secondary" id="copy-link">复制乘客链接</button></section><section id="destination-area">${messagesMarkup(state.messages)}</section><p class="footer-note">接收页保持打开时，会在收到新目的地后震动、提示音和高亮提醒；后台或关闭 App 后仍需原生推送服务。</p>`;
  const qr = document.querySelector('#qrcode');
  if (window.QRCode) new QRCode(qr, { text: board.passengerUrl, width: 190, height: 190, correctLevel: QRCode.CorrectLevel.M }); else qr.textContent = board.passengerUrl;
  document.querySelector('#copy-link').onclick = async () => { await navigator.clipboard.writeText(board.passengerUrl); document.querySelector('#copy-link').textContent = '已复制'; };
  bindMaps();
}

function messagesMarkup(messages) {
  if (!messages?.length) return '<div class="empty">还没有目的地<br><small>等待乘客扫码并发送地址</small></div>';
  const notice = state.arrivalNotice ? `<div class="arrival-notice" role="status">${esc(state.arrivalNotice)}</div>` : '';
  return `${notice}<div class="inbox-heading"><h2>最近收到的目的地</h2><span>${messages.length} 条</span></div>${messages.map(({ id, destination }) => destinationMarkup(destination, id)).join('')}`;
}

function enableDriverAlerts() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    arrivalAudio = arrivalAudio || new AudioContext();
    arrivalAudio.resume?.();
  } catch { arrivalAudio = null; }
}

function playArrivalTone() {
  try {
    if (!arrivalAudio || arrivalAudio.state !== 'running') return;
    const now = arrivalAudio.currentTime, oscillator = arrivalAudio.createOscillator(), gain = arrivalAudio.createGain();
    oscillator.frequency.setValueAtTime(880, now); oscillator.frequency.setValueAtTime(1047, now + .18);
    gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(.12, now + .02); gain.gain.exponentialRampToValueAtTime(.0001, now + .42);
    oscillator.connect(gain).connect(arrivalAudio.destination); oscillator.start(now); oscillator.stop(now + .45);
  } catch { /* Optional alert. */ }
}

function destinationMarkup(d, id) {
  const precise = Number.isFinite(d.lat) && Number.isFinite(d.lng);
  const encoded = esc(JSON.stringify(d));
  const buttons = [{ id: 'amap', label: '高德地图', primary: true }, { id: 'baidu', label: '百度地图' }, { id: 'tencent', label: '腾讯地图' }, ...(!isNativeAndroid() ? [{ id: 'apple', label: '苹果地图' }] : [])];
  const route = d.route ? `<div class="route-summary"><strong>乘客已选路线：${esc(d.route.label)}</strong><span>${esc(d.route.distanceText)} · 预计 ${esc(d.route.durationText)}</span>${d.route.trafficText ? `<em>${esc(d.route.trafficText)}</em>` : ''}${d.route.highwayText ? `<em>${esc(d.route.highwayText)}</em>` : ''}</div><button class="route-map-button" data-route-map="${esc(JSON.stringify(d.route))}">查看乘客路线图</button><div class="driver-route-map"></div>` : '';
  return `<article class="card destination"><div class="destination-title"><h2>${esc(d.name)}<span class="badge">${precise ? '已确认坐标' : '文字地址'}</span></h2><button class="delete-destination" data-delete-id="${Number(id)}" aria-label="删除此目的地">删除</button></div><p class="muted">${esc(d.address)}${d.city ? ` · ${esc(d.city)}` : ''}</p>${route}${d.note ? `<p class="note">乘客备注：${esc(d.note)}</p>` : ''}<div class="map-grid">${buttons.map((item) => `<button class="map-button${item.primary ? ' primary-map' : ''}" data-map="${item.id}" data-destination="${encoded}">${item.label}</button>`).join('')}</div></article>`;
}

function bindMaps() {
  document.querySelectorAll('[data-map]').forEach((button) => button.onclick = () => openMap(button.dataset.map, JSON.parse(button.dataset.destination)));
  document.querySelectorAll('[data-delete-id]').forEach((button) => button.onclick = () => deleteDestination(button.dataset.deleteId));
  document.querySelectorAll('[data-route-map]').forEach((button) => button.onclick = () => previewRoute(JSON.parse(button.dataset.routeMap), button.closest('.destination')?.querySelector('.driver-route-map')));
}

async function deleteDestination(messageId) {
  if (!confirm('删除这条目的地？删除后不会再显示。')) return;
  try {
    const result = await request(`/api/boards/${state.driver.boardId}/destination/${encodeURIComponent(messageId)}`, { method: 'DELETE', headers: { 'x-driver-token': state.driver.driverToken } });
    state.messages = result.messages || [];
    state.messagesFingerprint = JSON.stringify(state.messages);
    const area = document.querySelector('#destination-area'); if (area) { area.innerHTML = messagesMarkup(state.messages); bindMaps(); }
  } catch (error) { alert(error.message || '删除失败，请稍后重试。'); }
}

async function pollDriver() {
  window.clearInterval(window.driverPoll);
  const update = async () => {
    try {
      const result = await request(`/api/boards/${state.driver.boardId}`, { headers: { 'x-driver-token': state.driver.driverToken } });
      const next = result.messages || [], fingerprint = JSON.stringify(next);
      if (fingerprint !== state.messagesFingerprint) {
        const previousIds = new Set(state.messages.map((message) => String(message.id)));
        const incoming = next.filter((message) => !previousIds.has(String(message.id)));
        const shouldAlert = state.driverLoaded && incoming.length > 0;
        state.messages = next; state.messagesFingerprint = fingerprint; state.driverLoaded = true;
        state.arrivalNotice = shouldAlert ? `收到 ${incoming.length} 条新目的地，请查看列表。` : '';
        const area = document.querySelector('#destination-area'); if (area) { area.innerHTML = messagesMarkup(next); bindMaps(); }
        if (shouldAlert) { if (navigator.vibrate) navigator.vibrate([130, 70, 130]); playArrivalTone(); }
      }
    } catch (error) { console.info('Destination polling retrying…', error.message); }
  };
  await update(); window.driverPoll = window.setInterval(update, 3000);
}

function renderCodeEntry(message = '') {
  app.innerHTML = `${brand()}<p class="eyebrow">乘客端</p><h1>把目的地发给司机</h1><p class="lead">扫描后座二维码会自动进入此页；也可以输入司机显示的编号。</p><section class="card"><label for="board-code-input">司机编号</label><input id="board-code-input" maxlength="16" placeholder="例如 6C82FA19" /><p class="status error">${esc(message)}</p><button class="primary" id="join-board">继续</button></section>`;
  document.querySelector('#join-board').onclick = () => { const id = document.querySelector('#board-code-input').value.trim().toUpperCase(); if (id.length < 6) return renderCodeEntry('请向司机确认编号。'); state.boardId = id; history.replaceState(null, '', `/?board=${id}`); renderPassenger(); };
}

function renderPassenger() {
  if (!state.boardId) return renderCodeEntry();
  app.innerHTML = `${brand()}<p class="eyebrow">发送给司机</p><h1>目的地在哪儿？</h1><p class="lead">输入或粘贴地点、店名、地标或完整地址。系统会查找位置，不需要输入经纬度。</p><section class="card"><label for="address">目的地信息</label><textarea id="address" placeholder="输入地点名称、店名、地标或完整地址"></textarea><div class="row"><button class="ghost" id="paste">粘贴内容</button><span class="hint">补充城市、区县会更准确</span></div><button class="primary" id="search">查找位置</button><p id="search-status" class="status"></p><div id="candidates"></div><div id="map-preview"></div><div id="route-options"></div></section><section class="card"><label for="note">给司机的补充说明（可选）</label><input id="note" maxlength="120" placeholder="例如：从东门进入" /></section><button class="primary" id="send" disabled>选择路线后发送给司机</button><p class="footer-note">路线仅用于本次交接；你选定的路线图、距离和预计时长会同步给司机。</p>`;
  document.querySelector('#paste').onclick = pasteAddress;
  document.querySelector('#search').onclick = searchAddress;
  document.querySelector('#send').onclick = sendDestination;
}

async function pasteAddress() { const s = document.querySelector('#search-status'); try { document.querySelector('#address').value = await navigator.clipboard.readText(); s.textContent = '已粘贴，请点击“查找位置”。'; } catch { s.textContent = '请长按输入框后选择“粘贴”。'; } }

function selectCandidate(candidate, card) {
  document.querySelectorAll('.candidate').forEach((el) => el.classList.remove('selected'));
  card?.classList.add('selected'); state.candidate = candidate; state.route = null;
  document.querySelector('#send').disabled = true; document.querySelector('#send').textContent = '选择路线后发送给司机'; document.querySelector('#search-status').textContent = '位置已确认。请规划并选择一条路线。';
  renderRoutePlanner();
}

function renderRoutePlanner() {
  const holder = document.querySelector('#route-options');
  if (!state.candidate || !Number.isFinite(state.candidate.lat) || !Number.isFinite(state.candidate.lng)) { holder.innerHTML = '<p class="status error">该地点没有坐标，无法规划路线。请重新选择地图定位结果。</p>'; return; }
  holder.innerHTML = `<section class="route-planner"><strong>选择乘客路线</strong><p>以你的当前位置为起点，规划驾车路线。你选定的路线图会同步给司机。</p><button class="secondary" id="plan-routes">使用当前位置规划路线</button><p id="route-status" class="status"></p><div id="route-list"></div><div id="route-map-preview"></div></section>`;
  holder.querySelector('#plan-routes').onclick = planRoutes;
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('当前设备不支持定位，请使用手机浏览器或 App 打开。'));
    navigator.geolocation.getCurrentPosition((position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), () => reject(new Error('未能获取当前位置。请允许定位权限后重试。')), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

async function planRoutes() {
  const status = document.querySelector('#route-status'), button = document.querySelector('#plan-routes'), list = document.querySelector('#route-list');
  button.disabled = true; button.textContent = '正在获取位置…'; status.className = 'status'; status.textContent = '请允许定位权限，以便计算路线。'; list.innerHTML = '';
  try {
    const origin = await currentPosition();
    button.textContent = '正在规划路线…';
    const result = await request('/api/routes', { method: 'POST', body: JSON.stringify({ origin, destination: { lat: state.candidate.lat, lng: state.candidate.lng } }) });
    if (!result.routes?.length) throw new Error('没有找到可选驾车路线。');
    status.textContent = '请选择要同步给司机的路线。';
    list.innerHTML = result.routes.map((route, index) => `<article class="route-option${index === 0 ? ' recommended' : ''}"><strong>${esc(route.label)}${index === 0 ? '<span>推荐</span>' : ''}</strong><small>${esc(route.distanceText)} · 预计 ${esc(route.durationText)}${route.tollsText ? ` · ${esc(route.tollsText)}` : ''}</small>${route.trafficText ? `<small class="route-live">路况：${esc(route.trafficText)}</small>` : ''}${route.highwayText ? `<small class="route-live">${esc(route.highwayText)}</small>` : ''}<div class="candidate-actions"><button class="ghost" data-route-preview="${index}">查看线路地图</button><button class="candidate-confirm" data-route-select="${index}">选择这条路线</button></div></article>`).join('');
    list.querySelectorAll('[data-route-preview]').forEach((item) => item.onclick = () => previewRoute(result.routes[Number(item.dataset.routePreview)]));
    list.querySelectorAll('[data-route-select]').forEach((item) => item.onclick = () => selectRoute(result.routes[Number(item.dataset.routeSelect)], item.closest('.route-option')));
  } catch (error) { status.className = 'status error'; status.textContent = error.message; button.disabled = false; button.textContent = '重新规划路线'; }
}

function selectRoute(route, item) {
  document.querySelectorAll('.route-option').forEach((el) => el.classList.remove('selected'));
  item.classList.add('selected'); state.route = route;
  const send = document.querySelector('#send'); send.disabled = false; send.textContent = '发送目的地和路线给司机';
  document.querySelector('#route-status').textContent = `已选择：${route.label}。`;
}

async function previewRoute(route, target = document.querySelector('#route-map-preview')) {
  if (AMAP_JS_KEY && AMAP_JS_SECURITY_CODE) return openInteractiveRouteMap(route);
  if (!target) return;
  target.innerHTML = `<div class="map-preview loading"><strong>${esc(route.label)}路线图</strong><span>正在加载路线地图…</span></div>`;
  try {
    const map = await request('/api/route-preview', { method: 'POST', body: JSON.stringify({ polyline: route.polyline }) });
    const title = `${route.label}路线图`, detail = `${route.distanceText} · 预计 ${route.durationText}`;
    target.innerHTML = `<div class="map-preview"><div class="map-preview-title"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div><button type="button" class="map-zoom" aria-label="放大查看${esc(title)}"><img src="${map.imageDataUrl}" alt="${esc(title)}" /><span>点击放大查看路线</span></button></div>`;
    target.querySelector('.map-zoom').onclick = () => openMapLightbox(map.imageDataUrl, { name: title, address: detail });
  } catch (error) { target.innerHTML = `<p class="status error">路线地图暂不可用：${esc(error.message)}</p>`; }
}

function parsePolyline(value) {
  return String(value || '').split(';').map((point) => point.split(',').map(Number)).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

function trafficColor(status) {
  return ({ '畅通':'#16a34a', '缓行':'#f59e0b', '拥堵':'#f97316', '严重拥堵':'#dc2626', '未知':'#64748b' })[status] || '#64748b';
}

function trafficStats(segments) {
  const counts = (segments || []).reduce((all, segment) => { all[segment.status] = (all[segment.status] || 0) + 1; return all; }, {});
  return [['畅通', 'traffic-green'], ['缓行', 'traffic-yellow'], ['拥堵', 'traffic-orange'], ['严重拥堵', 'traffic-red']].filter(([status]) => counts[status]).map(([status, className]) => `<span class="traffic-legend"><i class="${className}"></i>${status} ${counts[status]} 段</span>`).join('');
}

function loadAmapJs() {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (!AMAP_JS_KEY || !AMAP_JS_SECURITY_CODE) return Promise.reject(new Error('交互地图尚未配置。'));
  if (!amapJsPromise) amapJsPromise = new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { ...(window._AMapSecurityConfig || {}), securityJsCode: AMAP_JS_SECURITY_CODE };
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_JS_KEY)}`;
    script.async = true; script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error('交互地图加载失败。'));
    script.onerror = () => reject(new Error('交互地图网络加载失败。'));
    document.head.append(script);
  });
  return amapJsPromise;
}

async function openInteractiveRouteMap(route) {
  document.querySelector('#map-lightbox')?.remove();
  const title = `${route.label}路线图`, detail = `${route.distanceText} · 预计 ${route.durationText}`;
  const lightbox = document.createElement('div');
  lightbox.id = 'map-lightbox'; lightbox.className = 'map-lightbox';
  lightbox.innerHTML = `<div class="map-lightbox-panel route-map-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="map-lightbox-title"><div><strong>${esc(title)}</strong><span>${esc(detail)}</span></div><button type="button" class="map-lightbox-close" aria-label="关闭路线地图">关闭</button></div><div class="route-map-meta">${trafficStats(route.trafficSegments)}${route.trafficText ? `<b>${esc(route.trafficText)}</b>` : ''}${route.highwayText ? `<b>${esc(route.highwayText)}</b>` : ''}</div><div class="interactive-route-map" id="interactive-route-map"><p>正在加载交互路线地图…</p></div></div>`;
  const close = () => lightbox.remove();
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) close(); });
  lightbox.querySelector('.map-lightbox-close').onclick = close;
  document.body.append(lightbox);
  try {
    const AMap = await loadAmapJs();
    const container = lightbox.querySelector('#interactive-route-map'), points = parsePolyline(route.polyline);
    if (points.length < 2) throw new Error('该路线缺少可绘制坐标。');
    container.innerHTML = '';
    const map = new AMap.Map(container, { viewMode: '2D', zoom: 11, resizeEnable: true, mapStyle: 'amap://styles/normal' });
    if (AMap.TileLayer?.Traffic) new AMap.TileLayer.Traffic({ autoRefresh: true, interval: 180 }).setMap(map);
    const overlays = [new AMap.Polyline({ path: points, strokeColor: '#d9e3eb', strokeWeight: 15, strokeOpacity: .95, lineJoin: 'round', lineCap: 'round' }), new AMap.Polyline({ path: points, strokeColor: '#16a34a', strokeWeight: 8, strokeOpacity: .7, lineJoin: 'round', lineCap: 'round' })];
    (route.trafficSegments || []).forEach((segment) => {
      const segmentPoints = parsePolyline(segment.polyline);
      if (segmentPoints.length > 1) overlays.push(new AMap.Polyline({ path: segmentPoints, strokeColor: trafficColor(segment.status), strokeWeight: 10, strokeOpacity: 1, lineJoin: 'round', lineCap: 'round' }));
    });
    overlays.push(new AMap.Marker({ position: points[0], title: '起点' }), new AMap.Marker({ position: points[points.length - 1], title: '目的地' }));
    map.add(overlays); map.setFitView(overlays, false, [34, 34, 34, 34]);
  } catch (error) {
    const container = lightbox.querySelector('#interactive-route-map');
    container.innerHTML = `<p class="route-map-error">${esc(error.message || '路线地图暂不可用。')}</p>`;
  }
}

async function previewCandidate(candidate) {
  const holder = document.querySelector('#map-preview');
  holder.innerHTML = `<div class="map-preview loading"><strong>${esc(candidate.name)}</strong><span>正在加载地图预览…</span></div>`;
  try {
    const map = await request(`/api/map-preview?lng=${encodeURIComponent(candidate.lng)}&lat=${encodeURIComponent(candidate.lat)}&name=${encodeURIComponent(candidate.name)}`);
    holder.innerHTML = `<div class="map-preview"><div class="map-preview-title"><strong>地图预览：${esc(candidate.name)}</strong><span>${esc(candidate.district || candidate.address)}</span></div><button type="button" class="map-zoom" aria-label="放大查看 ${esc(candidate.name)} 的地图"><img src="${map.imageDataUrl}" alt="${esc(candidate.name)} 的地图定位预览" /><span>点击放大确认位置</span></button></div>`;
    holder.querySelector('.map-zoom').onclick = () => openMapLightbox(map.imageDataUrl, candidate);
  } catch (error) { holder.innerHTML = `<p class="status error">地图预览暂不可用：${esc(error.message)}</p>`; }
}

function openMapLightbox(imageDataUrl, candidate) {
  document.querySelector('#map-lightbox')?.remove();
  const lightbox = document.createElement('div');
  lightbox.id = 'map-lightbox'; lightbox.className = 'map-lightbox';
  lightbox.innerHTML = `<div class="map-lightbox-panel" role="dialog" aria-modal="true" aria-label="${esc(candidate.name)} 地图大图"><div class="map-lightbox-title"><div><strong>${esc(candidate.name)}</strong><span>${esc(candidate.district || candidate.address)}</span></div><button type="button" class="map-lightbox-close" aria-label="关闭地图大图">关闭</button></div><img src="${imageDataUrl}" alt="${esc(candidate.name)} 的地图定位大图" /><p>请确认标记位置后，再选择这个地点。</p></div>`;
  const close = () => lightbox.remove();
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) close(); });
  lightbox.querySelector('.map-lightbox-close').onclick = close;
  document.body.append(lightbox);
}

async function searchAddress() {
  const address = document.querySelector('#address').value.trim(), status = document.querySelector('#search-status'), holder = document.querySelector('#candidates');
  state.candidate = null; state.route = null; document.querySelector('#send').disabled = true; document.querySelector('#send').textContent = '选择路线后发送给司机'; document.querySelector('#map-preview').innerHTML = ''; document.querySelector('#route-options').innerHTML = '';
  if (address.length < 2) { status.className = 'status error'; status.textContent = '请填写目的地信息。'; return; }
  status.className = 'status'; status.textContent = '正在查找位置…'; holder.innerHTML = '';
  try {
    const result = await request(`/api/geocode?address=${encodeURIComponent(address)}`);
    if (!result.candidates.length) {
      status.className = 'status error'; status.textContent = result.message || '没有找到位置。';
      holder.innerHTML = `<button class="candidate" id="send-text-only"><strong>仍发送这段目的地信息</strong><small>司机将在地图中搜索，准确性可能较低</small></button>`;
      document.querySelector('#send-text-only').onclick = () => { selectCandidate({ name: address, address, city: '', district: '', lat: null, lng: null }, document.querySelector('#send-text-only')); };
      return;
    }
    status.textContent = '先查看地图，再确认正确的目的地。';
    holder.innerHTML = result.candidates.map((c, i) => `<article class="candidate" data-index="${i}"><strong>${esc(c.name)}</strong><small>${esc(c.district || c.city || c.address || '地图已定位')}</small><div class="candidate-actions"><button class="ghost" data-preview="${i}">查看地图</button><button class="candidate-confirm" data-select="${i}">选这个地点</button></div></article>`).join('');
    holder.querySelectorAll('[data-preview]').forEach((button) => button.onclick = () => previewCandidate(result.candidates[Number(button.dataset.preview)]));
    holder.querySelectorAll('[data-select]').forEach((button) => button.onclick = () => { const i = Number(button.dataset.select), card = button.closest('.candidate'); selectCandidate(result.candidates[i], card); previewCandidate(result.candidates[i]); });
  } catch (error) { status.className = 'status error'; status.textContent = error.message; }
}

async function sendDestination() {
  if (!state.candidate || !state.route) return;
  const button = document.querySelector('#send'); button.disabled = true; button.textContent = '正在发送…';
  try {
    await request(`/api/boards/${state.boardId}/destination`, { method: 'POST', body: JSON.stringify({ destination: { ...state.candidate, route: state.route, note: document.querySelector('#note').value.trim() } }) });
    app.innerHTML = `${brand()}<section class="card"><p class="eyebrow">已发送</p><h1>司机已收到目的地</h1><p class="lead">请让司机在手机上选择常用地图并点击导航。</p><div class="destination"><p class="address">${esc(state.candidate.name)}</p><p class="muted">${esc(state.candidate.address)}</p></div></section>`;
  } catch (error) { button.disabled = false; button.textContent = '确认位置后发送'; alert(error.message); }
}

function isNativeAndroid() { return window.Capacitor?.getPlatform?.() === 'android'; }

async function openMap(provider, d) {
  const hasPoint = Number.isFinite(d.lat) && Number.isFinite(d.lng), name = encodeURIComponent(d.name), address = encodeURIComponent(d.address), { lat, lng } = d;
  const fallback = { amap: hasPoint ? `https://uri.amap.com/navigation?to=${lng},${lat},${name}&mode=car&callnative=1` : `https://uri.amap.com/search?keyword=${address}&callnative=1`, baidu: hasPoint ? `https://api.map.baidu.com/direction?destination=latlng:${lat},${lng}|name:${name}&mode=driving&coord_type=gcj02&output=html` : `https://api.map.baidu.com/geocoding/v3/?address=${address}&output=html`, tencent: hasPoint ? `https://apis.map.qq.com/uri/v1/routeplan?type=drive&tocoord=${lat},${lng}&to=${name}&referer=destinationbridge` : `https://apis.map.qq.com/uri/v1/search?keyword=${address}&referer=destinationbridge`, apple: hasPoint ? `https://maps.apple.com/directions?destination=${lat},${lng}&mode=driving` : `https://maps.apple.com/?q=${address}` };
  const native = hasPoint ? { amap: `androidamap://navi?sourceApplication=daonaer&poiname=${name}&lat=${lat}&lon=${lng}&dev=0&style=0`, baidu: `baidumap://map/direction?destination=latlng:${lat},${lng}|name:${name}&mode=driving&coord_type=gcj02&src=daonaer`, tencent: `qqmap://map/routeplan?type=drive&tocoord=${lat},${lng}&to=${name}&referer=daonaer` } : {};
  // In Harmony's Android compatibility layer, hand the map scheme to the
  // system. It can open a compatible map directly or offer its app-search flow.
  if (isNativeAndroid() && native[provider]) { window.location.href = native[provider]; return; }
  window.location.href = fallback[provider];
}

function renderError(message) { app.innerHTML = `${brand()}<section class="card"><h2>暂时无法生成二维码</h2><p class="muted">${esc(message)}</p><button class="primary" id="retry">重试</button></section>`; document.querySelector('#retry').onclick = openDriverBoard; }

if (state.boardId) renderPassenger(); else renderHome();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
