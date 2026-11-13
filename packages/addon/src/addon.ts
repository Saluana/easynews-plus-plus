import { ContentType } from 'stremio-addon-sdk';
import addonBuilder from 'stremio-addon-sdk/src/builder';
import { manifest } from './manifest';
import {
  buildSearchQuery,
  createStreamPath,
  createStreamUrl,
  getDuration,
  getFileExtension,
  getPostTitle,
  getQuality,
  getSize,
  isBadVideo,
  logError,
  matchesTitle,
  getAlternativeTitles,
  isAuthError,
} from './utils';
import { EasynewsAPI, SearchOptions, EasynewsSearchResponse } from 'easynews-plus-plus-api';
import { publicMetaProvider } from './meta';
import { Stream } from './types';
import customTitlesJson from '../../../custom-titles.json';
import { getUILanguage, translations } from './i18n';
import { createLogger } from 'easynews-plus-plus-shared';

// Extended configuration interface
interface AddonConfig {
  username: string;
  password: string;
  strictTitleMatching?: string;
  preferredLanguage?: string;
  sortingPreference?: string;
  showQualities?: string; // Comma-separated list of qualities to show
  maxResultsPerQuality?: string; // Max results per quality
  maxFileSize?: string; // Max file size in GB
  baseUrl?: string; // Scheme, host and (optional port)
  [key: string]: any;
}

// Create a logger with Addon prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Addon',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

// Helper to create a localized auth error stream
function authErrorStream(langCode: string) {
  const lang = getUILanguage(langCode);
  return {
    streams: [
      {
        name: 'Easynews++ Auth Error',
        description: translations[lang].errors.authFailed,
        url: 'https://example.com/error', // Dummy URL that won't play
        behaviorHints: {
          notWebReady: true,
        },
      },
    ],
  };
}

function errorStream(title: string, message: string) {
  return { streams: [{ name: `Easynews++ ${title}`, description: message,
    url: 'https://example.com/error', behaviorHints: { notWebReady: true } }] };
}

function qualityCategory(stream: Stream): string {
  const quality = stream.name?.split('\n')[1] || '';
  return quality.includes('4K') || quality.includes('UHD') || quality.includes('2160p')
    ? '4k' : quality.includes('1080p') ? '1080p' : quality.includes('720p')
    ? '720p' : quality.includes('480p') || quality.includes('SD') ? '480p' : 'other';
}

// Default configuration values
const DEFAULT_CONFIG = {
  strictTitleMatching: 'true',
  preferredLanguage: '',
  sortingPreference: 'quality_first',
  showQualities: '4k,1080p,720p,480p',
  maxResultsPerQuality: '0',
  maxFileSize: '0',
};

const builder = new addonBuilder(manifest);

// Load custom titles
let titlesFromFile: Record<string, string[]> = {};
let loadedPath = '';

try {
  // Always use the imported JSON by default
  logger.debug('Loading custom titles from imported custom-titles.json');
  titlesFromFile = customTitlesJson;
  loadedPath = 'imported';

  // Log some details about the loaded custom titles
  const numCustomTitles = Object.keys(titlesFromFile).length;
  logger.info(`Successfully loaded ${numCustomTitles} custom titles`);

  if (numCustomTitles > 0) {
    // Log an example to verify they're loaded correctly
    const examples = Object.entries(titlesFromFile).slice(0, 1);
    for (const [original, customTitles] of examples) {
      logger.debug(`Example custom title: "${original}" -> "${customTitles.join('", "')}"`);
    }
  } else {
    logger.warn(
      'No custom titles were loaded from the file. The file might be empty or have invalid format.'
    );
  }
} catch (error) {
  logger.error('Error loading custom titles file:', error);
  logger.info('Using imported custom titles as fallback');
  titlesFromFile = customTitlesJson;
}

// Import custom template for landing page
import customTemplate from './custom-template';

// Export landing HTML for Cloudflare Worker
export const landingHTML = customTemplate(manifest);

