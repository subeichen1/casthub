#!/usr/bin/env node
// CastHub fake-dlna：纯 Node 模拟 UPnP MediaRenderer（SSDP + AVTransport SOAP）
import dgram from "node:dgram";
import http from "node:http";
import { randomUUID } from "node:crypto";

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = Number(process.env.FAKE_DLNA_SSDP_PORT ?? 1900);
const HTTP_PORT = Number(process.env.FAKE_DLNA_HTTP_PORT ?? 0);
const NAME = process.env.FAKE_DLNA_NAME ?? "Fake DLNA TV";
const UDN = "uuid:" + randomUUID();
const DURATION_MS = Number(process.env.FAKE_DLNA_DURATION_MS ?? 60000);
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";

let transportState = "STOPPED";
let positionMs = 0;
let lastTick = Date.now();
let currentUri = "";
let volume = 50;
let muted = false;

function settlePosition() {
  if (transportState === "PLAYING") {
    positionMs += Date.now() - lastTick;
    lastTick = Date.now();
  }
}

function currentPosition() {
  const value = transportState === "PLAYING" ? positionMs + (Date.now() - lastTick) : positionMs;
  return Math.max(0, Math.min(DURATION_MS, value));
}

function formatHms(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function parseHms(value) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(value || "").trim());
  if (!match) return 0;
  return Math.max(0, Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000));
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagValue(xml, name) {
  const regex = new RegExp("<(?:[\\w.-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?" + name + ">", "i");
  const match = regex.exec(xml);
  return match ? xmlUnescape(match[1]).trim() : "";
}

function sendXml(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", 'text/xml; charset="utf-8"');
  res.end(body);
}

function soapResponse(action, fields, serviceType = AV_TRANSPORT) {
  const inner = Object.entries(fields)
    .map(([key, value]) => "<" + key + ">" + xmlEscape(value) + "</" + key + ">")
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:' + action + 'Response xmlns:u="' + serviceType + '">' +
    inner +
    "</u:" + action + "Response></s:Body></s:Envelope>"
  );
}

function soapFault(message) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    "<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>" +
    "<detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\">" +
    "<errorCode>501</errorCode><errorDescription>" + xmlEscape(message) + "</errorDescription>" +
    "</UPnPError></detail></s:Fault></s:Body></s:Envelope>"
  );
}

function deviceXml() {
  return (
    '<?xml version="1.0"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    "<device>" +
    "<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>" +
    "<friendlyName>" + xmlEscape(NAME) + "</friendlyName>" +
    "<UDN>" + UDN + "</UDN>" +
    "<serviceList>" +
    "<service>" +
    "<serviceType>" + AV_TRANSPORT + "</serviceType>" +
    "<serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>" +
    "<controlURL>/control</controlURL>" +
    "<eventSubURL>/event</eventSubURL>" +
    "<SCPDURL>/scpd/avtransport.xml</SCPDURL>" +
    "</service>" +
    "<service>" +
    "<serviceType>" + RENDERING_CONTROL + "</serviceType>" +
    "<serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>" +
    "<controlURL>/control</controlURL>" +
    "<eventSubURL>/event</eventSubURL>" +
    "<SCPDURL>/scpd/renderingcontrol.xml</SCPDURL>" +
    "</service>" +
    "</serviceList>" +
    "</device></root>"
  );
}

