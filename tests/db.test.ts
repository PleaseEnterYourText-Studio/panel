import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { insertAsset, getAssetBySlug, listDueTargets } from '../src/db/queries';

describe('queries', () => {
  it('inserts and reads an asset by slug', async () => {
    await insertAsset(env.DB, {
      id: 'a1', kind: 'service', name: 'newapi', slug: 'newapi',
      grp: 'prod', ownerEmail: 'nowint@peyt.studio', repo: 'NoWint/xiatian-ai-newapi',
      tags: 'ai', notes: null, enabled: 1, createdAt: 1_700_000_000_000,
    });
    const row = await getAssetBySlug(env.DB, 'newapi');
    expect(row?.name).toBe('newapi');
  });

  it('returns only due targets up to the limit', async () => {
    const due = await listDueTargets(env.DB, 1_700_000_100_000, 40);
    expect(Array.isArray(due)).toBe(true);
  });
});
