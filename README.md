# Flaynity-Server — A–Z Setup Guide

এই README অনুযায়ী নতুন করে **Flaynity Server** সেটআপ করলে Flaynity Website-এর Video, Feels এবং Post upload-এর জন্য Cloudflare Worker + R2 backend তৈরি করা যাবে।

> **গুরুত্বপূর্ণ:** এই Server setup-এর জন্য Flaynity-এর বর্তমান R2 bucket `flaynity-storage`-ই ব্যবহার করতে হবে। নতুন R2 bucket তৈরি করবেন না।

---

## 1. এই Server কী কাজ করে?

Flaynity-Server মূলত:

- Firebase login token যাচাই করে
- নিরাপদ R2 upload URL তৈরি করে
- Browser থেকে R2-তে media upload করতে দেয়
- R2 media CDN দিয়ে Video/Feels/Post media দেখায়
- Video-এর Range/streaming playback support করে
- CORS handle করে
- Media cache করে দ্রুত delivery দিতে সাহায্য করে
- Health check দেয়

---

## 2. আগে যা লাগবে

আপনার Cloudflare account-এ থাকতে হবে:

- Existing R2 bucket: `flaynity-storage`
- Cloudflare account ID: `b3741135bd1f3e96b6744f11e6a06600`
- Firebase project: `flaynity-app`
- Website: `https://flaynity.indevs.in`
- API Worker domain: `https://api.flaynity.indevs.in`
- CDN Worker domain: `https://cdn.flaynity.indevs.in`

---

## 3. GitHub Repository তৈরি করুন

1. GitHub-এ login করুন।
2. **New repository** চাপুন।
3. Repository name দিন: `Flaynity-Server`
4. Repository public/private যেটা চান রাখতে পারেন।
5. Repository তৈরি করুন।
6. এই folder-এর সব file GitHub repository root-এ upload করুন।

Folder structure এমন হবে:

```text
Flaynity-Server/
├── README.md
├── wrangler.toml
└── src/
    └── index.js
```

---

## 4. `wrangler.toml` কীভাবে কাজ করবে

এই project-এর `wrangler.toml`-এ আগে থেকেই নিচের গুরুত্বপূর্ণ configuration দেওয়া আছে:

```toml
name = "flaynity-server"
main = "src/index.js"
compatibility_date = "2026-09-09"
workers_dev = true

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "flaynity-storage"

[vars]
APP_ORIGIN = "https://flaynity.indevs.in"
FIREBASE_PROJECT_ID = "flaynity-app"
R2_ACCOUNT_ID = "b3741135bd1f3e96b6744f11e6a06600"
MEDIA_BUCKET_NAME = "flaynity-storage"
MEDIA_BASE_URL = "https://cdn.flaynity.indevs.in/media"
```

**এই values পরিবর্তন করবেন না**, যদি Flaynity-এর বর্তমান domain/bucket একই থাকে।

---

## 5. Cloudflare Worker তৈরি করুন

Cloudflare Dashboard খুলুন।

1. **Workers & Pages** এ যান।
2. নতুন Worker/Worker project তৈরি করুন।
3. Worker name দিন:

```text
flaynity-server
```

4. GitHub repository connect করলে `Flaynity-Server` repository select করুন।
5. Build/deploy configuration-এ project-এর `wrangler.toml` ব্যবহার করুন।
6. Deploy করুন।

যদি GitHub integration ব্যবহার না করেন, Cloudflare-এর Worker code editor/CLI দিয়েও deploy করা যাবে।

---

## 6. R2 Bucket binding সেট করুন

Cloudflare Worker-এর Settings → Bindings/Resources অংশে যান।

R2 bucket binding যোগ করুন:

- **Binding name:** `MEDIA_BUCKET`
- **R2 bucket:** `flaynity-storage`

`wrangler.toml`-এ binding আগে থেকেই আছে, তাই GitHub-based deployment-এ এটি configuration থেকে নেওয়া উচিত। Dashboard-এ binding না থাকলে অবশ্যই যোগ করুন।

