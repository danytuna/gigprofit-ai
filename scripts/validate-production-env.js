const nodeEnv = (process.env.NODE_ENV || "development").trim();

const requiredByEnvironment = {
  production: [
    "NODE_ENV",
    "PLAID_ENV",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "FIREBASE_SERVICE_ACCOUNT_BASE64",
    "PLAID_TOKEN_ENCRYPTION_KEY",
    "ALLOWED_ORIGINS",
    "OPENAI_API_KEY",
    "TICKETMASTER_API_KEY",
    "MAPBOX_ACCESS_TOKEN",
  ],
};

const requiredVariables = requiredByEnvironment[nodeEnv] || [];

const missing = requiredVariables.filter((name) => {
  const value = process.env[name];
  return typeof value !== "string" || value.trim() === "";
});

if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
  process.exit(1);
}

if (
  process.env.PLAID_ENV &&
  !["production", "development", "sandbox"].includes(
    process.env.PLAID_ENV.trim().toLowerCase()
  )
) {
  console.error("Missing required environment variables: PLAID_ENV");
  process.exit(1);
}

console.log(`Environment validation passed for ${nodeEnv}.`);
