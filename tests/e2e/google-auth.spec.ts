import { expect, test } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { signInWithTestGoogle } from "./sign-in";

test("Google sign-in creates a durable user profile and restores the session", async ({
  page,
}) => {
  test.slow(); // The first Firestore request can include emulator startup.
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(initializeApp({ projectId: "demo-meeting-auth" }));
  await page.goto("/");
  const googleButton = page.getByRole("button", { name: "Googleでログイン" });
  const identity = await signInWithTestGoogle(
    page,
    "participant@example.test",
    "テスト参加者",
  );
  await expect(page.getByText("テスト参加者 さんでログイン中")).toBeVisible();
  const profile = db.collection("users").doc(identity.uid);
  const initial = await profile.get();
  expect(initial.data()).toEqual({
    displayName: "テスト参加者",
    createdAt: expect.any(Timestamp),
  });

  // A saved Firebase login still has to pass server verification on reload.
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await expect(
    page.getByText("ログイン状態を確認できませんでした。"),
  ).toBeVisible();
  await page.unroute("**/api/auth/me");
  const restored = page.waitForResponse("**/api/auth/me");
  await page.getByRole("button", { name: "再確認する" }).click();
  expect(await (await restored).json()).toEqual(identity);
  await expect(page.getByText("テスト参加者 さんでログイン中")).toBeVisible();
  expect((await profile.get()).updateTime).toEqual(initial.updateTime);

  // Two visits can initialize an account that predates profiles.
  await profile.delete();
  const secondTab = await page.context().newPage();
  await Promise.all([page.reload(), secondTab.goto("/")]);
  await expect(page.getByText("テスト参加者 さんでログイン中")).toBeVisible();
  await expect(
    secondTab.getByText("テスト参加者 さんでログイン中"),
  ).toBeVisible();
  expect((await profile.get()).exists).toBe(true);
  await secondTab.close();

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(googleButton).toBeVisible();
  await page.reload();
  await expect(googleButton).toBeVisible();
  expect((await profile.get()).exists).toBe(true);
});

test("the identity endpoint requires a verified bearer token", async ({
  request,
}) => {
  const cases: Record<string, string>[] = [
    {},
    { Authorization: "Bearer invalid-test-token" },
  ];
  for (const method of ["GET", "PUT"]) {
    for (const headers of cases) {
      const response = await request.fetch("/api/auth/me", { headers, method });
      expect(response.status()).toBe(401);
      expect(response.headers()["www-authenticate"]).toBe("Bearer");
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  }
});
