import { Router } from "express";
import Joi from "joi";
import { AppError } from "../lib/errors.js";
import { pagination, uuid, validate } from "../lib/validation.js";

const columns =
  'id, full_name AS "fullName", role, bio, specialties, avatar_url AS "avatarUrl", created_at AS "createdAt"';
const imageExtensions = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function avatarUpload(uploadStorage) {
  return uploadStorage.middleware({
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (imageExtensions[file.mimetype]) {
        callback(null, true);
        return;
      }
      callback(
        new AppError(
          400,
          "INVALID_IMAGE_TYPE",
          "Choose a JPEG, PNG, WebP, or GIF image.",
        ),
      );
    },
  });
}

function hasImageSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/gif") {
    return ["GIF87a", "GIF89a"].some((signature) =>
      buffer.subarray(0, 6).equals(Buffer.from(signature)),
    );
  }
  return (
    mimeType === "image/webp" &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  );
}

export async function removeAvatarFile(url, uploadStorage) {
  await uploadStorage.removePublicUrl(url);
}

export function userRoutes({ pool, uploadStorage }) {
  const router = Router();
  router.post(
    "/me/avatar",
    avatarUpload(uploadStorage).single("avatar"),
    async (req, res) => {
      if (!req.file) {
        throw new AppError(400, "IMAGE_REQUIRED", "Choose an image to upload.");
      }
      const image = req.file.buffer;
      if (!hasImageSignature(image, req.file.mimetype)) {
        throw new AppError(
          400,
          "INVALID_IMAGE",
          "The uploaded file is not a supported image.",
        );
      }

      const stored = await uploadStorage.save(req.file, "public");
      const avatarUrl = stored.url;
      let rows;
      try {
        ({ rows } = await pool.query(
          `UPDATE users SET avatar_url = $2
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING ${columns}`,
          [req.user.id, avatarUrl],
        ));
      } catch (error) {
        await uploadStorage.remove(stored.key).catch(() => {});
        throw error;
      }
      if (!rows[0]) {
        await uploadStorage.remove(stored.key).catch(() => {});
        throw new AppError(404, "USER_NOT_FOUND", "User not found.");
      }

      await removeAvatarFile(req.user.avatarUrl, uploadStorage);
      res.json({ user: rows[0] });
    },
  );

  router.get("/", async (req, res) => {
    const { search, role } = validate(
      Joi.object({
        search: Joi.string().trim().max(120).allow("").default(""),
        role: Joi.string().valid("client", "counsellor", "admin"),
      }),
      { search: req.query.search, role: req.query.role },
    );
    const { limit, offset } = pagination(req.query);
    const { rows } = await pool.query(
      `SELECT ${columns} FROM users
      WHERE deleted_at IS NULL AND full_name ILIKE $1
        AND ($2::text IS NULL OR role = $2)
      ORDER BY full_name, id LIMIT $3 OFFSET $4`,
      [`%${search}%`, role ?? null, limit, offset],
    );
    res.json({ users: rows, limit, offset });
  });
  router.patch("/me", async (req, res) => {
    const body = validate(
      Joi.object({
        fullName: Joi.string().trim().min(2).max(120),
        bio: Joi.string().trim().max(2000).allow(""),
        specialties: Joi.array()
          .items(Joi.string().trim().min(2).max(80))
          .max(12)
          .unique(),
      })
        .min(1)
        .required(),
      req.body,
    );
    if (body.specialties && req.user.role !== "counsellor") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only counsellors can set specialties.",
      );
    }
    const { rows } = await pool.query(
      `UPDATE users SET full_name = COALESCE($2,full_name), bio = COALESCE($3,bio),
      specialties = COALESCE($4::text[],specialties) WHERE id = $1 RETURNING ${columns}`,
      [
        req.user.id,
        body.fullName ?? null,
        body.bio ?? null,
        body.specialties ?? null,
      ],
    );
    res.json({ user: rows[0] });
  });
  router.patch("/:id/role", async (req, res) => {
    if (req.user.role !== "admin") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only admins can change user roles.",
      );
    }
    const { id } = validate(
      Joi.object({
        id: Joi.string()
          .guid({ version: ["uuidv4"] })
          .required(),
      }).required(),
      { id: req.params.id },
    );
    const { role } = validate(
      Joi.object({
        role: Joi.string().valid("client", "counsellor", "admin").required(),
      }).required(),
      req.body,
    );
    const { rows } = await pool.query(
      `UPDATE users SET role = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING ${columns}`,
      [id, role],
    );
    if (!rows[0]) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    res.json({ user: rows[0] });
  });

  router.get("/:id", async (req, res) => {
    const id = uuid(req.params.id);
    const { rows } = await pool.query(
      `SELECT ${columns},
      (SELECT count(*)::integer FROM follows WHERE following_id = users.id) AS "followerCount",
      (SELECT count(*)::integer FROM follows WHERE follower_id = users.id) AS "followingCount",
      EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = users.id) AS "isFollowing"
      FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id, req.user.id],
    );
    if (!rows[0]) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    res.json({ user: rows[0] });
  });
  return router;
}
