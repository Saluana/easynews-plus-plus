import { EasynewsSearchResponse, FileData } from 'easynews-plus-plus-api';
import { MetaProviderResponse } from './meta';
import { ContentType } from 'stremio-addon-sdk';
import { parse as parseTorrentTitle } from 'parse-torrent-title';
import path from 'path';
import dotenv from 'dotenv';
import { createLogger } from 'easynews-plus-plus-shared';
import { Buffer } from 'buffer';

// Import the custom titles JSON directly
import customTitlesJson from '../../../custom-titles.json';

// Load .env file to ensure we have all environment variables
function loadEnv() {
  // Skip .env loading for Cloudflare Workers environment
  if (process.env.CLOUDFLARE === 'true') {
    // We can't use logger here since it's not initialized yet
    console.log('Cloudflare environment detected, skipping .env file loading');
    return;
  }

  try {
    // Load environment variables from env file in project root
    const configPath = path.resolve('../../.env');
    const result = dotenv.config({ path: configPath });

    // Log the result of loading the environment config
    if (result.error) {
      // We can't use logger here since it's not initialized yet
      console.warn('Error loading .env. Continuing with default values.');
    } else {
      // We can't use logger here since it's not initialized yet
      console.log('Environment configuration loaded successfully');
    }
  } catch (error) {
    // We can't use logger here since it's not initialized yet
    console.error('Error while trying to load .env file:', error);
  }
}

// Only load .env in non-Cloudflare environments
if (typeof process !== 'undefined' && !process.env.CLOUDFLARE) {
  loadEnv();
}

// Create a logger with Addon prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Utils',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

// Add interface to declare the function with properties
interface TypeFunction {
  (type?: string): string;
  currentType: string;
}

export function isBadVideo(file: FileData) {
  const duration = file['14'] ?? '';
  const title = getPostTitle(file);

  logger.debug(`Checking if video is bad: "${title}" (duration: ${duration}, type: ${file.type})`);

  // Check each condition and log the reason if it fails
  if (duration.match(/^\d+s/)) {
    logger.debug(`Bad video: "${title}": Duration too short (${duration})`);
    return true;
  }
  if (duration.match('^[0-5]m')) {
    logger.debug(`Bad video: "${title}": Duration too short (${duration})`);
    return true;
  }
  if (file.passwd) {
    logger.debug(`Bad video: "${title}": Password protected`);
    return true;
  }
  if (file.virus) {
    logger.debug(`Bad video: "${title}": Contains virus`);
    return true;
  }
  if (file.type.toUpperCase() !== 'VIDEO') {
    logger.debug(`Bad video: "${title}": Not a video file (type: ${file.type})`);
    return true;
  }
  if (file.rawSize && file.rawSize < 20 * 1024 * 1024) {
    logger.debug(
      `Bad video: "${title}": File too small (${Math.round(file.rawSize / 1024 / 1024)}MB)`
    );
    return true;
  }

  logger.debug(`Video passed quality checks: "${title}"`);
  return false;
}

/**
 * Sanitize a title for case-insensitive comparison.
 * Handles special characters, accented letters, and common separators.
 */
export function sanitizeTitle(title: string) {
  // logger.debug(`Sanitizing title: "${title}"`);
  const result = title
    // replace common accented characters with their base characters
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    // replace common symbols with words
    .replaceAll('&', 'and')
    // replace common separators (., _, -, whitespace) with a single space
    .replace(/[\.\-_:\s]+/g, ' ')
    // handle brackets and parentheses - replace with space
    .replace(/[\[\]\(\){}]/g, ' ')
    // remove non-alphanumeric characters except for accented characters
    .replace(/[^\w\sÀ-ÿ]/g, '')
    // to lowercase + remove spaces at the beginning and end
    .toLowerCase()
    .trim();
  // logger.debug(`Sanitized result: "${result}"`);
  return result;
}

/**
 * Improved title matching with more accurate results
 * @param title The content title to check
 * @param query The search query to match against
 * @param strict Whether to perform exact matching (for movies)
 * @returns Whether the title matches the query
 */
