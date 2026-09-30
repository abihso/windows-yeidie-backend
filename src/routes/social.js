import { randomUUID } from "node:crypto";
import { Router } from "express";
import Joi from "joi";
import { transaction } from "../db/transaction.js";
import { AppError } from "../lib/errors.js";
import { validate, uuid, pagination } from "../lib/validation.js";
import {
  assertConversationMember,
  deliverMessage,
  sendMessage,
} from "../services/chat.js";

const imageVideoFilter = (_req, file, callback) => {
  if (
    file.mimetype.startsWith("image/") ||
    file.mimetype.startsWith("video/")
  ) {
    callback(null, true);
    return;
  }
  callback(
    new AppError(
      400,
      "INVALID_FILE_TYPE",
      "Only images and videos are allowed.",
    ),
  );
};

function postUpload(uploadStorage) {
  return uploadStorage.middleware({
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: imageVideoFilter,
  });
}

function messageUpload(uploadStorage) {
  return uploadStorage.middleware({ limits: { fileSize: 25 * 1024 * 1024 } });
}

const conversationSchema = Joi.object({
  kind: Joi.string().valid("direct", "group").required(),
  memberIds: Joi.array()
    .items(Joi.string().uuid().lowercase())
    .unique()
    .min(1)
    .max(5)
    .required(),
  title: Joi.string().trim().min(1).max(120),
}).unknown(false);

const conversationUpdateSchema = Joi.object({
  title: Joi.string().trim().min(1).max(120).required(),
}).unknown(false);

const conversationMemberSchema = Joi.object({
  memberId: Joi.string().uuid().lowercase().required(),
}).unknown(false);

const messageBodySchema = Joi.object({
  body: Joi.string().trim().min(1).max(4000).required(),
}).unknown(false);

const reactionEmojis = ["❤️", "😂", "👍", "😮", "😢", "👏"];
const messageReactionSchema = Joi.object({
  emoji: Joi.string()
    .valid(...reactionEmojis)
    .required(),
}).unknown(false);

const commentSchema = Joi.object({
  body: Joi.string().trim().min(1).max(4000).required(),
}).unknown(false);

const postSchema = Joi.object({
  body: Joi.string().trim().max(4000).allow("").default(""),
  mediaType: Joi.string().valid("image", "video").allow(null).default(null),
  mediaUrl: Joi.string()
    .trim()
    .max(25 * 1024 * 1024)
    .allow("")
    .default(""),
})
  .custom((value, helpers) => {
    const body = value.body?.trim?.() ?? "";
    const mediaUrl = value.mediaUrl?.trim?.() ?? "";
    if (!body && !mediaUrl) {
      return helpers.message("Either body or mediaUrl is required.");
    }
    if (value.mediaType && !mediaUrl) {
      return helpers.message("mediaType requires a mediaUrl.");
    }
    return value;
  })
  .unknown(false);

const publicProfileColumns = `u.id, u.full_name AS "fullName", u.role,
                              u.bio, u.specialties,
                              u.avatar_url AS "avatarUrl",
                              u.created_at AS "createdAt"`;

