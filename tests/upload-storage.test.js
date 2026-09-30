import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createUploadStorage } from "../src/services/upload-storage.js";

test("S3 upload storage writes public and private objects with correct access paths", async () => {
  const commands = [];
  const attachmentBytes = Buffer.from("private attachment");
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([attachmentBytes]) };
      }
      return {};
    },
  };
  const storage = createUploadStorage(
    {
      s3Bucket: "test-uploads",
      s3Region: "us-east-1",
      s3PublicBaseUrl: "https://cdn.example.test",
    },
    client,
  );

  const image = await storage.save(
    {
      originalname: "profile.png",
      mimetype: "image/png",
      buffer: Buffer.from("image"),
    },
    "public",
  );
  assert.match(image.key, /^uploads\/[\w-]+\.png$/);
  assert.equal(image.url, `https://cdn.example.test/${image.key}`);
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.Bucket, "test-uploads");
  assert.equal(commands[0].input.Key, image.key);
  assert.equal(commands[0].input.ACL, undefined);

  const attachment = await storage.save(
    {
      originalname: "session.webm",
      mimetype: "audio/webm",
      buffer: attachmentBytes,
    },
    "private",
  );
  assert.match(attachment.key, /^messages\/[\w-]+\.webm$/);
  assert.equal(attachment.url, null);
  assert.equal(
    await storage.sendPrivate("../private.txt", new PassThrough()),
    false,
  );

  const response = new PassThrough();
  response.type = () => response;
  response.set = () => response;
  response.attachment = () => response;
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  assert.equal(await storage.sendPrivate(attachment.key, response), true);
  assert.deepEqual(Buffer.concat(chunks), attachmentBytes);
  assert.ok(commands.at(-1) instanceof GetObjectCommand);
  assert.equal(commands.at(-1).input.Key, attachment.key);

  await storage.removePublicUrl(image.url);
  assert.ok(commands.at(-1) instanceof DeleteObjectCommand);
  assert.equal(commands.at(-1).input.Key, image.key);
});
