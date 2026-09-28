import Joi from "joi";
import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { validate, uuid } from "../lib/validation.js";

const messageSchema = Joi.object({
  conversationId: Joi.string().uuid().lowercase().required(),
  senderId: Joi.string().uuid().lowercase().required(),
  body: Joi.string().trim().max(4000).allow("").required(),
  attachmentName: Joi.string().max(255).allow(null).default(null),
  attachmentUrl: Joi.string().max(512).allow(null).default(null),
  attachmentMime: Joi.string().max(255).allow(null).default(null),
  attachmentSize: Joi.number()
    .integer()
    .min(1)
    .max(25 * 1024 * 1024)
    .allow(null)
    .default(null),
})
  .custom((value, helpers) => {
    if (!value.body && !value.attachmentUrl) {
      return helpers.message("A message or file is required.");
    }
    return value;
  })
  .unknown(false);

/** Only return a conversation when this user belongs to it. */
export async function assertConversationMember(pool, conversationId, userId) {
  const id = uuid(conversationId);
  const memberId = uuid(userId);
  const { rows } = await pool.query(
    `SELECT c.id, c.kind, c.title, c.created_by AS "createdBy",
            c.created_at AS "createdAt"
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = $1 AND cm.user_id = $2`,
    [id, memberId],
  );

  if (!rows[0]) {
    throw new AppError(
      404,
      "CONVERSATION_NOT_FOUND",
      "Conversation not found.",
    );
  }

  return rows[0];
}

/** Shared by the HTTP API and authenticated Socket.IO message handler. */
export async function sendMessage(pool, input) {
  const {
    conversationId,
    senderId,
    body,
    attachmentName,
    attachmentUrl,
    attachmentMime,
    attachmentSize,
  } = validate(messageSchema, input);
  await assertConversationMember(pool, conversationId, senderId);
  const { rows } = await pool.query(
    `INSERT INTO messages (
       id, conversation_id, sender_id, body, attachment_name,
       attachment_url, attachment_mime, attachment_size
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, conversation_id AS "conversationId", sender_id AS "senderId",
               body, attachment_name AS "attachmentName",
               attachment_url AS "attachmentUrl", attachment_mime AS "attachmentMime",
               attachment_size AS "attachmentSize", created_at AS "createdAt",
               '[]'::json AS reactions`,
    [
      randomUUID(),
      conversationId,
      senderId,
      body,
      attachmentName,
      attachmentUrl,
      attachmentMime,
      attachmentSize,
    ],
  );
  return rows[0];
}

/** Fan out to every member's devices, including the sender's other devices. */
export async function deliverMessage(io, pool, message) {
  const { rows } = await pool.query(
    "SELECT user_id AS id FROM conversation_members WHERE conversation_id = $1",
    [message.conversationId],
  );
  const rooms = rows.map(({ id }) => `user:${id}`);
  if (rooms.length > 0) io.to(rooms).emit("message:new", message);
}
