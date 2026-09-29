import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createFixture, emit, event } from "./helpers.js";

function times(minutesAhead = 60, duration = 30) {
  const start = Date.now() + minutesAhead * 60_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + duration * 60_000).toISOString(),
  };
}

async function availability(counsellor, when = times()) {
  const response = await counsellor
    .request("post", "/api/counsellors/availability", when)
    .expect(201);
  return response.body.slot;
}

async function book(client, slotId, note = "") {
  const response = await client
    .request("post", "/api/bookings", { slotId, note })
    .expect(201);
  return response.body.booking;
}

test("booking lifecycle keeps participant history private and enforces completion time", async (t) => {
  const { account, app, pool } = await createFixture(t);
  const counsellor = await account("counsellor", "Ama Counsellor");
  const client = await account("client", "Kofi Client");
  const stranger = await account();
  await request(app).get("/api/bookings").expect(401);

  const slot = await availability(counsellor);
  const booking = await book(client, slot.id, "  Career guidance  ");
  assert.equal(booking.status, "pending");
  assert.equal(booking.note, "Career guidance");
  assert.equal(booking.clientName, "Kofi Client");
  assert.equal(booking.counsellorName, "Ama Counsellor");
  assert.equal(booking.startsAt, slot.startsAt);

  const strangerHistory = await stranger
    .request("get", "/api/bookings")
    .expect(200);
  assert.deepEqual(strangerHistory.body.bookings, []);
  await stranger
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "cancelled",
    })
    .expect(404);
  await client
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "confirmed",
    })
    .expect(403);
  await counsellor
    .request("post", "/api/bookings", { slotId: slot.id })
    .expect(403);

  const confirmed = await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "confirmed",
    })
    .expect(200);
  assert.equal(confirmed.body.booking.status, "confirmed");
  const early = await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "completed",
    })
    .expect(409);
  assert.equal(early.body.error.code, "SESSION_NOT_FINISHED");
  await client
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "completed",
    })
    .expect(403);
  await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "pending",
    })
    .expect(400);

  // Move the fixture session into the past without making the suite wait.
  await pool.query(
    "UPDATE availability_slots SET starts_at = NOW() - INTERVAL '1 hour', ends_at = NOW() - INTERVAL '30 minutes' WHERE id = $1",
    [slot.id],
  );
  const completed = await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "completed",
    })
    .expect(200);
  assert.equal(completed.body.booking.status, "completed");
  await client
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "cancelled",
    })
    .expect(409);
  await counsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(204);

  for (const participant of [client, counsellor]) {
    const history = await participant
      .request("get", "/api/bookings")
      .expect(200);
    assert.equal(history.body.bookings.length, 1);
    assert.equal(history.body.bookings[0].id, booking.id);
    assert.equal(history.body.bookings[0].status, "completed");
  }
});

test("availability and appointment changes reach connected participants in real time", async (t) => {
  const { account } = await createFixture(t);
  const counsellor = await account("counsellor", "Ama Counsellor");
  const client = await account("client", "Kofi Client");
  const counsellorSocket = await counsellor.socket();
  const clientSocket = await client.socket();

  const slotCreatedForClient = event(clientSocket, "availability:created");
  const slotCreatedForCounsellor = event(
    counsellorSocket,
    "availability:created",
  );
  const slot = await availability(counsellor);
  assert.deepEqual(await slotCreatedForClient, slot);
  assert.deepEqual(await slotCreatedForCounsellor, slot);

  const bookingCreatedForClient = event(clientSocket, "booking:created");
  const bookingCreatedForCounsellor = event(
    counsellorSocket,
    "booking:created",
  );
  const availabilityChangedForClient = event(
    clientSocket,
    "availability:changed",
  );
  const booking = await book(client, slot.id, "Live appointment request");
  assert.deepEqual(await bookingCreatedForClient, booking);
  assert.deepEqual(await bookingCreatedForCounsellor, booking);
  assert.deepEqual(await availabilityChangedForClient, {
    counsellorId: counsellor.id,
    slotId: slot.id,
  });

  const confirmationForClient = event(clientSocket, "booking:updated");
  const confirmationForCounsellor = event(counsellorSocket, "booking:updated");
  const confirmed = await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "confirmed",
    })
    .expect(200);
  assert.deepEqual(await confirmationForClient, confirmed.body.booking);
  assert.deepEqual(await confirmationForCounsellor, confirmed.body.booking);

  const cancellationForClient = event(clientSocket, "booking:updated");
  const cancellationForCounsellor = event(counsellorSocket, "booking:updated");
  const cancelled = await client
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "cancelled",
    })
    .expect(200);
  assert.deepEqual(await cancellationForClient, cancelled.body.booking);
  assert.deepEqual(await cancellationForCounsellor, cancelled.body.booking);

  const slotDeletedForClient = event(clientSocket, "availability:deleted");
  await counsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(204);
  assert.deepEqual(await slotDeletedForClient, {
    slotId: slot.id,
    counsellorId: counsellor.id,
  });
});

