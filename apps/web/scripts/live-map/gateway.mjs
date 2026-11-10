import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { discussion } from "./discussion.mjs";
import { frameBytes, voiceGate } from "./audio.mjs";

const key = () => randomBytes(24).toString("base64url");
const matches = (secret, input) =>
  typeof input === "string" &&
  input.length === 32 &&
  /^[\w-]+$/.test(input) &&
  timingSafeEqual(Buffer.from(secret), Buffer.from(input));
const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};
const fail = (ws, code) => send(ws, { type: "error", code });
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".html": "text/html; charset=utf-8",
};
const minute = 60_000;

// Two separate loopback listeners: only the operator's port can create or end a
// session. A tunnel/SSH forward may target the guest port, never the host port.
export function gateway({
  services,
  appRoot,
  hostPort,
  guestPort,
  guestOrigin,
  share,
}) {
  const local = (port) => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  const guestURL = new URL(guestOrigin ?? local(guestPort)[0]);
  if (
    (guestURL.protocol !== "https:" &&
      !local(guestPort).includes(guestURL.origin)) ||
    guestURL.username ||
    guestURL.password ||
    guestURL.href !== guestURL.origin + "/"
  )
    throw new Error("invalid-guest-origin");
  let room = null;
  function update() {
    if (!room) return;
    const members = room.members.map((p) => ({
      name: p.name,
      connected: !!p.ws,
      mic: p.mic,
    }));
    const event = {
      type: "state",
      members,
      expires: room.expires,
      ...room.map.snapshot(),
    };
    for (const p of room.members) if (p.ws) send(p.ws, event);
  }
  function end() {
    if (!room) return;
    const old = room;
    room = null;
    clearTimeout(old.expiry);
    clearTimeout(old.empty);
    old.map.end();
    for (const p of old.members)
      if (p.ws) {
        send(p.ws, { type: "ended" });
        p.ws.close(1000);
      }
    // Allow the final notification and normal close frame to pass through.
    if (old.stopTunnel) setTimeout(old.stopTunnel, 500).unref();
  }
  function inviteInfo() {
    return room.origin
      ? {
          inviteUrl: room.origin + "/demo/map/live#" + room.invite,
          sharing: "ready",
        }
      : { sharing: room.sharing };
  }
  function announceShare() {
    const host = room?.members.find((p) => p.host)?.ws;
    if (host) send(host, { type: "share", ...inviteInfo() });
  }
  function startShare() {
    if (!share || !room || room.sharing === "starting" || room.origin) return;
    const target = room;
    room.sharing = "starting";
    announceShare();
    room.stopTunnel = share(guestPort, {
      ready(origin) {
        if (room !== target) return;
        room.origin = origin;
        room.sharing = "ready";
        announceShare();
      },
      stopped() {
        if (room !== target) return;
        room.origin = null;
        room.sharing = "failed";
        announceShare();
      },
    });
  }
  function create() {
    const expires = Date.now() + 30 * minute;
    room = {
      invite: key(),
      origin: share ? null : guestURL.origin,
      sharing: "idle",
      stopTunnel: null,
      expires,
      members: [],
      names: new Set(),
      map: discussion(services, update),
      expiry: setTimeout(end, 30 * minute),
      empty: undefined,
    };
    startShare();
  }
  const servers = [];
  for (const isHost of [true, false]) {
    const port = isHost ? hostPort : guestPort;
    const origins = () =>
      !isHost && room?.origin ? [...local(port), room.origin] : local(port);
    const allowedHost = (host) =>
      origins().some((s) => new URL(s).host === host);
    const server = createServer(async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
      res.setHeader("Cache-Control", "no-store");
      const path = (req.url ?? "").split("?")[0];
      if (!allowedHost(req.headers.host) || req.method !== "GET") {
        res.writeHead(404).end();
        return;
      }
      if (path === "/live-map/info") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ host: isHost, tunneled: !!share }));
        return;
      }
      let file;
      if (
        path === "/" ||
        path === "/demo/map/live" ||
        path === "/demo/map/live/"
      )
        file = join(appRoot, ".next/server/app/demo/map/live.html");
      else if (path === "/live-map-capture.js")
        file = join(appRoot, "public/live-map-capture.js");
      else if (
        /^\/_next\/static\/[a-zA-Z0-9_./~-]+$/.test(path) &&
        !path.includes("..") &&
        !path.endsWith(".map")
      )
        file = join(appRoot, ".next", path.slice("/_next/".length));
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(file);
        res
          .writeHead(200, {
            "content-type": mime[extname(file)] ?? "application/octet-stream",
          })
          .end(data);
      } catch {
        res.writeHead(404).end();
      }
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8192,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (
        req.url !== "/live-map/socket" ||
        !allowedHost(req.headers.host) ||
        !origins().includes(req.headers.origin) ||
        new URL(req.headers.origin).host !== req.headers.host ||
        wss.clients.size >= 12
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    });
    wss.on("connection", (ws) => {
      let member,
        session,
        removed = false,
        lastText = 0,
        rateStart = Date.now(),
        frames = 0;
      let alive = true;
      ws.on("error", () => {}); // Never log buffers, names, invitations or SDK errors.
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        else {
          alive = false;
          ws.ping();
        }
      }, 15_000);
      const authTimeout = setTimeout(() => ws.close(1008), 8000);
      const gate = voiceGate((pcm) => {
        if (room && room === session && !room.map.audio(member.name, pcm))
          fail(ws, "limit");
      });
      ws.on("message", (data, binary) => {
        if (Date.now() - rateStart > 1000) {
          rateStart = Date.now();
          frames = 0;
        }
        if (++frames > 40) {
          ws.close(1008);
          return;
        }
        if (binary) {
          if (
            !member ||
            !room ||
            room !== session ||
            !member.mic ||
            data.length !== frameBytes
          ) {
            ws.close(1008);
            return;
          }
          const packet = Buffer.concat([Buffer.from([member.slot]), data]);
          for (const p of room.members)
            if (
              p !== member &&
              p.ws?.readyState === WebSocket.OPEN &&
              p.ws.bufferedAmount < frameBytes * 6
            )
              p.ws.send(packet);
          gate.push(data);
          return;
        }
        let m;
        try {
          m = JSON.parse(data.toString());
        } catch {
          ws.close(1008);
          return;
        }
        if (!m || typeof m !== "object") {
          ws.close(1008);
          return;
        }
        if (!member) {
          const reject = (code) => {
            fail(ws, code);
            ws.close(1008);
          };
          if (m.type === "resume") {
            member = room?.members.find(
              (p) => p.host === isHost && matches(p.resume, m.token) && !p.ws,
            );
            if (!member) return reject("expired");
          } else {
            if (
              !["create", "join"].includes(m.type) ||
              m.consent !== true ||
              typeof m.name !== "string" ||
              !m.name.trim() ||
              m.name.trim().length > 24 ||
              /[\p{C}]/u.test(m.name)
            )
              return reject("invalid");
            if (isHost && m.type === "create" && !room) create();
            else if (isHost) return reject("occupied");
            else if (
              m.type !== "join" ||
              !room ||
              !matches(room.invite, m.invite)
            )
              return reject("invite");
            if (room.members.length >= 4) return reject("full");
            const name = m.name.trim();
            if (room.names.has(name)) return reject("name");
            const slot = [0, 1, 2, 3].find(
              (i) => !room.members.some((p) => p.slot === i),
            );
            member = {
              name,
              host: isHost,
              slot,
              resume: key(),
              mic: false,
              ws: null,
            };
            room.members.push(member);
            room.names.add(name);
          }
          session = room;
          clearTimeout(authTimeout);
          clearTimeout(room.empty);
          member.ws = ws;
          send(ws, {
            type: "joined",
            name: member.name,
            host: isHost,
            resume: member.resume,
            ...(isHost && inviteInfo()),
          });
          update();
          return;
        }
        if (!room || room !== session || member.ws !== ws) return;
        if (m.type === "share" && member.host && room.sharing === "failed") {
          startShare();
          return;
        }
        if (m.type === "end" && member.host && isHost) {
          end();
          return;
        }
        if (m.type === "leave") {
          removed = true;
          send(ws, { type: "left" });
          ws.close(1000);
          return;
        }
        if (m.type === "mic" && typeof m.on === "boolean") {
          if (member.mic && !m.on) gate.finish();
          member.mic = m.on;
          update();
        } else if (m.type === "text" && typeof m.text === "string") {
          const text = m.text.trim();
          if (!text || text.length > 1000) return fail(ws, "invalid");
          if (Date.now() - lastText < 500 || !room.map.text(member.name, text))
            return fail(ws, "limit");
          lastText = Date.now();
        } else if (m.type === "research") {
          const code = room.map.research(m.id, m.retryId);
          if (code) fail(ws, code);
        } else if (member.host && ["retry", "skip"].includes(m.type))
          room.map.recover(m.id, m.type === "skip");
      });
      ws.on("close", () => {
        clearTimeout(authTimeout);
        clearInterval(heartbeat);
        if (!member || !room || room !== session || member.ws !== ws) return;
        if (member.mic) gate.finish();
        member.mic = false;
        member.ws = null;
        if (removed) {
          room.members = room.members.filter((p) => p !== member);
          room.names.delete(member.name);
        }
        update();
        if (room.members.every((p) => !p.ws))
          room.empty = setTimeout(end, minute);
      });
    });
    servers.push({ server, wss, port });
  }
  return {
    async start() {
      try {
        for (const { server, port } of servers)
          await new Promise((ok, no) => {
            server.once("error", no);
            server.listen(port, "127.0.0.1", ok);
          });
      } catch (err) {
        for (const { server } of servers) server.close();
        throw err;
      }
    },
    async close() {
      end();
      await Promise.all(
        servers.map(
          ({ server, wss }) =>
            new Promise((ok) => {
              for (const ws of wss.clients) ws.terminate();
              wss.close();
              server.close(ok);
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
