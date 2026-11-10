type Environment = Readonly<Record<string, string | undefined>>;

export function liveKitConfig(env: Environment) {
  const url = URL.parse(env.LIVEKIT_URL ?? "");
  const local =
    url?.protocol === "ws:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !url ||
    (url.protocol !== "wss:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !env.LIVEKIT_API_KEY ||
    !env.LIVEKIT_API_SECRET
  )
    return null;
  return {
    url: url.href,
    key: env.LIVEKIT_API_KEY,
    secret: env.LIVEKIT_API_SECRET,
  };
}
