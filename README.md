# Yiedie backend

## Render deployment

Use `npm ci` as the build command, `npm start` as the start command, and
`/api/health` as the health check path. The server uses Render's `PORT`.

Set these variables in the Render service's **Environment** settings:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
CLIENT_ORIGINS=https://pro-yiedie.vercel.app
COOKIE_SAME_SITE=none
TRUST_PROXY=1
```

Keep your `DATABASE_URL` and `SESSION_SECRET` configured as secrets. Save the
environment changes and redeploy the backend with the latest code.

`CLIENT_ORIGINS` contains frontend origins, without paths or trailing slashes.
For multiple frontends, use a comma-separated list of their exact origins.
An environment value replaces the default list in `src/config.js`; copying the
local `.env` to Render would allow only localhost and retain development cookie
settings. Set the production values above explicitly.

On Render, `TRUST_PROXY` defaults to `1` so secure cookies work behind its HTTPS
proxy. An explicit value such as `TRUST_PROXY=0` overrides that default.
`COOKIE_SAME_SITE=none` requires `NODE_ENV=production` and HTTPS.

### S3 uploads

The backend uses S3 for avatar images, community post media, and private chat
attachments when `AWS_BUCKET_NAME` is set. Configure `AWS_REGION` and provide
AWS credentials through the runtime's IAM role or the existing
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables. Do not
commit credentials.

Set `AWS_PUBLIC_BASE_URL` to the root URL of your CloudFront distribution or
other public asset domain when using one. Without it, public media URLs use the
regional S3 bucket URL, so the bucket must allow reads under the `uploads/`
prefix. Grant the backend identity `s3:PutObject`, `s3:GetObject`, and
`s3:DeleteObject` for the bucket objects. Chat attachments are stored under
`messages/` and are only downloaded through the authenticated API; do not make
that prefix publicly readable. The backend does not set object ACLs.

Without `AWS_BUCKET_NAME`, the backend continues storing uploads on local disk.

In the Vercel frontend project's environment settings, set:

```dotenv
VITE_API_URL=https://yeidie-backend.onrender.com/api
```

Redeploy the frontend after changing this value. The frontend already includes
credentials on API requests and sends `X-CSRF-Token` for mutations.

### Verify CORS

```sh
curl -i -X OPTIONS 'https://yeidie-backend.onrender.com/api/auth/login' \
  -H 'Origin: https://pro-yiedie.vercel.app' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token'
```

Expect HTTP `204`, `Access-Control-Allow-Origin: https://pro-yiedie.vercel.app`,
`Access-Control-Allow-Credentials: true`, and the requested headers in
`Access-Control-Allow-Headers`.

`GET /api/auth/csrf` over HTTPS should return a session cookie with `Secure`,
`HttpOnly`, and `SameSite=None`. If CORS succeeds but login returns
`CSRF_INVALID`, check that the browser stores and sends this cookie. Browser
settings that block third-party cookies can prevent sessions between the
Vercel and Render domains; using frontend and API custom domains under the same
site avoids that cross-site dependency.

If the service returns `502` or `503`, check Render's startup and database logs.
Those responses can appear as browser CORS errors when the application never
gets a chance to add its headers.

References: [Render web services](https://render.com/docs/web-services),
[Render environment variables](https://render.com/docs/environment-variables),
and [Express session proxy and cookie settings](https://expressjs.com/en/resources/middleware/session/).

## Checks

```sh
npm run check
npm test
```
