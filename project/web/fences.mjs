const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const rules = [
  { key: 'buffer_m', label: '固定缓冲（米）', min: 0, max: 500, initial: 10 },
  { key: 'min_buffer_m', label: '最小动态缓冲（米）', min: 0, max: 500, initial: 15 },
  { key: 'accuracy_limit_m', label: '最大定位误差（米）', min: 0, max: 500, initial: 100, positive: true },
  { key: 'confirm_points', label: '连续确认点数', min: 2, max: 10, initial: 2, integer: true },
  { key: 'min_exit_seconds', label: '越界持续时间（秒）', min: 0, max: 3600, initial: 0, integer: true },
  { key: 'min_enter_seconds', label: '返回持续时间（秒）', min: 0, max: 3600, initial: 0, integer: true },
];

function numberField(label, name, value, min, max, integer = false) {
  return `<label>${label}<input type="number" name="${name}" value="${esc(value)}" min="${min}" max="${max}" step="${integer ? '1' : 'any'}" required></label>`;
}

export function renderFenceForm(fence, submitHtml) {
  const geometry = fence?.geometry;
  const polygon = geometry?.type === 'polygon';
  const coordinates = polygon ? geometry.coordinates.map(([lon, lat]) => `${lon}, ${lat}`).join('\n') : '';
  return `<form id="fence-form" class="form-grid" data-id="${esc(fence?.id)}">
    <label>围栏名称<input name="name" value="${esc(fence?.name)}" required maxlength="100"></label>
    <label>围栏形状<select name="shape"><option value="circle"${polygon ? '' : ' selected'}>圆形</option><option value="polygon"${polygon ? ' selected' : ''}>多边形</option></select></label>
    <fieldset class="full-span" data-geometry="circle"${polygon ? ' hidden disabled' : ''}>
      <legend>圆形范围</legend><div class="form-grid">
        ${numberField('中心纬度', 'lat', geometry?.lat, -90, 90)}
        ${numberField('中心经度', 'lon', geometry?.lon, -180, 180)}
        ${numberField('半径（米）', 'radius_m', geometry?.radius_m, 0, 100000)}
      </div>
    </fieldset>
    <fieldset class="full-span" data-geometry="polygon"${polygon ? '' : ' hidden disabled'}>
      <legend>多边形范围</legend>
      <label>多边形顶点<textarea name="coordinates" rows="5" required aria-describedby="fence-coordinate-help">${esc(coordinates)}</textarea></label>
      <p class="hint" id="fence-coordinate-help">按边界顺序输入 3–101 行 WGS84 坐标，每行「经度, 纬度」，例如 121.470, 31.230。边界会自动闭合，不可自相交。</p>
    </fieldset>
    ${rules.map(({ key, label, initial, min, max, integer }) => numberField(label, key, fence?.[key] ?? initial, min, max, integer)).join('')}
    <label class="share-consent full-span"><input type="checkbox" name="dynamic_buffer"${fence?.dynamic_buffer ? ' checked' : ''}>根据定位误差扩大缓冲区</label>
    <p class="hint full-span">连续确认点数与持续时间均满足后，状态才会改变。修改判定规则会清除旧判断，等待新定位。</p>
    ${submitHtml}
  </form>`;
}

export function syncFenceGeometry(form) {
  const shape = form.elements.namedItem('shape').value;
  for (const group of form.querySelectorAll('fieldset[data-geometry]')) {
    group.hidden = group.disabled = group.dataset.geometry !== shape;
  }
}

const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function readNumber(raw, label, min, max, { integer = false, positive = false } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const value = Number(text);
  if (!decimal.test(text) || !Number.isFinite(value) || value < min || value > max || (positive && value <= 0) || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}须为${positive ? `大于 0 且不超过 ${max}` : `${min} 至 ${max} 之间`}的${integer ? '整数' : '数字'}`);
  }
  return value;
}

function readGeometry(values) {
  if (values.shape === 'circle') {
    return { type: 'circle', lat: readNumber(values.lat, '中心纬度', -90, 90), lon: readNumber(values.lon, '中心经度', -180, 180),
      radius_m: readNumber(values.radius_m, '半径', 0, 100000, { positive: true }) };
  }
  if (values.shape !== 'polygon') throw new Error('请选择围栏形状');
  const lines = String(values.coordinates ?? '').trim().split(/\r?\n/);
  if (lines.length < 3 || lines.length > 101) throw new Error('请输入 3–101 行多边形顶点');
  return { type: 'polygon', coordinates: lines.map((line, index) => {
    const pair = line.split(/[,，]/);
    const row = `第 ${index + 1} 行`;
    if (pair.length !== 2) throw new Error(`${row}请按「经度, 纬度」输入`);
    return [readNumber(pair[0], `${row}经度`, -180, 180), readNumber(pair[1], `${row}纬度`, -90, 90)];
  }) };
}

function geometryMatches(next, previous) {
  if (next.type !== previous?.type) return false;
  if (next.type === 'circle') return next.lat === previous.lat && next.lon === previous.lon && next.radius_m === previous.radius_m;
  return JSON.stringify(next.coordinates) === JSON.stringify(previous.coordinates);
}

export function fenceFormBody(values, existing) {
  const name = typeof values.name === 'string' ? values.name.trim() : '';
  if (!name || name.length > 100) throw new Error('请填写 1–100 字的围栏名称');
  const geometry = readGeometry(values);
  const body = { name, geometry, dynamic_buffer: values.dynamic_buffer === 'on' };
  for (const rule of rules) body[rule.key] = readNumber(values[rule.key], rule.label, rule.min, rule.max, rule);
  if (!existing) return body;
  // Sending an unchanged rule would reset the fence's current judgment.
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => key === 'geometry' ? !geometryMatches(geometry, existing.geometry) : value !== existing[key]));
}
