import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { createFixture, emit, event } from "./helpers.js";

async function conversation(owner, members, kind = "direct") {
  const response = await owner
    .request("post", "/api/conversations", {
      kind,
      memberIds: members.map(({ id }) => id),
      ...(kind === "group" ? { title: "Community support" } : {}),
    })
    .expect(201);
  return response.body.conversation;
}

async function call(owner, conversationId) {
  const response = await owner
    .request("post", "/api/calls", { conversationId })
    .expect(201);
  return response.body.call;
}

function expectFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

test("realtime requires a session and CSRF token, and logout disconnects every session socket", async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();

  await assert.rejects(
    alice.socket({ extraHeaders: {} }),
    (error) => error.data?.code === "UNAUTHENTICATED",
  );
  await assert.rejects(
    alice.socket({ auth: { csrfToken: "invalid" } }),
    (error) => error.data?.code === "CSRF_INVALID",
  );
  await assert.rejects(
    alice.socket({ auth: {} }),
    (error) => error.data?.code === "CSRF_INVALID",
  );

  const first = await alice.socket();
  const second = await alice.socket();
  const firstDisconnected = event(first, "disconnect");
  const secondDisconnected = event(second, "disconnect");
  await alice.request("post", "/api/auth/logout").expect(204);
  assert.equal(await firstDisconnected, "io server disconnect");
  assert.equal(await secondDisconnected, "io server disconnect");
  assert.equal(first.connected, false);
  assert.equal(second.connected, false);
  await assert.rejects(
    alice.socket(),
    (error) => error.data?.code === "UNAUTHENTICATED",
  );
});

test("chat persists messages, reaches all member devices, and excludes outsiders", async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const outsider = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const aliceSocket = await alice.socket();
  const aliceOtherDevice = await alice.socket();
  const bobSocket = await bob.socket();
  const outsiderSocket = await outsider.socket();
  const leakedMessages = [];
  outsiderSocket.on("message:new", (message) => leakedMessages.push(message));

  const deliveries = [aliceSocket, aliceOtherDevice, bobSocket].map((socket) =>
    event(socket, "message:new"),
  );
  const sent = await emit(aliceSocket, "message:send", {
    conversationId: direct.id,
    body: "Hello from my other device.",
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.data.senderId, alice.id);
  assert.equal(sent.data.conversationId, direct.id);
  assert.equal(sent.data.body, "Hello from my other device.");
  for (const delivery of deliveries)
    assert.deepEqual(await delivery, sent.data);

  const history = await bob
    .request("get", `/api/conversations/${direct.id}/messages`)
    .expect(200);
  assert.deepEqual(history.body.messages, [sent.data]);
  await outsider
    .request("get", `/api/conversations/${direct.id}/messages`)
    .expect(404);
  expectFailure(
    await emit(outsiderSocket, "message:send", {
      conversationId: direct.id,
      body: "Intrusion",
    }),
    "CONVERSATION_NOT_FOUND",
  );
  expectFailure(
    await emit(aliceSocket, "message:send", {
      conversationId: direct.id,
      body: "Forged",
      senderId: bob.id,
    }),
    "VALIDATION_ERROR",
  );

  const typing = event(bobSocket, "typing");
  assert.equal(
    (
      await emit(aliceSocket, "typing", {
        conversationId: direct.id,
        isTyping: true,
      })
    ).ok,
    true,
  );
  assert.deepEqual(await typing, {
    conversationId: direct.id,
    userId: alice.id,
    isTyping: true,
  });
  expectFailure(
    await emit(outsiderSocket, "typing", {
      conversationId: direct.id,
      isTyping: true,
    }),
    "CONVERSATION_NOT_FOUND",
  );
  assert.deepEqual(leakedMessages, []);
  const {
    rows: [count],
  } = await fixture.pool.query(
    "SELECT count(*)::integer AS count FROM messages WHERE conversation_id = $1",
    [direct.id],
  );
  assert.equal(count.count, 1);
});