function scpdXml(service) {
  const actions =
    service === "renderingcontrol"
      ? "<actionList>" +
        "<action><name>GetVolume</name></action>" +
        "<action><name>SetVolume</name></action>" +
        "<action><name>GetMute</name></action>" +
        "<action><name>SetMute</name></action>" +
        "</actionList>"
      : "<actionList></actionList>";
  return (
    '<?xml version="1.0"?>' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    "<specVersion><major>1</major><minor>0</minor></specVersion>" +
    actions +
    "</scpd>"
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleSoap(req, res) {
  const body = await readBody(req);
  const soapAction = String(req.headers.soapaction || "");
  const serviceMatch = /^"?(urn:[^#"]+)#/.exec(soapAction);
  const serviceType = serviceMatch ? serviceMatch[1] : "";
  const match = /#([A-Za-z0-9_]+)"?$/.exec(soapAction);
  const action = match ? match[1] : "";
  if (!action) {
    sendXml(res, 500, soapFault("missing SOAPACTION"));
    return;
  }
  try {
    if (serviceType === RENDERING_CONTROL && action === "GetVolume") {
      sendXml(res, 200, soapResponse(action, { CurrentVolume: String(volume) }, serviceType));
      return;
    }
    if (serviceType === RENDERING_CONTROL && action === "SetVolume") {
      const raw = tagValue(body, "DesiredVolume");
      if (!/^\d+$/.test(raw)) throw new Error("DesiredVolume 必须是整数");
      const next = Number(raw);
      if (next < 0 || next > 100) throw new Error("DesiredVolume 越界");
      volume = next;
      console.log("VOLUME " + volume);
      sendXml(res, 200, soapResponse(action, {}, serviceType));
      return;
    }
    if (serviceType === RENDERING_CONTROL && action === "GetMute") {
      sendXml(res, 200, soapResponse(action, { CurrentMute: muted ? "1" : "0" }, serviceType));
      return;
    }
    if (serviceType === RENDERING_CONTROL && action === "SetMute") {
      const raw = tagValue(body, "DesiredMute");
      if (raw !== "0" && raw !== "1") throw new Error("DesiredMute 必须是 0/1");
      muted = raw === "1";
      sendXml(res, 200, soapResponse(action, {}, serviceType));
      return;
    }
    if (action === "SetAVTransportURI") {
      const uri = tagValue(body, "CurrentURI");
      if (!uri) throw new Error("CurrentURI 为空");
      const probe = await fetch(uri, { headers: { Range: "bytes=0-1023" } });
      await probe.arrayBuffer();
      if (probe.status !== 206) throw new Error("媒体地址不支持 Range: HTTP " + probe.status);
      settlePosition();
      currentUri = uri;
      positionMs = 0;
      transportState = "STOPPED";
      console.log("MEDIA_PROBE 206 " + uri);
      sendXml(res, 200, soapResponse(action, {}));
      return;
    }
    if (action === "Play") {
      settlePosition();
      transportState = "PLAYING";
      lastTick = Date.now();
      sendXml(res, 200, soapResponse(action, { Speed: "1" }));
      return;
    }
    if (action === "Pause") {
      settlePosition();
      transportState = "PAUSED_PLAYBACK";
      sendXml(res, 200, soapResponse(action, {}));
      return;
    }
    if (action === "Stop") {
      settlePosition();
      transportState = "STOPPED";
      positionMs = 0;
      sendXml(res, 200, soapResponse(action, {}));
      return;
    }
    if (action === "Seek") {
      settlePosition();
      const target = tagValue(body, "Target");
      positionMs = Math.max(0, Math.min(DURATION_MS, parseHms(target)));
      lastTick = Date.now();
      console.log("SEEK " + target + " -> " + positionMs + "ms");
      sendXml(res, 200, soapResponse(action, {}));
      return;
    }
    if (action === "GetTransportInfo") {
      sendXml(res, 200, soapResponse(action, {
        CurrentTransportState: transportState,
        CurrentTransportStatus: "OK",
        CurrentSpeed: "1"
      }));
      return;
    }
    if (action === "GetPositionInfo") {
      sendXml(res, 200, soapResponse(action, {
        Track: currentUri ? "1" : "0",
        TrackDuration: formatHms(DURATION_MS),
        TrackMetaData: "",
        TrackURI: currentUri,
        RelTime: formatHms(currentPosition()),
        AbsTime: formatHms(currentPosition()),
        RelCount: "0",
        AbsCount: "0"
      }));
      return;
    }
    if (action === "GetMediaInfo") {
      sendXml(res, 200, soapResponse(action, {
        NrTracks: currentUri ? "1" : "0",
        MediaDuration: formatHms(DURATION_MS),
        CurrentURI: currentUri,
        CurrentURIMetaData: "",
        NextURI: "",
        NextURIMetaData: "",
        PlayMedium: "NETWORK",
        RecordMedium: "NOT_IMPLEMENTED",
        WriteStatus: "NOT_IMPLEMENTED"
      }));
      return;
    }
    sendXml(res, 500, soapFault("unsupported action: " + action));
  } catch (error) {
    console.error("SOAP_ERROR " + action + " " + error.message);
    sendXml(res, 500, soapFault(error.message));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/device.xml") {
    sendXml(res, 200, deviceXml());
    return;
  }
  if (req.method === "GET" && req.url === "/scpd.xml") {
    sendXml(res, 200, scpdXml("avtransport"));
    return;
  }
  if (req.method === "GET" && req.url === "/scpd/avtransport.xml") {
    sendXml(res, 200, scpdXml("avtransport"));
    return;
  }
  if (req.method === "GET" && req.url === "/scpd/renderingcontrol.xml") {
    sendXml(res, 200, scpdXml("renderingcontrol"));
    return;
  }
  if (req.method === "POST" && req.url === "/control") {
    void handleSoap(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/event") {
    res.statusCode = 200;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(HTTP_PORT, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : HTTP_PORT;
  console.log("LOCATION http://127.0.0.1:" + port + "/device.xml");
  console.log("UDN " + UDN);
  console.log("FAKE_DLNA_READY " + NAME);
});

const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (message, rinfo) => {
  const text = message.toString();
  if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
  const lines = text.split(/\r?\n/);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  const st = headers.get("st") || "";
  if (st !== "urn:schemas-upnp-org:device:MediaRenderer:1" && st !== "ssdp:all") return;
  const response = [
    "HTTP/1.1 200 OK",
    "CACHE-CONTROL: max-age=1800",
    "EXT:",
    "LOCATION: http://127.0.0.1:" + server.address().port + "/device.xml",
    "SERVER: OS/1.0 UPnP/1.0 FakeDLNA/1.0",
    "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
    "USN: " + UDN + "::urn:schemas-upnp-org:device:MediaRenderer:1",
    "",
    ""
  ].join("\r\n");
  udp.send(Buffer.from(response), rinfo.port, rinfo.address);
});

udp.on("error", (error) => {
  console.error("SSDP_DISABLED " + error.message);
  try { udp.close(); } catch { /* ignore */ }
});

udp.bind(SSDP_PORT, () => {
  try {
    udp.addMembership(SSDP_ADDRESS);
    console.log("SSDP_READY " + SSDP_ADDRESS + ":" + SSDP_PORT);
  } catch (error) {
    console.error("SSDP_DISABLED " + error.message);
  }
});

function shutdown() {
  try { udp.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
