import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

export class Mkvbase extends Source {
  public readonly id = 'mkvbase';
  public readonly label = 'MKVBase';
  public readonly contentTypes: ContentType[] = ['movie'];
  public readonly countryCodes: CountryCode[] = [];
  public readonly baseUrl = 'https://mkvbase.site';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, _type: string, id: Id): Promise<SourceResult[]> {
    const tmdbId = await getTmdbId(ctx, this.fetcher, id);

    let name: string;
    let year: number;
    try {
      [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId, 'en');
    } catch {
      return [];
    }

    const moviePageUrl = await this.searchMovie(ctx, name, year);
    if (!moviePageUrl) return [];

    return this.extractStreams(ctx, moviePageUrl, name);
  }

  private searchMovie = async (ctx: Context, name: string, year: number): Promise<URL | null> => {
    const searchUrl = new URL(`/?s=${encodeURIComponent(`${name} ${year}`)}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, searchUrl);
    const $ = cheerio.load(html);

    const link = $('article a')
      .filter((_i, el) => $(el).text().toLowerCase().includes(name.toLowerCase()))
      .attr('href');

    return link ? new URL(link, this.baseUrl) : null;
  };

  private extractStreams = async (ctx: Context, moviePageUrl: URL, title: string): Promise<SourceResult[]> => {
    const html = await this.fetcher.text(ctx, moviePageUrl);
    const $ = cheerio.load(html);

    const playerLinks = $('a[href]')
      .map((_i, el) => $(el).attr('href')!)
      .get()
      .filter(href =>
        href.includes('stream') || href.includes('player') || href.includes('embed') ||
        href.includes('dood') || href.includes('mixdrop') || href.includes('streamtape') ||
        href.includes('voe') || href.includes('upstream')
      )
      .map(href => new URL(href, moviePageUrl));

    const results: SourceResult[] = [];
    for (const playerUrl of playerLinks) {
      try {
        const directUrl = await this.extractFromPlayer(ctx, playerUrl);
        if (directUrl) {
          results.push({
            url: new URL(directUrl),
            meta: { title, referer: playerUrl.href }
          });
        }
      } catch {}
    }
    return results;
  };

  private extractFromPlayer = async (ctx: Context, playerUrl: URL): Promise<string | null> => {
    const html = await this.fetcher.text(ctx, playerUrl);
    const $ = cheerio.load(html);

    const videoSrc: string | null = $('video source').attr('src') ?? $('video').attr('src') ?? null;
    if (videoSrc) return new URL(videoSrc, playerUrl).href;

    const scripts = $('script').map((_i, el) => $(el).html()).get();
    for (const script of scripts) {
      if (!script) continue;
      const match = script.match(/(?:file|src|source)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)/i);
      if (match) return match[1];
    }

    const iframeSrc = $('iframe').attr('src');
    if (iframeSrc) {
      return await this.extractFromPlayer(ctx, new URL(iframeSrc, playerUrl));
    }
    return null;
  };
}
