# GigProfit Plaid Production Validation

This checklist is for a controlled production validation of the secure Plaid migration on Railway.

## Preconditions

- Branch deployed: `secure-plaid-production`
- Railway service is configured with production-only Plaid credentials
- `NODE_ENV=production`
- `PLAID_ENV=production`
- Firebase Authentication test user is available
- Firestore rules are deployed with client access denied for `users/{uid}/privateIntegrations/**`

## Required Railway variable names

Confirm the production service has these variables defined before testing:

- `NODE_ENV`
- `PLAID_ENV`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `PLAID_TOKEN_ENCRYPTION_KEY`
- `ALLOWED_ORIGINS`

Do not print values while validating.

## Controlled Production Test

1. Sign in with a dedicated GigProfit production test account.
2. Open the bank connection flow from the iPhone.
3. Launch Plaid Link in production and connect a real institution that is authorized for testing.
4. Confirm the iPhone receives a `link_token`, but never receives an `access_token`.
5. Complete the link flow and inspect the `POST /plaid/exchange_public_token` response.
6. Confirm the response contains only:
   - `ok`
   - `connected`
   - `item_id`
7. In Firestore Admin, verify the private document path is:
   - `users/{uid}/privateIntegrations/plaid/items/{itemId}`
8. Confirm the document stores only encrypted token fields and safe metadata, such as:
   - `encryptedAccessToken`
   - `iv`
   - `authTag`
   - `itemId`
   - `environment`
   - `connectionStatus`
   - `institutionName`
   - masked `accounts`
   - timestamps
9. Confirm no full access token, public token, or raw transaction payload appears in Railway logs.
10. Restart the app and call `GET /plaid/status`.
11. Confirm the connection persists and the user only sees their own institutions.
12. Request a small transaction range with `POST /plaid/transactions`.
13. Confirm transactions load without exposing any server-side Plaid secret to the app.
14. If supported by the test account, connect a second institution and confirm both remain isolated under the same Firebase UID.
15. Sign in as a different Firebase user and confirm the first user's institutions are not visible.
16. Disconnect one institution and confirm:
   - `itemRemove` succeeds or safely tolerates `ITEM_NOT_FOUND`
   - the matching Firestore private document is removed
17. Disconnect all remaining institutions and confirm no private item documents remain.

## Logging Validation

Review sanitized Railway logs during testing and confirm:

- no `access_token`
- no `public_token`
- no full transaction dumps
- no Firestore service account JSON
- no encryption key material

## Rollback Plan

If any part of the production validation fails:

1. Stop further Plaid testing immediately.
2. Roll back Railway to the previous known-good deploy reference.
3. Re-verify health check after rollback.
4. Keep Firestore private documents untouched unless disconnect cleanup is being explicitly tested.
5. Document the failing endpoint, timestamp, Firebase UID used for testing, and sanitized Railway request ID if available.
6. Fix on `secure-plaid-production`, rerun tests, and redeploy in a new controlled window.

## Manual Security Checklist

Before broad release, manually confirm:

- MFA is enabled in Plaid
- MFA is enabled in Google / Firebase
- MFA is enabled in Railway
- MFA is enabled in GitHub
- MFA is enabled in Apple Developer
- MFA is enabled in Netlify
- the Firebase service account is limited to the correct project
- no service account JSON exists in Git
- no encryption key exists in Git
- no legacy Plaid route outside Railway remains active
