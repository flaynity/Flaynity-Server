# Flaynity-Server

Cloudflare Worker backend for the existing Flaynity R2 bucket.

## IMPORTANT
This project is already configured to bind the **existing** R2 bucket:

`flaynity-storage`

Do **NOT** create another R2 bucket.

The bucket used by the Flaynity client is also `flaynity-storage`.

## Existing R2 endpoint/account
The current Flaynity client uses the R2 account endpoint:

`b3741135bd1f3e96b6744f11e6a06600.r2.cloudflarestorage.com`

The account ID is configured in `wrangler.toml` as `R2_ACCOUNT_ID`.

## What the Worker does
- Authenticated upload URL generation
- Direct browser-to-R2 upload
- R2 media delivery
- HTTP Range playback for video
- CORS headers
- Long-lived cache headers for immutable media
- Health endpoint

## Existing app object key format
The app already uses keys such as:

`uploads/images/...`
`uploads/feels/...`
`uploads/videos/...`
`uploads/shorts/...`

The Worker accepts the same `uploads/...` namespace so the existing bucket and app remain compatible.

## Required Cloudflare secrets
Add these as Worker Secrets; never commit them to GitHub:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

These credentials must have access to the existing `flaynity-storage` bucket only.

## Deploy
Connect this GitHub repository to Cloudflare Workers & Pages / Workers Builds and deploy.

Then bind the existing R2 bucket `flaynity-storage` to the `MEDIA_BUCKET` binding. The binding is already declared in `wrangler.toml`.
