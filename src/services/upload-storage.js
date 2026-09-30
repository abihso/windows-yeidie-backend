import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import multer from "multer";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const uploadDirectory = fileURLToPath(
  new URL("../../uploads/", import.meta.url),
);
const privateUploadDirectory = fileURLToPath(
  new URL("../../private-uploads/messages/", import.meta.url),
);

function safeFilename(file) {
  const originalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const extension = path.extname(originalName);
  return `${Date.now()}-${randomUUID()}${extension || (file.mimetype.startsWith("video/") ? ".mp4" : ".bin")}`;
}

export function createUploadStorage(config, client) {
  const bucket = config.s3Bucket;
  const s3 = bucket
    ? (client ?? new S3Client({ region: config.s3Region }))
    : null;
  const publicBaseUrl = config.s3PublicBaseUrl
    ? config.s3PublicBaseUrl.replace(/\/+$/, "")
    : bucket
      ? `https://${bucket}.s3.${config.s3Region}.amazonaws.com`
      : "";

  return {
    usesS3: Boolean(s3),
    middleware(options) {
      return multer({ storage: multer.memoryStorage(), ...options });
    },
    async save(file, visibility) {
      const filename = safeFilename(file);
      const key = s3
        ? `${visibility === "private" ? "messages" : "uploads"}/${filename}`
        : filename;
      if (s3) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          }),
        );
      } else {
        const directory =
          visibility === "private" ? privateUploadDirectory : uploadDirectory;
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, filename), file.buffer);
      }
      return {
        key,
        url: visibility === "private" ? null : this.publicUrl(key),
      };
    },
    publicUrl(key) {
      if (!s3) return `/uploads/${key}`;
      return `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    async remove(key) {
      if (!key) return;
      if (s3) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return;
      }
      const filename = path.basename(key);
      if (filename !== key) return;
      await Promise.all([
        fs.unlink(path.join(uploadDirectory, filename)).catch(() => {}),
        fs.unlink(path.join(privateUploadDirectory, filename)).catch(() => {}),
      ]);
    },
    async removePublicUrl(url) {
      if (!url) return;
      if (!s3) {
        if (!url.startsWith("/uploads/")) return;
        await this.remove(url.slice("/uploads/".length));
        return;
      }
      if (!url.startsWith(`${publicBaseUrl}/`)) return;
      try {
        const encodedKey = url.slice(publicBaseUrl.length + 1);
        await this.remove(
          encodedKey.split("/").map(decodeURIComponent).join("/"),
        );
      } catch {
        return;
      }
    },
    async sendPrivate(
      key,
      res,
      { inline = false, name = "attachment", mime } = {},
    ) {
      const validS3Key = s3 && /^messages\/[\w.-]+$/.test(key);
      const validLocalKey = !s3 && path.basename(key) === key;
      if (!validS3Key && !validLocalKey) return false;
      res.type(mime || "application/octet-stream");
      if (inline) {
        res.set("Content-Disposition", "inline; filename=attachment");
      } else {
        res.attachment(name);
      }
      if (s3) {
        const { Body } = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        await pipeline(Body, res);
      } else {
        await pipeline(
          createReadStream(path.join(privateUploadDirectory, key)),
          res,
        );
      }
      return true;
    },
  };
}
