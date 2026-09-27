import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { createFixture, testPool } from "./helpers.js";
import { migrate } from "../src/db/migrate.js";
import { startServer } from "../src/index.js";

test("production defaults use cross-site cookies for deployed frontends", async () => {
  const { readConfig } = await import("../src/config.js");
  const config = readConfig({
    NODE_ENV: "production",
    SESSION_SECRET: "tests-only-long-session-secret-do-not-use-in-production",
    CLIENT_ORIGINS: "https://app.example.com",
  });

  assert.equal(config.production, true);
  assert.equal(config.sameSite, "none");
});

test("wildcard client origins are accepted for preview domains", async (t) => {
  const f = await createFixture(t, {
    clientOrigins: ["https://*.example.test", "http://localhost:5173"],
  });

  await request(f.app)
    .get("/api/auth/csrf")
    .set("Origin", "https://app.example.test")
    .expect(200);

  await request(f.app)
    .get("/api/auth/csrf")
    .set("Origin", "https://example.com")
    .expect(403);
});

test("authentication, CSRF, sessions and public profiles protect private data", async (t) => {
  const f = await createFixture(t);
  await request(f.app).get("/api/health").expect(200);
  await request(f.app).get("/api/users").expect(401);
  await request(f.app).post("/api/auth/register").send({}).expect(403);
  await request(f.app)
    .get("/api/auth/csrf")
    .set("Origin", "https://untrusted.example")
    .expect(403);
  const alice = await f.account("client", "Alice Example");
  assert.match(alice.cookie, /^yiedie\.sid=/);
  await alice.request("get", "/api/auth/me").expect(200);
  await alice.agent.patch("/api/users/me").send({ bio: "Hello" }).expect(403);
  await alice
    .request("patch", "/api/users/me", { role: "counsellor" })
    .expect(400);
  await alice
    .request("patch", "/api/users/me", { specialties: ["Career"] })
    .expect(403);
  const update = await alice
    .request("patch", "/api/users/me", {
      bio: "Hello",
      fullName: "Alice Updated",
    })
    .expect(200);
  assert.equal(update.body.user.fullName, "Alice Updated");
  const profile = await alice
    .request("get", `/api/users/${alice.id}`)
    .expect(200);
  assert.equal(profile.body.user.email, undefined);
  assert.equal(profile.body.user.password_hash, undefined);
  const users = await alice
    .request("get", "/api/users?search=Updated")
    .expect(200);
  assert.equal(users.body.users.length, 1);
  assert.equal(users.body.users[0].email, undefined);
  const wrongLogin = await alice
    .request("post", "/api/auth/login", {
      email: alice.email,
      password: "wrong-password-123",
    })
    .expect(401);
  assert.equal(wrongLogin.body.error.code, "INVALID_CREDENTIALS");
  await alice.request("post", "/api/auth/logout").expect(204);
  await alice.agent.get("/api/auth/me").expect(401);
  const csrf = await alice.agent.get("/api/auth/csrf").expect(200);
  await alice.agent
    .post("/api/auth/register")
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({
      fullName: "Admin Attempt",
      email: "admin@example.test",
      password: "long-password-123",
      role: "admin",
    })
    .expect(400);
  const login = await alice.agent
    .post("/api/auth/login")
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({ email: alice.email.toUpperCase(), password: alice.password })
    .expect(200);
  assert.equal(login.body.user.id, alice.id);
  assert.notEqual(login.body.csrfToken, csrf.body.csrfToken);
  assert.equal(login.body.user.password_hash, undefined);
});

