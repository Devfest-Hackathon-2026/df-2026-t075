import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDatabaseConnection } from "./connection-check";

vi.mock("server-only", () => ({}));
const ops = vi.hoisted(() => ({
  write:
    vi.fn<
      (_db: unknown, row: { id: string; marker: string }) => Promise<void>
    >(),
  read: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("./generated", () => ({
  connectorConfig: {
    location: "asia-northeast1",
    serviceId: "unit-test",
    connector: "app",
  },
  writeConnectionCheck: ops.write,
  readConnectionCheck: ops.read,
  removeConnectionCheck: ops.remove,
}));

describe("SQL Connect database check", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-unit-test");
    vi.stubEnv("DATA_CONNECT_EMULATOR_HOST", undefined);
    return () => vi.unstubAllEnvs();
  });

  it("reads back the same marker and removes only that check's row", async () => {
    ops.read.mockImplementationOnce(() => {
      const row = ops.write.mock.calls[0]![1];
      return { data: { connectionCheck: { marker: row.marker } } };
    });
    await verifyDatabaseConnection();
    const [db, { id }] = ops.write.mock.calls[0]!;
    expect(ops.read).toHaveBeenCalledWith(db, { id });
    expect(ops.remove).toHaveBeenCalledWith(db, { id });
  });

  it("rejects a stale read and still cleans up", async () => {
    ops.read.mockResolvedValueOnce({
      data: { connectionCheck: { marker: "stale" } },
    });
    await expect(verifyDatabaseConnection()).rejects.toThrow("readback");
    expect(ops.remove).toHaveBeenCalledOnce();
  });

  it("cleans up even if the write response was lost after commit", async () => {
    ops.write.mockRejectedValueOnce(new Error("write response lost"));
    await expect(verifyDatabaseConnection()).rejects.toThrow(
      "write response lost",
    );
    expect(ops.read).not.toHaveBeenCalled();
    expect(ops.remove).toHaveBeenCalledOnce();
  });

  it.each([
    ["GOOGLE_CLOUD_PROJECT", ""],
    ["DATA_CONNECT_EMULATOR_HOST", "127.0.0.1:9399"],
  ])("does not run a live check with invalid %s", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(verifyDatabaseConnection()).rejects.toThrow(
      "live SQL Connect project",
    );
    expect(ops.write).not.toHaveBeenCalled();
  });
});
