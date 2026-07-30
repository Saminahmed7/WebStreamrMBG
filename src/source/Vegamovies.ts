import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

export class Vegamovies extends Source {
  public readonly id = 'vegamovies';
  public readonly label = 'Vegamovies';
  public readonly contentTypes: ContentType[] = ['movie'];
  public readonly countryCodes: CountryCode[] = []; // worldwide
  public readonly baseUrl = 'https://vegamovies.catering';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, _type: string, id: Id): Promise<SourceResult[]> {
    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    if (tmdbId.type !== 'movie') return [];

    let name: string, year: string;
    try {
      [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId, 'en');
    } catch {
      return [];
    }

    const moviePageUrl = await this.searchMovie(ctx, name, year);
    if (!moviePageUrl) return [];

    return await this.extractStreams(ctx, moviePageUrl, name);
  }

  private searchMovie = async (ctx: Context, name: string, year: string): Promise<URL | null> => {
    const searchUrl = new URL(`/?s=${encodeURIComponent(`${name} ${year}`)}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, searchUrl);
    const $ = cheerio.load(html);

    // Find first article link where title contains the movie name
    const link = $('article a')
      .filter((_i, el) => $(el).text().toLowerCase().includes(name.toLowerCase()))
      .attr('href');

    return link ? new URL(link, this.baseUrl) : null;
  };

  private extractStreams = async (ctx: Context, moviePageUrl: URL, title: string): Promise<SourceResult[]> => {
    const html = await this.fetcher.text(ctx, moviePageUrl);
    const $ = cheerio.load(html);

    const streamResults: SourceResult[] = [];

    // Collect all links that look like player/embed URLs
    const playerLinks = $('a[href]')
      .map((_i, el) => $(el).attr('href')!)
      .get()
      .filter(href =>
        href.includes('stream') || href.includes('player') || href.includes('embed') ||
        href.includes('dood') || href.includes('mixdrop') || href.includes('streamtape') ||
        href.includes('voe') || href.includes('upstream')
      )
      .map(href => new URL(href, moviePageUrl));

    // For each player link, try to extract a direct stream URL
    for (const playerUrl of playerLinks) {
      try {
        const directUrl = await this.extractFromPlayer(ctx, playerUrl);
        if (directUrl) {
          streamResults.push({
            url: directUrl,
            meta: { title, referer: playerUrl.href }
          });
        }
      } catch {
        // continue
      }
    }

    return streamResults;
  };

  private extractFromPlayer = async (ctx: Context, playerUrl: URL): Promise<string | null> => {
    const html = await this.fetcher.text(ctx, playerUrl);
    const $ = cheerio.load(html);

    // Look for common patterns in player pages
    // 1. <video> or <source> tag
    const videoSrc = $('video source').attr('src') || $('video').attr('src');
    if (videoSrc) return new URL(videoSrc, playerUrl).href;

    // 2. JavaScript variable with stream URL (e.g. sources: [{file: "..."}])
    const scripts = $('script').map((_i, el) => $(el).html()).get();
    for (const script of scripts) {
      if (!script) continue;
      // Match patterns like: 'file': "https://...m3u8"
      const match = script.match(/(?:file|src|source)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)/i);
      if (match) return match[1];
      // Doodstream pattern: dood?token=...
      const doodMatch = script.match(/https?:\/\/[^"']+dood[^"']+/i);
      if (doodMatch) return doodMatch[0]; // will be resolved by Nuvio? But we need direct m3u8, so better to fetch further. For now return.
    }

    // 3. If it's an iframe page, get the iframe src and recurse
    const iframeSrc = $('iframe').attr('src');
    if (iframeSrc) {
      const iframeUrl = new URL(iframeSrc, playerUrl);
      return await this.extractFromPlayer(ctx, iframeUrl); // recurse one level
    }

    return null;
  };
}