test("following, direct/group conversations and persisted messages enforce membership", async (t) => {
  const f = await createFixture(t);
  const alice = await f.account("client", "Alice");
  const bob = await f.account("client", "Bob");
  const outsider = await f.account("client", "Outsider");
  const newMember = await f.account("client", "New Member");
  await alice.request("post", `/api/users/${alice.id}/follow`).expect(400);
  await alice.request("post", `/api/users/${bob.id}/follow`).expect(200);
  await alice.request("post", `/api/users/${bob.id}/follow`).expect(200);
  const followers = await bob
    .request("get", `/api/users/${bob.id}/followers`)
    .expect(200);
  assert.deepEqual(
    followers.body.users.map((user) => user.id),
    [alice.id],
  );
  assert.equal(followers.body.users[0].email, undefined);
  await alice.request("delete", `/api/users/${bob.id}/follow`).expect(200);
  const creations = await Promise.all([
    alice.request("post", "/api/conversations", {
      kind: "direct",
      memberIds: [bob.id],
    }),
    bob.request("post", "/api/conversations", {
      kind: "direct",
      memberIds: [alice.id],
    }),
  ]);
  assert.ok(
    creations.every((res) => [200, 201].includes(res.status)),
    JSON.stringify(creations.map((res) => res.body)),
  );
  const conversationId = creations[0].body.conversation.id;
  assert.equal(creations[1].body.conversation.id, conversationId);
  await outsider
    .request("get", `/api/conversations/${conversationId}/messages`)
    .expect(404);
  await outsider
    .request("post", `/api/conversations/${conversationId}/messages`, {
      body: "Not allowed",
    })
    .expect(404);
  await alice
    .request("post", `/api/conversations/${conversationId}/messages`, {
      body: "   ",
    })
    .expect(400);
  const sent = await alice
    .request("post", `/api/conversations/${conversationId}/messages`, {
      body: "Hello Bob",
    })
    .expect(201);
  assert.equal(sent.body.message.senderId, alice.id);
  const history = await bob
    .request("get", `/api/conversations/${conversationId}/messages`)
    .expect(200);
  assert.equal(history.body.messages[0].body, "Hello Bob");
  await bob
    .request("get", `/api/conversations/${conversationId}/messages?limit=-1`)
    .expect(400);
  await alice
    .request("post", "/api/conversations", {
      kind: "group",
      memberIds: [bob.id, bob.id],
      title: "Duplicates",
    })
    .expect(400);
  const group = await alice
    .request("post", "/api/conversations", {
      kind: "group",
      memberIds: [bob.id, outsider.id],
      title: "Peer support",
    })
    .expect(201);
  assert.equal(group.body.conversation.kind, "group");
  const mine = await outsider.request("get", "/api/conversations").expect(200);
  assert.deepEqual(
    mine.body.conversations.map((c) => c.id),
    [group.body.conversation.id],
  );
  const renamed = await alice
    .request("patch", `/api/conversations/${group.body.conversation.id}`, {
      title: "Renewed peer support",
    })
    .expect(200);
  assert.equal(renamed.body.conversation.title, "Renewed peer support");
  await bob
    .request("patch", `/api/conversations/${group.body.conversation.id}`, {
      title: "Not allowed",
    })
    .expect(403);
  const added = await alice
    .request(
      "post",
      `/api/conversations/${group.body.conversation.id}/members`,
      {
        memberId: newMember.id,
      },
    )
    .expect(201);
  assert.equal(added.body.members.length, 4);
  await bob
    .request(
      "delete",
      `/api/conversations/${group.body.conversation.id}/members/${alice.id}`,
    )
    .expect(403);
  await alice
    .request(
      "delete",
      `/api/conversations/${group.body.conversation.id}/members/${bob.id}`,
    )
    .expect(204);
  await bob
    .request(
      "delete",
      `/api/conversations/${group.body.conversation.id}/members/${bob.id}`,
    )
    .expect(404);
  await alice
    .request("delete", `/api/conversations/${group.body.conversation.id}`)
    .expect(204);
  await alice
    .request("get", `/api/conversations/${group.body.conversation.id}/messages`)
    .expect(404);
});

