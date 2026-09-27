import Joi from "joi";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";
import {
  assertDirectCallAccess,
  createAcceptedDirectCall,
  getAuthorizedCall,
} from "../routes/calls.js";
import {
  assertConversationMember,
  deliverMessage,
  sendMessage,
} from "../services/chat.js";

const uuid = Joi.string()
  .guid({ version: ["uuidv4"] })
  .required();
const socketId = Joi.string()
  .pattern(/^[A-Za-z0-9_-]{1,128}$/)
  .required();
const callSchema = Joi.object({ callId: uuid }).required();
const messageSchema = Joi.object({
  conversationId: uuid,
  body: Joi.string().trim().min(1).max(4000).required(),
}).required();
const callRequestSchema = Joi.object({
  conversationId: uuid,
  targetUserId: uuid,
  type: Joi.string().valid("audio", "video").required(),
}).required();
const callDecisionSchema = Joi.object({
  requestId: uuid,
}).required();
const descriptionSchema = (type) =>
  Joi.object({
    callId: uuid,
    targetId: socketId,
    sdp: Joi.object({
      type: Joi.string().valid(type).required(),
      sdp: Joi.string()
        .max(64 * 1024)
        .required(),
    }).required(),
  }).required();
const candidateSchema = Joi.object({
  callId: uuid,
  targetId: socketId,
  candidate: Joi.object({
    candidate: Joi.string().max(4096).allow("").required(),
    sdpMid: Joi.string().max(256).allow(null),
    sdpMLineIndex: Joi.number().integer().min(0).max(65535).allow(null),
    usernameFragment: Joi.string().max(256).allow(null),
  })
    .allow(null)
    .required(),
}).required();

function parse(schema, input) {
  const result = schema.validate(input, { abortEarly: true, convert: false });
  if (result.error)
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      result.error.details[0].message,
    );
  for (const key of ["callId", "conversationId", "targetUserId", "requestId"]) {
    if (result.value[key]) result.value[key] = result.value[key].toLowerCase();
  }
  return result.value;
}

async function refreshIdentity(socket, pool) {
  const request = socket.request;
  if (!request.session?.userId)
    throw new AppError(401, "UNAUTHENTICATED", "Please sign in.");
  await new Promise((resolve, reject) =>
    request.session.reload((error) =>
      error
        ? reject(
            new AppError(401, "SESSION_EXPIRED", "Your session has expired."),
          )
        : resolve(),
    ),
  );
  const session = request.session;
  if (
    !session?.userId ||
    (session.cookie.expires &&
      new Date(session.cookie.expires).getTime() <= Date.now())
  ) {
    throw new AppError(401, "SESSION_EXPIRED", "Your session has expired.");
  }
  const {
    rows: [user],
  } = await pool.query("SELECT id, full_name FROM users WHERE id = $1", [
    session.userId,
  ]);
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Please sign in.");
  if (socket.data.userId && socket.data.userId !== user.id)
    throw new AppError(
      401,
      "SESSION_CHANGED",
      "Please reconnect after signing in.",
    );
  socket.data.userId = user.id;
  socket.data.fullName = user.full_name;
  return user;
}

function peerInfo(socket) {
  return {
    socketId: socket.id,
    userId: socket.data.userId,
    fullName: socket.data.fullName,
  };
}

function publicError(error) {
  return {
    code: error.status && error.status < 500 ? error.code : "INTERNAL_ERROR",
    message:
      error.status && error.status < 500
        ? error.message
        : "Something went wrong. Please try again.",
  };
}

