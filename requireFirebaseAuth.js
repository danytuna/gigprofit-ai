export function createRequireFirebaseAuth(auth, { timeoutMs = 8_000 } = {}) {
  return async function requireFirebaseAuth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        code: "AUTHENTICATION_REQUIRED",
        error_type: "authentication_failure",
        error: "Unauthorized",
      });
    }

    const idToken = header.slice("Bearer ".length).trim();

    if (!idToken) {
      return res.status(401).json({
        ok: false,
        code: "AUTHENTICATION_REQUIRED",
        error_type: "authentication_failure",
        error: "Unauthorized",
      });
    }

    try {
      let timer;
      const decoded = await Promise.race([
        auth.verifyIdToken(idToken),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Firebase authentication timed out.");
            error.code = "auth_timeout";
            reject(error);
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));

      req.auth = {
        uid: decoded.uid,
        email: decoded.email || null,
      };

      return next();
    } catch (error) {
      if (error?.code === "auth_timeout") {
        return res.status(503).json({
          ok: false,
          code: "AUTHENTICATION_BACKEND_UNAVAILABLE",
          error_type: "temporary_backend_failure",
          error: "Authentication service is temporarily unavailable.",
        });
      }
      return res.status(401).json({
        ok: false,
        code: "AUTHENTICATION_FAILED",
        error_type: "authentication_failure",
        error: "Unauthorized",
      });
    }
  };
}
