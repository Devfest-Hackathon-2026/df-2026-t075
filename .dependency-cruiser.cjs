const source = "^apps/web/src/";
const server = `${source}server/`;
const serverLayers = `${server}(domain|application|infrastructure|composition)/`;

module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-unresolved-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "domain-is-independent",
      severity: "error",
      from: { path: `${server}domain/` },
      to: { pathNot: `${server}domain/` },
    },
    {
      name: "application-only-depends-on-domain",
      severity: "error",
      from: { path: `${server}application/` },
      to: { pathNot: `${server}(application|domain)/` },
    },
    {
      name: "client-only-depends-on-client-source",
      severity: "error",
      from: { path: `${source}client/` },
      to: { path: source, pathNot: `${source}client/` },
    },
    {
      // Local allowlists also prevent a server/utils or src/utils detour.
      name: "server-only-depends-on-defined-server-layers",
      severity: "error",
      from: { path: server },
      to: { path: source, pathNot: serverLayers },
    },
    {
      name: "infrastructure-does-not-call-composition",
      severity: "error",
      from: { path: `${server}infrastructure/` },
      to: { path: `${server}composition/` },
    },
    {
      name: "presentation-uses-composition-not-adapters",
      severity: "error",
      from: { path: `${source}app/` },
      to: {
        path: source,
        pathNot: `${source}(app|client|server/(domain|application|composition))/`,
      },
    },
    {
      name: "instrumentation-enters-through-composition",
      severity: "error",
      from: { path: `${source}instrumentation\\.ts$` },
      to: { path: source, pathNot: `${server}composition/` },
    },
    {
      name: "external-services-live-in-infrastructure",
      severity: "error",
      from: {
        path: source,
        pathNot: `${source}(client|server/(infrastructure|composition))/`,
      },
      to: {
        path: "node_modules/(firebase|firebase-admin|@google-cloud|@google/genai|livekit-server-sdk|@livekit/agents)(/|$)",
      },
    },
    {
      name: "client-does-not-import-server-sdks",
      severity: "error",
      from: { path: `${source}client/` },
      to: {
        // Firebase's browser SDK is allowed here; admin and server SDKs are not.
        path: "node_modules/(firebase-admin|@google-cloud|@google/genai|livekit-server-sdk|@livekit/agents)(/|$)",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.(test|spec)\\.[cm]?[jt]sx?$" },
    // Type-only imports must follow the same boundaries as runtime imports.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "apps/web/tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
