// The wire to the analyzer: a serial port (RS-232 / USB adapter) or a TCP socket (LAN).
// Gives { write(buf), close() } and calls onData(buf) / onState(text). Reconnects by itself.
import net from "node:net";
import { log } from "./log.js";

export function openTransport(conn, { name, onData, onState }) {
  return conn?.type === "tcp" ? openTcp(conn, { name, onData, onState }) : openSerial(conn || {}, { name, onData, onState });
}

function openTcp(conn, { name, onData, onState }) {
  let socket = null;
  let server = null;
  let closed = false;
  let retry = null;

  const attach = (s, how) => {
    if (socket && socket !== s) socket.destroy();
    socket = s;
    s.setKeepAlive(true, 30000);
    onState(`connected (${how})`);
    log("info", `[${name}] analyzer connected ${how}`);
    s.on("data", onData);
    s.on("error", (e) => log("warn", `[${name}] socket error: ${e.message}`));
    s.on("close", () => {
      if (socket === s) socket = null;
      onState("waiting for the analyzer");
      if (!closed && conn.mode === "client") retry = setTimeout(connect, 5000);
    });
  };

  function connect() {
    if (closed) return;
    const s = net.connect({ host: conn.host, port: conn.tcpPort });
    s.once("connect", () => attach(s, `to ${conn.host}:${conn.tcpPort}`));
    s.once("error", (e) => { onState(`cannot reach ${conn.host}:${conn.tcpPort}`); log("warn", `[${name}] ${e.message}`); s.destroy(); if (!closed) retry = setTimeout(connect, 5000); });
  }

  if (conn.mode === "client") connect();
  else {
    server = net.createServer((s) => attach(s, `from ${s.remoteAddress}`));
    server.on("error", (e) => { onState(`port ${conn.tcpPort} busy: ${e.message}`); log("error", `[${name}] listen ${conn.tcpPort}: ${e.message}`); });
    server.listen(conn.tcpPort, "0.0.0.0", () => onState(`listening on port ${conn.tcpPort}`));
  }
  return {
    write: (buf) => { if (socket) socket.write(buf); else log("warn", `[${name}] not connected, reply dropped`); },
    close: () => { closed = true; clearTimeout(retry); socket?.destroy(); server?.close(); },
  };
}

// Tests swap the real port for serialport's mock (no COM port or driver needed)
let SerialClass = null;
export function useSerialPortClass(cls) { SerialClass = cls; }

function openSerial(conn, { name, onData, onState }) {
  let port = null;
  let closed = false;
  let retry = null;
  async function open() {
    if (closed) return;
    let SerialPort = SerialClass;
    if (!SerialPort) {
      try { ({ SerialPort } = await import("serialport")); } catch {
        onState("serial support missing (reinstall LabXpro Bridge)"); log("error", `[${name}] the serialport package is not installed`); return;
      }
    }
    port = new SerialPort({
      path: conn.port || "COM1", baudRate: conn.baud || 9600, dataBits: conn.dataBits || 8,
      parity: conn.parity || "none", stopBits: conn.stopBits || 1, autoOpen: false,
    });
    port.on("data", onData);
    port.on("error", (e) => log("warn", `[${name}] ${conn.port}: ${e.message}`));
    port.on("close", () => { onState(`${conn.port} closed`); if (!closed) retry = setTimeout(open, 5000); });
    port.open((e) => {
      if (e) { onState(`cannot open ${conn.port}: ${e.message}`); log("warn", `[${name}] open ${conn.port}: ${e.message}`); if (!closed) retry = setTimeout(open, 10000); return; }
      onState(`${conn.port} open at ${conn.baud || 9600} baud`);
      log("info", `[${name}] ${conn.port} open`);
    });
  }
  open();
  return {
    write: (buf) => { if (port?.isOpen) port.write(buf); },
    close: () => { closed = true; clearTimeout(retry); if (port?.isOpen) port.close(); },
  };
}
