export function createRequireFirebaseAuth(auth) {
  return async function requireFirebaseAuth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const idToken = header.slice("Bearer ".length).trim();

    if (!idToken) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    try {
      const decoded = await auth.verifyIdToken(idToken);

      req.auth = {
        uid: decoded.uid,
        email: decoded.email || null,
      };

      return next();
    } catch {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }
  };
}
