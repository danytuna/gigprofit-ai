export const APPLE_SUBSCRIPTION_OWNERSHIP_CONFLICT =
  "APPLE_SUBSCRIPTION_OWNERSHIP_CONFLICT";

export const APPLE_SUBSCRIPTION_CONFLICT_MESSAGE =
  "This Apple subscription is already linked to another GigProfit account. Please sign in with the original account or contact support.";

export class AppleSubscriptionOwnershipConflictError extends Error {
  constructor() {
    super(APPLE_SUBSCRIPTION_CONFLICT_MESSAGE);
    this.name = "AppleSubscriptionOwnershipConflictError";
    this.code = APPLE_SUBSCRIPTION_OWNERSHIP_CONFLICT;
    this.status = 409;
  }
}

function clean(value) {
  return String(value || "").trim();
}

export async function claimAppleSubscriptionOwnership({
  firestore,
  adminFirestore,
  uid,
  verified,
}) {
  const firebaseUid = clean(uid);
  const originalTransactionId = clean(verified?.originalTransactionId);

  if (!firebaseUid || !originalTransactionId) {
    throw new Error("Subscription ownership identity is missing.");
  }

  if (verified.appAccountToken && !verified.accountTokenMatches) {
    throw new AppleSubscriptionOwnershipConflictError();
  }

  const users = firestore.collection("users");
  const ownershipRef = firestore
    .collection("appleSubscriptionOwnership")
    .doc(originalTransactionId);
  const currentUserRef = users.doc(firebaseUid);
  const legacyOwnerQuery = users
    .where("subscriptionOriginalTransactionId", "==", originalTransactionId)
    .limit(10);

  return firestore.runTransaction(async (transaction) => {
    const ownershipSnapshot = await transaction.get(ownershipRef);
    const existingOwner = clean(ownershipSnapshot.data()?.uid);

    if (existingOwner && existingOwner !== firebaseUid) {
      throw new AppleSubscriptionOwnershipConflictError();
    }

    const legacyOwners = await transaction.get(legacyOwnerQuery);
    const hasCurrentLegacyOwner = legacyOwners.docs
      .some((document) => document.id === firebaseUid);
    const differentLegacyOwner = legacyOwners.docs
      .map((document) => document.id)
      .find((legacyUid) => legacyUid !== firebaseUid);

    if (differentLegacyOwner) {
      throw new AppleSubscriptionOwnershipConflictError();
    }

    const now = adminFirestore.FieldValue.serverTimestamp();

    if (verified.status && verified.status !== "active") {
      if (!existingOwner && !hasCurrentLegacyOwner) {
        throw new AppleSubscriptionOwnershipConflictError();
      }

      transaction.set(ownershipRef, {
        uid: firebaseUid,
        originalTransactionId,
        transactionId: verified.transactionId,
        productId: verified.productId,
        plan: verified.plan,
        status: verified.status,
        expiresAt: verified.expiresAt,
        updatedAt: now,
      }, { merge: true });
      transaction.set(currentUserRef, {
        plan: "free",
        subscriptionStatus: verified.status,
        subscriptionProductId: verified.productId,
        subscriptionTransactionId: verified.transactionId,
        subscriptionOriginalTransactionId: originalTransactionId,
        subscriptionExpiresAt: verified.expiresAt,
        subscriptionUpdatedAt: now,
      }, { merge: true });

      return {
        ownerUid: firebaseUid,
        claimed: false,
        idempotent: true,
        active: false,
      };
    }

    const ownershipData = {
      uid: firebaseUid,
      originalTransactionId,
      transactionId: verified.transactionId,
      productId: verified.productId,
      plan: verified.plan,
      environment: verified.environment,
      appAccountToken: verified.appAccountToken,
      status: "active",
      expiresAt: verified.expiresAt,
      updatedAt: now,
    };

    if (!ownershipSnapshot.exists) {
      ownershipData.createdAt = now;
    }

    transaction.set(ownershipRef, ownershipData, { merge: true });
    transaction.set(currentUserRef, {
      plan: verified.plan,
      subscriptionStatus: "active",
      subscriptionSource: "storekit-verified-jws",
      subscriptionProductId: verified.productId,
      subscriptionTransactionId: verified.transactionId,
      subscriptionOriginalTransactionId: originalTransactionId,
      subscriptionAppAccountToken: verified.appAccountToken,
      subscriptionExpiresAt: verified.expiresAt,
      subscriptionEnvironment: verified.environment,
      subscriptionUpdatedAt: now,
    }, { merge: true });

    return {
      ownerUid: firebaseUid,
      claimed: !ownershipSnapshot.exists,
      idempotent: ownershipSnapshot.exists && existingOwner === firebaseUid,
      active: true,
    };
  });
}
