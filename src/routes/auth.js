import { Router } from "express";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcrypt";
import Joi from "joi";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";
import { validate } from "../lib/validation.js";
import { ensureCsrfToken, requireAuth } from "../middleware/auth.js";
import { transaction } from "../db/transaction.js";
import { removeAvatarFile } from "./users.js";

const password = Joi.string()
  .min(10)
  .max(72)
  .custom((value, helpers) =>
    Buffer.byteLength(value, "utf8") <= 72
      ? value
      : helpers.message("Password must be at most 72 UTF-8 bytes"),
  );
const email = Joi.string()
  .trim()
  .lowercase()
  .email({ tlds: { allow: false } })
  .max(254);
const publicColumns =
  'id, full_name AS "fullName", email, role, bio, specialties, avatar_url AS "avatarUrl", created_at AS "createdAt"';
// A valid hash makes missing-account login attempts do the same bcrypt work.
const dummyHash = bcrypt.hashSync("not-a-real-account-password", 12);

async function establishSession(req, userId) {
  await promisify(req.session.regenerate).call(req.session);
  req.session.userId = userId;
  const csrfToken = ensureCsrfToken(req);
  await promisify(req.session.save).call(req.session);
  return csrfToken;
}

export function authRoutes({ pool, io, config }) {
  const router = Router();
  const limit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication attempts. Try again later.",
      },
    },
  });
  router.get("/csrf", (req, res) =>
    res.json({ csrfToken: ensureCsrfToken(req) }),
  );

  router.post("/register", limit, async (req, res) => {
    const data = validate(
      Joi.object({
        fullName: Joi.string().trim().min(2).max(120).required(),
        email: email.required(),
        password: password.required(),
        role: Joi.string().valid("client", "counsellor").default("client"),
      }).required(),
      req.body,
    );
    const hash = await bcrypt.hash(data.password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (id, full_name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING ${publicColumns}`,
      [randomUUID(), data.fullName, data.email, hash, data.role],
    );
    const oldSessionId = req.sessionID;
    const csrfToken = await establishSession(req, rows[0].id);
    io.in(`session:${oldSessionId}`).disconnectSockets(true);
    res.status(201).json({ user: rows[0], csrfToken });
  });

  router.post("/login", limit, async (req, res) => {
    const data = validate(
      Joi.object({
        email: email.required(),
        password: password.required(),
      }).required(),
      req.body,
    );
    const { rows } = await pool.query(
      `SELECT ${publicColumns}, password_hash FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [data.email],
    );
    const user = rows[0];
    const valid = await bcrypt.compare(
      data.password,
      user?.password_hash ?? dummyHash,
    );
    if (!user || !valid)
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    delete user.password_hash;
    const oldSessionId = req.sessionID;
    const csrfToken = await establishSession(req, user.id);
    io.in(`session:${oldSessionId}`).disconnectSockets(true);
    res.json({ user, csrfToken });
  });

  router.get("/me", requireAuth(pool), (req, res) =>
    res.json({ user: req.user, csrfToken: ensureCsrfToken(req) }),
  );
  router.patch("/password", requireAuth(pool), async (req, res) => {
    const data = validate(
      Joi.object({
        currentPassword: password.required(),
        newPassword: password.required(),
      })
        .custom((value, helpers) => {
          if (value.currentPassword === value.newPassword) {
            return helpers.message("New password must be different.");
          }
          return value;
        })
        .required(),
      req.body,
    );
    const { rows } = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id],
    );
    const valid = await bcrypt.compare(
      data.currentPassword,
      rows[0]?.password_hash ?? dummyHash,
    );
    if (!valid) {
      throw new AppError(
        400,
        "INVALID_PASSWORD",
        "Current password is incorrect.",
      );
    }
    const hash = await bcrypt.hash(data.newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      req.user.id,
      hash,
    ]);
    res.status(204).end();
  });
  router.delete("/account", requireAuth(pool), async (req, res) => {
    const { password: currentPassword } = validate(
      Joi.object({ password: password.required() }).required(),
      req.body,
    );
    const deletion = await transaction(pool, async (client) => {
      const { rows } = await client.query(
        "SELECT password_hash, avatar_url FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [req.user.id],
      );
      if (
        !rows[0] ||
        !(await bcrypt.compare(currentPassword, rows[0].password_hash))
      ) {
        throw new AppError(
          400,
          "INVALID_PASSWORD",
          "Current password is incorrect.",
        );
      }

      const { rows: sessions } = await client.query(
        "DELETE FROM user_sessions WHERE sess->>'userId' = $1 RETURNING sid",
        [req.user.id],
      );
      await client.query(
        `UPDATE users
         SET full_name = 'Deleted user', email = $2, password_hash = $3,
           bio = '', specialties = '{}'::text[], avatar_url = NULL,
           deleted_at = NOW()
         WHERE id = $1`,
        [
          req.user.id,
          `deleted+${req.user.id}@deleted.invalid`,
          await bcrypt.hash(randomUUID(), 12),
        ],
      );
      return {
        sessionIds: sessions.map(({ sid }) => sid),
        avatarUrl: rows[0].avatar_url,
      };
    });

    for (const sessionId of new Set([...deletion.sessionIds, req.sessionID])) {
      io.in(`session:${sessionId}`).disconnectSockets(true);
    }
    await removeAvatarFile(deletion.avatarUrl);
    await promisify(req.session.destroy).call(req.session);
    res.clearCookie("yiedie.sid", {
      httpOnly: true,
      secure: config.production,
      sameSite: config.sameSite,
      path: "/",
    });
    res.status(204).end();
  });
  router.post("/logout", async (req, res) => {
    const sessionId = req.sessionID;
    await promisify(req.session.destroy).call(req.session);
    io.in(`session:${sessionId}`).disconnectSockets(true);
    res.clearCookie("yiedie.sid", {
      httpOnly: true,
      secure: config.production,
      sameSite: config.sameSite,
      path: "/",
    });
    res.status(204).end();
  });
  return router;
}