export function matchesTitle(title: string, query: string, strict: boolean) {
  logger.debug(`Matching title: "${title}" against query: "${query}" (strict: ${strict})`);

  const sanitizedQuery = sanitizeTitle(query);
  const sanitizedTitle = sanitizeTitle(title);

  // Series results must identify both the show and the requested episode.
  // Work with the original filename so ranges retain their hyphens.
  const requested = query.match(/\bs(\d{1,3})e(\d{1,3})(?!\d)/i);
  if (requested && requested.index !== undefined) {
    const requestedSeason = Number(requested[1]);
    const requestedEpisode = Number(requested[2]);
    const show = sanitizeTitle(query.slice(0, requested.index)).replace(/\s+/g, ' ');
    const markerPattern = /(?:^|[^a-z0-9])(?:s(\d{1,3})[ ._-]*e(\d{1,3})|(\d{1,3})x(\d{1,3}))(?!\d)/gi;
    let marker: RegExpExecArray | null;
    let firstMarkerIndex: number | undefined;
    let episodeMatches = false;

    while ((marker = markerPattern.exec(title)) !== null) {
      if (firstMarkerIndex === undefined) firstMarkerIndex = marker.index;
      const season = Number(marker[1] ?? marker[3]);
      const firstEpisode = Number(marker[2] ?? marker[4]);
      const remainder = title.slice(markerPattern.lastIndex);
      const episodes = [firstEpisode];
      let rest = remainder;
      let chained: RegExpMatchArray | null;
      while ((chained = rest.match(/^[ ._]*e(\d{1,3})(?!\d)/i))) {
        episodes.push(Number(chained[1]));
        rest = rest.slice(chained[0].length);
      }
      const range = rest.match(/^[ ._]*[-–—][ ._]*(?:s(\d{1,3})[ ._-]*)?e?(\d{1,3})(?![a-z0-9])/i);
      const rangeEnd = range && (!range[1] || Number(range[1]) === season) ? Number(range[2]) : undefined;
      if (season === requestedSeason && (episodes.includes(requestedEpisode) ||
          (rangeEnd !== undefined && rangeEnd >= firstEpisode &&
           requestedEpisode >= firstEpisode && requestedEpisode <= rangeEnd))) {
        episodeMatches = true;
      }
    }

    if (!episodeMatches || firstMarkerIndex === undefined || !show) return false;
    const candidate = sanitizeTitle(title.slice(0, firstMarkerIndex)).replace(/\s+/g, ' ');
    const withoutYear = candidate.replace(/\b(?:19\d{2}|20\d{2})\b/g, '').replace(/\s+/g, ' ').trim();
    if (strict) return candidate === show || withoutYear === show;
    // The general loose matcher ignores short words; avoid accepting any show
    // when the requested title consists entirely of short words.
    if (!show.split(' ').some(word => word.length > 2)) return candidate === show || withoutYear === show;
    return matchesTitle(candidate, show, false);
  }

  // For strict mode, require an exact movie title match.
  if (strict) {
    // For movies or other non-series content
    const { title: parsedTitle, year } = parseTorrentTitle(title);
    logger.debug(`Strict mode - parsed title: "${parsedTitle}", year: ${year}`);

    if (parsedTitle) {
      const sanitizedParsedTitle = sanitizeTitle(parsedTitle);
      const parsedTitleWords = sanitizedParsedTitle.split(/\s+/);
      const queryWords = sanitizedQuery.split(/\s+/);

      // For movies, only match if:
      // 1. The parsed title is EXACTLY the query
      if (sanitizedParsedTitle === sanitizedQuery) {
        logger.debug(`Strict mode - exact match found`);
        return true;
      }

      // 2. Or if title has a year, check if title without year matches query exactly
      if (year) {
        const titleWithoutYear = sanitizedParsedTitle.replace(year.toString(), '').trim();
        if (titleWithoutYear === sanitizedQuery) {
          logger.debug(`Strict mode - title matches query after removing year`);
          return true;
        }
      }

      // 3. Or if query has a year and title has a year, check if both title and year match
      const queryYearMatch = sanitizedQuery.match(/\b(\d{4})\b/);
      if (queryYearMatch && year) {
        const queryYear = queryYearMatch[1];
        const queryWithoutYear = sanitizedQuery.replace(queryYear, '').trim();
        const titleWithoutYear = sanitizedParsedTitle.replace(year.toString(), '').trim();

        if (queryWithoutYear === titleWithoutYear && year.toString() === queryYear) {
          logger.debug(`Strict mode - title and year match query`);
          return true;
        }
      }

      // 4. Reject if parsed title has more words than query (e.g. "grace and frankie" for "grace")
      // First remove any year from the title
      const yearPattern = /\b(19\d{2}|20\d{2})\b/;
      const parsedTitleWithoutYear = sanitizedParsedTitle.replace(yearPattern, '').trim();
      const parsedTitleWordsWithoutYear = parsedTitleWithoutYear.split(/\s+/);

      if (parsedTitleWordsWithoutYear.length > queryWords.length) {
        logger.debug(`Strict mode - parsed title has extra words (excluding year), rejecting`);
        return false;
      }
    }

    // If we're in strict mode and haven't matched by now, return false
    logger.debug(`Strict mode - no match found`);
    return false;
  }

  // Non-strict mode below (original behavior)
  logger.debug(`Non-strict mode matching`);

  // Check that all words in the query appear in the title
  const queryWords = sanitizedQuery.split(/\s+/);
  const allWordsMatch = queryWords.every(word => {
    // Skip very short words (1-2 chars) to avoid false positives
    if (word.length <= 2) return true;
    return sanitizedTitle.includes(word);
  });
  logger.debug(`Non-strict mode - all words match: ${allWordsMatch}`);

  // For multiple word queries, ensure the title contains the full phrase
  // or at least a high percentage of matching words
  if (queryWords.length > 1 && !strict) {
    // Count matching words
    const matchingWords = queryWords.filter(
      word => word.length > 2 && sanitizedTitle.includes(word)
    ).length;

    // If more than 70% of significant words match, consider it a match
    const significantWords = queryWords.filter(word => word.length > 2).length;
    if (significantWords > 0) {
      const matchRatio = matchingWords / significantWords;
      logger.debug(
        `Non-strict mode - match ratio: ${matchRatio.toFixed(2)} (${matchingWords}/${significantWords})`
      );
      return matchRatio >= 0.7;
    }
  }

  logger.debug(`Non-strict mode final result: ${allWordsMatch}`);
  return allWordsMatch;
}

