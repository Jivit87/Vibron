/**
 * Optional Firestore backing for the key/value store. Local dev has no
 * Firebase project configured, so this resolves to null and lib/store.ts
 * falls back to its disk-backed in-memory map.
 */
import type { Firestore } from "firebase-admin/firestore";

let cached: Firestore | null | undefined;

export function getFirestoreDb(): Firestore | null {
  if (cached !== undefined) return cached;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    cached = null;
    return cached;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initializeApp, getApps, cert } = require("firebase-admin/app");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFirestore } = require("firebase-admin/firestore");

    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });

    cached = getFirestore(app);
  } catch {
    cached = null;
  }

  return cached;
}