### খুব গুরুত্বপূর্ণ

❌ নতুন bucket তৈরি করবেন না।

✅ পুরোনো/বর্তমান:

```text
flaynity-storage
```

ব্যবহার করুন।

---

## 7. R2 API credentials তৈরি করুন

Worker-কে R2-তে upload URL তৈরি করতে R2 S3 credentials লাগবে।

Cloudflare Dashboard থেকে R2 API token/access credentials তৈরি করুন।

Credentials-এর permission এমন রাখুন যেন প্রয়োজনীয় `flaynity-storage` bucket access থাকে।

আপনার পাওয়া দুটি value:

```text
Access Key ID
Secret Access Key
```

**এগুলো README, GitHub code, `wrangler.toml`, HTML বা JavaScript-এর ভিতরে লিখবেন না।**

---

## 8. Worker Secrets যোগ করুন

Cloudflare Worker → Settings → Variables and Secrets-এ যান।

দুটি **Secret** যোগ করুন:

### Secret 1

Name:

```text
R2_ACCESS_KEY_ID
```

Value:

```text
আপনার R2 Access Key ID
```

### Secret 2

Name:

```text
R2_SECRET_ACCESS_KEY
```

Value:

```text
আপনার R2 Secret Access Key
```

তারপর **Save/Deploy** করুন।

> Secret-এর আসল value কখনো GitHub-এ commit করবেন না।

---

## 9. Firebase Authentication configuration

Server-এর Firebase project অবশ্যই Flaynity-এর Firebase project হতে হবে:

```text
flaynity-app
```

`wrangler.toml`-এ এটি আছে:

```toml
FIREBASE_PROJECT_ID = "flaynity-app"
```

Server Firebase ID token verify করে। Signing key rotate হলেও Server-এর code refresh করার ব্যবস্থা রাখে। প্রয়োজন হলে Firebase Identity Toolkit validation fallback-ও ব্যবহার করে।

---

## 10. Firebase Web API Key

Server-এর authentication fallback-এর জন্য Firebase Web API key ব্যবহার করা যেতে পারে।

প্রয়োজনে Worker Variables/Secrets-এ একটি variable যোগ করুন:

```text
FIREBASE_WEB_API_KEY
```

Value হবে আপনার existing `js/firebase-config.js`-এর Firebase Web API key।

এটি **R2 secret নয়**। এটি Firebase-এর public web API key।

বর্তমান `src/index.js`-এ fallback key রাখা আছে যাতে setup-এর সময় আলাদা variable না দিলেও কাজ করতে পারে। নিরাপত্তা ও maintenance-এর জন্য Cloudflare Worker Variable হিসেবে `FIREBASE_WEB_API_KEY` সেট করে রাখা ভালো।

---

## 11. Worker deploy করুন

সব configuration শেষ হলে Worker deploy করুন।

Deploy-এর পরে Worker-এর domain/API route অবশ্যই এই service-এর দিকে যেতে হবে:

```text
https://api.flaynity.indevs.in
```

যদি custom domain/route ব্যবহার করেন, `api.flaynity.indevs.in`-কে `flaynity-server` Worker-এর সাথে connect করুন।

---

## 12. Health Check করুন

Browser-এ খুলুন:

```text
https://api.flaynity.indevs.in/api/health
```

সঠিক হলে JSON response-এর মধ্যে এমন তথ্য থাকবে:

```json
{
  "ok": true,
  "service": "flaynity-server"
}
```

এটি দেখালে Worker online আছে।

---

## 13. CDN media endpoint

Flaynity media delivery হবে:

```text
https://cdn.flaynity.indevs.in/media/<object-key>
```

উদাহরণ:

```text
https://cdn.flaynity.indevs.in/media/uploads/posts/example.jpg
```

Object না থাকলে `Not found` আসা স্বাভাবিক।

---

## 14. R2 CORS configuration

