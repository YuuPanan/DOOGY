import { ApiClient } from './client';

export async function readIdentity(client: ApiClient) {
  const [profile, families, animals, guide] = await Promise.all([
    client.get('/auth/me'), client.get('/households'), client.get('/pets'), client.get('/auth/onboarding'),
  ]);
  return { profile, families, animals, guide };
}

export async function restoreIdentity(client: ApiClient, isCurrent: () => boolean) {
  const epoch = client.sessionEpoch, current = () => isCurrent() && client.sessionEpoch === epoch;
  try {
    if (!current() || !await client.restore() || !current()) return null;
    const identity = await readIdentity(client);
    return current() ? identity : null;
  } catch (error) { if (!current()) return null; throw error; }
}