test("direct calls relay offer, answer and ICE only between joined members and clean up on leave", async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const outsider = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const room = await call(alice, direct.id);
  const aliceAvatarUrl = "/uploads/alice-avatar.png";
  await fixture.pool.query("UPDATE users SET avatar_url = $2 WHERE id = $1", [
    alice.id,
    aliceAvatarUrl,
  ]);
  const aliceSocket = await alice.socket();
  const aliceOtherTab = await alice.socket();
  const bobSocket = await bob.socket();
  const outsiderSocket = await outsider.socket();

  const firstJoin = await emit(aliceSocket, "call:join", { callId: room.id });
  assert.equal(firstJoin.ok, true);
  assert.deepEqual(firstJoin.data.peers, []);
  const joined = event(aliceSocket, "call:peer-joined");
  const secondJoin = await emit(bobSocket, "call:join", { callId: room.id });
  assert.equal(secondJoin.ok, true);
  assert.deepEqual(secondJoin.data.peers, [
    {
      socketId: aliceSocket.id,
      userId: alice.id,
      fullName: alice.fullName,
      avatarUrl: aliceAvatarUrl,
    },
  ]);
  assert.deepEqual(await joined, {
    callId: room.id,
    socketId: bobSocket.id,
    userId: bob.id,
    fullName: bob.fullName,
  });
  expectFailure(
    await emit(aliceOtherTab, "call:join", { callId: room.id }),
    "ALREADY_IN_CALL",
  );
  expectFailure(
    await emit(outsiderSocket, "call:join", { callId: room.id }),
    "CONVERSATION_NOT_FOUND",
  );

  const offer = { type: "offer", sdp: "v=0\r\na=group:BUNDLE 0\r\n" };
  const offered = event(bobSocket, "webrtc:offer");
  assert.equal(
    (
      await emit(aliceSocket, "webrtc:offer", {
        callId: room.id,
        targetId: bobSocket.id,
        sdp: offer,
      })
    ).ok,
    true,
  );
  assert.deepEqual(await offered, {
    callId: room.id,
    fromId: aliceSocket.id,
    sdp: offer,
  });

  const answer = { type: "answer", sdp: "v=0\r\na=group:BUNDLE 0\r\n" };
  const answered = event(aliceSocket, "webrtc:answer");
  assert.equal(
    (
      await emit(bobSocket, "webrtc:answer", {
        callId: room.id,
        targetId: aliceSocket.id,
        sdp: answer,
      })
    ).ok,
    true,
  );
  assert.deepEqual(await answered, {
    callId: room.id,
    fromId: bobSocket.id,
    sdp: answer,
  });

  const candidate = {
    candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54400 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
  };
  const ice = event(bobSocket, "webrtc:ice-candidate");
  assert.equal(
    (
      await emit(aliceSocket, "webrtc:ice-candidate", {
        callId: room.id,
        targetId: bobSocket.id,
        candidate,
      })
    ).ok,
    true,
  );
  assert.deepEqual(await ice, {
    callId: room.id,
    fromId: aliceSocket.id,
    candidate,
  });
  const completedIce = event(aliceSocket, "webrtc:ice-candidate");
  assert.equal(
    (
      await emit(bobSocket, "webrtc:ice-candidate", {
        callId: room.id,
        targetId: aliceSocket.id,
        candidate: null,
      })
    ).ok,
    true,
  );
  assert.equal((await completedIce).candidate, null);

  expectFailure(
    await emit(outsiderSocket, "webrtc:offer", {
      callId: room.id,
      targetId: aliceSocket.id,
      sdp: offer,
    }),
    "CALL_MEMBERSHIP_REQUIRED",
  );
  expectFailure(
    await emit(aliceSocket, "webrtc:answer", {
      callId: room.id,
      targetId: bobSocket.id,
      sdp: offer,
    }),
    "VALIDATION_ERROR",
  );
  const left = event(aliceSocket, "call:peer-left");
  assert.equal(
    (await emit(bobSocket, "call:leave", { callId: room.id })).ok,
    true,
  );
  assert.equal((await left).socketId, bobSocket.id);
  expectFailure(
    await emit(bobSocket, "webrtc:offer", {
      callId: room.id,
      targetId: aliceSocket.id,
      sdp: offer,
    }),
    "CALL_MEMBERSHIP_REQUIRED",
  );
  expectFailure(
    await emit(aliceSocket, "webrtc:offer", {
      callId: room.id,
      targetId: bobSocket.id,
      sdp: offer,
    }),
    "PEER_NOT_FOUND",
  );
  assert.equal(fixture.io.sockets.adapter.rooms.get(`call:${room.id}`).size, 1);
});

