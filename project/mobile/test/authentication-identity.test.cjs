const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { React, screenModule, render, change, act } = require('./helpers/render-screen.cjs');

test('registered session survives identity failure and can finish without repeating account creation', async t => {
  const before = process.env.EXPO_PUBLIC_API_URL; process.env.EXPO_PUBLIC_API_URL = 'https://qa.example.invalid';
  t.after(() => { if (before === undefined) delete process.env.EXPO_PUBLIC_API_URL; else process.env.EXPO_PUBLIC_API_URL = before; });
  let state, failed = false, posts = 0, sessions = 0;
  class FakeApi {
    constructor(origin) { this.origin = origin; this.sessionEpoch = 0; this.saved = false; }
    async restore() { return this.saved; }
    async setSession() { this.saved = true; sessions++; }
    async post() { posts++; return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }; }
    async get(endpoint) {
      if (endpoint === '/auth/me') { if (!failed) { failed = true; throw new Error('synthetic identity 503'); } return { id: 'owner' }; }
      if (endpoint === '/households') return { items: [{ id: 'family', role: 'owner' }] };
      if (endpoint === '/pets') return { items: [{ id: 'pet', household_id: 'family' }] };
      if (endpoint === '/auth/onboarding') return { pet_id: 'pet', next_step: 'done' };
      throw new Error(`Unexpected ${endpoint}`);
    }
    async clear() { this.saved = false; }
  }
  const { AppProvider, useApp } = screenModule('src/state/AppContext.tsx', null, {
    '../lib/mobileApi': { MobileApi: FakeApi },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} },
  });
  function Probe() { state = useApp(); return React.createElement('Probe'); }
  const tree = await render(AppProvider, { children: React.createElement(Probe) });
  t.after(async () => { await act(async () => tree.unmount()); });
  await change(async () => { await assert.rejects(state.authenticate('register', { email: 'qa@example.invalid' }), /identity|资料/); });
  assert.equal(state.authenticated, false); assert.equal(state.canRetryRestore, true);
  assert.equal(state.api.saved, true); assert.match(state.restoreError, /资料/);
  await change(() => state.retryRestore());
  assert.equal(state.authenticated, true); assert.equal(state.pet.id, 'pet'); assert.equal(state.restoreError, null);
  assert.equal(posts, 1); assert.equal(sessions, 1);
});
