import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  json,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    fullName: varchar("full_name", { length: 120 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    bio: varchar("bio", { length: 2000 }).notNull().default(""),
    specialties: text("specialties")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt,
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    check(
      "users_role_check",
      sql`${table.role} in ('client', 'counsellor', 'admin')`,
    ),
  ],
);

export const availabilitySlots = pgTable(
  "availability_slots",
  {
    id: uuid("id").primaryKey(),
    counsellorId: uuid("counsellor_id")
      .notNull()
      .references(() => users.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("availability_counsellor_time")
      .on(table.counsellorId, table.startsAt)
      .where(sql`${table.deletedAt} is null`),
    check("availability_time_check", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => availabilitySlots.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id),
    counsellorId: uuid("counsellor_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    note: varchar("note", { length: 2000 }).notNull().default(""),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("one_active_booking_per_slot")
      .on(table.slotId)
      .where(sql`${table.status} in ('pending', 'confirmed')`),
    index("bookings_client").on(table.clientId, table.createdAt),
    index("bookings_counsellor").on(table.counsellorId, table.createdAt),
    check(
      "bookings_status_check",
      sql`${table.status} in ('pending', 'confirmed', 'cancelled', 'completed')`,
    ),
    check(
      "bookings_participants_check",
      sql`${table.clientId} <> ${table.counsellorId}`,
    ),
  ],
);

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followingId] }),
    index("follows_following").on(table.followingId),
    check(
      "follows_self_check",
      sql`${table.followerId} <> ${table.followingId}`,
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    title: varchar("title", { length: 120 }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    directKey: text("direct_key"),
    createdAt,
  },
  (table) => [
    uniqueIndex("conversations_direct_key_unique").on(table.directKey),
    check(
      "conversations_kind_check",
      sql`${table.kind} in ('direct', 'group')`,
    ),
    check(
      "conversations_direct_key_check",
      sql`(${table.kind} = 'direct' and ${table.directKey} is not null) or (${table.kind} = 'group' and ${table.directKey} is null)`,
    ),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("conversation_members_user").on(table.userId),
    check(
      "conversation_members_role_check",
      sql`${table.role} in ('owner', 'member')`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    body: varchar("body", { length: 4000 }).notNull(),
    attachmentName: text("attachment_name"),
    attachmentUrl: text("attachment_url"),
    attachmentMime: text("attachment_mime"),
    attachmentSize: integer("attachment_size"),
    createdAt,
  },
  (table) => [
    index("messages_history").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    check(
      "messages_content_check",
      sql`length(trim(${table.body})) > 0 or ${table.attachmentUrl} is not null`,
    ),
  ],
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 16 }).notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
    index("message_reactions_message").on(table.messageId),
  ],
);

export const callRooms = pgTable(
  "call_rooms",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    bookingId: uuid("booking_id").references(() => bookings.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    mode: text("mode").notNull().default("video"),
    createdAt,
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("one_active_conversation_call")
      .on(table.conversationId)
      .where(sql`${table.endedAt} is null`),
    uniqueIndex("one_active_booking_call")
      .on(table.bookingId)
      .where(sql`${table.endedAt} is null`),
    check("call_rooms_mode_check", sql`${table.mode} in ('audio', 'video')`),
    check(
      "call_rooms_target_check",
      sql`(${table.conversationId} is not null and ${table.bookingId} is null) or (${table.conversationId} is null and ${table.bookingId} is not null)`,
    ),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 4000 }).notNull().default(""),
    mediaType: text("media_type"),
    mediaUrl: text("media_url"),
    createdAt,
  },
  (table) => [
    index("posts_author_created").on(table.authorId, table.createdAt),
    check(
      "posts_media_type_check",
      sql`${table.mediaType} is null or ${table.mediaType} in ('image', 'video')`,
    ),
  ],
);

export const postLikes = pgTable(
  "post_likes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.postId] })],
);

export const postComments = pgTable(
  "post_comments",
  {
    id: uuid("id").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 4000 }).notNull(),
    createdAt,
  },
  (table) => [
    index("post_comments_post_created").on(table.postId, table.createdAt),
  ],
);

export const postReposts = pgTable(
  "post_reposts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.postId] })],
);

export const postSaves = pgTable(
  "post_saves",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.postId] })],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { mode: "string" }).notNull(),
  },
  (table) => [index("user_sessions_expire").on(table.expire)],
);