async function assertUserExists(pool, id) {
  const { rows } = await pool.query(
    "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  if (!rows.length)
    throw new AppError(404, "USER_NOT_FOUND", "User not found.");
}

async function assertPostExists(pool, id) {
  const { rows } = await pool.query("SELECT id FROM posts WHERE id = $1", [id]);
  if (!rows.length)
    throw new AppError(404, "POST_NOT_FOUND", "Post not found.");
}

async function conversationMembers(pool, id) {
  const { rows } = await pool.query(
    `SELECT ${publicProfileColumns}, cm.role AS "membershipRole"
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1
      ORDER BY cm.joined_at, u.id`,
    [id],
  );
  return rows;
}

async function groupMembership(pool, conversationId, userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.kind, c.created_by AS "createdBy", cm.role AS "membershipRole"
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = $1 AND cm.user_id = $2`,
    [conversationId, userId],
  );
  const conversation = rows[0];
  if (!conversation) {
    throw new AppError(
      404,
      "CONVERSATION_NOT_FOUND",
      "Conversation not found.",
    );
  }
  if (conversation.kind !== "group") {
    throw new AppError(
      400,
      "GROUP_REQUIRED",
      "This action requires a group conversation.",
    );
  }
  return conversation;
}

function requireGroupOwner(conversation, userId) {
  if (
    conversation.createdBy.toLowerCase() !== userId.toLowerCase() ||
    conversation.membershipRole !== "owner"
  ) {
    throw new AppError(
      403,
      "GROUP_OWNER_REQUIRED",
      "Only the group owner can manage this group.",
    );
  }
}

export function socialRoutes({ pool, io, uploadStorage }) {
  const router = Router();

  router.post("/users/:id/follow", async (req, res) => {
    const targetId = uuid(req.params.id).toLowerCase();
    if (targetId === req.user.id.toLowerCase()) {
      throw new AppError(400, "SELF_FOLLOW", "You cannot follow yourself.");
    }
    await assertUserExists(pool, targetId);
    await pool.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [req.user.id, targetId],
    );
    res.json({ following: true });
  });

  router.delete("/users/:id/follow", async (req, res) => {
    const targetId = uuid(req.params.id).toLowerCase();
    if (targetId === req.user.id.toLowerCase()) {
      throw new AppError(400, "SELF_FOLLOW", "You cannot follow yourself.");
    }
    await assertUserExists(pool, targetId);
    await pool.query(
      "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2",
      [req.user.id, targetId],
    );
    res.json({ following: false });
  });

  // These SQL fragments are fixed by the route definition, never supplied by a user.
  for (const [path, ownerColumn, profileColumn] of [
    ["followers", "following_id", "follower_id"],
    ["following", "follower_id", "following_id"],
  ]) {
    router.get(`/users/:id/${path}`, async (req, res) => {
      const userId = uuid(req.params.id);
      const { limit, offset } = pagination(req.query);
      await assertUserExists(pool, userId);
      const { rows } = await pool.query(
        `SELECT ${publicProfileColumns}
           FROM follows f JOIN users u ON u.id = f.${profileColumn}
          WHERE f.${ownerColumn} = $1 AND u.deleted_at IS NULL
          ORDER BY f.created_at DESC, u.id
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      res.json({ users: rows, limit, offset });
    });
  }

  router.get("/posts", async (req, res) => {
    const { rows } = await pool.query(
      `WITH like_counts AS (
          SELECT post_id, COUNT(*)::int AS likes
          FROM post_likes
          GROUP BY post_id
        ),
        repost_counts AS (
          SELECT post_id, COUNT(*)::int AS reposts
          FROM post_reposts
          GROUP BY post_id
        ),
        save_counts AS (
          SELECT post_id, COUNT(*)::int AS saves
          FROM post_saves
          GROUP BY post_id
        )
      SELECT p.id, p.body, p.media_type AS "mediaType", p.media_url AS "mediaUrl", p.created_at AS "createdAt",
             u.id AS "authorId", u.full_name AS "authorFullName", u.role AS "authorRole",
             u.avatar_url AS "authorAvatarUrl",
             COALESCE(lc.likes, 0) AS likes,
             COALESCE(rc.reposts, 0) AS reposts,
             COALESCE(sc.saves, 0) AS saves,
             EXISTS (
               SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
             ) AS liked,
             EXISTS (
               SELECT 1 FROM post_reposts pr WHERE pr.post_id = p.id AND pr.user_id = $1
             ) AS reposted,
             EXISTS (
               SELECT 1 FROM post_saves ps WHERE ps.post_id = p.id AND ps.user_id = $1
             ) AS saved
        FROM posts p
        JOIN users u ON u.id = p.author_id
        LEFT JOIN like_counts lc ON lc.post_id = p.id
        LEFT JOIN repost_counts rc ON rc.post_id = p.id
        LEFT JOIN save_counts sc ON sc.post_id = p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT 50`,
      [req.user.id],
    );

    const postIds = rows.map((row) => row.id);
    const commentsByPost = new Map();
    if (postIds.length) {
      const { rows: commentRows } = await pool.query(
        `SELECT c.id, c.post_id AS "postId", c.body, c.created_at AS "createdAt",
                u.id AS "authorId", u.full_name AS "authorFullName", u.role AS "authorRole",
                u.avatar_url AS "authorAvatarUrl"
           FROM post_comments c
           JOIN users u ON u.id = c.author_id
          WHERE c.post_id = ANY($1)
          ORDER BY c.created_at ASC, c.id`,
        [postIds],
      );
      for (const comment of commentRows) {
        const list = commentsByPost.get(comment.postId) ?? [];
        list.push({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          author: {
            id: comment.authorId,
            fullName: comment.authorFullName,
            role: comment.authorRole,
            avatarUrl: comment.authorAvatarUrl,
          },
        });
        commentsByPost.set(comment.postId, list);
      }
    }

    res.json({
      posts: rows.map((row) => ({
        id: row.id,
        body: row.body,
        mediaType: row.mediaType,
        mediaUrl: row.mediaUrl,
        createdAt: row.createdAt,
        likes: Number(row.likes ?? 0),
        liked: Boolean(row.liked),
        comments: commentsByPost.get(row.id) ?? [],
        reposts: Number(row.reposts ?? 0),
        reposted: Boolean(row.reposted),
        saves: Number(row.saves ?? 0),
        saved: Boolean(row.saved),
        author: {
          id: row.authorId,
          fullName: row.authorFullName,
          role: row.authorRole,
          avatarUrl: row.authorAvatarUrl,
        },
      })),
    });
  });

  router.post("/posts/:id/like", async (req, res) => {
    const postId = uuid(req.params.id).toLowerCase();
    await assertPostExists(pool, postId);

    const existing = await pool.query(
      "SELECT 1 FROM post_likes WHERE user_id = $1 AND post_id = $2",
      [req.user.id, postId],
    );

    if (existing.rows.length) {
      await pool.query(
        "DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2",
        [req.user.id, postId],
      );
    } else {
      await pool.query(
        "INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2)",
        [req.user.id, postId],
      );
    }

    const count = await pool.query(
      "SELECT COUNT(*)::int AS likes FROM post_likes WHERE post_id = $1",
      [postId],
    );

    const liked = !existing.rows.length;
    res.json({ liked, likes: Number(count.rows[0].likes) });
  });

  router.post("/posts/:id/repost", async (req, res) => {
    const postId = uuid(req.params.id).toLowerCase();
    await assertPostExists(pool, postId);

    const existing = await pool.query(
      "SELECT 1 FROM post_reposts WHERE user_id = $1 AND post_id = $2",
      [req.user.id, postId],
    );

    if (existing.rows.length) {
      await pool.query(
        "DELETE FROM post_reposts WHERE user_id = $1 AND post_id = $2",
        [req.user.id, postId],
      );
    } else {
      await pool.query(
        "INSERT INTO post_reposts (user_id, post_id) VALUES ($1, $2)",
        [req.user.id, postId],
      );
    }

    const count = await pool.query(
      "SELECT COUNT(*)::int AS reposts FROM post_reposts WHERE post_id = $1",
      [postId],
    );

    const reposted = !existing.rows.length;
    res.json({ reposted, reposts: Number(count.rows[0].reposts) });
  });

  router.post("/posts/:id/save", async (req, res) => {
    const postId = uuid(req.params.id).toLowerCase();
    await assertPostExists(pool, postId);

    const existing = await pool.query(
      "SELECT 1 FROM post_saves WHERE user_id = $1 AND post_id = $2",
      [req.user.id, postId],
    );

    if (existing.rows.length) {
      await pool.query(
        "DELETE FROM post_saves WHERE user_id = $1 AND post_id = $2",
        [req.user.id, postId],
      );
    } else {
      await pool.query(
        "INSERT INTO post_saves (user_id, post_id) VALUES ($1, $2)",
        [req.user.id, postId],
      );
    }

    const count = await pool.query(
      "SELECT COUNT(*)::int AS saves FROM post_saves WHERE post_id = $1",
      [postId],
    );

    const saved = !existing.rows.length;
    res.json({ saved, saves: Number(count.rows[0].saves) });
  });

  router.post("/posts/:id/comments", async (req, res) => {
    const postId = uuid(req.params.id).toLowerCase();
    await assertPostExists(pool, postId);
    const input = validate(commentSchema, req.body);

    const { rows } = await pool.query(
      `INSERT INTO post_comments (id, post_id, author_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, post_id AS "postId", body, created_at AS "createdAt"`,
      [randomUUID(), postId, req.user.id, input.body],
    );
    const comment = rows[0];
    res.status(201).json({
      comment: {
        id: comment.id,
        postId: comment.postId,
        body: comment.body,
        createdAt: comment.createdAt,
        author: {
          id: req.user.id,
          fullName: req.user.fullName,
          role: req.user.role,
          avatarUrl: req.user.avatarUrl,
        },
      },
    });
  });

  router.post(
    "/posts",
    postUpload(uploadStorage).single("media"),
    async (req, res) => {
      console.log("hit")
      const payload = req.body ?? {};
      const mediaType = req.file
        ? req.file.mimetype.startsWith("video/")
          ? "video"
          : "image"
        : (payload.mediaType ?? null);
      const mediaUrl = req.file ? "upload-pending" : (payload.mediaUrl ?? "");
      const input = validate(postSchema, {
        body: payload.body ?? "",
        mediaType,
        mediaUrl,
      });

      const stored = req.file
        ? await uploadStorage.save(req.file, "public")
        : null;
      if (stored) input.mediaUrl = stored.url;
      let result;
      try {
        result = await pool.query(
          `INSERT INTO posts (id, author_id, body, media_type, media_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, body, media_type AS "mediaType", media_url AS "mediaUrl", created_at AS "createdAt"`,
          [
            randomUUID(),
            req.user.id,
            input.body ?? "",
            input.mediaType ?? null,
            input.mediaUrl || null,
          ],
        );
      } catch (error) {
        // console.error("Error creating post:", error);
        if (stored) await uploadStorage.remove(stored.key).catch(() => {});
        throw error;
      }
      const post = result.rows[0];
      res.status(201).json({
        post: {
          ...post,
          author: {
            id: req.user.id,
            fullName: req.user.fullName,
            role: req.user.role,
            avatarUrl: req.user.avatarUrl,
          },
        },
      });
    },
  );

  router.post("/conversations", async (req, res) => {
    const input = validate(conversationSchema, req.body);
    const userId = req.user.id.toLowerCase();
    if (input.memberIds.includes(userId)) {
      throw new AppError(
        400,
        "INVALID_MEMBERS",
        "List the other participants only.",
      );
    }
    if (input.kind === "direct" && input.memberIds.length !== 1) {
      throw new AppError(
        400,
        "INVALID_MEMBERS",
        "Direct conversations need one other participant.",
      );
    }
    if (input.kind === "group" && input.memberIds.length < 2) {
      throw new AppError(
        400,
        "INVALID_MEMBERS",
        "Group conversations need at least two other participants.",
      );
    }
    if (input.kind === "direct" && input.title !== undefined) {
      throw new AppError(
        400,
        "INVALID_TITLE",
        "Titles are only available for group conversations.",
      );
    }

    const { conversation, created } = await transaction(
      pool,
      async (client) => {
        const members = [userId, ...input.memberIds];
        const existingUsers = await client.query(
          "SELECT id FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
          [members],
        );
        if (existingUsers.rows.length !== members.length) {
          throw new AppError(
            404,
            "USER_NOT_FOUND",
            "One or more participants could not be found.",
          );
        }

        const directKey =
          input.kind === "direct" ? [...members].sort().join(":") : null;
        const inserted = await client.query(
          `INSERT INTO conversations (id, kind, title, created_by, direct_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (direct_key) DO NOTHING
         RETURNING id, kind, title, created_by AS "createdBy", created_at AS "createdAt"`,
          [randomUUID(), input.kind, input.title ?? null, userId, directKey],
        );

        if (!inserted.rows[0]) {
          // PostgreSQL waits for a concurrent INSERT to commit before resolving the
          // unique conflict. This subsequent query sees that committed conversation.
          const existing = await client.query(
            `SELECT id, kind, title, created_by AS "createdBy", created_at AS "createdAt"
             FROM conversations WHERE direct_key = $1`,
            [directKey],
          );
          return { conversation: existing.rows[0], created: false };
        }

        const result = inserted.rows[0];
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
         SELECT $1::uuid, member_id,
                CASE WHEN member_id = $2::uuid THEN 'owner' ELSE 'member' END
           FROM unnest($3::uuid[]) AS member_id`,
          [result.id, userId, members],
        );
        return { conversation: result, created: true };
      },
    );

    const members = await conversationMembers(pool, conversation.id);
    const result = { ...conversation, members };
    if (created)
      io.to(members.map(({ id }) => `user:${id}`)).emit(
        "conversation:new",
        result,
      );
    res.status(created ? 201 : 200).json({ conversation: result });
  });

  router.get("/conversations", async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const { rows } = await pool.query(
      `SELECT c.id, c.kind, c.title, c.created_by AS "createdBy", c.created_at AS "createdAt",
              (SELECT json_agg(json_build_object(
                  'id', u.id, 'fullName', u.full_name, 'role', u.role,
                  'avatarUrl', u.avatar_url,
                  'membershipRole', cm.role
                ) ORDER BY cm.joined_at, u.id)
                 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                WHERE cm.conversation_id = c.id) AS members,
              CASE WHEN latest.id IS NULL THEN NULL ELSE json_build_object(
                'id', latest.id, 'conversationId', c.id, 'senderId', latest.sender_id,
                'body', latest.body, 'createdAt', latest.created_at
              ) END AS "latestMessage"
         FROM conversations c
         JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
         LEFT JOIN LATERAL (
           SELECT id, sender_id, body, created_at FROM messages
            WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
         ) latest ON true
        ORDER BY COALESCE(latest.created_at, c.created_at) DESC, c.id
        LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );
    res.json({ conversations: rows, limit, offset });
  });

  router.patch("/conversations/:id", async (req, res) => {
    const conversationId = uuid(req.params.id);
    const input = validate(conversationUpdateSchema, req.body);
    const conversation = await groupMembership(
      pool,
      conversationId,
      req.user.id,
    );
    requireGroupOwner(conversation, req.user.id);
    const { rows } = await pool.query(
      `UPDATE conversations SET title = $2
        WHERE id = $1
        RETURNING id, kind, title, created_by AS "createdBy", created_at AS "createdAt"`,
      [conversationId, input.title],
    );
    res.json({
      conversation: {
        ...rows[0],
        members: await conversationMembers(pool, conversationId),
      },
    });
  });

  router.post("/conversations/:id/members", async (req, res) => {
    const conversationId = uuid(req.params.id);
    const { memberId } = validate(conversationMemberSchema, req.body);
    const conversation = await groupMembership(
      pool,
      conversationId,
      req.user.id,
    );
    requireGroupOwner(conversation, req.user.id);
    await assertUserExists(pool, memberId);
    const result = await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT (conversation_id, user_id) DO NOTHING
       RETURNING conversation_id AS "conversationId", user_id AS "userId"`,
      [conversationId, memberId],
    );
    if (!result.rows.length) {
      throw new AppError(
        409,
        "ALREADY_MEMBER",
        "This user is already in the group.",
      );
    }
    const members = await conversationMembers(pool, conversationId);
    io.to(`user:${memberId}`).emit("conversation:new", {
      id: conversationId,
      kind: "group",
      members,
    });
    res.status(201).json({ members });
  });

  router.delete("/conversations/:id/members/:userId", async (req, res) => {
    const conversationId = uuid(req.params.id);
    const memberId = uuid(req.params.userId);
    const conversation = await groupMembership(
      pool,
      conversationId,
      req.user.id,
    );
    if (memberId.toLowerCase() !== req.user.id.toLowerCase()) {
      requireGroupOwner(conversation, req.user.id);
    }
    if (memberId.toLowerCase() === conversation.createdBy.toLowerCase()) {
      throw new AppError(
        400,
        "OWNER_CANNOT_LEAVE",
        "Transfer ownership before leaving the group.",
      );
    }
    const result = await pool.query(
      `DELETE FROM conversation_members
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING user_id`,
      [conversationId, memberId],
    );
    if (!result.rows.length) {
      throw new AppError(
        404,
        "MEMBER_NOT_FOUND",
        "That user is not a member of this group.",
      );
    }
    res.status(204).send();
  });

  router.delete("/conversations/:id", async (req, res) => {
    const conversationId = uuid(req.params.id);
    const conversation = await groupMembership(
      pool,
      conversationId,
      req.user.id,
    );
    requireGroupOwner(conversation, req.user.id);
    await pool.query("DELETE FROM call_rooms WHERE conversation_id = $1", [
      conversationId,
    ]);
    await pool.query("DELETE FROM conversations WHERE id = $1", [
      conversationId,
    ]);
    res.status(204).send();
  });

  router.get("/conversations/:id/messages", async (req, res) => {
    const conversationId = uuid(req.params.id);
    const { limit, offset } = pagination(req.query);
    await assertConversationMember(pool, conversationId, req.user.id);
    const { rows } = await pool.query(
      `SELECT id, conversation_id AS "conversationId", sender_id AS "senderId",
              body, attachment_name AS "attachmentName",
              attachment_url AS "attachmentUrl", attachment_mime AS "attachmentMime",
              attachment_size AS "attachmentSize", created_at AS "createdAt",
              COALESCE((
                SELECT json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id))
                  FROM message_reactions r WHERE r.message_id = messages.id
              ), '[]'::json) AS reactions
         FROM messages WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset],
    );
    res.json({ messages: rows, limit, offset });
  });

  router.post("/conversations/:id/messages", async (req, res) => {
    const { body } = validate(messageBodySchema, req.body);
    const message = await sendMessage(pool, {
      conversationId: req.params.id,
      senderId: req.user.id,
      body,
    });
    await deliverMessage(io, pool, message);
    res.status(201).json({ message });
  });

  router.post(
    "/conversations/:id/messages/attachment",
    async (req, _res, next) => {
      try {
        await assertConversationMember(pool, req.params.id, req.user.id);
        next();
      } catch (error) {
        next(error);
      }
    },
    messageUpload(uploadStorage).single("file"),
    async (req, res) => {
      let stored;
      let message;
      try {
        const body = (req.body?.body ?? "").trim();
        if (body) validate(messageBodySchema, { body });
        if (!body && !req.file) {
          throw new AppError(400, "MESSAGE_REQUIRED", "Add a message or file.");
        }
        stored = req.file
          ? await uploadStorage.save(req.file, "private")
          : null;
        message = await sendMessage(pool, {
          conversationId: req.params.id,
          senderId: req.user.id,
          body,
          attachmentName: req.file?.originalname.slice(0, 255) ?? null,
          attachmentUrl: stored?.key ?? null,
          attachmentMime: req.file?.mimetype ?? null,
          attachmentSize: req.file?.size ?? null,
        });
      } catch (error) {
        if (stored) await uploadStorage.remove(stored.key).catch(() => {});
        throw error;
      }
      await deliverMessage(io, pool, message);
      res.status(201).json({ message });
    },
  );

  router.get(
    "/conversations/:id/messages/:messageId/attachment",
    async (req, res) => {
      const conversationId = uuid(req.params.id);
      const messageId = uuid(req.params.messageId);
      await assertConversationMember(pool, conversationId, req.user.id);
      const { rows } = await pool.query(
        `SELECT attachment_url AS "attachmentUrl",
                attachment_name AS "attachmentName",
                attachment_mime AS "attachmentMime"
           FROM messages WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId],
      );
      const attachment = rows[0];
      if (!attachment?.attachmentUrl) {
        throw new AppError(404, "ATTACHMENT_NOT_FOUND", "File not found.");
      }
      const sent = await uploadStorage.sendPrivate(
        attachment.attachmentUrl,
        res,
        {
          inline: req.query.inline === "true",
          name: attachment.attachmentName || "attachment",
          mime: attachment.attachmentMime,
        },
      );
      if (!sent) {
        throw new AppError(404, "ATTACHMENT_NOT_FOUND", "File not found.");
      }
    },
  );

  router.post(
    "/conversations/:id/messages/:messageId/reactions",
    async (req, res) => {
      const conversationId = uuid(req.params.id);
      const messageId = uuid(req.params.messageId);
      const { emoji } = validate(messageReactionSchema, req.body);
      await assertConversationMember(pool, conversationId, req.user.id);
      const message = await pool.query(
        "SELECT id FROM messages WHERE id = $1 AND conversation_id = $2",
        [messageId, conversationId],
      );
      if (!message.rows.length) {
        throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found.");
      }

      const inserted = await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`,
        [messageId, req.user.id, emoji],
      );
      const active = inserted.rows.length > 0;
      if (!active) {
        await pool.query(
          "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
          [messageId, req.user.id, emoji],
        );
      }
      const { rows: members } = await pool.query(
        "SELECT user_id FROM conversation_members WHERE conversation_id = $1",
        [conversationId],
      );
      io.to(members.map(({ user_id }) => `user:${user_id}`)).emit(
        "message:reaction",
        { conversationId, messageId, userId: req.user.id, emoji, active },
      );
      res.json({ active, userId: req.user.id, emoji });
    },
  );

  return router;
}
