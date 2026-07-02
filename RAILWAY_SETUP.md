# GigProfit Railway Setup

This repository is the backend Railway should deploy for GigProfit.

## Expected repository

- GitHub repository: `danytuna/gigprofit-ai`
- Local path used for development: `/Users/admin/Documents/Project/GigProfit/gigprofit-backend`

## Railway root directory

Use the repository root directly.

- Root Directory: not required when Railway points to this backend repo
- Start command: `npm start`

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

1. Confirm the branch and commit to deploy.
2. Confirm the required Railway variables exist.
3. Deploy from the backend repo root.
4. Verify `GET /health` returns HTTP 200.
5. Run the controlled Plaid validation in `PLAID_PRODUCTION_VALIDATION.md`.
