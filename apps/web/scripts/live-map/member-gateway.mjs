import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { voiceGate, frameBytes } from "./audio.mjs";
import { discussion } from "./discussion.mjs";

const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};
const maxConnections = 16;
export function memberGateway({ services, access, allowedOrigins }) {
  const rooms = new Map();
  const isActive = (room) => room && rooms.get(room.id) === room;
  let admitting = Promise.resolve(),
    closed = false;
  const server = createServer((req, res) => {
    res
      .writeHead(req.method === "GET" && req.url === "/health" ? 200 : 404)
      .end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 3400,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      closed ||
      req.url !== "/live-map/socket" ||
      !allowedOrigins.includes(req.headers.origin) ||
      sockets.clients.size >= maxConnections
    )
      return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws),
    );
  });

  function publish(room) {
    if (!isActive(room)) return;
    const state = {
      type: "state",
      ...(room.map?.snapshot() ?? {
        graph: { nodes: [], edges: [] },
        turns: [],
        waiting: 0,
        canRetry: false,
      }),
      mappingEnabled: !!room.map,
      expires: room.expires,
      members: [...room.people.values()].map((p) => ({
        name: p.name,
        connected: !!p.ws,
        mic: p.mic,
      })),
    };
    for (const p of room.people.values()) if (p.ws) send(p.ws, state);
  }
  function end(room) {
    if (!isActive(room)) return;
    rooms.delete(room.id);
    room.map?.end();
    clearTimeout(room.empty);
    clearInterval(room.heartbeat);
    clearTimeout(room.deadline);
    for (const p of room.people.values())
      if (p.ws) {
        send(p.ws, { type: "ended" });
        p.ws.close(1000);
      }
    return access.release(room.lease, room.generation).catch(() => {}); // The lease also expires after a crash.
  }
  async function open(person) {
    const generation = randomUUID();
    const lease = await access.roomLease(person);
    const until = await access.claim(lease, person.roomId, generation);
    if (!until) return null;
    const room = {
      id: person.roomId,
      lease,
      generation,
      people: new Map(),
      expires: Date.now() + 30 * 60_000,
    };
    if (closed) {
      await access.release(lease, generation);
      return null;
    }
    room.map = discussion(services, () => publish(room));
    rooms.set(room.id, room);
    const expire = (lease) => {
      clearTimeout(room.deadline);
      room.validUntil = Math.min(room.expires, lease - 2000);
      room.deadline = setTimeout(
        () => void end(room),
        Math.max(0, room.validUntil - Date.now()),
      );
    };
    expire(until);
    let renewing = false;
    room.heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const lease = await access.claim(room.lease, room.id, generation, true);
        if (isActive(room)) {
          if (lease) expire(lease);
          else void end(room);
        }
      } catch {
        /* Keep the last confirmed deadline. */
      } finally {
        renewing = false;
      }
    }, 20_000);
    return room;
  }
  sockets.on("connection", (ws) => {
    let room,
      member,
      unwatch,
      pending = false,
      closing = false;
    let lastText = 0,
      windowStart = Date.now(),
      frames = 0,
      alive = true;
    const reject = (code) => {
      closing = true;
      send(ws, { type: "error", code });
      ws.close(1008);
    };
    const authTimer = setTimeout(() => reject("expired"), 12_000);
    ws.on("error", () => {});
    ws.on("pong", () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) ws.terminate();
      else {
        alive = false;
        ws.ping();
      }
    }, 15_000);
    async function enter(msg) {
      if (closing || ws.readyState !== WebSocket.OPEN) return;
      const person = await access.consume(msg);
      if (closing || ws.readyState !== WebSocket.OPEN) return;
      if (!person) return reject("membership");
      room = rooms.get(person.roomId);
      if (!room && rooms.size >= maxConnections) return reject("capacity");
      room ??= await open(person);
      if (!room) return reject("room-busy");
      if (closing || ws.readyState !== WebSocket.OPEN) {
        if (!room.people.size) void end(room);
        return;
      }
      member = room.people.get(person.uid);
      if (member?.ws && member.version === person.version)
        return reject("second-tab");
      if (!member) {
        if (room.people.size >= 4) return reject("full");
        const names = new Set([...room.people.values()].map((p) => p.name));
        const base = person.name;
        let name = base,
          n = 1;
        while (names.has(name)) name = base + "（" + ++n + "）";
        member = { ...person, name, slot: room.people.size, mic: false };
        room.people.set(person.uid, member);
      }
      member.ws?.close(1008);
      member.version = person.version;
      member.peerAudio = msg.peerAudio !== false;
      member.mic = false;
      member.ws = ws;
      member.gate = null;
      clearTimeout(room.empty);
      clearTimeout(authTimer);
      unwatch = access.watch(person, () => reject("membership"));
      send(ws, { type: "joined", name: member.name, host: member.host });
      publish(room);
    }
    ws.on("message", (data, binary) => {
      if (closing) return;
      if (Date.now() - windowStart >= 1000) {
        windowStart = Date.now();
        frames = 0;
      }
      if (++frames > 40) return reject("limit");
      if (member?.ws !== ws || !member) {
        if (binary || pending) return reject("membership");
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return reject("invalid");
        }
        if (msg?.type !== "member") return reject("membership");
        pending = true;
        // A host and guest can arrive in the same tick; allocate one room and one ordered map.
        admitting = admitting
          .then(() => enter(msg))
          .catch(() => reject("unavailable"));
        return;
      }
      if (!isActive(room) || Date.now() >= room.validUntil)
        return reject("expired");
      if (binary) {
        if (!member.mic || data.length !== frameBytes) return reject("invalid");
        const packet = Buffer.concat([Buffer.from([member.slot]), data]);
        for (const p of room.people.values())
          if (
            member.peerAudio &&
            p.peerAudio &&
            p !== member &&
            p.ws?.readyState === WebSocket.OPEN &&
            p.ws.bufferedAmount < 6 * frameBytes
          )
            p.ws.send(packet);
        if (room.map) {
          member.gate ??= voiceGate((pcm) => {
            if (!room.map.audio(member.name, pcm))
              send(ws, { type: "error", code: "limit" });
          });
          member.gate.push(data);
        }
        return;
      }
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return reject("invalid");
      }
      switch (m?.type) {
        case "mic":
          if (typeof m.on !== "boolean") return reject("invalid");
          if (member.mic && !m.on) member.gate?.finish();
          member.mic = m.on;
          publish(room);
          break;
        case "text": {
          if (!room.map) break;
          const text = typeof m.text === "string" ? m.text.trim() : "";
          if (
            !text ||
            text.length > 1000 ||
            Date.now() - lastText < 500 ||
            !room.map.text(member.name, text)
          )
            return send(ws, { type: "error", code: "limit" });
          lastText = Date.now();
          break;
        }
        case "retry":
        case "skip":
          if (member.host) room.map?.recover(m.id, m.type === "skip");
          break;
        case "stop-map":
          if (member.host && room.map) {
            room.map.end();
            room.map = null;
            // Discard partially captured turns too. Peer audio continues independently.
            for (const p of room.people.values()) p.gate = null;
            publish(room);
          }
          break;
        case "start-map":
          if (member.host && !room.map) {
            room.map = discussion(services, () => publish(room));
            publish(room);
          }
          break;
        case "end":
          if (member.host) void end(room);
          break;
        case "leave":
          send(ws, { type: "left" });
          ws.close(1000);
          break;
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      unwatch?.();
      if (!isActive(room) || member?.ws !== ws) return;
      if (member.mic && !closing) member.gate?.finish();
      member.mic = false;
      member.ws = null;
      member.gate = null;
      publish(room);
      if (![...room.people.values()].some((p) => p.ws))
        room.empty = setTimeout(() => void end(room), 60_000);
    });
  });
  return {
    server,
    async close() {
      closed = true;
      await Promise.all(Array.from(rooms.values(), end));
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.close();
    },
  };
}
