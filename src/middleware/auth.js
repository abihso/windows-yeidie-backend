import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";

export function ensureCsrfToken(req) {
  req.session.csrfToken ??= randomBytes(32).toString("hex");
  return req.session.csrfToken;
}

export function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const expected = req.session.csrfToken;
  const supplied = req.get("X-CSRF-Token");
  if (
    !expected ||
    !supplied ||
    Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  ) {
    return next(
      new AppError(
        403,
        "CSRF_INVALID",
        "Fetch a CSRF token and send it in the X-CSRF-Token header.",
      ),
    );
  }
  next();
}

export function requireAuth(pool) {
  return async (req, res, next) => {
    if (!req.session.userId)
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const { rows } = await pool.query(
      'SELECT id, full_name AS "fullName", email, role, bio, specialties, avatar_url AS "avatarUrl", created_at AS "createdAt" FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.session.userId],
    );
    if (!rows[0])
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
    req.user = rows[0];
    next();
  };
}
