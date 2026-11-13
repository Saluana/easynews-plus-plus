import { afterEach, describe, expect, it, vi } from 'vitest';

const easynewsUrl = 'https://members.easynews.com/farm/Secret.Show.S01E01.mkv?u=test-user&p=test-password';
const legacyToken = Buffer.from(easynewsUrl).toString('base64url');
const legacyUrl = `https://addon.example/resolve/${legacyToken}/Secret.Show.S01E01.mkv`;

vi.mock('easynews-plus-plus-addon', () => ({
  addonInterface: {
    manifest: { config: [{ key: 'username' }], catalogs: [], resources: ['stream'], behaviorHints: { configurable: true } },
    get: async () => ({ streams: [{ name: 'A show', url: legacyUrl }], cacheMaxAge: 86400 }),
  },
  customTemplate: () => '',
}));
vi.mock('easynews-plus-plus-addon/dist/i18n', () => ({ getUILanguage: () => 'eng' }));

import app from '../src/index';

const env = { STREAM_LINK_KEY: Buffer.alloc(32, 42).toString('base64url') };
const streamRequest = () => app.request('https://addon.example/config/stream/series/tt123:1:1.json', {}, env);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('encrypted stream links', () => {
  it('hides the credential and filename and resolves through Easynews until expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const response = await streamRequest();
    const data = await response.json() as { streams: { url: string }[] };
    const link = data.streams[0].url;
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(data).not.toHaveProperty('cacheMaxAge');
    expect(link).toMatch(/^https:\/\/addon\.example\/resolve\//);
    expect(link).toMatch(/\/video\.mkv$/);
    expect(link).not.toContain('Secret.Show');
    expect(link).not.toContain(legacyToken);
    const token = new URL(link).pathname.split('/')[2];
    const decoded = Buffer.from(token.replace(/^v1\./, ''), 'base64url').toString();
    expect(decoded).not.toContain('test-password');
    expect(decoded).not.toContain('Secret.Show');

    const upstream = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://download.easynews.com/temporary' } }));
    vi.stubGlobal('fetch', upstream);
    vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
    const resolved = await app.request(link, {}, env);
    expect(resolved.status).toBe(307);
    expect(resolved.headers.get('location')).toBe('https://download.easynews.com/temporary');
    expect(upstream).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const expired = await app.request(link, {}, env);
    expect(expired.status).toBe(410);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('rejects altered and old unencrypted tokens without contacting Easynews', async () => {
    const response = await streamRequest();
    const data = await response.json() as { streams: { url: string }[] };
    const url = new URL(data.streams[0].url);
    const parts = url.pathname.split('/');
    const token = parts[2];
    const offset = Math.floor(token.length / 2);
    parts[2] = token.slice(0, offset) + (token[offset] === 'A' ? 'B' : 'A') + token.slice(offset + 1);
    url.pathname = parts.join('/');
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await app.request(url.toString(), {}, env)).status).toBe(400);
    expect((await app.request(legacyUrl, {}, env)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not return exposed links when the encryption key is missing', async () => {
    const response = await app.request('https://addon.example/config/stream/series/tt123:1:1.json', {}, {});
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(legacyToken);
  });
});
