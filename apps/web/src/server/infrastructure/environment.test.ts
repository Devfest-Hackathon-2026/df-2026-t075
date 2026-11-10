import { describe, expect, it } from "vitest";
import {
  EnvironmentConfigurationError,
  readServerEnvironment,
} from "./environment";

describe("server environment", () => {
  it("starts without cloud credentials and returns only owned settings", () => {
    expect(
      readServerEnvironment({ UNRELATED_SECRET: "must-not-copy" }),
    ).toEqual({
      nodeEnv: "development",
      logLevel: "info",
    });
  });

  it.each(["info", "warn", "error"])("accepts the %s log level", (logLevel) => {
    expect(
      readServerEnvironment({
        NODE_ENV: "production",
        APP_LOG_LEVEL: logLevel,
      }),
    ).toEqual({ nodeEnv: "production", logLevel });
  });

  it("reports all invalid keys without exposing their values", () => {
    const secret = "secret-that-must-not-appear";

    try {
      readServerEnvironment({ NODE_ENV: secret, APP_LOG_LEVEL: secret });
      expect.unreachable("Invalid configuration must stop startup");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentConfigurationError);
      expect((error as EnvironmentConfigurationError).fields).toEqual([
        "NODE_ENV",
        "APP_LOG_LEVEL",
      ]);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each(["", "INFO", " info", "debug"])(
    "rejects the unsupported log level %j instead of silently falling back",
    (logLevel) => {
      expect(() => readServerEnvironment({ APP_LOG_LEVEL: logLevel })).toThrow(
        "APP_LOG_LEVEL",
      );
    },
  );
});