R2 bucket-এর CORS configuration-এ Flaynity website origin allow করতে হবে। বর্তমান setup-এর জন্য মূল origin:

```text
https://flaynity.indevs.in
```

বর্তমান upload flow-এর জন্য অন্তত `PUT` এবং `Content-Type` প্রয়োজন। উদাহরণ:

```json
[
  {
    "AllowedOrigins": [
      "https://flaynity.indevs.in"
    ],
    "AllowedMethods": [
      "PUT"
    ],
    "AllowedHeaders": [
      "Content-Type"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

Sketchware/WebView থেকে যদি পরে `Origin: null`-related CORS error দেখা যায়, তখন WebView-এর জন্য প্রয়োজনীয় origin policy আলাদাভাবে পরীক্ষা করতে হবে। অকারণে CORS পুরোপুরি `*` করে দেবেন না।

---

## 15. Object Lifecycle Rules

এই setup-এর জন্য R2 Object Lifecycle Rules **অবশ্যই চালু করতে হবে এমন নয়**।

আপনি যদি uploaded Video/Feels/Post media automatic delete করতে না চান, lifecycle rule দিয়ে media expire/delete করার নিয়ম দেবেন না।

অর্থাৎ permanent media চাইলে lifecycle expiration rule না রাখাই নিরাপদ।

---

## 16. Flaynity Website-এর সাথে connection

Flaynity client-side code-এ API/CDN base URL হবে:

```text
API:
https://api.flaynity.indevs.in/api

Media:
https://cdn.flaynity.indevs.in/media
```

Client upload করার সময় Firebase logged-in user-এর ID token পাঠাবে। Server token verify করে signed R2 upload URL তৈরি করবে। তারপর browser সরাসরি R2-তে file upload করবে।

---

## 17. Upload flow সহজভাবে

পুরো system এইভাবে কাজ করে:

```text
Flaynity App
     │
     │ Firebase ID Token
     ▼
api.flaynity.indevs.in
     │
     │ Verify user
     │ Create signed upload URL
     ▼
Cloudflare R2
flaynity-storage
     │
     │ Stored media
     ▼
cdn.flaynity.indevs.in
     │
     ▼
