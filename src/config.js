import "dotenv/config";
import Joi from "joi";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isOriginAllowed(origin, allowedOrigins = []) {
  if (!origin) return true;
  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === "*" || allowedOrigin === origin) return true;
    if (!/^https?:\/\//.test(allowedOrigin)) return false;

    const trimmed = allowedOrigin.replace(/\/$/, "");
    const hostAndPort = trimmed.replace(/^https?:\/\//, "");
    if (!hostAndPort || hostAndPort.includes("/")) return false;
    if (!hostAndPort.includes("*")) return false;

    const [hostname, port] = hostAndPort.split(":");
    if (port && !/^\d+$/.test(port)) return false;
    const hostPattern = hostname
      .split(".")
      .map((segment) => (segment === "*" ? "[^.]+" : escapeRegExp(segment)))
      .join("\\.");

    const regex = new RegExp(
      `^${trimmed.startsWith("https://") ? "https" : "http"}://${hostPattern}${port ? `:${port}` : ""}$`,
      "i",
    );
    return regex.test(origin);
  });
}

export function readConfig(env = process.env) {
  const defaultSameSite = env.NODE_ENV === "production" ? "none" : "lax";
  const { value, error } = Joi.object({
    NODE_ENV: Joi.string()
      .valid("development", "test", "production")
      .default("development"),
    PORT: Joi.number().integer().min(0).max(65535).default(4000),
    HOST: Joi.string().default("127.0.0.1"),
    // DATABASE_URL: Joi.string()
    //   .pattern(/^postgres(?:ql)?:\/\/.+$/i)
    //   .message(
    //     `"DATABASE_URL ${value.DATABASE_URL} " must be a valid postgres or postgresql connection string`,
    //   )
    //   .required(),
    SESSION_SECRET: Joi.string().required(),
    CLIENT_ORIGINS: Joi.string().default(
      "https://pro-yiedie.vercel.app,http://localhost:5173,http://localhost:3000,http://localhost:4173,http://localhost:4000,http://localhost:5000,http://127.0.0.1:5173,http://127.0.0.1:3000,http://127.0.0.1:4173,http://127.0.0.1:4000,http://127.0.0.1:5000",
    ),
    // Render terminates HTTPS at its proxy; secure session cookies need Express
    // to recognize the forwarded protocol. Explicit settings still take priority.
    TRUST_PROXY: Joi.number()
      .integer()
      .min(0)
      .max(5)
      .default(env.RENDER === "true" ? 1 : 0),
    COOKIE_SAME_SITE: Joi.string()
      .lowercase()
      .valid("lax", "strict", "none")
      .default(defaultSameSite),
    SESSION_HOURS: Joi.number().integer().min(1).max(168).default(24),
    STUN_URLS: Joi.string().allow("").default("stun:stun.l.google.com:19302"),
    TURN_URLS: Joi.string().allow("").default(""),
    TURN_SECRET: Joi.string().allow("").default(""),
    ENABLE_DEMO: Joi.boolean().default(false),
  })
    .unknown(true)
    .validate(env);
  if (error) throw new Error(`Invalid environment: ${error.message}`);
  const clientOrigins = value.CLIENT_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of clientOrigins) {
    if (origin === "*") continue;
    const hasWildcard = origin.includes("*");
    if (hasWildcard) {
      if (
        !/^https?:\/\/(?:\*|(?:\*\.)?[A-Za-z0-9.-]+)(?::\d+)?$/.test(origin)
      ) {
        throw new Error(
          "CLIENT_ORIGINS wildcard entries must look like https://*.example.com or https://*.example.com:3000.",
        );
      }
      continue;
    }
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin
    ) {
      throw new Error(
        "CLIENT_ORIGINS must contain exact HTTP(S) origins without paths or trailing slashes.",
      );
    }
  }
  if (!clientOrigins.length)
    throw new Error("At least one CLIENT_ORIGINS value is required.");
  if (value.COOKIE_SAME_SITE === "none" && value.NODE_ENV !== "production") {
    throw new Error(
      "COOKIE_SAME_SITE=none requires production HTTPS (secure cookies).",
    );
  }
  const turnUrls = value.TURN_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length && value.TURN_SECRET.length < 32) {
    throw new Error(
      "TURN_SECRET must contain at least 32 characters when TURN_URLS is set.",
    );
  }
  const host =
    value.NODE_ENV === "production" && value.HOST === "127.0.0.1"
      ? "0.0.0.0"
      : value.HOST;

  return {
    production: value.NODE_ENV === "production",
    port: value.PORT,
    host,
    databaseUrl: value.DATABASE_URL,
    sessionSecret: value.SESSION_SECRET,
    sessionMaxAge: value.SESSION_HOURS * 3600000,
    sameSite: value.COOKIE_SAME_SITE,
    trustProxy: value.TRUST_PROXY,
    clientOrigins,
    stunUrls: value.STUN_URLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    turnUrls,
    turnSecret: value.TURN_SECRET,
    callInvitationTimeoutMs: 10 * 60 * 1000,
    maxCallParticipants: 6,
    enableDemo: value.ENABLE_DEMO,
  };
}
