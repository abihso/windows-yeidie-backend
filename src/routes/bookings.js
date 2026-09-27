import { randomUUID } from "node:crypto";
import { Router } from "express";
import Joi from "joi";
import { AppError } from "../lib/errors.js";
import { pagination, uuid, validate } from "../lib/validation.js";
import { transaction } from "../db/transaction.js";
import { closeCallRoom } from "./calls.js";

const activeStatuses = ["pending", "confirmed"];
const timestamp = Joi.string()
  .isoDate()
  .strict()
  .pattern(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i,
  )
  .custom((value, helpers) => {
    const calendarDate = value.slice(0, 10);
    const parsed = new Date(`${calendarDate}T00:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== calendarDate
    ) {
      return helpers.error("string.isoDate");
    }
    return value;
  })
  .required();
const availabilitySchema = Joi.object({
  startsAt: timestamp,
  endsAt: timestamp,
}).required();
const bookingSchema = Joi.object({
  slotId: Joi.string()
    .guid({ version: ["uuidv4"] })
    .required(),
  note: Joi.string().trim().max(2000).allow("").default(""),
}).required();
const statusSchema = Joi.object({
  status: Joi.string().valid("confirmed", "cancelled", "completed").required(),
}).required();
const searchSchema = Joi.object({
  search: Joi.string().trim().max(100).allow("").default(""),
});

const slotFields = `id, counsellor_id AS "counsellorId",
  starts_at AS "startsAt", ends_at AS "endsAt", created_at AS "createdAt"`;
const bookingFields = `b.id, b.slot_id AS "slotId", b.client_id AS "clientId",
  b.counsellor_id AS "counsellorId", b.status, b.note,
  b.created_at AS "createdAt", b.updated_at AS "updatedAt",
  s.starts_at AS "startsAt", s.ends_at AS "endsAt",
  client.full_name AS "clientName", counsellor.full_name AS "counsellorName"`;
const bookingJoins = `JOIN availability_slots s ON s.id = b.slot_id
  JOIN users client ON client.id = b.client_id
  JOIN users counsellor ON counsellor.id = b.counsellor_id`;

function requireUser(req, _res, next) {
  if (!req.user?.id) {
    return next(new AppError(401, "UNAUTHENTICATED", "Please sign in."));
  }
  next();
}

function requireRole(req, role) {
  if (req.user.role !== role) {
    throw new AppError(
      403,
      "FORBIDDEN",
      `This action requires a ${role} account.`,
    );
  }
}

function validateTimes(startsAt, endsAt) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= Date.now()) {
    throw new AppError(
      400,
      "INVALID_AVAILABILITY",
      "Availability must start in the future.",
    );
  }
  const duration = end - start;
  if (duration < 15 * 60_000 || duration > 180 * 60_000) {
    throw new AppError(
      400,
      "INVALID_AVAILABILITY",
      "Slots must last between 15 and 180 minutes.",
    );
  }
}

// Every schedule mutation takes user locks first, in a shared order. This also
// serializes different slots being booked concurrently by the same client.
async function lockUsers(client, userIds) {
  await client.query(
    "SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
    [[...new Set(userIds)].sort()],
  );
}

async function readBooking(client, id) {
  const result = await client.query(
    `SELECT ${bookingFields} FROM bookings b ${bookingJoins} WHERE b.id = $1`,
    [id],
  );
  return result.rows[0];
}

export function counsellorRoutes({ pool }) {
  const router = Router();
  router.use(requireUser);

  router.get("/", async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const { search } = validate(searchSchema, { search: req.query.search });
    // Escape LIKE metacharacters so ordinary search text is matched literally.
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const result = await pool.query(
      `SELECT id, full_name AS "fullName", bio, specialties
       FROM users
       WHERE role = 'counsellor'
         AND ($1 = '' OR full_name ILIKE $2 OR EXISTS (
           SELECT 1 FROM unnest(specialties) specialty WHERE specialty ILIKE $2
         ))
       ORDER BY full_name, id LIMIT $3 OFFSET $4`,
      [search, pattern, limit, offset],
    );
    res.json({ counsellors: result.rows, limit, offset });
  });

  router.post("/availability", async (req, res) => {
    requireRole(req, "counsellor");
    const { startsAt, endsAt } = validate(availabilitySchema, req.body);
    validateTimes(startsAt, endsAt);
    const slot = await transaction(pool, async (client) => {
      await lockUsers(client, [req.user.id]);
      validateTimes(startsAt, endsAt);
      const overlap = await client.query(
        `SELECT id FROM availability_slots
         WHERE counsellor_id = $1 AND deleted_at IS NULL
           AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
         LIMIT 1`,
        [req.user.id, startsAt, endsAt],
      );
      if (overlap.rows.length) {
        throw new AppError(
          409,
          "AVAILABILITY_OVERLAP",
          "This slot overlaps your existing availability.",
        );
      }
      const result = await client.query(
        `INSERT INTO availability_slots (id, counsellor_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4) RETURNING ${slotFields}`,
        [randomUUID(), req.user.id, startsAt, endsAt],
      );
      return result.rows[0];
    });
    res.status(201).json({ slot });
  });

  router.delete("/availability/:slotId", async (req, res) => {
    requireRole(req, "counsellor");
    const slotId = uuid(req.params.slotId);
    await transaction(pool, async (client) => {
      await lockUsers(client, [req.user.id]);
      const slot = await client.query(
        `SELECT id FROM availability_slots
         WHERE id = $1 AND counsellor_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [slotId, req.user.id],
      );
      if (!slot.rows.length) {
        throw new AppError(
          404,
          "SLOT_NOT_FOUND",
          "Availability slot not found.",
        );
      }
      const booked = await client.query(
        "SELECT id FROM bookings WHERE slot_id = $1 AND status = ANY($2::text[]) LIMIT 1",
        [slotId, activeStatuses],
      );
      if (booked.rows.length) {
        throw new AppError(
          409,
          "SLOT_BOOKED",
          "Cancel the active booking before removing this slot.",
        );
      }
      await client.query(
        "UPDATE availability_slots SET deleted_at = NOW() WHERE id = $1",
        [slotId],
      );
    });
    res.status(204).end();
  });

  router.get("/:id/availability", async (req, res) => {
    const counsellorId = uuid(req.params.id);
    const { limit, offset } = pagination(req.query);
    const counsellor = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'counsellor'",
      [counsellorId],
    );
    if (!counsellor.rows.length) {
      throw new AppError(404, "COUNSELLOR_NOT_FOUND", "Counsellor not found.");
    }
    const result = await pool.query(
      `SELECT ${slotFields} FROM availability_slots s
       WHERE counsellor_id = $1 AND deleted_at IS NULL AND starts_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = ANY($2::text[])
         )
       ORDER BY starts_at, id LIMIT $3 OFFSET $4`,
      [counsellorId, activeStatuses, limit, offset],
    );
    res.json({ slots: result.rows, limit, offset });
  });

  return router;
}

