import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;

test('registration, password authentication, rotating refresh and logout revoke tokens', async () => {
  let now = new Date('2026-11-17T02:00:00Z');
  const db = new Db(':memory:', () => now);
  try {
    const identity = new IdentityService(db);
    const owner = await identity.register({ email: 'Owner@Example.com', password: 'password123' });
    assert.equal(owner.user.email, 'owner@example.com');
    assert.equal((await identity.userFromAccess(owner.access_token)), owner.user.id);
    await assert.rejects(async () => await identity.register({ email: 'owner@example.com', password: 'password123' }), status(409));
    await assert.rejects(async () => await identity.login({ email: owner.user.email, password: 'wrong-password' }), status(401));
    const signedIn = await identity.login({ email: owner.user.email, password: 'password123' });
    assert.equal(signedIn.user.id, owner.user.id);
    const refreshed = await identity.refresh({ refresh_token: signedIn.refresh_token });
    await assert.rejects(async () => await identity.refresh({ refresh_token: signedIn.refresh_token }), status(401));
    await assert.rejects(async () => await identity.userFromAccess(signedIn.access_token), status(401));
    assert.equal((await identity.userFromAccess(refreshed.access_token)), owner.user.id);
    await identity.logout(`Bearer ${refreshed.access_token}`);
    await assert.rejects(async () => await identity.userFromAccess(refreshed.access_token), status(401));
    await assert.rejects(async () => await identity.refresh({ refresh_token: refreshed.refresh_token }), status(401));
    now = new Date('2026-11-17T03:00:00Z');
    await assert.rejects(async () => await identity.userFromAccess(owner.access_token), status(401));
    assert.ok((await identity.refresh({ refresh_token: owner.refresh_token })).access_token);
    assert.notEqual((await db.get('SELECT password_hash FROM users WHERE id=?', owner.user.id))!.password_hash, 'password123');
  } finally { await db.close(); }
});

test('household invitation email, viewer restrictions, role change and immediate revocation', async () => {
  const db = new Db(':memory:');
  try {
    const identity = new IdentityService(db);
    const owner = await identity.register({ email: 'owner@example.com', password: 'password123' });
    const invited = await identity.register({ email: 'viewer@example.com', password: 'password123' });
    const outsider = await identity.register({ email: 'outsider@example.com', password: 'password123' });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '豆豆', species: 'cat' });
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: invited.user.email, role: 'viewer' });
    await assert.rejects(async () => await identity.accept(outsider.user.id, invitation.token), status(403));
    await identity.accept(invited.user.id, invitation.token);
    assert.equal((await identity.getPet(invited.user.id, pet.id)).name, '豆豆');
    await assert.rejects(async () => await identity.updatePet(invited.user.id, pet.id, { name: '其他名字' }), status(403));
    await assert.rejects(async () => await identity.getPet(outsider.user.id, pet.id), status(404));
    await assert.rejects(async () => await identity.invite(invited.user.id, owner.household.id, { email: outsider.user.email }), status(403));
    await identity.changeMember(owner.user.id, owner.household.id, invited.user.id, { role: 'caregiver' });
    const updated = await identity.updatePet(invited.user.id, pet.id, { weight_kg: 4.5 });
    assert.equal(updated.weight_kg, 4.5);
    assert.equal(updated.species, 'cat');
    await assert.rejects(async () => await identity.updatePet(owner.user.id, pet.id, {}), status(400));
    await assert.rejects(async () => await identity.changeMember(owner.user.id, owner.household.id, owner.user.id, { role: 'viewer' }), status(409));
    await identity.revokeMember(owner.user.id, owner.household.id, invited.user.id);
    await assert.rejects(async () => await identity.getPet(invited.user.id, pet.id), status(404));
    await assert.rejects(async () => await identity.accept(invited.user.id, invitation.token), status(404));
    assert.ok((await db.get('SELECT id FROM audit_logs WHERE action=?', 'household.member.revoke')));
  } finally { await db.close(); }
});

test('invitation expires and login throttling expires after ten minutes', async () => {
  let now = new Date('2026-11-17T02:00:00Z');
  const db = new Db(':memory:', () => now);
  try {
    const identity = new IdentityService(db);
    const owner = await identity.register({ email: 'owner@example.com', password: 'password123' });
    const invited = await identity.register({ email: 'viewer@example.com', password: 'password123' });
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: invited.user.email });
    for (let i = 0; i < 10; i++) await assert.rejects(async () => await identity.login({ email: owner.user.email, password: 'incorrect' }), status(401));
    await assert.rejects(async () => await identity.login({ email: owner.user.email, password: 'password123' }), status(429));
    now = new Date('2026-11-17T02:11:00Z');
    assert.ok((await identity.login({ email: owner.user.email, password: 'password123' })).access_token);
    now = new Date('2026-11-25T02:00:00Z');
    await assert.rejects(async () => await identity.accept(invited.user.id, invitation.token), status(404));
  } finally { await db.close(); }
});
