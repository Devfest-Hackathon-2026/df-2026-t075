import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";

export type SignInConfig = {
  projectId: string;
  apiKey: string;
  authDomain: string;
  appId: string;
  emulatorUrl: string | null;
};

export type AccountState =
  | { status: "checking" | "signed-out" | "unverified" }
  | { status: "signed-in"; uid: string; name: string | null };

function browserAuth({ emulatorUrl, ...options }: SignInConfig) {
  const auth = getAuth(initializeApp(options, "meeting-web"));
  if (emulatorUrl && !auth.emulatorConfig) {
    connectAuthEmulator(auth, new URL(emulatorUrl, location.origin).origin, {
      disableWarnings: true,
    });
  }
  return auth;
}

export function signInWithGoogle(config: SignInConfig) {
  return signInWithPopup(browserAuth(config), new GoogleAuthProvider());
}

export function signOutOfGoogleSession(config: SignInConfig) {
  return signOut(browserAuth(config));
}

export async function currentIdToken(config: SignInConfig) {
  const user = browserAuth(config).currentUser;
  if (!user) throw new Error("Googleでログインしてください。");
  return user.getIdToken();
}

async function ensureAccount(user: User, signal: AbortSignal): Promise<void> {
  const token = await user.getIdToken();
  const response = await fetch("/api/auth/me", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!response.ok || (await response.json()).uid !== user.uid) {
    throw new Error("Account verification failed.");
  }
}

export function observeAccount(
  config: SignInConfig,
  update: (state: AccountState) => void,
) {
  let verification: AbortController | undefined;
  let verifiedUid: string | undefined;
  const unsubscribe = onIdTokenChanged(browserAuth(config), async (user) => {
    verification?.abort();
    if (!user) {
      verifiedUid = undefined;
      update({ status: "signed-out" });
      return;
    }
    const controller = new AbortController();
    verification = controller;
    if (verifiedUid !== user.uid) update({ status: "checking" });
    try {
      await ensureAccount(
        user,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (!controller.signal.aborted) {
        verifiedUid = user.uid;
        update({ status: "signed-in", uid: user.uid, name: user.displayName });
      }
    } catch {
      if (!controller.signal.aborted) {
        verifiedUid = undefined;
        update({ status: "unverified" });
      }
    }
  });
  return () => {
    unsubscribe();
    verification?.abort();
  };
}
