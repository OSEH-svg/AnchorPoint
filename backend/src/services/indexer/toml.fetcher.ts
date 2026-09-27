import * as TOML from "@iarna/toml";
import { ParsedToml } from "../../types/indexer.types";
import { redis } from "../../lib/redis";
import { RedisService } from "../redis.service";
import logger from "../../utils/logger";

export class TomlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlFetchError";
  }
}

export class TomlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlParseError";
  }
}

export interface TomlFetcher {
  fetch(homeDomain: string): Promise<ParsedToml>;
}

const CACHE_KEY_PREFIX = "sep1:toml:";
const CACHE_TTL_SECONDS = 3600;

export class TomlFetcherImpl implements TomlFetcher {
  private readonly redisService: RedisService;

  constructor() {
    this.redisService = new RedisService(redis);
  }

  async fetch(homeDomain: string): Promise<ParsedToml> {
    const cacheKey = `${CACHE_KEY_PREFIX}${homeDomain}`;

    const cached = await this.redisService.getJSON<ParsedToml>(cacheKey);
    if (cached) {
      logger.debug('SEP-1 TOML cache hit', { homeDomain });
      return cached;
    }

    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await globalThis.fetch(url, { signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TomlFetchError(
          `stellar.toml fetch timed out for ${homeDomain}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new TomlFetchError(
        `Network error fetching stellar.toml for ${homeDomain}: ${message}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new TomlFetchError(
        `stellar.toml fetch failed for ${homeDomain}: HTTP ${response.status}`,
      );
    }

    const text = await response.text();
    let parsed: TOML.JsonMap;
    try {
      parsed = TOML.parse(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TomlParseError(
        `Failed to parse stellar.toml for ${homeDomain}: ${message}`,
      );
    }

    const result = parsed as ParsedToml;

    await this.redisService.setJSON(cacheKey, result, CACHE_TTL_SECONDS);
    logger.debug('SEP-1 TOML cache written', { homeDomain, ttlSeconds: CACHE_TTL_SECONDS });

    return result;
  }
}

export async function purgeTomlCache(homeDomain?: string): Promise<number> {
  const pattern = homeDomain
    ? `${CACHE_KEY_PREFIX}${homeDomain}`
    : `${CACHE_KEY_PREFIX}*`;

  let keys: string[];
  if (homeDomain) {
    const exists = await redis.get(pattern);
    keys = exists ? [pattern] : [];
  } else {
    const allKeys = await redis.keys(pattern);
    keys = allKeys;
  }

  if (keys.length === 0) {
    return 0;
  }

  const deleted = await redis.del(...keys);
  logger.info('SEP-1 TOML cache purged', { homeDomain, deletedCount: deleted });
  return deleted;
}