test("three-user group calls isolate rooms, remove disconnected peers, and cannot rejoin after ending", async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const carol = await fixture.account();
  const dave = await fixture.account();
  const group = await conversation(alice, [bob, carol], "group");
  const separate = await conversation(alice, [dave]);
  const room = await call(alice, group.id);
  const otherRoom = await call(alice, separate.id);
  const aliceSocket = await alice.socket();
  const bobSocket = await bob.socket();
  const carolSocket = await carol.socket();
  const daveSocket = await dave.socket();

  assert.equal(
    (await emit(aliceSocket, "call:join", { callId: room.id })).ok,
    true,
  );
  assert.equal(
    (await emit(bobSocket, "call:join", { callId: room.id })).data.peers.length,
    1,
  );
  const aliceSeesCarol = event(aliceSocket, "call:peer-joined");
  const bobSeesCarol = event(bobSocket, "call:peer-joined");
  const carolJoin = await emit(carolSocket, "call:join", { callId: room.id });
  assert.equal(carolJoin.ok, true);
  assert.deepEqual(
    new Set(carolJoin.data.peers.map(({ userId }) => userId)),
    new Set([alice.id, bob.id]),
  );
  assert.equal((await aliceSeesCarol).userId, carol.id);
  assert.equal((await bobSeesCarol).userId, carol.id);
  assert.equal(
    (await emit(daveSocket, "call:join", { callId: otherRoom.id })).ok,
    true,
  );
  expectFailure(
    await emit(aliceSocket, "call:join", { callId: otherRoom.id }),
    "ALREADY_IN_CALL",
  );

  const groupOffer = { type: "offer", sdp: "v=0\r\n" };
  const offerForCarol = event(carolSocket, "webrtc:offer");
  assert.equal(
    (
      await emit(bobSocket, "webrtc:offer", {
        callId: room.id,
        targetId: carolSocket.id,
        sdp: groupOffer,
      })
    ).ok,
    true,
  );
  assert.equal((await offerForCarol).fromId, bobSocket.id);
  expectFailure(
    await emit(aliceSocket, "webrtc:offer", {
      callId: room.id,
      targetId: daveSocket.id,
      sdp: groupOffer,
    }),
    "PEER_NOT_FOUND",
  );
  const cannotEnd = await bob
    .request("post", `/api/calls/${room.id}/end`)
    .expect(403);
  assert.equal(cannotEnd.body.error.code, "CALL_END_FORBIDDEN");

  const aliceSeesDisconnect = event(aliceSocket, "call:peer-left");
  const bobSeesDisconnect = event(bobSocket, "call:peer-left");
  const carolSocketId = carolSocket.id;
  carolSocket.disconnect();
  assert.equal((await aliceSeesDisconnect).socketId, carolSocketId);
  assert.equal((await bobSeesDisconnect).socketId, carolSocketId);
  assert.equal(fixture.io.sockets.adapter.rooms.get(`call:${room.id}`).size, 2);

  const carolReconnect = await carol.socket();
  const rejoined = await emit(carolReconnect, "call:join", { callId: room.id });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.data.peers.length, 2);
  const endedEvents = [aliceSocket, bobSocket, carolReconnect].map((socket) =>
    event(socket, "call:ended"),
  );
  const ended = await alice
    .request("post", `/api/calls/${room.id}/end`)
    .expect(200);
  assert.ok(ended.body.call.endedAt);
  for (const endedEvent of endedEvents)
    assert.deepEqual(await endedEvent, { callId: room.id, reason: "ended" });
  assert.equal(fixture.io.sockets.adapter.rooms.has(`call:${room.id}`), false);
  assert.equal(
    fixture.io.sockets.adapter.rooms.get(`call:${otherRoom.id}`).size,
    1,
  );
  expectFailure(
    await emit(aliceSocket, "call:join", { callId: room.id }),
    "CALL_ENDED",
  );
});

test("ICE configuration requires authentication and issues expiring user-specific TURN credentials", async (t) => {
  const turnSecret = "integration-test-turn-secret";
  const fixture = await createFixture(t, {
    stunUrls: ["stun:stun.example.test:3478"],
    turnUrls: ["turn:turn.example.test:3478?transport=udp"],
    turnSecret,
  });
  await request(fixture.app).get("/api/calls/ice").expect(401);
  const alice = await fixture.account();
  const response = await alice.request("get", "/api/calls/ice").expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body.iceServers[0], {
    urls: ["stun:stun.example.test:3478"],
  });
  const turn = response.body.iceServers[1];
  assert.deepEqual(turn.urls, ["turn:turn.example.test:3478?transport=udp"]);
  const [expires, userId] = turn.username.split(":");
  assert.equal(userId, alice.id);
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  assert.ok(remaining > 3500 && remaining <= 3600);
  assert.equal(
    response.body.expiresAt,
    new Date(Number(expires) * 1000).toISOString(),
  );
  assert.equal(
    turn.credential,
    createHmac("sha1", turnSecret).update(turn.username).digest("base64"),
  );
  assert.equal(JSON.stringify(response.body).includes(turnSecret), false);
});
