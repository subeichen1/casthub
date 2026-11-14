// DLNA 兼容模式：SSDP 发现 + AVTransport SOAP 控制 + 1s 轮询
import { createSocket } from "node:dgram";
import { XMLParser } from "fast-xml-parser";
import type { DeviceView, TvState, TvStatusPayload } from "./types";

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SSDP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 1000;
const OFFLINE_FAILURE_LIMIT = 5;
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";

export interface DlnaDeviceInfo {
  id: string;
  deviceName: string;
  address: string;
  controlURL: string;
}

interface DlnaRuntime {
  info: DlnaDeviceInfo;
  online: boolean;
  failures: number;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  lastStatus: TvStatusPayload | null;
}

interface SsdpResponse {
  location?: string;
  st?: string;
  usn?: string;
}

type XmlRecord = Record<string, unknown>;

function asRecord(value: unknown): XmlRecord {
  return value && typeof value === "object" ? (value as XmlRecord) : {};
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function formatHms(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseHms(value: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.max(0, Math.round((hours * 3600 + minutes * 60 + seconds) * 1000));
}

function localValue(xml: string, name: string): string {
  const regex = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "i");
  const match = regex.exec(xml);
  return match ? decodeXml(match[1]).trim() : "";
}

function parseSsdpResponse(text: string): SsdpResponse {
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.1\s+200/i.test(lines[0] ?? "")) return {};
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return {
    location: headers.get("location"),
    st: headers.get("st"),
    usn: headers.get("usn")
  };
}

function buildDidl(url: string, title: string, mimeType: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    "<upnp:class>object.item.videoItem</upnp:class>" +
    `<res protocolInfo="http-get:*:${escapeXml(mimeType)}:*">${escapeXml(url)}</res>` +
    "</item></DIDL-Lite>"
  );
}

function ssdpSearch(st: string): Promise<string[]> {
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    let finished = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(Array.from(locations));
    };

    timer = setTimeout(finish, SSDP_TIMEOUT_MS);
    socket.on("message", (message) => {
      const response = parseSsdpResponse(message.toString());
      if (response.location) locations.add(response.location);
    });
    socket.on("error", (error) => {
      console.error(`[dlna] SSDP ${st} 错误: ${error.message}`);
      finish();
    });
    socket.bind(() => {
      const packet = Buffer.from(
        [
          "M-SEARCH * HTTP/1.1",
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          "MX: 3",
          `ST: ${st}`,
          "",
          ""
        ].join("\r\n")
      );
      let sent = 0;
      const sendOne = (): void => {
        socket.send(packet, SSDP_PORT, SSDP_ADDRESS, (error) => {
          if (error) console.error(`[dlna] SSDP ${st} 发送失败: ${error.message}`);
        });
        sent += 1;
        if (sent < 3) setTimeout(sendOne, 300);
      };
      sendOne();
    });
  });
}

function parseDeviceDescription(xml: string, location: string): DlnaDeviceInfo | null {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }
  const root = asRecord(asRecord(parsed).root);
  const device = asRecord(root.device);
  const udn = String(device.UDN ?? "").trim();
  if (!udn) return null;
  const services = asArray(asRecord(device.serviceList).service).map(asRecord);
  const avTransport = services.find((service) =>
    String(service.serviceType ?? "").includes(":service:AVTransport:")
  );
  if (!avTransport) return null;
  const controlRaw = String(avTransport.controlURL ?? "").trim();
  if (!controlRaw) return null;
  let controlURL: string;
  try {
    controlURL = new URL(controlRaw, location).toString();
  } catch {
    return null;
  }
  return {
    id: udn,
    deviceName: String(device.friendlyName ?? "DLNA 电视").trim() || "DLNA 电视",
    address: location,
    controlURL
  };
}

export class DlnaService {
  private devices = new Map<string, DlnaRuntime>();
  private discoverTimer: NodeJS.Timeout | null = null;
  private discovering = false;
  private started = false;

  onDevicesChanged: (() => void) | null = null;
  onTvStatus: ((deviceId: string, status: TvStatusPayload) => void) | null = null;
  onDeviceError: ((deviceId: string, message: string) => void) | null = null;

