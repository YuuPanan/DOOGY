import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const fenceModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/fences.mjs')).href);
const circleForm = { name: '家附近', shape: 'circle', lat: '0', lon: '121.47', radius_m: '100', buffer_m: '10', min_buffer_m: '15',
  accuracy_limit_m: '100', confirm_points: '2', min_exit_seconds: '0', min_enter_seconds: '0' };

test('围栏表单按经度、纬度解析顶点并拒绝空或无效数字', async () => {
  const { fenceFormBody } = await fenceModule;
  const polygon = { ...circleForm, shape: 'polygon', coordinates: '121.47, 31.23\r\n121.48，31.23\r\n121.47,31.24' };
  assert.deepEqual(fenceFormBody(polygon).geometry, { type: 'polygon', coordinates: [[121.47, 31.23], [121.48, 31.23], [121.47, 31.24]] });
  assert.equal(fenceFormBody(circleForm).geometry.lat, 0);
  assert.throws(() => fenceFormBody({ ...circleForm, lat: '' }), /中心纬度/);
  assert.throws(() => fenceFormBody({ ...polygon, coordinates: '121.47, 31.23\n ,31.23\n121.47,31.24' }), /第 2 行经度/);
  assert.throws(() => fenceFormBody({ ...polygon, coordinates: '121.47,31.23\n121.48,31.23' }), /3–101/);
});

test('围栏编辑仅提交改动，包括明确关闭动态缓冲', async () => {
  const { fenceFormBody } = await fenceModule;
  const existing = fenceFormBody({ ...circleForm, dynamic_buffer: 'on' });
  assert.deepEqual(fenceFormBody({ ...circleForm, name: '  安全范围  ', dynamic_buffer: 'on' }, existing), { name: '安全范围' });
  assert.deepEqual(fenceFormBody(circleForm, existing), { dynamic_buffer: false });
  assert.deepEqual(fenceFormBody({ ...circleForm, dynamic_buffer: 'on' }, existing), {});
  assert.deepEqual(fenceFormBody({ ...circleForm, dynamic_buffer: 'on', min_exit_seconds: '15' }, existing), { min_exit_seconds: 15 });
});
