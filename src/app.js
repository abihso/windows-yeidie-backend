import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import { AppError, errorHandler } from "./lib/errors.js";
import { csrfProtection, requireAuth } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { bookingRoutes, counsellorRoutes } from "./routes/bookings.js";
import { socialRoutes } from "./routes/social.js";
import { callRoutes } from "./routes/calls.js";
import { attachRealtime } from "./realtime/index.js";
import { isOriginAllowed } from "./config.js";
import { createUploadStorage } from "./services/upload-storage.js";

export function createApplication({ pool, config, sessionStore }) {
  const app = express();
  const uploadStorage = createUploadStorage(config);
  const httpServer = createServer(app);
  const PgStore = connectPgSimple(session);
  const store =
    sessionStore ??
    new PgStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
    });
  const sessionMiddleware = session({
    name: "yiedie.sid",
    store,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.production,
      sameSite: config.sameSite,
      maxAge: config.sessionMaxAge,
      path: "/",
    },
  });
  const originAllowed = (origin) =>
    isOriginAllowed(origin, config.clientOrigins);
  const corsOptions = {
    origin(origin, callback) {
      callback(
        originAllowed(origin)
          ? null
          : new AppError(403, "ORIGIN_DENIED", "This origin is not allowed."),
        originAllowed(origin),
      );
    },
    credentials: true,
  };
  const io = new Server(httpServer, {
    cors: corsOptions,
    allowRequest: (req, callback) =>
      callback(null, originAllowed(req.headers.origin)),
    maxHttpBufferSize: 100 * 1024,
    connectionStateRecovery: undefined,
  });
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "connect-src": ["'self'", "ws:", "wss:"],
          "upgrade-insecure-requests": config.production ? [] : null,
        },
      },
    }),
  );
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true, limit: "25mb" }));
  if (!uploadStorage.usesS3) {
    app.use(
      "/uploads",
      (req, res, next) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        next();
      },
      express.static(fileURLToPath(new URL("../uploads/", import.meta.url))),
    );
  }
  app.get("/api/health", (req, res) =>
    res.json({ status: "ok", service: "yiedie-backend" }),
  );
  app.get("/api/ready", async (req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Try again shortly.",
        },
      },
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", sessionMiddleware, csrfProtection);
  app.use("/api/auth", authRoutes({ pool, io, config, uploadStorage }));
  app.use("/api", requireAuth(pool));
  app.use("/api/users", userRoutes({ pool, uploadStorage }));
  app.use("/api/counsellors", counsellorRoutes({ pool, io }));
  app.use("/api/bookings", bookingRoutes({ pool, io }));
  app.use("/api/calls", callRoutes({ pool, io, config }));
  app.use("/api", socialRoutes({ pool, io, uploadStorage }));
  if (config.enableDemo) {
    app.use(
      "/demo",
      express.static(fileURLToPath(new URL("../examples/", import.meta.url))),
    );
  }
  app.use((req, res, next) =>
    next(new AppError(404, "NOT_FOUND", "Endpoint not found.")),
  );
  app.use(errorHandler);
  attachRealtime(io, { pool, sessionMiddleware, config });
  return { app, httpServer, io, store };
}