  list(): DeviceView[] {
    return Array.from(this.devices.values()).map((runtime) => ({
      id: runtime.info.id,
      address: runtime.info.address,
      online: runtime.online,
      type: "dlna" as const,
      deviceName: runtime.info.deviceName
    }));
  }

  has(id: string): boolean {
    return this.devices.has(id);
  }

  findByAddress(address: string): DlnaDeviceInfo | null {
    const needle = address.trim();
    if (!needle) return null;
    for (const runtime of this.devices.values()) {
      if (runtime.info.address === needle) return runtime.info;
    }
    return null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.discover();
    this.discoverTimer = setInterval(() => void this.discover(), 60000);
  }

  async discover(): Promise<DlnaDeviceInfo[]> {
    if (this.discovering) return [];
    this.discovering = true;
    const found: DlnaDeviceInfo[] = [];
    try {
      const seed = (process.env.DLNA_SEED ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (seed.length > 0) {
        for (const location of seed) {
          const info = await this.loadDevice(location);
          if (info) {
            found.push(info);
            this.upsert(info, "DLNA_SEED");
          }
        }
        return found;
      }

      const responses = await Promise.all([ssdpSearch(MEDIA_RENDERER), ssdpSearch("ssdp:all")]);
      const locations = Array.from(new Set(responses.flat()));
      for (const location of locations) {
        const info = await this.loadDevice(location);
        if (!info) continue;
        found.push(info);
        this.upsert(info, "DLNA_DISCOVERED");
      }
      if (found.length === 0) console.log("[dlna] SSDP 扫描完成，未发现 MediaRenderer");
      return found;
    } catch (error) {
      console.error(`[dlna] 发现失败: ${(error as Error).message}`);
      return found;
    } finally {
      this.discovering = false;
    }
  }

  async play(id: string, url: string, title: string, mimeType: string): Promise<void> {
    const runtime = this.devices.get(id);
    if (!runtime) throw new Error("DLNA 设备不存在");
    const active =
      runtime.lastStatus &&
      (runtime.lastStatus.state === "playing" ||
        runtime.lastStatus.state === "paused" ||
        runtime.lastStatus.state === "buffering");
    if (active) {
      try {
        await this.soap(runtime, "Stop", "");
      } catch {
        // 有的电视没有当前媒体时会拒绝 Stop，继续 SetAVTransportURI。
      }
    }
    const didl = buildDidl(url, title, mimeType);
    await this.soap(
      runtime,
      "SetAVTransportURI",
      "<InstanceID>0</InstanceID>" +
        `<CurrentURI>${escapeXml(url)}</CurrentURI>` +
        `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.soap(runtime, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
    runtime.online = true;
    runtime.failures = 0;
    runtime.lastStatus = { state: "buffering", positionMs: 0, durationMs: runtime.lastStatus?.durationMs ?? 0 };
    this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    this.startPolling(runtime);
    this.emitDevices();
  }

  async control(id: string, action: "pause" | "resume" | "stop" | "seek", positionMs?: number): Promise<boolean> {
    const runtime = this.devices.get(id);
    if (!runtime) return false;
    if (action === "seek") {
      if (!Number.isFinite(positionMs) || (positionMs as number) < 0) return false;
      await this.soap(
        runtime,
        "Seek",
        "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit>" +
          `<Target>${formatHms(positionMs as number)}</Target>`
      );
      runtime.lastStatus = {
        state: runtime.lastStatus?.state ?? "playing",
        positionMs: Math.round(positionMs as number),
        durationMs: runtime.lastStatus?.durationMs ?? 0
      };
      this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
      return true;
    }
    const actionName = action === "pause" ? "Pause" : action === "resume" ? "Play" : "Stop";
    const extra = action === "resume" ? "<Speed>1</Speed>" : "";
    await this.soap(runtime, actionName, `<InstanceID>0</InstanceID>${extra}`);
    if (action === "stop") {
      runtime.lastStatus = {
        state: "idle",
        positionMs: 0,
        durationMs: runtime.lastStatus?.durationMs ?? 0
      };
      this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    }
    return true;
  }

  dispose(): void {
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    this.discoverTimer = null;
    for (const runtime of this.devices.values()) {
      if (runtime.pollTimer) clearInterval(runtime.pollTimer);
      runtime.pollTimer = null;
    }
    this.devices.clear();
  }

  private async loadDevice(location: string): Promise<DlnaDeviceInfo | null> {
    try {
      const response = await fetch(location, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        console.error(`[dlna] device.xml HTTP ${response.status}: ${location}`);
        return null;
      }
      const xml = await response.text();
      return parseDeviceDescription(xml, location);
    } catch (error) {
      console.error(`[dlna] 读取 device.xml 失败 ${location}: ${(error as Error).message}`);
      return null;
    }
  }

  private upsert(info: DlnaDeviceInfo, source: "DLNA_DISCOVERED" | "DLNA_SEED"): void {
    const existing = this.devices.get(info.id);
    if (existing) {
      existing.info = info;
      if (!existing.online) {
        existing.online = true;
        this.emitDevices();
      }
      return;
    }
    this.devices.set(info.id, {
      info,
      online: true,
      failures: 0,
      pollTimer: null,
      polling: false,
      lastStatus: null
    });
    console.log(`${source} ${info.deviceName} ${info.controlURL}`);
    this.emitDevices();
  }

  private async soap(runtime: DlnaRuntime, action: string, inner: string): Promise<string> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${action} xmlns:u="${AV_TRANSPORT}">${inner}</u:${action}>` +
      "</s:Body></s:Envelope>";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(runtime.info.controlURL, {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPACTION: `"${AV_TRANSPORT}#${action}"`
        },
        body,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`SOAP ${action} HTTP ${response.status}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private startPolling(runtime: DlnaRuntime): void {
    if (runtime.pollTimer) return;
    runtime.pollTimer = setInterval(() => void this.poll(runtime), POLL_INTERVAL_MS);
    void this.poll(runtime);
  }

  private async poll(runtime: DlnaRuntime): Promise<void> {
    if (runtime.polling) return;
    runtime.polling = true;
    try {
      let transportXml = "";
      let positionXml = "";
      let anySuccess = false;
      try {
        transportXml = await this.soap(runtime, "GetTransportInfo", "<InstanceID>0</InstanceID>");
        anySuccess = true;
      } catch {
        // 单次失败静默跳过
      }
      try {
        positionXml = await this.soap(runtime, "GetPositionInfo", "<InstanceID>0</InstanceID>");
        anySuccess = true;
      } catch {
        // 单次失败静默跳过
      }
      if (!anySuccess) throw new Error("SOAP 轮询失败");
      runtime.failures = 0;
      if (!runtime.online) {
        runtime.online = true;
        this.emitDevices();
      }
      const rawState = localValue(transportXml, "CurrentTransportState").toUpperCase();
      const mapped = this.mapState(rawState);
      const state = mapped ?? runtime.lastStatus?.state ?? "idle";
      const position = positionXml ? parseHms(localValue(positionXml, "RelTime")) : runtime.lastStatus?.positionMs ?? 0;
      const duration = positionXml ? parseHms(localValue(positionXml, "TrackDuration")) : runtime.lastStatus?.durationMs ?? 0;
      runtime.lastStatus = {
        state,
        positionMs: position,
        durationMs: duration
      };
      this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    } catch {
      runtime.failures += 1;
      if (runtime.failures >= OFFLINE_FAILURE_LIMIT && runtime.online) {
        runtime.online = false;
        this.emitDevices();
      }
    } finally {
      runtime.polling = false;
    }
  }

  private mapState(rawState: string): TvState | null {
    switch (rawState) {
      case "STOPPED":
      case "NO_MEDIA_PRESENT":
        return "idle";
      case "TRANSITIONING":
        return "buffering";
      case "PLAYING":
        return "playing";
      case "PAUSED_PLAYBACK":
        return "paused";
      default:
        return null;
    }
  }

  private emitDevices(): void {
    this.onDevicesChanged?.();
  }
}