Flaynity App
```

---

## 18. কোন কোন upload এই Server ব্যবহার করে

বর্তমান secure upload system-এর মাধ্যমে:

- 📝 Post image
- 🎬 Video
- 🎞️ Feels/short video
- 🖼️ Video thumbnail
- 👤 Avatar/banner-এর মতো image upload

R2-তে media রাখা হবে এবং CDN URL database/content data-তে ব্যবহার করা যাবে।

---

## 19. Server update করার সময়

ভবিষ্যতে Server code update করলে মূল file:

```text
src/index.js
```

আর configuration:

```text
wrangler.toml
```

Secrets আবার code-এর মধ্যে লিখবেন না।

Deploy করার পরে অবশ্যই:

```text
https://api.flaynity.indevs.in/api/health
```

চেক করবেন।

---

## 20. নতুন করে setup করার সংক্ষিপ্ত checklist

একদম শুরু থেকে করলে এই order অনুসরণ করুন:

- [ ] 1. GitHub-এ `Flaynity-Server` repository তৈরি
- [ ] 2. `README.md` upload
- [ ] 3. `wrangler.toml` upload
- [ ] 4. `src/index.js` upload
- [ ] 5. Cloudflare Worker `flaynity-server` তৈরি/connect
- [ ] 6. Existing R2 bucket `flaynity-storage` bind
- [ ] 7. `R2_ACCESS_KEY_ID` Secret যোগ
- [ ] 8. `R2_SECRET_ACCESS_KEY` Secret যোগ
- [ ] 9. `FIREBASE_PROJECT_ID = flaynity-app` নিশ্চিত
- [ ] 10. প্রয়োজনে `FIREBASE_WEB_API_KEY` Variable যোগ
- [ ] 11. `APP_ORIGIN` ঠিক আছে কিনা দেখুন
- [ ] 12. `MEDIA_BASE_URL` ঠিক আছে কিনা দেখুন
- [ ] 13. R2 CORS check করুন
- [ ] 14. `api.flaynity.indevs.in` Worker-এর সাথে connect করুন
- [ ] 15. Deploy করুন
- [ ] 16. `/api/health` খুলে test করুন
- [ ] 17. Flaynity app-এ login করুন
- [ ] 18. Post upload test করুন
- [ ] 19. Feels upload test করুন
- [ ] 20. Video upload test করুন
- [ ] 21. CDN URL দিয়ে media playback test করুন

---

## 21. গুরুত্বপূর্ণ Security Rules

### কখনো করবেন না

❌ R2 Access Key HTML/JS-এ রাখবেন না

❌ R2 Secret Access Key GitHub-এ রাখবেন না

❌ Secret `wrangler.toml`-এ লিখবেন না

❌ নতুন R2 bucket বানিয়ে পুরোনো app-এর সাথে mix করবেন না

❌ Upload-এর জন্য browser থেকে R2 secret ব্যবহার করবেন না

### সবসময় করবেন

✅ R2 credentials Worker Secrets-এ রাখবেন

✅ Firebase ID token দিয়ে upload authorization করবেন

✅ Presigned upload URL ব্যবহার করবেন

✅ Existing `flaynity-storage` bucket ব্যবহার করবেন

✅ Deploy-এর পরে `/api/health` test করবেন

---

## 22. Common Error এবং কী করবেন

### `Unknown token key`

Firebase signing key rotation/cache-এর কারণে হতে পারে। এই Server-এর `src/index.js`-এ unknown key হলে fresh Google signing keys নেওয়ার ব্যবস্থা আছে। সর্বশেষ `src/index.js` deploy করুন।

### `Authentication token missing`

App থেকে Firebase ID token পাঠানো হচ্ছে না। User-কে Flaynity app-এ sign in করতে হবে এবং latest client upload code ব্যবহার করতে হবে।

### `Authentication token expired`

Firebase token expired। App থেকে নতুন ID token নেওয়া প্রয়োজন।

### `Invalid media key`

Server নিরাপত্তার জন্য invalid object key reject করে। Client-এর secure upload code ব্যবহার করুন; পুরোনো direct R2 upload code ব্যবহার করবেন না।

### `Could not create upload URL`

Worker Secrets এবং R2 binding check করুন:

```text
MEDIA_BUCKET → flaynity-storage
R2_ACCESS_KEY_ID → set
R2_SECRET_ACCESS_KEY → set
```

### CORS error

Website origin এবং R2 CORS configuration check করুন। Website origin:

```text
https://flaynity.indevs.in
```

---

## 23. Final working configuration

```text
Website
https://flaynity.indevs.in

API Worker
https://api.flaynity.indevs.in

API health
https://api.flaynity.indevs.in/api/health

CDN Worker
https://cdn.flaynity.indevs.in

Media base
https://cdn.flaynity.indevs.in/media

Worker name
flaynity-server

R2 bucket
flaynity-storage

Firebase project
flaynity-app
```

---

## 24. শেষ কথা

নতুন করে Server setup করতে হলে **এই README-এর 3 নম্বর ধাপ থেকে 20 নম্বর checklist পর্যন্ত একে একে অনুসরণ করুন।**

সবচেয়ে গুরুত্বপূর্ণ 3টি বিষয়:

1. `flaynity-server` Worker অবশ্যই `flaynity-storage` R2 bucket-এর সাথে bind থাকবে।
2. R2 credentials শুধু Worker Secrets-এ থাকবে।
3. Deploy-এর পরে `/api/health` success না হওয়া পর্যন্ত App upload test করবেন না।

**এই project-এর `src/index.js` এবং `wrangler.toml`-এর configuration Flaynity-এর বর্তমান setup অনুযায়ী তৈরি করা হয়েছে।**
