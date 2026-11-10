export type LogLevel = "info" | "warn" | "error";

export type ServerEnvironment = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: LogLevel;
}>;

export class EnvironmentConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid server configuration: ${fields.join(", ")}`);
    this.name = "EnvironmentConfigurationError";
  }
}

/** Validate only owned settings; never copy or print environment values. */
export function readServerEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): ServerEnvironment {
  const nodeEnv = values.NODE_ENV ?? "development";
  const logLevel = values.APP_LOG_LEVEL ?? "info";
  const invalidFields: string[] = [];

  if (!isNodeEnvironment(nodeEnv)) invalidFields.push("NODE_ENV");
  if (!isLogLevel(logLevel)) invalidFields.push("APP_LOG_LEVEL");

  if (!isNodeEnvironment(nodeEnv) || !isLogLevel(logLevel)) {
    throw new EnvironmentConfigurationError(invalidFields);
  }

  return Object.freeze({ nodeEnv, logLevel });
}

function isNodeEnvironment(
  value: string,
): value is ServerEnvironment["nodeEnv"] {
  return value === "development" || value === "test" || value === "production";
}

function isLogLevel(value: string): value is LogLevel {
  return value === "info" || value === "warn" || value === "error";
}