/** Session-authenticated chat and WebRTC signaling. Media travels between browsers. */
export function attachRealtime(io, { pool, sessionMiddleware, config }) {
  io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    try {
      await refreshIdentity(socket, pool);
      const received = socket.handshake.auth?.csrfToken;
      const expected = socket.request.session.csrfToken;
      if (
        typeof received !== "string" ||
        typeof expected !== "string" ||
        Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
      ) {
        throw new AppError(
          403,
          "CSRF_INVALID",
          "Reconnect using the current session CSRF token.",
        );
      }
      next();
    } catch (error) {
      const failure = new Error(publicError(error).message);
      failure.data = publicError(error);
      next(failure);
    }
  });

  // Serialize invitations and membership changes across every socket in this
  // process, including different rooms used by the same user in separate tabs.
  let callLock = Promise.resolve();
  async function withCallLock(work) {
    const previous = callLock;
    let release;
    callLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  const pendingCalls = new Map();
  const pendingByUser = new Map();
  const invitationTimeoutMs = config.callInvitationTimeoutMs ?? 10 * 60 * 1000;

  function userSockets(userId) {
    return [...(io.sockets.adapter.rooms.get(`user:${userId}`) || [])]
      .map((id) => io.sockets.sockets.get(id))
      .filter((socket) => socket?.connected);
  }

  function isInCall(userId) {
    return userSockets(userId).some(
      (socket) => socket.data.callId || socket.data.acceptedCallId,
    );
  }

  function notifyInvitation(name, invitation, extra = {}) {
    const payload = { ...invitation, ...extra };
    io.to([
      `user:${invitation.fromUserId}`,
      `user:${invitation.targetUserId}`,
    ]).emit(name, payload);
    return payload;
  }

  function removeInvitation(invitation) {
    const pending = pendingCalls.get(invitation.requestId);
    clearTimeout(pending?.timer);
    pendingCalls.delete(invitation.requestId);
    for (const userId of [invitation.fromUserId, invitation.targetUserId]) {
      if (pendingByUser.get(userId) === invitation.requestId)
        pendingByUser.delete(userId);
    }
  }

  function finishInvitation(name, invitation, reason) {
    removeInvitation(invitation);
    return notifyInvitation(name, invitation, { reason });
  }

  function pendingInvitation(requestId, userId, role) {
    const invitation = pendingCalls.get(requestId)?.invitation;
    if (!invitation || invitation[role] !== userId) {
      throw new AppError(
        404,
        "CALL_REQUEST_NOT_FOUND",
        "This call request is no longer available.",
      );
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      finishInvitation("call:expired", invitation, "no_answer");
      throw new AppError(
        409,
        "CALL_REQUEST_EXPIRED",
        "This call request has expired.",
      );
    }
    return invitation;
  }

  async function leaveCall(socket) {
    socket.data.acceptedCallId = null;
    const callId = socket.data.callId;
    if (!callId) return;
    socket.data.callId = null;
    await socket.leave(`call:${callId}`);
    io.to(`call:${callId}`).emit("call:peer-left", {
      callId,
      ...peerInfo(socket),
    });
  }

  async function assertActiveParticipant(socket, callId) {
    try {
      await refreshIdentity(socket, pool);
    } catch (error) {
      if (error.status === 401) socket.disconnect(true);
      throw error;
    }
    if (
      !socket.connected ||
      socket.data.callId !== callId ||
      !socket.rooms.has(`call:${callId}`)
    ) {
      throw new AppError(
        403,
        "CALL_MEMBERSHIP_REQUIRED",
        "Join this call before sending signaling messages.",
      );
    }
    try {
      return await getAuthorizedCall(pool, callId, socket.data.userId);
    } catch (error) {
      if (error.status && error.status < 500) {
        await leaveCall(socket);
        socket.emit("call:ended", { callId, reason: error.code });
      }
      throw error;
    }
  }

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.join(`session:${socket.request.sessionID}`);
    let chain = Promise.resolve();
    let queued = 0;
    let rateWindow = Date.now();
    let rateCount = 0;
    let sessionTimer;

    // Expire idle sockets too; HTTP logout can disconnect the session room immediately.
    function scheduleSessionCheck() {
      clearTimeout(sessionTimer);
      if (!socket.connected) return;
      const expires = socket.request.session?.cookie.expires;
      const remaining = expires
        ? new Date(expires).getTime() - Date.now()
        : 60_000;
      sessionTimer = setTimeout(
        async () => {
          try {
            await refreshIdentity(socket, pool);
            if (socket.data.callId)
              await assertActiveParticipant(socket, socket.data.callId);
          } catch (error) {
            if (error.status === 401) socket.disconnect(true);
            else if (!error.status || error.status >= 500)
              socket.emit("app:error", publicError(error));
          } finally {
            scheduleSessionCheck();
          }
        },
        Math.max(1, Math.min(60_000, remaining)),
      );
      sessionTimer.unref?.();
    }
    scheduleSessionCheck();

    function event(name, schema, handler) {
      socket.on(name, (payload, acknowledgement) => {
        const ack =
          typeof acknowledgement === "function" ? acknowledgement : null;
        const fail = (error) => {
          const response = publicError(error);
          if (ack) ack({ ok: false, error: response });
          else socket.emit("app:error", response);
          if (error.status === 401) socket.disconnect(true);
          if (!error.status || error.status >= 500)
            console.error(`Socket event ${name} failed:`, {
              name: error.name,
              code: error.code,
            });
        };
        let input;
        try {
          if (Date.now() - rateWindow >= 10_000) {
            rateWindow = Date.now();
            rateCount = 0;
          }
          rateCount += 1;
          if (rateCount > 120 || queued >= 64)
            throw new AppError(
              429,
              "RATE_LIMITED",
              "Too many realtime requests. Please slow down.",
            );
          input = parse(schema, payload);
        } catch (error) {
          fail(error);
          return;
        }
        queued += 1;
        chain = chain
          .then(async () => {
            if (!socket.connected) return;
            await refreshIdentity(socket, pool);
            const data = await handler(input);
            if (ack) ack({ ok: true, data: data ?? null });
          })
          .catch(fail)
          .finally(() => {
            queued -= 1;
          });
      });
    }

    event("message:send", messageSchema, async (input) => {
      const message = await sendMessage(pool, {
        ...input,
        senderId: socket.data.userId,
      });
      await deliverMessage(io, pool, message);
      return message;
    });

    event("call:request", callRequestSchema, (input) =>
      withCallLock(async () => {
        const fromUserId = socket.data.userId;
        const target = await assertDirectCallAccess(
          pool,
          input.conversationId,
          fromUserId,
          input.targetUserId,
        );
        if (!socket.connected)
          throw new AppError(
            409,
            "SOCKET_DISCONNECTED",
            "Reconnect before calling.",
          );
        if (pendingByUser.has(fromUserId) || isInCall(fromUserId)) {
          throw new AppError(
            409,
            "ALREADY_IN_CALL",
            "Finish your current call before starting another.",
          );
        }
        if (!userSockets(input.targetUserId).length) {
          throw new AppError(
            409,
            "USER_OFFLINE",
            "This person is currently offline.",
          );
        }
        if (
          pendingByUser.has(input.targetUserId) ||
          isInCall(input.targetUserId)
        ) {
          throw new AppError(
            409,
            "USER_BUSY",
            "This person is already on another call.",
          );
        }
        const invitation = {
          requestId: randomUUID(),
          ...input,
          fromUserId,
          fromUserName: socket.data.fullName,
          targetUserName: target.full_name,
          callerSocketId: socket.id,
          expiresAt: new Date(Date.now() + invitationTimeoutMs).toISOString(),
        };
        const timer = setTimeout(() => {
          void withCallLock(async () => {
            if (pendingCalls.has(invitation.requestId))
              finishInvitation("call:expired", invitation, "no_answer");
          });
        }, invitationTimeoutMs);
        timer.unref?.();
        pendingCalls.set(invitation.requestId, { invitation, timer });
        pendingByUser.set(fromUserId, invitation.requestId);
        pendingByUser.set(input.targetUserId, invitation.requestId);
        io.to(`user:${input.targetUserId}`).emit("call:request", invitation);
        return invitation;
      }),
    );

    event("call:accepted", callDecisionSchema, ({ requestId }) =>
      withCallLock(async () => {
        const invitation = pendingInvitation(
          requestId,
          socket.data.userId,
          "targetUserId",
        );
        const caller = io.sockets.sockets.get(invitation.callerSocketId);
        if (!socket.connected || !caller?.connected) {
          finishInvitation("call:cancelled", invitation, "disconnected");
          throw new AppError(
            409,
            "CALLER_UNAVAILABLE",
            "The caller is no longer available.",
          );
        }
        if (
          isInCall(invitation.fromUserId) ||
          isInCall(invitation.targetUserId)
        ) {
          finishInvitation("call:rejected", invitation, "busy");
          throw new AppError(
            409,
            "USER_BUSY",
            "A participant is already on another call.",
          );
        }
        // Recheck the caller's session and both persisted conversation members;
        // knowing a request ID never grants permission to accept it.
        try {
          await refreshIdentity(caller, pool);
        } catch (error) {
          if (error.status !== 401) throw error;
          finishInvitation("call:cancelled", invitation, "disconnected");
          caller.disconnect(true);
          throw new AppError(
            409,
            "CALLER_UNAVAILABLE",
            "The caller is no longer available.",
          );
        }
        let call;
        try {
          call = await createAcceptedDirectCall(pool, invitation);
        } catch (error) {
          if (error.status && error.status < 500)
            finishInvitation("call:cancelled", invitation, "unavailable");
          throw error;
        }
        if (!socket.connected || !caller.connected) {
          await pool.query(
            "UPDATE call_rooms SET ended_at = COALESCE(ended_at, NOW()) WHERE id = $1",
            [call.id],
          );
          finishInvitation("call:cancelled", invitation, "disconnected");
          throw new AppError(
            409,
            "CALLER_UNAVAILABLE",
            "A participant disconnected before the call could start.",
          );
        }
        caller.data.acceptedCallId = call.id;
        socket.data.acceptedCallId = call.id;
        try {
          await getAuthorizedCall(pool, call.id, invitation.fromUserId);
          if (
            !caller.connected ||
            !socket.connected ||
            caller.data.acceptedCallId !== call.id ||
            socket.data.acceptedCallId !== call.id
          ) {
            throw new AppError(409, "CALL_ENDED", "This call has ended.");
          }
        } catch (error) {
          if (caller.data.acceptedCallId === call.id)
            caller.data.acceptedCallId = null;
          if (socket.data.acceptedCallId === call.id)
            socket.data.acceptedCallId = null;
          finishInvitation("call:cancelled", invitation, "unavailable");
          throw error;
        }
        removeInvitation(invitation);
        return notifyInvitation("call:accepted", invitation, {
          callId: call.id,
          acceptedBySocketId: socket.id,
        });
      }),
    );

    event("call:rejected", callDecisionSchema, ({ requestId }) =>
      withCallLock(async () =>
        finishInvitation(
          "call:rejected",
          pendingInvitation(requestId, socket.data.userId, "targetUserId"),
          "declined",
        ),
      ),
    );

    event("call:cancelled", callDecisionSchema, ({ requestId }) =>
      withCallLock(async () =>
        finishInvitation(
          "call:cancelled",
          pendingInvitation(requestId, socket.data.userId, "fromUserId"),
          "cancelled",
        ),
      ),
    );

    event("call:sync", Joi.object({}).required(), () =>
      withCallLock(async () => {
        const requestId = pendingByUser.get(socket.data.userId);
        let invitation = pendingCalls.get(requestId)?.invitation;
        if (invitation && Date.parse(invitation.expiresAt) <= Date.now()) {
          finishInvitation("call:expired", invitation, "no_answer");
          invitation = null;
        }
        return {
          incoming:
            invitation?.targetUserId === socket.data.userId ? invitation : null,
          outgoing:
            invitation?.fromUserId === socket.data.userId ? invitation : null,
        };
      }),
    );

    event(
      "typing",
      Joi.object({
        conversationId: uuid,
        isTyping: Joi.boolean().required(),
      }).required(),
      async ({ conversationId, isTyping }) => {
        await assertConversationMember(
          pool,
          conversationId,
          socket.data.userId,
        );
        const { rows } = await pool.query(
          "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2",
          [conversationId, socket.data.userId],
        );
        if (rows.length)
          io.to(rows.map((row) => `user:${row.user_id}`)).emit("typing", {
            conversationId,
            userId: socket.data.userId,
            isTyping,
          });
      },
    );

    event("call:join", callSchema, ({ callId }) =>
      withCallLock(async () => {
        if (socket.data.callId && socket.data.callId !== callId)
          throw new AppError(
            409,
            "ALREADY_IN_CALL",
            "Leave your current call before joining another.",
          );
        if (
          pendingByUser.has(socket.data.userId) ||
          (socket.data.acceptedCallId &&
            socket.data.acceptedCallId !== callId) ||
          userSockets(socket.data.userId).some(
            (other) =>
              other.id !== socket.id &&
              (other.data.callId || other.data.acceptedCallId),
          )
        ) {
          throw new AppError(
            409,
            "ALREADY_IN_CALL",
            "Finish your current call before joining another.",
          );
        }
        const call = await getAuthorizedCall(pool, callId, socket.data.userId);
        const room = `call:${callId}`;
        const members = [...(io.sockets.adapter.rooms.get(room) || [])]
          .map((id) => io.sockets.sockets.get(id))
          .filter((member) => member && member.id !== socket.id);
        const peers = [];
        for (const member of members) {
          try {
            await assertActiveParticipant(member, callId);
            peers.push(member);
          } catch (error) {
            if (!error.status || error.status >= 500) throw error;
          }
        }
        if (peers.some((member) => member.data.userId === socket.data.userId))
          throw new AppError(
            409,
            "ALREADY_IN_CALL",
            "You have already joined this call in another tab or device.",
          );
        if (peers.length >= config.maxCallParticipants)
          throw new AppError(
            409,
            "CALL_FULL",
            "This call has reached its participant limit.",
          );
        // Recheck after awaited peer/session checks so an ended call cannot be rejoined.
        await getAuthorizedCall(pool, callId, socket.data.userId);
        if (!socket.connected)
          throw new AppError(
            409,
            "SOCKET_DISCONNECTED",
            "Reconnect before joining the call.",
          );
        const alreadyJoined = socket.rooms.has(room);
        socket.data.callId = callId;
        await socket.join(room);
        try {
          await getAuthorizedCall(pool, callId, socket.data.userId);
        } catch (error) {
          await leaveCall(socket);
          throw error;
        }
        if (
          !socket.connected ||
          socket.data.callId !== callId ||
          !socket.rooms.has(room)
        ) {
          throw new AppError(
            409,
            "CALL_JOIN_CANCELLED",
            "The call ended or the connection closed while joining.",
          );
        }
        if (!alreadyJoined)
          socket
            .to(room)
            .emit("call:peer-joined", { callId, ...peerInfo(socket) });
        return { callId, mode: call.mode, peers: peers.map(peerInfo) };
      }),
    );

    event("call:leave", callSchema, ({ callId }) =>
      withCallLock(async () => {
        if (
          socket.data.callId === callId ||
          socket.data.acceptedCallId === callId
        )
          await leaveCall(socket);
        return { callId };
      }),
    );

    async function relay(name, input) {
      await assertActiveParticipant(socket, input.callId);
      const target = io.sockets.sockets.get(input.targetId);
      if (!target || target.id === socket.id)
        throw new AppError(
          404,
          "PEER_NOT_FOUND",
          "The other participant is unavailable.",
        );
      try {
        await assertActiveParticipant(target, input.callId);
      } catch (error) {
        if (!error.status || error.status >= 500) throw error;
        throw new AppError(
          404,
          "PEER_NOT_FOUND",
          "The other participant is no longer available in this call.",
        );
      }
      // Neither socket may leave/end its call while the membership queries run.
      const room = `call:${input.callId}`;
      if (
        !socket.rooms.has(room) ||
        !target.rooms.has(room) ||
        socket.data.callId !== input.callId ||
        target.data.callId !== input.callId
      ) {
        throw new AppError(
          409,
          "CALL_MEMBERSHIP_REQUIRED",
          "The call is no longer active for both participants.",
        );
      }
      const { targetId, ...signal } = input;
      target.emit(name, { ...signal, fromId: socket.id });
    }
    event("webrtc:offer", descriptionSchema("offer"), (input) =>
      relay("webrtc:offer", input),
    );
    event("webrtc:answer", descriptionSchema("answer"), (input) =>
      relay("webrtc:answer", input),
    );
    event("webrtc:ice-candidate", candidateSchema, (input) =>
      relay("webrtc:ice-candidate", input),
    );

    socket.on("disconnect", () => {
      clearTimeout(sessionTimer);
      // Socket.IO already removed the room; the stored call ID lets remaining peers clean up.
      void withCallLock(async () => {
        const invitation = pendingCalls.get(
          pendingByUser.get(socket.data.userId),
        )?.invitation;
        if (
          invitation &&
          (invitation.callerSocketId === socket.id ||
            (invitation.targetUserId === socket.data.userId &&
              !userSockets(socket.data.userId).length))
        ) {
          finishInvitation("call:cancelled", invitation, "disconnected");
        }
        await leaveCall(socket);
      }).catch((error) =>
        console.error("Call disconnect cleanup failed:", {
          name: error.name,
          code: error.code,
        }),
      );
    });
  });
}
