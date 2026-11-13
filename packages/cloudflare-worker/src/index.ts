import { Hono } from 'hono';
import { getRouter } from 'hono-stremio';
import { addonInterface, customTemplate } from 'easynews-plus-plus-addon';
import { getUILanguage } from 'easynews-plus-plus-addon/dist/i18n';
import { createLogger } from 'easynews-plus-plus-shared';
import { ExpiredStreamLink, extractEasynewsUrl, genericFilename, importStreamLinkKey, openStreamLink, sealStreamLink } from './stream-links';

// Create a logger with CF prefix for better context and set Cloudflare environment
const logger = createLogger({ prefix: 'CF', isCloudflare: true });

// Create the router with the default HTML
logger.debug('Initializing Cloudflare Worker with addon interface');
const defaultHTML = customTemplate(addonInterface.manifest);
logger.debug(`Generated default HTML template (${defaultHTML.length} bytes)`);
const addonRouter = getRouter(addonInterface, { landingHTML: defaultHTML });
logger.debug('Created Stremio router with addon interface');

const app = new Hono();
logger.debug('Initialized Hono app');

// Helper function to create a deep clone of the manifest with a specified language
function createManifestWithLanguage(lang: string) {
  logger.debug(`Creating manifest clone for language: ${lang}`);
  const manifest = structuredClone(addonInterface.manifest);

  // Find and update the uiLanguage field
  if (manifest.config) {
    const uiLangFieldIndex = manifest.config.findIndex((field: any) => field.key === 'uiLanguage');
    if (uiLangFieldIndex >= 0 && lang) {
      logger.debug(`Setting language in manifest to: ${lang}`);
      manifest.config[uiLangFieldIndex].default = lang;
      logger.debug(`Updated manifest language setting to: ${lang}`);
    } else {
      logger.debug(`No uiLanguage field found in manifest config or empty language`);
    }
  } else {
    logger.debug('No config found in manifest');
  }

  return manifest;
}

// Encrypt addon-generated stream links before the response leaves the Worker.
app.use('*', async (c, next) => {
  if (!/\/stream\/(?:movie|series)\/[^/]+(?:\/[^/]+)?\.json$/.test(new URL(c.req.url).pathname)) {
    return next();
  }
  let key: CryptoKey;
  try {
    key = await importStreamLinkKey((c.env as Record<string, unknown>)?.STREAM_LINK_KEY);
  } catch {
    return c.json({ error: 'Stream link encryption is not configured' }, 503, { 'Cache-Control': 'no-store' });
  }
  await next();
  if (!c.res.ok) return;
  try {
    const body = await c.res.json() as { streams?: Array<{ url?: string }>; cacheMaxAge?: number; staleRevalidate?: number; staleError?: number };
    if (!Array.isArray(body.streams)) throw new Error('Invalid stream response');
    const origin = new URL(c.req.url).origin;
    await Promise.all(body.streams.map(async stream => {
      if (!stream.url) return;
      const target = extractEasynewsUrl(stream.url);
      if (!target) return; // Addon error placeholder, not a playback URL.
      const token = await sealStreamLink(target, key);
      stream.url = `${origin}/resolve/${token}/${genericFilename(target)}`;
    }));
    delete body.cacheMaxAge;
    delete body.staleRevalidate;
    delete body.staleError;
    const headers = new Headers(c.res.headers);
    headers.set('Cache-Control', 'no-store');
    headers.delete('Content-Length');
    c.res = new Response(JSON.stringify(body), { status: c.res.status, headers });
    c.header('Cache-Control', 'no-store');
  } catch {
    c.res = c.json({ error: 'Unable to protect stream links' }, 500, { 'Cache-Control': 'no-store' });
    c.header('Cache-Control', 'no-store');
  }
});

// Only authenticated, unexpired encrypted tokens are accepted.
app.get('/resolve/:payload/:filename', async c => {
  let parsed: URL;
  try {
    const key = await importStreamLinkKey((c.env as Record<string, unknown>)?.STREAM_LINK_KEY);
    parsed = await openStreamLink(c.req.param('payload'), key);
  } catch (err) {
    if (err instanceof ExpiredStreamLink) return c.text('Stream link expired; refresh the stream list', 410, { 'Cache-Control': 'no-store' });
    return c.text('Invalid stream link', 400, { 'Cache-Control': 'no-store' });
  }

  const username = parsed.searchParams.get('u') || '';
  const password = parsed.searchParams.get('p') || '';
  parsed.searchParams.delete('u');
  parsed.searchParams.delete('p');
  const cleanUrl = parsed.toString();

  try {
    const auth = 'Basic ' + btoa(`${username}:${password}`);
    const response = await fetch(cleanUrl, {
      method: 'GET',
      headers: { Authorization: auth, Range: 'bytes=0-0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const location = response.headers.get('Location');
    if (response.body) await response.body.cancel();
    if (!response.ok && !(response.status >= 300 && response.status < 400 && location)) {
      return c.text('Unable to resolve stream', 502, { 'Cache-Control': 'no-store' });
    }
    c.header('Cache-Control', 'no-store');
    return c.redirect(location || cleanUrl, 307);
  } catch {
    logger.error('Error resolving stream');
    return c.text('Error resolving stream', 502, { 'Cache-Control': 'no-store' });
  }
});

// Add the configure route for direct access with language selection
app.get('/configure', c => {
  logger.debug(`Received configure request from: ${c.req.header('user-agent')}`);

  // Set no-cache headers
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  const lang = c.req.query('lang') || '';
  const uiLanguage = getUILanguage(lang);

  logger.debug(
    `Cloudflare worker: Received request with lang=${lang}, using UI language ${uiLanguage}`
  );

  // Generate new HTML with the selected language
  let tempManifest;

  // If a language is specified, create a specialized manifest for that language
  if (lang) {
    logger.debug(`Creating customized manifest for language: ${lang}`);
    tempManifest = createManifestWithLanguage(lang);
  } else {
    // Otherwise, use the default manifest
    logger.debug('Using default manifest (no language specified)');
    tempManifest = addonInterface.manifest;
  }

  // Generate new HTML with the updated language
  logger.debug('Generating HTML with localized template');
  const localizedHTML = customTemplate(tempManifest);
  logger.debug(`Generated localized HTML (${localizedHTML.length} bytes)`);
  return c.html(localizedHTML);
});

// If we have a config, add a redirect from the root to configure
if ((addonInterface.manifest.config || []).length > 0) {
  logger.debug('Addon has configuration, setting up root redirect');
  app.get('/', c => {
    logger.debug(`Received root request from: ${c.req.header('user-agent')}`);

    // Pass any language parameter to the configure route
    const lang = c.req.query('lang') || '';
    const redirectUrl = lang ? `/configure?lang=${lang}` : '/configure';
    logger.debug(`Cloudflare worker: Redirecting to ${redirectUrl}`);
    return c.redirect(redirectUrl);
  });
} else {
  logger.debug('Addon has no configuration, keeping default root route');
}

app.route('/', addonRouter as any);
logger.info('Router setup complete, Cloudflare Worker initialized');

export default app;
