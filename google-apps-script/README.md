# Flaynity Google Apps Script Email OTP

This is the Google Apps Script backend for Flaynity's **new email/password account signup** verification. It sends a 4-digit code, expires it after 5 minutes, enforces a 60-second resend cooldown and 5 failed attempts, and sets Firebase Authentication `emailVerified=true` only after a successful OTP check.

## 1. Create the Apps Script project

1. Open https://script.google.com/ and create a new standalone project.
2. Replace the contents of `Code.gs` with the code in this folder.
3. In **Project Settings → Script Properties**, add all properties below.

| Property | Value |
|---|---|
| `FIREBASE_API_KEY` | Web API key from Flaynity's Firebase project |
| `FIREBASE_PROJECT_ID` | `flaynity-app` |
| `SERVICE_ACCOUNT_EMAIL` | Service-account email from Firebase/Google Cloud |
| `SERVICE_ACCOUNT_KEY` | Full private key including BEGIN/END lines |
| `OTP_HMAC_SECRET` | A unique random secret of at least 32 characters |

Create a dedicated Google Cloud service account for this script and grant it the **Firebase Authentication Admin** role (or the narrowest role that permits updating Firebase Auth users). Keep the private key only in Script Properties. Never put it in the web app or GitHub.

## 2. Deploy

1. Click **Deploy → New deployment → Web app**.
2. Execute as: **Me**.
3. Who has access: **Anyone**.
4. Deploy, authorize the requested Mail and external-request permissions, and copy the URL ending in `/exec`.

The deployment URL is needed before the Flaynity WebView can call this backend.

## 3. API contract

Send a POST request using `application/x-www-form-urlencoded` (not JSON):

- `action=sendEmailCode&idToken=FIREBASE_ID_TOKEN`
- `action=verifyEmailCode&idToken=FIREBASE_ID_TOKEN&code=1234`

The Firebase ID token is validated against the Flaynity Firebase project. On success, the backend updates the Firebase Auth user's `emailVerified` flag with the service-account credential. The client must reload the Firebase user after verification.

## 4. Important notes

- This endpoint is intended only for the signup verification flow. Do not expose service-account credentials.
- Apps Script MailApp has daily recipient quotas; consumer Gmail accounts currently have a low daily sending limit. See https://developers.google.com/apps-script/guides/services/quotas.
- After deployment, send the `/exec` URL to the developer so the existing Flaynity OTP screen can be connected. Do not replace the current endpoint with a guessed URL.
- The existing UI uses four OTP boxes, so this backend intentionally uses a 4-digit code to preserve the current design.