builder.defineStreamHandler(
  async ({ id, type, config }: { id: string; type: ContentType; config: AddonConfig }) => {
    // Apply default values for any missing configuration options
    const {
      username,
      password,
      strictTitleMatching = DEFAULT_CONFIG.strictTitleMatching,
      preferredLanguage = DEFAULT_CONFIG.preferredLanguage,
      sortingPreference = DEFAULT_CONFIG.sortingPreference,
      showQualities = DEFAULT_CONFIG.showQualities,
      maxResultsPerQuality = DEFAULT_CONFIG.maxResultsPerQuality,
      maxFileSize = DEFAULT_CONFIG.maxFileSize,
      baseUrl,
      ...options
    } = config;

    if (!id.startsWith('tt')) {
      return {
        streams: [],
      };
    }

    try {
      if (!username || !password) {
        // Instead of throwing error, return a single stream with error message
        return authErrorStream(config.preferredLanguage || '');
      }

      const useStrictMatching = strictTitleMatching === 'on' || strictTitleMatching === 'true';
      if (!config.strictTitleMatching) {
        logger.info(`Using default strictTitleMatching: ${strictTitleMatching}`);
      } else {
        // Parse strictTitleMatching option (checkbox returns string 'on' or undefined)
        logger.info(`Strict title matching: ${useStrictMatching ? 'enabled' : 'disabled'}`);
      }

      const preferredLang = preferredLanguage || '';
      if (!config.preferredLanguage) {
        logger.info(`Using default preferredLanguage: ${preferredLanguage || 'No preference'}`);
      } else {
        // Get preferred language from configuration
        logger.info(
          `Preferred language: ${preferredLanguage ? preferredLanguage : 'No preference'}`
        );
      }

      // Parse quality filters
      const qualityFilters = showQualities
        ? showQualities
            .split(',')
            .map(q => q.trim().toLowerCase())
            .filter(Boolean)
        : ['4k', '1080p', '720p', '480p'];

      if (!config.showQualities) {
        logger.info('Using default showQualities: ' + showQualities);
      } else {
        logger.info(`Quality filters: ${qualityFilters.join(', ')}`);
      }

      // Parse max results per quality (0 = no limit)
      let maxResultsPerQualityValue = parseInt(maxResultsPerQuality ?? '0', 10);
      if (Number.isNaN(maxResultsPerQualityValue) || maxResultsPerQualityValue < 0) {
        maxResultsPerQualityValue = 0;
      }
      if (!config.maxResultsPerQuality) {
        logger.info('Using default maxResultsPerQuality: ' + maxResultsPerQuality);
      } else {
        logger.info(
          `Max results per quality: ${maxResultsPerQualityValue === 0 ? 'No limit' : maxResultsPerQualityValue}`
        );
      }

      // Parse max file size (0 = no limit)
      let maxFileSizeGB = parseFloat(maxFileSize ?? '0');
      if (Number.isNaN(maxFileSizeGB) || maxFileSizeGB < 0) {
        maxFileSizeGB = 0;
      }
      if (!config.maxFileSize) {
        logger.info('Using default maxFileSize: ' + maxFileSize);
      } else {
        logger.info(`Max file size: ${maxFileSizeGB === 0 ? 'No limit' : maxFileSizeGB + ' GB'}`);
      }

      // Use custom titles from custom-titles.json
      const customTitles = { ...titlesFromFile };

      logger.debug(
        `Using ${Object.keys(customTitles).length} custom titles from custom-titles.json`
      );

      if (!config.sortingPreference) {
        logger.info(`Using default sortingPreference: ${sortingPreference}`);
      } else {
        logger.info(`Sorting preference from config: ${sortingPreference}`);
      }

      // Configure API sorting options based on user sorting preference
      const sortOptions: Partial<SearchOptions> = {
        query: '', // Will be set for each search later
      };

      // Set consistent API sorting parameters regardless of user sorting preference
      // This ensures we always get the same raw results
      // We'll handle user sorting preferences after fetching all results

      // Use parameters that give us the most complete results
      sortOptions.sort1 = 'relevance'; // Use relevance as primary sort
      sortOptions.sort1Direction = '-'; // Descending
      sortOptions.sort2 = 'dsize'; // Then size
      sortOptions.sort2Direction = '-'; // Descending
      // Set a consistent third sort option
      sortOptions.sort3 = 'dtime'; // DateTime
      sortOptions.sort3Direction = '-'; // Descending

      // Log the API sorting parameters
      logger.debug(
        `API Sorting: ${sortOptions.sort1} (${sortOptions.sort1Direction}), ${sortOptions.sort2} (${sortOptions.sort2Direction}), ${sortOptions.sort3} (${sortOptions.sort3Direction})`
      );

      let meta;
      try {
        meta = await publicMetaProvider(id, type, preferredLanguage);
      } catch (error) {
        logger.error('Metadata lookup failed:', error);
        return errorStream('Metadata unavailable', 'Could not retrieve title information. Please try again.');
      }
      logger.info(`Searching for: ${meta.name}`);

      // Check if we have a custom title for this title directly
      if (customTitles[meta.name]) {
        logger.info(
          `Direct custom title found for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
      } else {
        logger.info(`No direct custom title found for "${meta.name}", checking partial matches`);

        // Look for partial matches in title keys
        for (const [key, values] of Object.entries(customTitles)) {
          if (
            meta.name.toLowerCase().includes(key.toLowerCase()) ||
            key.toLowerCase().includes(meta.name.toLowerCase())
          ) {
            logger.debug(
              `Possible title match: "${meta.name}" ~ "${key}" -> "${values.join('", "')}"`
            );
          }
        }
      }

      // Initialize the API with user credentials
      let api;
      try {
        api = new EasynewsAPI({ username, password });
      } catch (error) {
        logger.error(`API initialization error: ${error}`);
        return authErrorStream(config.preferredLanguage || '');
      }

      logger.debug(`Getting alternative titles for: ${meta.name}`);

      // Initialize with the original title
      let allTitles = [meta.name];

      // Add any direct custom titles found in customTitles
      if (customTitles[meta.name] && customTitles[meta.name].length > 0) {
        logger.debug(
          `Adding direct custom titles for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
        allTitles = [...allTitles, ...customTitles[meta.name]];
      }

      // Add any alternative names from meta (if available)
      if (meta.alternativeNames && meta.alternativeNames.length > 0) {
        logger.debug(
          `Adding ${meta.alternativeNames.length} alternative names from metadata (${meta.alternativeNames.join(', ')})`
        );
        // Filter out duplicates
        const newAlternatives = meta.alternativeNames.filter(alt => !allTitles.includes(alt));
        allTitles = [...allTitles, ...newAlternatives];
      }

      // Use getAlternativeTitles to find additional matches (like partial matches)
      const additionalTitles = getAlternativeTitles(meta.name, customTitles).filter(
        alt => !allTitles.includes(alt) && alt !== meta.name
      );

      if (additionalTitles.length > 0) {
        logger.debug(`Adding ${additionalTitles.length} additional titles from partial matches`);
        allTitles = [...allTitles, ...additionalTitles];
      }

      logger.debug(`Will search for ${allTitles.length} titles: ${allTitles.join(', ')}`);

      const TOTAL_MAX_RESULTS = parseInt(process.env.TOTAL_MAX_RESULTS || '500', 10);
      const MAX_PAGES = parseInt(process.env.MAX_PAGES || '10', 10);
      const processedHashes = new Set<string>();
      const seenQueries = new Set<string>();
      let streams: Stream[] = [];
      let successfulSearches = 0;
      let failedSearches = 0;
      let rejectedByFilters = 0;
      const foundByQuality: Record<string, number> = {};
      const selectedQualities = [...new Set(qualityFilters.filter(q =>
        ['4k', '1080p', '720p', '480p'].includes(q)
      ))];
      let enoughResults = false;

      const processResult = (res: EasynewsSearchResponse) => {
        for (const file of res.data ?? []) {
          // Check if we've reached the global limit
          if (streams.length >= TOTAL_MAX_RESULTS) {
            logger.debug(
              `Reached global limit of ${TOTAL_MAX_RESULTS} streams, stopping processing`
            );
            break;
          }

          const title = getPostTitle(file);
          const fileHash = file['0']; // Use file hash to detect duplicates

          if (isBadVideo(file) || processedHashes.has(fileHash)) {
            continue;
          }

          // For series there are multiple possible queries that could match the title.
          // We check if at least one of them matches.
          if (type === 'series') {
            // Create queries for all title variants
            const queries: string[] = [];

            for (const titleVariant of allTitles) {
              // Add full query with season and episode
              const fullMeta = {
                ...meta,
                name: titleVariant,
                year: meta.year,
              };
              queries.push(buildSearchQuery(type, fullMeta));

              // Add query with episode only
              const episodeMeta = {
                name: titleVariant,
                episode: meta.episode,
              };
              queries.push(buildSearchQuery(type, episodeMeta));
            }

            // Use strictTitleMatching setting if enabled for series
            if (!queries.some(q => matchesTitle(title, q, useStrictMatching))) {
              logger.debug(`Rejected series by title matching: "${title}"`);
              continue;
            }
          }

          // For movies, check if title matches any of the query variants
          // Other content types are loosely matched
          const matchesAnyVariant = allTitles.some(titleVariant => {
            const variantQuery = buildSearchQuery(type, {
              ...meta,
              name: titleVariant,
            });
            // For movies, only use strictTitleMatching if enabled by user, just like for series
            return matchesTitle(title, variantQuery, useStrictMatching);
          });

          if (!matchesAnyVariant) {
            logger.debug(`Rejected ${type} by title matching: "${title}"`);
            continue;
          }

          const stream = mapStream({
              username,
              password,
              fullResolution: file.fullres,
              fileExtension: getFileExtension(file),
              duration: getDuration(file),
              size: getSize(file),
              title,
              url: createStreamUrl(
                { downURL: res.downURL, dlFarm: res.dlFarm, dlPort: res.dlPort },
                username,
                password,
                createStreamPath(file),
                baseUrl
              ),
              videoSize: file.rawSize,
              file,
              preferredLang,
            });
          const quality = stream.name?.split('\n')[1] || '';
          const qualityTerms: Record<string, string[]> = {
            '4k': ['4K', 'UHD', '2160p'], '1080p': ['1080p'],
            '720p': ['720p'], '480p': ['480p', 'SD'],
          };
          const defaultQualities = ['4k', '1080p', '720p', '480p'];
          const customQuality = qualityFilters.length !== defaultQualities.length ||
            !qualityFilters.every(q => defaultQualities.includes(q));
          if (customQuality && !qualityFilters.some(q => qualityTerms[q]?.some(term => quality.includes(term)))) { rejectedByFilters++; continue; }
          if (maxFileSizeGB > 0 && typeof file.rawSize === 'number' && file.rawSize > maxFileSizeGB * 1024 ** 3) { rejectedByFilters++; continue; }
          processedHashes.add(fileHash);
          streams.push(stream);
          const category = qualityCategory(stream);
          foundByQuality[category] = (foundByQuality[category] || 0) + 1;
        }
      };

      const searchTitles = async (year: number | undefined): Promise<boolean> => {
        const queries = allTitles.filter(title => title.trim())
          .map(name => buildSearchQuery(type, { ...meta, name, year }))
          .filter(query => {
            const key = query.trim().toLowerCase();
            if (seenQueries.has(key)) return false;
            seenQueries.add(key);
            return true;
          });
        for (let i = 0; i < queries.length && streams.length < TOTAL_MAX_RESULTS && !enoughResults; i += 3) {
          const batch = queries.slice(i, i + 3);
          let active = batch.map(query => ({ query, firstHash: undefined as string | undefined }));
          for (let pageNr = 1; pageNr <= MAX_PAGES && active.length && streams.length < TOTAL_MAX_RESULTS && !enoughResults; pageNr++) {
            const results = await Promise.allSettled(active.map(({ query }) => api.search({ ...sortOptions, query, pageNr })));
            const next: typeof active = [];
            for (let j = 0; j < results.length; j++) {
              const result = results[j];
              const current = active[j];
              if (result.status === 'rejected') {
                if (isAuthError(result.reason)) return false;
                failedSearches++;
                logger.error(`Error searching for "${current.query}":`, result.reason);
                continue;
              }
              successfulSearches++;
              const files = result.value.data ?? [];
              if (!files.length || (pageNr > 1 && files[0]?.['0'] === current.firstHash)) continue;
              processResult(result.value);
              next.push({ query: current.query, firstHash: current.firstHash ?? files[0]?.['0'] });
            }
            if (maxResultsPerQualityValue > 0 && selectedQualities.length > 0) {
              const counts = selectedQualities.map(q => Math.min(foundByQuality[q] || 0, maxResultsPerQualityValue));
              const allQualitiesFull = counts.every(count => count >= maxResultsPerQualityValue);
              const availableResults = counts.reduce((sum, count) => sum + count, 0);
              // Give scarce qualities a second page, then return useful choices promptly.
              enoughResults = allQualitiesFull || (pageNr >= 2 && availableResults >= maxResultsPerQualityValue);
            }
            active = next;
          }
        }
        return true;
      };

      if (!(await searchTitles(undefined))) return authErrorStream(config.preferredLanguage || '');
      if (meta.year !== undefined && streams.length < TOTAL_MAX_RESULTS && !enoughResults) {
        if (!(await searchTitles(meta.year))) return authErrorStream(config.preferredLanguage || '');
      }
      if (!successfulSearches && failedSearches) {
        return errorStream('Search unavailable', 'Easynews search failed or timed out. Please try again.');
      }

      // Filtering happens as results arrive so the search limit counts usable streams.
      const originalCount = streams.length;

      // Now sort the filtered streams based on user preference
      if (sortingPreference === 'language_first' && preferredLang) {
        logger.debug(`Applying language-first sorting for language: ${preferredLang}`);

        // Special handling for language-first sorting
        // First, separate streams by language
        const preferredLangStreams: Stream[] = [];
        const otherStreams: Stream[] = [];

        // Split streams into two groups
        for (const stream of streams) {
          const file = (stream as any)._temp?.file;
          const hasPreferredLang =
            file?.alangs && Array.isArray(file.alangs) && file.alangs.includes(preferredLang);

          if (hasPreferredLang) {
            preferredLangStreams.push(stream);
          } else {
            otherStreams.push(stream);
          }
        }

        logger.debug(
          `Sorting: ${preferredLangStreams.length} streams with preferred language and ${otherStreams.length} other streams`
        );

        // Sort each group by quality and size
        const sortByQualityAndSize = (a: Stream, b: Stream) => {
          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Compare quality scores
          if (aScore !== bScore) {
            return bScore - aScore;
          }

          // Compare sizes
          const aSize = aDesc.length > 2 ? aDesc[2] : '';
          const bSize = bDesc.length > 2 ? bDesc[2] : '';

          if (aSize.includes('GB') && bSize.includes('GB')) {
            const aGB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bGB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aGB > bGB) return -1;
            if (aGB < bGB) return 1;
          }

          if (aSize.includes('GB') && bSize.includes('MB')) return -1;
          if (aSize.includes('MB') && bSize.includes('GB')) return 1;

          if (aSize.includes('MB') && bSize.includes('MB')) {
            const aMB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bMB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aMB > bMB) return -1;
            if (aMB < bMB) return 1;
          }

          return 0;
        };

        // Sort each group independently
        preferredLangStreams.sort(sortByQualityAndSize);
        otherStreams.sort(sortByQualityAndSize);

        // Replace streams array with the concatenated sorted groups
        streams.length = 0;
        streams.push(...preferredLangStreams, ...otherStreams);
      } else {
        // Original sorting for other preferences
        streams.sort((a, b) => {
          // Extract stream data
          const aFile = (a as any)._temp?.file;
          const bFile = (b as any)._temp?.file;
          const aHasPreferredLang = preferredLang && aFile?.alangs?.includes(preferredLang);
          const bHasPreferredLang = preferredLang && bFile?.alangs?.includes(preferredLang);

          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Size comparison logic
          const compareSize = () => {
            const aSize = aDesc.length > 2 ? aDesc[2] : '';
            const bSize = bDesc.length > 2 ? bDesc[2] : '';

            if (aSize.includes('GB') && bSize.includes('GB')) {
              const aGB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
              const bGB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
              if (aGB > bGB) return -1;
              if (aGB < bGB) return 1;
            }

            if (aSize.includes('GB') && bSize.includes('MB')) return -1;
            if (aSize.includes('MB') && bSize.includes('GB')) return 1;

            if (aSize.includes('MB') && bSize.includes('MB')) {
              const aMB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
              const bMB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
              if (aMB > bMB) return -1;
              if (aMB < bMB) return 1;
            }

            return 0;
          };

          // Apply sorting based on user preference
          switch (sortingPreference) {
            case 'size_first':
              // Size first, then quality, then language
              const sizeCompare = compareSize();
              if (sizeCompare !== 0) {
                return sizeCompare;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              return 0;

            case 'date_first':
              // Sort by date first using the file's date info
              const aDate = aFile?.['5'] ? new Date(aFile['5']).getTime() : 0;
              const bDate = bFile?.['5'] ? new Date(bFile['5']).getTime() : 0;
              if (aDate !== bDate) {
                // Higher date value (more recent) comes first - descending order
                return bDate - aDate;
              }
              // Then quality
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();

            case 'lang_first':
            case 'language_first':
              // Language first, then quality, then size
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              return compareSize();

            case 'quality_first':
            default:
              // Quality first (default), then language, then size
              // Make sure the quality score comparison is working
              if (aScore !== bScore) {
                // Higher quality score first - ensure descending order
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();
          }
        });
      }

      // Apply per-quality limits after sorting, preserving the selected order.
      if (maxResultsPerQualityValue > 0) {
        const qualityCounts: Record<string, number> = {};
        streams = streams.filter(stream => {
          const category = qualityCategory(stream);
          const count = qualityCounts[category] || 0;
          qualityCounts[category] = count + 1;
          return count < maxResultsPerQualityValue;
        });
      }

      if (streams.length > 0) {
        const qualitySummary: Record<string, number> = {};
        streams.forEach(stream => {
          const quality = stream.name?.split('\n')[1] || 'Unknown';
          qualitySummary[quality] = (qualitySummary[quality] || 0) + 1;
        });

        const qualitySummaryStr = Object.entries(qualitySummary)
          .map(([quality, count]) => `${quality}: ${count}`)
          .join(', ');

        logger.info(`Found ${streams.length} streams total for ${id} (${qualitySummaryStr})`);
      } else {
        logger.info(`Found 0 streams total for ${id}`);
      }

      if (!streams.length && (originalCount > 0 || rejectedByFilters > 0)) {
        return errorStream('No matching streams', 'No streams match your quality and size settings. Adjust your addon configuration.');
      }
      return { streams };
    } catch (error) {
      logError({
        message: `failed to handle stream: ${error}`,
        error,
        context: { resource: 'stream', id, type },
      });

      // Check if the error is related to authentication
      if (isAuthError(error)) return authErrorStream(config.preferredLanguage || '');

      return errorStream('Request failed', 'The addon could not complete the request. Please try again.');
    }
  }
);

function mapStream({
  username,
  password,
  duration,
  size,
  fullResolution,
  title,
  fileExtension,
  videoSize,
  url,
  file,
  preferredLang,
}: {
  title: string;
  url: string;
  username: string;
  password: string;
  fileExtension: string;
  videoSize: number | undefined;
  duration: string | undefined;
  size: string | undefined;
  fullResolution: string | undefined;
  file: any;
  preferredLang: string;
}): Stream {
  logger.debug(`Mapping stream: "${title}" (${fileExtension}, ${size}, ${duration})`);

  const quality = getQuality(title, fullResolution);

  // Log language information for debugging
  if (file.alangs && file.alangs.length > 0) {
    logger.debug(`Stream "${title}" has languages: ${JSON.stringify(file.alangs)}`);
  } else {
    logger.debug(`Stream "${title}" has no language information`);
  }

  // Calculate days since upload
  const publishDate = getPublishDate(file.ts);

  // Show language information in the description if available
  const languageInfo = file.alangs?.length
    ? `🌐 ${file.alangs.join(', ')}${preferredLang && file.alangs.includes(preferredLang) ? ' ⭐' : ''}`
    : '🌐 Unknown';

  const stream: Stream & { _temp?: any } = {
    name: `Easynews++${quality ? `\n${quality}` : ''}`,
    description: [
      `${title}${fileExtension}`,
      `🕛 ${duration ?? 'unknown duration'}`,
      `📦 ${size ?? 'unknown size'} ${publishDate}`,
      languageInfo,
    ].join('\n'),
    url: url,
    behaviorHints: {
      notWebReady: true,
      filename: `${title}${fileExtension}`,
    },
    // Add temporary property with file data for sorting
    _temp: { file },
  };

  return stream;
}

/**
 * Calculate a human-readable publish date from timestamp
 * @param timestamp Unix timestamp in seconds
 * @returns Formatted date string or empty string if timestamp is invalid
 */
function getPublishDate(timestamp: number): string {
  if (!timestamp) return '';

  const uploadDate = new Date(timestamp * 1000);
  const now = new Date();

  // Calculate days difference
  const diffTime = Math.abs(now.getTime() - uploadDate.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return `📅 ${diffDays}d`;
}

export const addonInterface = builder.getInterface();
