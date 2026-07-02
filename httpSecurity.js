import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

function parseAllowedOrigins(rawValue, nodeEnv) {
  const envOrigins = String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (nodeEnv !== "production") {
    envOrigins.push("http://localhost:3000", "http://127.0.0.1:3000");
  }

  return Array.from(new Set(envOrigins));
}

export function applyHttpSecurity(app, { allowedOrigins, nodeEnv }) {
  const originAllowlist = parseAllowedOrigins(allowedOrigins, nodeEnv);

  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    })
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          return callback(null, true);
        }

        if (originAllowlist.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("CORS origin not allowed."));
      },
    })
  );
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
}

export function createPlaidRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: "Too many requests",
    },
  });
}