test("server startup repairs missing community tables before serving posts", async (t) => {
  const database = await testPool();
  t.after(async () => {
    await database.close();
  });

  await database.pool.query("DROP TABLE IF EXISTS post_saves CASCADE");
  await database.pool.query("DROP TABLE IF EXISTS post_reposts CASCADE");
  await database.pool.query("DROP TABLE IF EXISTS post_comments CASCADE");
  await database.pool.query("DROP TABLE IF EXISTS post_likes CASCADE");
  await database.pool.query("DROP TABLE IF EXISTS posts CASCADE");

  const config = {
    ...(await import("../src/config.js")).readConfig({
      NODE_ENV: "test",
      PORT: 0,
      HOST: "127.0.0.1",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      SESSION_SECRET: "tests-only-long-session-secret-do-not-use-in-production",
      ENABLE_DEMO: "true",
    }),
  };

  const started = await startServer({
    pool: database.pool,
    config,
    sessionStore: new (await import("express-session")).default.MemoryStore(),
  });

  const agent = request.agent(started.app);
  const csrf = await agent.get("/api/auth/csrf").expect(200);
  const alice = await agent
    .post("/api/auth/register")
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({
      fullName: "Alice",
      email: "alice-autofix@example.test",
      password: "test-password-123",
      role: "client",
    })
    .expect(201);

  assert.equal(alice.body.user.fullName, "Alice");
  const list = await agent.get("/api/posts").expect(200);
  assert.deepEqual(list.body.posts, []);
  await new Promise((resolve, reject) => {
    started.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test("community posts can be created and loaded back from the database", async (t) => {
  const f = await createFixture(t);
  const alice = await f.account("client", "Alice");
  const create = await alice
    .request("post", "/api/posts", {
      body: "Hello community",
      mediaType: "image",
      mediaUrl: "data:image/png;base64,abc123",
    })
    .expect(201);
  assert.equal(create.body.post.body, "Hello community");
  assert.equal(create.body.post.author.fullName, "Alice");

  const list = await alice.request("get", "/api/posts").expect(200);
  assert.equal(list.body.posts.length, 1);
  assert.equal(list.body.posts[0].body, "Hello community");
  assert.equal(list.body.posts[0].mediaType, "image");
});

test("video posts with large data URLs are accepted", async (t) => {
  const f = await createFixture(t);
  const alice = await f.account("client", "Alice");
  const largeVideo = `data:video/mp4;base64,${"a".repeat(180000)}`;

  const create = await alice
    .request("post", "/api/posts", {
      body: "Shared a short clip",
      mediaType: "video",
      mediaUrl: largeVideo,
    })
    .expect(201);

  assert.equal(create.body.post.mediaType, "video");
  assert.equal(create.body.post.body, "Shared a short clip");

  const list = await alice.request("get", "/api/posts").expect(200);
  assert.equal(list.body.posts[0].mediaType, "video");
  assert.equal(list.body.posts[0].body, "Shared a short clip");
});

test("likes and comments are persisted to the database", async (t) => {
  const f = await createFixture(t);
  const alice = await f.account("client", "Alice");
  const bob = await f.account("client", "Bob");

  const post = await alice
    .request("post", "/api/posts", {
      body: "Persisted reaction test",
    })
    .expect(201);

  const liked = await alice
    .request("post", `/api/posts/${post.body.post.id}/like`)
    .expect(200);
  assert.equal(liked.body.liked, true);
  assert.equal(liked.body.likes, 1);

  const commented = await bob
    .request("post", `/api/posts/${post.body.post.id}/comments`, {
      body: "Great post!",
    })
    .expect(201);
  assert.equal(commented.body.comment.body, "Great post!");

  const list = await alice.request("get", "/api/posts").expect(200);
  const savedPost = list.body.posts.find(
    (item) => item.id === post.body.post.id,
  );
  assert.ok(savedPost);
  assert.equal(savedPost.likes, 1);
  assert.equal(savedPost.liked, true);
  assert.equal(savedPost.comments.length, 1);
  assert.equal(savedPost.comments[0].body, "Great post!");
});

test("uploaded image and video files can be posted to the community feed", async (t) => {
  const f = await createFixture(t);
  const alice = await f.account("client", "Alice");
  const csrf = await alice.agent.get("/api/auth/csrf").expect(200);

  const image = await alice.agent
    .post("/api/posts")
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .field("body", "Uploaded image")
    .field("mediaType", "image")
    .attach("media", Buffer.from("fake-image-data"), {
      filename: "photo.png",
      contentType: "image/png",
    })
    .expect(201);

  assert.equal(image.body.post.mediaType, "image");
  assert.match(image.body.post.mediaUrl, /\/uploads\//);

  const video = await alice.agent
    .post("/api/posts")
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .field("body", "Uploaded video")
    .field("mediaType", "video")
    .attach("media", Buffer.from("fake-video-data"), {
      filename: "clip.mp4",
      contentType: "video/mp4",
    })
    .expect(201);

  assert.equal(video.body.post.mediaType, "video");
  assert.match(video.body.post.mediaUrl, /\/uploads\//);

  const list = await alice.request("get", "/api/posts").expect(200);
  assert.equal(list.body.posts.length >= 2, true);
});

test("ICE endpoint signs expiring TURN credentials and demo assets are served", async (t) => {
  const secret = "test-only-turn-shared-secret-32-chars";
  const f = await createFixture(t, {
    turnUrls: ["turn:turn.example.test:3478"],
    turnSecret: secret,
  });
  const alice = await f.account();
  const result = await alice.request("get", "/api/calls/ice").expect(200);
  const turn = result.body.iceServers.find((server) => server.username);
  assert.ok(turn.username.endsWith(`:${alice.id}`));
  assert.equal(
    turn.credential,
    createHmac("sha1", secret).update(turn.username).digest("base64"),
  );
  assert.ok(new Date(result.body.expiresAt).getTime() > Date.now());
  assert.ok(!JSON.stringify(result.body).includes(secret));
  await request(f.app).get("/demo/").expect(200);
  await request(f.app).get("/demo/demo.js").expect(200);
});

test("migrations are repeatable without discarding existing application data", async (t) => {
  const f = await createFixture(t);
  // PGlite fixture already loaded schema, so record the first migration before rerunning.
  await f.pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  await f.pool.query(
    "INSERT INTO schema_migrations (name) VALUES ('001_initial.sql') ON CONFLICT DO NOTHING",
  );
  const alice = await f.account();
  await migrate(f.pool);
  await migrate(f.pool);
  const { rows } = await f.pool.query("SELECT id FROM users WHERE id = $1", [
    alice.id,
  ]);
  assert.equal(rows[0].id, alice.id);
});
