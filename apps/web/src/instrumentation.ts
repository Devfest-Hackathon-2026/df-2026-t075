export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeServerRuntime } =
      await import("./server/composition/runtime.server");
    initializeServerRuntime();
  }
}