export function bookingRoutes({ pool, io }) {
  const router = Router();
  router.use(requireUser);

  router.get("/", async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const result = await pool.query(
      `SELECT ${bookingFields} FROM bookings b ${bookingJoins}
       WHERE b.client_id = $1 OR b.counsellor_id = $1
       ORDER BY s.starts_at DESC, b.id LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );
    res.json({ bookings: result.rows, limit, offset });
  });

  router.post("/", async (req, res) => {
    requireRole(req, "client");
    const { slotId, note } = validate(bookingSchema, req.body);
    let booking;
    try {
      booking = await transaction(pool, async (client) => {
        // Read the owner to determine the lock order, then re-read the slot
        // under those locks before making any scheduling decision.
        const owner = await client.query(
          "SELECT counsellor_id FROM availability_slots WHERE id = $1 AND deleted_at IS NULL",
          [slotId],
        );
        if (!owner.rows.length) {
          throw new AppError(
            404,
            "SLOT_NOT_FOUND",
            "Availability slot not found.",
          );
        }
        const counsellorId = owner.rows[0].counsellor_id;
        await lockUsers(client, [req.user.id, counsellorId]);
        const result = await client.query(
          `SELECT ${slotFields} FROM availability_slots
           WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [slotId],
        );
        const slot = result.rows[0];
        if (!slot) {
          throw new AppError(
            404,
            "SLOT_NOT_FOUND",
            "Availability slot not found.",
          );
        }
        if (new Date(slot.startsAt).getTime() <= Date.now()) {
          throw new AppError(
            409,
            "SLOT_IN_PAST",
            "This slot is no longer available.",
          );
        }
        if (counsellorId === req.user.id) {
          throw new AppError(
            400,
            "SELF_BOOKING",
            "You cannot book an appointment with yourself.",
          );
        }
        const overlap = await client.query(
          `SELECT b.id FROM bookings b
           JOIN availability_slots s ON s.id = b.slot_id
           WHERE b.status = ANY($1::text[])
             AND (b.client_id = ANY($2::uuid[]) OR b.counsellor_id = ANY($2::uuid[]))
             AND s.starts_at < $4::timestamptz AND s.ends_at > $3::timestamptz
           LIMIT 1`,
          [
            activeStatuses,
            [req.user.id, counsellorId],
            slot.startsAt,
            slot.endsAt,
          ],
        );
        if (overlap.rows.length) {
          throw new AppError(
            409,
            "BOOKING_CONFLICT",
            "A participant already has an appointment at this time.",
          );
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO bookings (id, slot_id, client_id, counsellor_id, status, note)
           VALUES ($1, $2, $3, $4, 'pending', $5)`,
          [id, slotId, req.user.id, counsellorId, note],
        );
        return readBooking(client, id);
      });
    } catch (error) {
      if (error.code === "23505") {
        throw new AppError(
          409,
          "BOOKING_CONFLICT",
          "This slot has already been booked.",
        );
      }
      throw error;
    }
    res.status(201).json({ booking });
  });

  router.patch("/:id/status", async (req, res) => {
    const id = uuid(req.params.id);
    const { status } = validate(statusSchema, req.body);
    const result = await transaction(pool, async (client) => {
      const participant = await client.query(
        `SELECT client_id, counsellor_id FROM bookings
         WHERE id = $1 AND (client_id = $2 OR counsellor_id = $2)`,
        [id, req.user.id],
      );
      if (!participant.rows.length) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found.");
      }
      const { client_id: clientId, counsellor_id: counsellorId } =
        participant.rows[0];
      await lockUsers(client, [clientId, counsellorId]);
      const current = await client.query(
        `SELECT b.status, s.ends_at FROM bookings b
         JOIN availability_slots s ON s.id = b.slot_id WHERE b.id = $1 FOR UPDATE OF b`,
        [id],
      );
      const booking = current.rows[0];
      if (!booking) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found.");
      }
      const canManageBooking =
        req.user.role === "admin" ||
        (req.user.role === "counsellor" && req.user.id === counsellorId);
      const canCancelBooking =
        canManageBooking ||
        (req.user.role === "client" && req.user.id === clientId);

      if (status !== "cancelled" && !canManageBooking) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only the assigned counsellor, the client, or an admin can update this booking.",
        );
      }

      if (status === "cancelled" && !canCancelBooking) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only the client, counsellor, or admin can cancel this booking.",
        );
      }
      const validTransition =
        (status === "confirmed" && booking.status === "pending") ||
        (status === "cancelled" && activeStatuses.includes(booking.status)) ||
        (status === "completed" && booking.status === "confirmed");
      if (!validTransition) {
        throw new AppError(
          409,
          "INVALID_BOOKING_STATUS",
          "This booking cannot move to the requested status.",
        );
      }
      if (
        status === "completed" &&
        new Date(booking.ends_at).getTime() > Date.now()
      ) {
        throw new AppError(
          409,
          "SESSION_NOT_FINISHED",
          "The scheduled session must end before it can be completed.",
        );
      }
      await client.query(
        "UPDATE bookings SET status = $2, updated_at = NOW() WHERE id = $1",
        [id, status],
      );
      let endedRooms = [];
      if (status === "cancelled" || status === "completed") {
        const ended = await client.query(
          "UPDATE call_rooms SET ended_at = NOW() WHERE booking_id = $1 AND ended_at IS NULL RETURNING id",
          [id],
        );
        endedRooms = ended.rows;
      }
      return { booking: await readBooking(client, id), endedRooms };
    });

    if (io) {
      for (const { id: roomId } of result.endedRooms) {
        await closeCallRoom(io, roomId, `booking_${status}`);
      }
    }
    res.json({ booking: result.booking });
  });

  return router;
}
