# GigProfit Railway Setup

This repository is the backend Railway should deploy for GigProfit.

## Expected repository

- GitHub repository: `danytuna/gigprofit-ai`
- Local path used for development: `/Users/admin/Documents/Project/GigProfit/gigprofit-backend`

## Railway root directory

Use the repository root directly.

- Root Directory: not required when Railway points to this backend repo
- Branch: `secure-plaid-production`
- Start command: `npm start`
- Healthcheck path: `/health`

## Required production variables

Set these in Railway without printing values:

- `NODE_ENV=production`
- `PLAID_ENV=production`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `PLAID_TOKEN_ENCRYPTION_KEY`
- `ALLOWED_ORIGINS`
- `OPENAI_API_KEY`
- `TICKETMASTER_API_KEY`
- `MAPBOX_ACCESS_TOKEN`

## Health endpoints

- `GET /`
- `GET /health`

Both should return HTTP 200 with a non-sensitive payload.

## Prestart validation

The app runs `scripts/validate-production-env.js` before startup. In production,
startup fails fast if a required variable is missing.

## Deploy checklist

1. Confirm Railway is connected to `danytuna/gigprofit-ai`.
2. Confirm the branch is `secure-plaid-production`.
3. Confirm the commit shown in Railway matches the audited branch head.
4. Confirm the required Railway variables exist.
5. Deploy from the backend repo root with `npm start`.
6. Verify `GET /health` returns HTTP 200.
7. Verify `GET /` returns the new JSON payload instead of the legacy text response.
8. Verify `GET /plaid/status` without `Authorization` returns HTTP 401.
9. Confirm logs do not show Firebase Admin errors, AES key errors, tokens, or secrets.
10. Run the controlled Plaid validation in `PLAID_PRODUCTION_VALIDATION.md`.

## Firestore rules

- Local rules file: `firestore.rules`
- Firebase config file: `firebase.json`
- Required blocked path:

```txt
match /users/{uid}/privateIntegrations/{document=**} {
  allow read, write: if false;
}
```

- Deploy rules only after confirming the correct Firebase project ID:

```bash
firebase deploy --only firestore:rules --project <PROJECT_ID>
```

### How to find the project ID

1. Open Firebase Console for GigProfit.
2. Go to Project settings.
3. Copy the exact Project ID from the General tab.

### Post-deploy verification

1. Authenticate in the iPhone app.
2. Confirm normal user profile reads still work.
3. Attempt to read `users/{uid}/privateIntegrations/plaid/items/{itemId}` from the client.
4. Confirm the client is denied.
