import admin from "firebase-admin";

let cachedApp = null;

function parseServiceAccount(base64Value) {
  if (!base64Value) {
    return null;
  }

  const decoded = Buffer.from(base64Value, "base64").toString("utf8");
  return JSON.parse(decoded);
}

export function initializeFirebaseAdmin({
  serviceAccountBase64,
  nodeEnv = "development",
}) {
  if (cachedApp) {
    return cachedApp;
  }

  if (!serviceAccountBase64) {
    if (nodeEnv === "production") {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production."
      );
    }

    if (admin.apps.length > 0) {
      cachedApp = admin.app();
      return cachedApp;
    }

    cachedApp = admin.initializeApp();
    return cachedApp;
  }

  const serviceAccount = parseServiceAccount(serviceAccountBase64);

  if (!serviceAccount?.project_id || !serviceAccount?.client_email) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_BASE64 could not be parsed into a valid Firebase service account."
    );
  }

  if (admin.apps.length > 0) {
    cachedApp = admin.app();
    return cachedApp;
  }

  cachedApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return cachedApp;
}

export function getFirebaseAdminServices(options) {
  const app = initializeFirebaseAdmin(options);

  return {
    admin,
    app,
    auth: admin.auth(app),
    firestore: admin.firestore(app),
  };
}
