import { ApiClient } from './api.mjs';

const api = new ApiClient('/api/v1', null);
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const refresh = document.querySelector('#refresh');
const summary = document.querySelector('#summary');
const point = document.querySelector('#point');
const sources = { gnss: 'GNSS 卫星定位', wifi: 'Wi-Fi', cellular: '蜂窝网络', ble: '蓝牙', vendor: '供应商' };
const when = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const unavailable = '分享链接已失效或不存在。';
let request = 0;
let expiryTimer;

function clearResult(message) {
  result.replaceChildren();
  result.hidden = true;
  status.textContent = message;
}

function pointCard(location, title, caption) {
  const card = point.content.cloneNode(true);
  card.querySelector('[data-title]').textContent = title;
  card.querySelector('[data-caption]').textContent = caption;
  card.querySelector('[data-coordinate]').textContent = `${location.lat}, ${location.lon}`;
  card.querySelector('[data-sampled]').textContent = when(location.device_ts);
  card.querySelector('[data-accuracy]').textContent = `${location.accuracy_m} 米`;
  card.querySelector('[data-source]').textContent = sources[location.source] ?? location.source;
  card.querySelector('[data-freshness]').textContent = location.freshness === 'fresh' ? '本次读取时新鲜' : '本次读取时已过期';
  return card;
}

async function load() {
  const current = ++request;
  const token = location.hash.slice(1);
  clearTimeout(expiryTimer);
  clearResult('正在读取分享…');
  refresh.disabled = true;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    clearResult(unavailable);
    return;
  }

  try {
    const response = await api.response(`/location-shares/${token}`);
    const data = await response.json();
    if (current !== request) return;

    const readAt = Date.parse(response.headers.get('Date')) || Date.now();
    const remaining = Date.parse(data.expires_at) - readAt;
    if (remaining <= 0) {
      clearResult(unavailable);
      return;
    }
    const overview = summary.content.cloneNode(true);
    overview.querySelector('[data-pet]').textContent = data.pet.name;
    overview.querySelector('[data-expires]').textContent = when(data.expires_at);
    overview.querySelector('[data-read-time]').textContent = when(readAt);
    result.append(overview);

    if (data.location) {
      const caption = data.location.usable_for_tracking ? '本次读取时可用于追踪。' : '本次读取时暂不可用于追踪，请结合采样时间与定位精度参考。';
      result.append(pointCard(data.location, '最近一次上报位置', caption));
    }
    if (data.last_usable_location) {
      result.append(pointCard(data.last_usable_location, '较早的可用位置', '这是最近一次上报之前的参考点。'));
    }
    status.textContent = data.location ? '' : '分享已打开，等待设备上报位置。';
    result.hidden = false;
    // shortcut: revocation is checked on refresh or return from background; add live updates if required.
    expiryTimer = setTimeout(() => clearResult(unavailable), remaining);
  } catch (error) {
    if (current === request) clearResult(error.status === 404 ? unavailable : '暂时无法读取位置，请刷新重试。');
  } finally {
    if (current === request) refresh.disabled = false;
  }
}

refresh.addEventListener('click', load);
window.addEventListener('hashchange', load);
window.addEventListener('pageshow', (event) => { if (event.persisted) void load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
void load();
