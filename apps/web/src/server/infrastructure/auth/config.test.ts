import { describe, expect, it } from "vitest";
import { readAuthConfig } from "./config";

const web = {
  GOOGLE_CLOUD_PROJECT: "example-project",
  FIREBASE_AUTH_DOMAIN: "example-project.firebaseapp.com",
  FIREBASE_WEB_API_KEY: "public-web-key",
  FIREBASE_WEB_APP_ID: "web-id",
};

describe("public auth configuration", () => {
  it("exposes only the Web SDK options", () => {
    expect(
      readAuthConfig({
        ...web,
        DB_CHECK_TOKEN: "private",
        FIREBASE_AUTH_EMULATOR_SAME_ORIGIN: "1",
      }),
    ).toEqual({
      projectId: "example-project",
      authDomain: web.FIREBASE_AUTH_DOMAIN,
      apiKey: web.FIREBASE_WEB_API_KEY,
      appId: web.FIREBASE_WEB_APP_ID,
      emulatorUrl: null,
    });
  });

  it.each(Object.keys(web))("disables sign-in without %s", (key) => {
    expect(readAuthConfig({ ...web, [key]: "" })).toBeNull();
  });

  it("only allows emulated identities with a local Firestore and a demo project", () => {
    const emulator = {
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
    };
    expect(readAuthConfig({ ...web, ...emulator })).toBeNull();
    const demo = { GOOGLE_CLOUD_PROJECT: "demo-meeting-auth" };
    expect(
      readAuthConfig({
        ...demo,
        ...emulator,
        FIREBASE_AUTH_EMULATOR_HOST: "remote:9099",
      }),
    ).toBeNull();
    expect(
      readAuthConfig({
        ...demo,
        FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
      }),
    ).toBeNull();
    expect(
      readAuthConfig({
        ...demo,
        ...emulator,
        FIRESTORE_EMULATOR_HOST: "remote:8180",
      }),
    ).toBeNull();
    expect(readAuthConfig({ ...demo, ...emulator })).toMatchObject({
      projectId: demo.GOOGLE_CLOUD_PROJECT,
      emulatorUrl: `http://${emulator.FIREBASE_AUTH_EMULATOR_HOST}`,
    });
    expect(
      readAuthConfig({
        ...demo,
        ...emulator,
        FIREBASE_AUTH_EMULATOR_SAME_ORIGIN: "1",
      })?.emulatorUrl,
    ).toBe("/");
  });
});