test("availability validates dates, ownership and overlaps, and discovery exposes only public profiles", async (t) => {
  const { account, pool } = await createFixture(t);
  const counsellor = await account("counsellor", "Akosua Mensah");
  const otherCounsellor = await account("counsellor", "Yaw Boateng");
  const client = await account();
  const valid = times();
  await client
    .request("post", "/api/counsellors/availability", valid)
    .expect(403);
  await counsellor.request("post", "/api/counsellors/availability").expect(400);

  const invalidTimes = [
    times(-60),
    times(60, 14),
    times(60, 181),
    times(60, -30),
    { startsAt: valid.startsAt.slice(0, -1), endsAt: valid.endsAt },
    { startsAt: "2099-02-30T12:00:00Z", endsAt: "2099-02-30T12:30:00Z" },
  ];
  for (const invalid of invalidTimes) {
    await counsellor
      .request("post", "/api/counsellors/availability", invalid)
      .expect(400);
  }

  const slot = await availability(counsellor, valid);
  await counsellor
    .request("post", "/api/counsellors/availability", valid)
    .expect(409);
  const adjacent = await availability(counsellor, {
    startsAt: valid.endsAt,
    endsAt: new Date(
      new Date(valid.endsAt).getTime() + 15 * 60_000,
    ).toISOString(),
  });
  await otherCounsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(404);
  await client
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(403);
  await counsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(204);
  await counsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(404);
  await client
    .request("post", "/api/bookings", { slotId: slot.id })
    .expect(404);
  const listed = await client
    .request("get", `/api/counsellors/${counsellor.id}/availability`)
    .expect(200);
  assert.deepEqual(
    listed.body.slots.map((value) => value.id),
    [adjacent.id],
  );
  await client
    .request("get", `/api/counsellors/${client.id}/availability`)
    .expect(404);
  await client
    .request("get", "/api/counsellors/not-a-uuid/availability")
    .expect(400);

  await pool.query("UPDATE users SET specialties = $2 WHERE id = $1", [
    counsellor.id,
    ["Career guidance"],
  ]);
  for (const search of ["mensah", "career"]) {
    const results = await client
      .request("get", `/api/counsellors?search=${search}`)
      .expect(200);
    assert.deepEqual(
      results.body.counsellors.map((value) => value.id),
      [counsellor.id],
    );
    assert.equal("email" in results.body.counsellors[0], false);
    assert.equal("password_hash" in results.body.counsellors[0], false);
  }
  const literalWildcard = await client
    .request("get", "/api/counsellors?search=%25")
    .expect(200);
  assert.deepEqual(literalWildcard.body.counsellors, []);
  const paginated = await client
    .request("get", "/api/counsellors?limit=1&offset=1")
    .expect(200);
  assert.deepEqual(
    paginated.body.counsellors.map((value) => value.id),
    [otherCounsellor.id],
  );

  await pool.query(
    "UPDATE availability_slots SET starts_at = NOW() - INTERVAL '1 hour', ends_at = NOW() - INTERVAL '30 minutes' WHERE id = $1",
    [adjacent.id],
  );
  const expired = await client
    .request("post", "/api/bookings", { slotId: adjacent.id })
    .expect(409);
  assert.equal(expired.body.error.code, "SLOT_IN_PAST");
  const futureOnly = await client
    .request("get", `/api/counsellors/${counsellor.id}/availability`)
    .expect(200);
  assert.deepEqual(futureOnly.body.slots, []);
});

