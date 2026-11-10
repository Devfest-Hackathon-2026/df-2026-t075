import { expect, type Page } from "@playwright/test";

export async function signInWithTestGoogle(
  page: Page,
  email: string,
  name: string,
) {
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Googleでログイン" }).click();
  const popup = await popupPromise;
  // The emulator renders the button before it initializes the provider and its click handler.
  await expect(popup.locator("#title .provider-name")).toHaveText(
    "Google.com",
    {
      timeout: 30_000,
    },
  );
  await popup.getByRole("button", { name: "Add new account" }).click();
  await popup.locator("#email-input").fill(email);
  await popup.locator("#display-name-input").fill(name);
  const result = page.waitForResponse("**/api/auth/me");
  await popup.getByRole("button", { name: /Sign in with Google/i }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  expect(response.request().method()).toBe("PUT");
  const identity = await response.json();
  expect(identity).toEqual({ uid: expect.any(String) });
  return identity as { uid: string };
}
