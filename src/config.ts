import { z } from 'zod';
import { loadSafetyConfig, type SafetyConfig } from './safety/index.js';

export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8000';

/** Fully resolved server configuration. */
export interface AppConfig {
  /** Base URL of Companion (`http://host:port`). Never contains credentials or a path. */
  readonly url: string;
  /** REST v2 token (`cpn_...`). Never printed, logged or returned by a tool. */
  readonly restToken: string | undefined;
  /** `COMPANION_MCP_ALLOW_UNKNOWN_VERSION=1`: accept Companion versions other than 5.1.x. */
  readonly allowUnknownVersion: boolean;
  readonly safety: SafetyConfig;
}

/** Error for an invalid environment. Messages never echo the offending value (it could be a token or a URL with credentials). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const UrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'COMPANION_URL is not a valid URL' });
      return z.NEVER;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: 'COMPANION_URL must start with http:// or https://',
      });
      return z.NEVER;
    }
    return `${parsed.protocol}//${parsed.host}`;
  });

const FlagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value === '1' || value === 'true');

const EnvSchema = z.object({
  COMPANION_URL: UrlSchema.default(DEFAULT_COMPANION_URL),
  COMPANION_REST_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
  COMPANION_MCP_ALLOW_UNKNOWN_VERSION: FlagSchema.default(false),
});

/**
 * Extension hosts (MCPB) substitute `${user_config.KEY}` placeholders. If the user left an optional field
 * empty, an unreplaced placeholder could reach the server as a literal value (for example as a token).
 * Such values are treated as unset so that defaults apply.
 */
export function sanitizeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value !== undefined && /\$\{[^}]*\}/.test(value) ? undefined : value;
  }
  return result;
}

/**
 * Reads the configuration from an environment object. Variables: `COMPANION_URL`, `COMPANION_REST_TOKEN`,
 * `COMPANION_MCP_ALLOW_UNKNOWN_VERSION` plus the safety variables of {@link loadSafetyConfig}.
 * Throws {@link ConfigError} (or `SafetyError` with code `CONFIG_INVALID`) for invalid values.
 */
export function loadConfig(rawEnv: Readonly<Record<string, string | undefined>>): AppConfig {
  const env = sanitizeEnv(rawEnv);
  const parsed = EnvSchema.safeParse({
    COMPANION_URL: env['COMPANION_URL'],
    COMPANION_REST_TOKEN: env['COMPANION_REST_TOKEN'],
    COMPANION_MCP_ALLOW_UNKNOWN_VERSION: env['COMPANION_MCP_ALLOW_UNKNOWN_VERSION'],
  });
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => issue.message);
    throw new ConfigError(`Invalid configuration: ${[...new Set(messages)].join('; ')}`);
  }
  return {
    url: parsed.data.COMPANION_URL,
    restToken: parsed.data.COMPANION_REST_TOKEN,
    allowUnknownVersion: parsed.data.COMPANION_MCP_ALLOW_UNKNOWN_VERSION,
    safety: loadSafetyConfig(env),
  };
}