test("contending requests cannot double-book a slot or client and cancelled slots can be reused", async (t) => {
  const { account, pool } = await createFixture(t);
  const counsellor = await account("counsellor");
  const otherCounsellor = await account("counsellor");
  const clients = [await account(), await account()];
  const when = times(60, 60);
  const slot = await availability(counsellor, when);
  const otherSlot = await availability(otherCounsellor, when);

  const contenders = await Promise.all(
    clients.map((client) =>
      client.request("post", "/api/bookings", { slotId: slot.id }),
    ),
  );
  assert.deepEqual(
    contenders.map((response) => response.status).sort(),
    [201, 409],
  );
  const winnerIndex = contenders.findIndex(
    (response) => response.status === 201,
  );
  const winner = clients[winnerIndex];
  const loser = clients[1 - winnerIndex];
  const booking = contenders[winnerIndex].body.booking;
  await winner
    .request("post", "/api/bookings", { slotId: otherSlot.id })
    .expect(409);
  await counsellor
    .request("delete", `/api/counsellors/availability/${slot.id}`)
    .expect(409);
  const unavailable = await loser
    .request("get", `/api/counsellors/${counsellor.id}/availability`)
    .expect(200);
  assert.deepEqual(unavailable.body.slots, []);

  await winner
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "cancelled",
    })
    .expect(200);
  const reusable = await loser
    .request("get", `/api/counsellors/${counsellor.id}/availability`)
    .expect(200);
  assert.equal(reusable.body.slots[0].id, slot.id);
  const replacement = await book(loser, slot.id);
  assert.notEqual(replacement.id, booking.id);
  assert.equal(replacement.status, "pending");

  // Different counsellors can expose overlapping times. The same client must
  // still win only one request, including with a real multi-connection pool.
  const later = times(180, 60);
  const laterSlots = [
    await availability(counsellor, later),
    await availability(otherCounsellor, later),
  ];
  const overlapping = await Promise.all(
    laterSlots.map((value) =>
      winner.request("post", "/api/bookings", { slotId: value.id }),
    ),
  );
  assert.deepEqual(
    overlapping.map((response) => response.status).sort(),
    [201, 409],
  );
  const saved = await pool.query(
    "SELECT status FROM bookings WHERE slot_id = $1 ORDER BY created_at",
    [slot.id],
  );
  assert.deepEqual(
    saved.rows.map((value) => value.status),
    ["cancelled", "pending"],
  );
});

test("cancelling a confirmed booking ends its call and revokes connected participant access", async (t) => {
  const { account, pool, io } = await createFixture(t);
  const counsellor = await account("counsellor");
  const client = await account();
  const slot = await availability(counsellor, times(5));
  const booking = await book(client, slot.id);
  await counsellor
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "confirmed",
    })
    .expect(200);
  const response = await client
    .request("post", "/api/calls", { bookingId: booking.id })
    .expect(201);
  const callId = response.body.call.id;
  const clientSocket = await client.socket();
  const counsellorSocket = await counsellor.socket();
  for (const socket of [clientSocket, counsellorSocket]) {
    assert.equal((await emit(socket, "call:join", { callId })).ok, true);
  }
  const endedEvents = [
    event(clientSocket, "call:ended"),
    event(counsellorSocket, "call:ended"),
  ];
  await client
    .request("patch", `/api/bookings/${booking.id}/status`, {
      status: "cancelled",
    })
    .expect(200);
  for (const ended of await Promise.all(endedEvents)) {
    assert.deepEqual(ended, { callId, reason: "booking_cancelled" });
  }
  const persisted = await pool.query(
    "SELECT ended_at FROM call_rooms WHERE id = $1",
    [callId],
  );
  assert.ok(persisted.rows[0].ended_at);
  assert.equal(io.sockets.adapter.rooms.has(`call:${callId}`), false);
  for (const socket of [clientSocket, counsellorSocket]) {
    assert.equal(io.sockets.sockets.get(socket.id).data.callId, null);
    assert.equal((await emit(socket, "call:join", { callId })).ok, false);
  }
  const staleSignal = await emit(clientSocket, "webrtc:offer", {
    callId,
    targetId: counsellorSocket.id,
    sdp: { type: "offer", sdp: "v=0\r\n" },
  });
  assert.equal(staleSignal.ok, false);
  await client
    .request("post", "/api/calls", { bookingId: booking.id })
    .expect(409);
});
