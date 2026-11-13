const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'v1.';
const TOKEN_CONTEXT = new TextEncoder().encode('easynews-stream-link-v1');

export class ExpiredStreamLink extends Error {}

export async function importStreamLinkKey(secret: unknown): Promise<CryptoKey> {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error('Stream link encryption key is not configured');
  }
  const bytes = Uint8Array.from(Buffer.from(secret, 'base64url'));
  if (bytes.length !== 32) throw new Error('Invalid stream link encryption key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// The addon creates a legacy resolver URL internally. Never return it to clients.
export function extractEasynewsUrl(streamUrl: string): string | null {
  const url = new URL(streamUrl);
  if (url.origin === 'https://example.com' && url.pathname === '/error') return null;
  const resolver = url.pathname.match(/\/resolve\/([^/]+)\/[^/]+$/);
  let target: URL;
  if (resolver) {
    target = new URL(Buffer.from(resolver[1], 'base64url').toString('utf8'));
  } else {
    target = url;
    if (target.username || target.password) {
      target.searchParams.set('u', decodeURIComponent(target.username));
      target.searchParams.set('p', decodeURIComponent(target.password));
      target.username = '';
      target.password = '';
    }
  }
  if (target.protocol !== 'https:' || target.port || target.username || target.password ||
      !/^([a-z0-9-]+\.)*easynews\.com$/i.test(target.hostname) ||
      !target.searchParams.get('u') || !target.searchParams.get('p')) {
    throw new Error('Invalid Easynews stream URL');
  }
  return target.toString();
}

export async function sealStreamLink(target: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ target, expires: Date.now() + LINK_LIFETIME_MS }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: TOKEN_CONTEXT }, key, payload);
  return TOKEN_PREFIX + Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64url');
}

export async function openStreamLink(token: string, key: CryptoKey): Promise<URL> {
  if (!token.startsWith(TOKEN_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(token.slice(TOKEN_PREFIX.length)) || token.length > 16384) {
    throw new Error('Invalid stream link');
  }
  const bytes = Uint8Array.from(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url'));
  if (bytes.length < 29) throw new Error('Invalid stream link');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: TOKEN_CONTEXT }, key, bytes.slice(12));
  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as { target?: unknown; expires?: unknown };
  if (typeof payload.expires !== 'number' || !Number.isSafeInteger(payload.expires)) throw new Error('Invalid stream link');
  if (Date.now() >= payload.expires) throw new ExpiredStreamLink();
  if (typeof payload.target !== 'string') throw new Error('Invalid stream link');
  const target = extractEasynewsUrl(payload.target);
  if (!target) throw new Error('Invalid stream link');
  return new URL(target);
}

export function genericFilename(target: string): string {
  const pathname = new URL(target).pathname;
  const extension = pathname.match(/\.(m4v|3gp|mov|divx|xvid|wmv|avi|mpg|mpeg|mp4|mkv|avc|flv|webm)$/i)?.[0] || '';
  return `video${extension.toLowerCase()}`;
}