/**
 * Create a stream URL that always routes through the addon's /resolve endpoint.
 */
export function createStreamUrl(
  { downURL, dlFarm, dlPort }: Pick<EasynewsSearchResponse, 'downURL' | 'dlFarm' | 'dlPort'>,
  username: string,
  password: string,
  filePath: string,
  baseUrl?: string
): string {
  logger.debug(`Creating stream URL with farm: ${dlFarm}, port: ${dlPort}`);
  if (!baseUrl) {
    // Legacy mode: credentials in URL
    const url = `${downURL.replace('https://', `https://${username}:${password}@`)}/${dlFarm}/${dlPort}/${filePath}`;
    logger.debug('Stream URL created for legacy playback');
    return url;
  } else {
    // Resolve mode: route via addon
    const url = `${downURL}/${dlFarm}/${dlPort}/${filePath}`;
    // Credentials as query‐parameters
    const authUrl = `${url}?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
    // Base64URL-encode authUrl
    const encodedUrl = Buffer.from(authUrl).toString('base64url');
    // Extract the filename
    const fileName = path.basename(filePath);
    // Strip any trailing slash on baseUrl before concatenating
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    // Build /resolve/<base64-payload>/<filename>
    logger.debug(
      `Stream URL created: ${normalizedBase}/resolve/<encoded-easynews-url>/${fileName}`
    );
    return `${normalizedBase}/resolve/${encodedUrl}/${fileName}`;
  }
}

export function createStreamPath(file: FileData) {
  const postHash = file['0'] ?? '';
  const postTitle = file['10'] ?? '';
  const ext = file['11'] ?? '';

  const path = `${postHash}${ext}/${postTitle}${ext}`;
  logger.debug(`Created stream path: ${path.substring(0, 50)}${path.length > 50 ? '...' : ''}`);
  return path;
}

export function getFileExtension(file: FileData) {
  return file['2'] ?? '';
}

export function getPostTitle(file: FileData) {
  return file['10'] ?? '';
}

export function getDuration(file: FileData) {
  return file['14'] ?? '';
}

export function getSize(file: FileData) {
  return file['4'] ?? '';
}

/**
 * Extract video quality information from the title or fallback resolution
 */
export function getQuality(title: string, fallbackResolution?: string): string | undefined {
  logger.debug(`Getting quality for: "${title}", fallback: ${fallbackResolution}`);
  const { resolution } = parseTorrentTitle(title);

  // Try to find quality indicators in the title if resolution not found
  if (!resolution && title) {
    const qualityPatterns = [
      // Common resolution patterns
      { pattern: /\b720p\b/i, quality: '720p' },
      { pattern: /\b1080p\b/i, quality: '1080p' },
      { pattern: /\b2160p\b/i, quality: '4K/2160p' },
      { pattern: /\b4k\b/i, quality: '4K' },
      { pattern: /\buhd\b/i, quality: '4K/UHD' },
      { pattern: /\bhdr\b/i, quality: 'HDR' },
      // Common quality indicators
      { pattern: /\bhq\b/i, quality: 'HQ' },
      { pattern: /\bbdrip\b/i, quality: 'BDRip' },
      { pattern: /\bbluray\b/i, quality: 'BluRay' },
      { pattern: /\bweb-?dl\b/i, quality: 'WEB-DL' },
    ];

    for (const { pattern, quality } of qualityPatterns) {
      if (pattern.test(title)) {
        logger.debug(`Quality found by pattern: ${quality}`);
        return quality;
      }
    }
  }

  // Return resolution found by parser
  if (resolution) {
    // Map common resolution formats to standard quality names
    if (resolution === '2160p' || resolution.includes('4k') || resolution.includes('4K')) {
      logger.debug(`Quality found by parser: 4K`);
      return '4K';
    }
    logger.debug(`Quality found by parser: ${resolution}`);
    return resolution;
  }

  // Use fallback if provided
  if (fallbackResolution) {
    logger.debug(`Using fallback quality: ${fallbackResolution}`);
    return fallbackResolution;
  }

  logger.debug(`No quality found`);
  return undefined;
}

export function createThumbnailUrl(res: EasynewsSearchResponse, file: FileData) {
  const id = file['0'];
  const idChars = id.slice(0, 3);
  const thumbnailSlug = file['10'];
  return `${res.thumbURL}${idChars}/pr-${id}.jpg/th-${thumbnailSlug}.jpg`;
}

/**
 * @param value String to extract digits from
 * @returns The first sequence of digits found in the string or undefined
 */
export function extractDigits(value: string) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/\d+/);

  if (match) {
    return parseInt(match[0], 10);
  }

  return undefined;
}

/**
 * Gets potential alternative titles based on the original title
 * @param title The original title
 * @param customTitlesInput Optional custom titles object
 * @returns Array of potential alternative titles including the original one
 */
export function getAlternativeTitles(
  title: string,
  customTitlesInput: Record<string, string[]> = customTitlesJson
): string[] {
  logger.debug(`Getting alternative titles for: "${title}"`);

  // Start with an empty array
  const alternatives: string[] = [title];

  // Check direct match first
  if (customTitlesInput[title]) {
    logger.debug(`Found direct match in custom titles for: "${title}"`);
    alternatives.push(...customTitlesInput[title]);
  }

  // Then check partial matches
  for (const [key, values] of Object.entries(customTitlesInput)) {
    // Skip direct matches that we've already handled
    if (key === title) continue;

    // Check if either string contains the other
    if (
      title.toLowerCase().includes(key.toLowerCase()) ||
      key.toLowerCase().includes(title.toLowerCase())
    ) {
      logger.debug(`Found partial match between "${title}" and "${key}"`);

      // Check if any of these alternatives are already in our list
      const newValues = values.filter(v => !alternatives.includes(v));
      if (newValues.length > 0) {
        logger.debug(
          `Adding ${newValues.length} new alternatives from partial match: ${newValues.join(', ')}`
        );
        alternatives.push(...newValues);
      }
    }
  }

  if (alternatives.length > 1) {
    logger.debug(`Found ${alternatives.length - 1} alternative titles for "${title}"`);
  } else {
    logger.debug(`No alternative titles found for "${title}"`);
  }

  return alternatives;
}

/**
 * Build a search query for different content types
 */
export function buildSearchQuery(type: ContentType, meta: MetaProviderResponse) {
  logger.debug(`Building search query for ${type}: ${meta.name} (year: ${meta.year || 'none'})`);

  let query = '';

  // Build advanced query with specific formats based on content type
  switch (type) {
    case 'movie':
      // For movies, we can search directly by name (and year if available)
      query = meta.year ? `${meta.name} ${meta.year}` : meta.name;
      break;
    case 'series':
      // For series, we need to include the season and episode
      if (meta.episode && meta.season) {
        // Format: Name S01E01
        query = `${meta.name} S${meta.season.toString().padStart(2, '0')}E${meta.episode
          .toString()
          .padStart(2, '0')}`;
      } else {
        // Just the name as fallback
        query = meta.name;
      }
      break;
    default:
      // Default to just the name
      query = meta.name;
  }

  logger.debug(`Final search query: ${query}`);
  return query;
}

/**
 * Format a timestamp for logging
 * @returns Formatted timestamp [HH:MM:SS]
 */
function getTimestamp(): string {
  const now = new Date();
  return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
}

// These methods should remain at the bottom of the file
export function logError(message: { message: string; error: unknown; context: unknown }) {
  logger.error(`Error: ${message.message}`, message);
}

export function capitalizeFirstLetter(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Checks if an error is related to authentication
 * @param err Any error object or string
 * @returns True if the error appears to be authentication-related
 */
export function isAuthError(err: unknown): boolean {
  return /auth|login|username|password|credentials|unauthorized|forbidden/i.test(String(err));
}
