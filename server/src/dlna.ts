// DLNA 兼容模式：SSDP 发现 + AVTransport SOAP 控制 + 1s 轮询
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import * as net from "node:net";
import * as os from "node:os";
import { XMLParser } from "fast-xml-parser";
import type { DeviceView, TvState, TvStatusPayload } from "./types";

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SSDP_TIMEOUT_MS = 5000;
const DISCOVER_INTERVAL_MS = 60000;
const DISCOVER_RETRY_MS = 15000;
const POLL_INTERVAL_MS = 1000;
const OFFLINE_FAILURE_LIMIT = 5;
const MAX_DEVICES = 64;
const MAX_SSDP_LOCATIONS = 64;
const MAX_XML_BYTES = 512 * 1024;
const MAX_SOAP_BYTES = 512 * 1024;
const STALE_DEVICE_MS = 5 * 60 * 1000;
const VOLUME_POLL_INTERVAL_MS = 2000;
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";

export interface DlnaDeviceInfo {
  id: string;
  deviceName: string;
  address: string;
  controlURL: string;
  /** RenderingControl 服务的 controlURL；设备不提供该服务时为 null。 */
  renderingControlURL: string | null;
}

interface DlnaRuntime {
  info: DlnaDeviceInfo;
  online: boolean;
  failures: number;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  volumeTimer: NodeJS.Timeout | null;
  volumePolling: boolean;
  volume: number | null;
  lastStatus: TvStatusPayload | null;
  lastSeenAt: number;
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
  const regex = new RegExp(`<(?:(?:[\\w.-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:(?:[\\w.-]+):)?${name}>`, "i");
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

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}

function ipv4Mask(mask: string): number | null {
  return ipv4ToInt(mask);
}

function sameSubnet(address: string, ifaceAddress: string, netmask: string): boolean {
  const a = ipv4ToInt(address);
  const b = ipv4ToInt(ifaceAddress);
  const m = ipv4Mask(netmask);
  if (a === null || b === null || m === null) return false;
  return (a & m) === (b & m);
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isPrivateAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return true;
  if (net.isIPv4(address)) {
    const value = ipv4ToInt(address);
    if (value === null) return false;
    const ranges: Array<[number, number]> = [
      [ipv4ToInt("10.0.0.0")!, ipv4ToInt("10.255.255.255")!],
      [ipv4ToInt("172.16.0.0")!, ipv4ToInt("172.31.255.255")!],
      [ipv4ToInt("192.168.0.0")!, ipv4ToInt("192.168.255.255")!],
      [ipv4ToInt("100.64.0.0")!, ipv4ToInt("100.127.255.255")!]
    ];
    return ranges.some(([start, end]) => value >= start && value <= end);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::1") return true;
    // 仅 ULA（fc00::/7）视为私网；IPv6 链路本地地址不纳入 DLNA/SSRF 白名单。
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return false;
}

function isLocalNetworkAddress(address: string, allowLoopback: boolean): boolean {
  if (isLoopbackAddress(address)) return allowLoopback;
  // SECURITY.md 的 DLNA 白名单是「同网段或私网」：私网地址即使不在本机网段也允许，
  // 否则双路由/VLAN/访客网络下电视能被 SSDP 发现却会被来源过滤误杀。
  if (isPrivateAddress(address)) return true;
  if (!net.isIPv4(address)) return false;
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      if (sameSubnet(address, info.address, info.netmask)) return true;
    }
  }
  return false;
}

function ssdpInterfaceAddresses(allowLoopback: boolean): string[] {
  const addresses: string[] = [];
  const add = (address: string): void => {
    if (!addresses.includes(address)) addresses.push(address);
  };
  if (allowLoopback) add("127.0.0.1");
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info || info.internal || info.family !== "IPv4") continue;
      // 只在私网 IPv4 网卡上发 SSDP，避免把多播包发进 VPN/公网网卡。
      if (isPrivateAddress(info.address)) add(info.address);
    }
  }
  return addresses;
}

async function assertSafeUrl(raw: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL 格式错误");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http/https URL");
  if (url.username || url.password) throw new Error("URL 不允许携带凭据");
  if (!url.hostname) throw new Error("URL 缺少主机");

  let addresses: string[];
  if (net.isIP(url.hostname)) {
    addresses = [url.hostname];
  } else {
    const resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
    addresses = resolved.map((item) => item.address);
  }
  if (addresses.length === 0) throw new Error("主机无法解析");
  if (!addresses.every((address) => isLocalNetworkAddress(address, allowLoopback))) {
    throw new Error(`URL 主机不在局域网内: ${url.hostname}`);
  }
  return url;
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error("响应体过大");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("响应体过大");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function ssdpSearch(st: string, allowLoopback: boolean): Promise<string[]> {
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
    socket.on("message", (message, rinfo) => {
      if (!isLocalNetworkAddress(rinfo.address, allowLoopback)) return;
      if (locations.size >= MAX_SSDP_LOCATIONS) return;
      const response = parseSsdpResponse(message.toString());
      if (response.location) locations.add(response.location);
    });
    socket.on("error", (error) => {
      console.error(`[dlna] SSDP ${st} 错误: ${error.message}`);
      finish();
    });
    socket.bind(0, "0.0.0.0", () => {
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
      const addresses = ssdpInterfaceAddresses(allowLoopback);
      const targets: Array<string | null> = addresses.length > 0 ? addresses : [null];
      try {
        socket.setMulticastTTL(4);
      } catch {
        // ignore
      }
      let sent = 0;
      const sendOne = (): void => {
        for (const address of targets) {
          if (address) {
            try {
              socket.setMulticastInterface(address);
            } catch (error) {
              console.error(`[dlna] SSDP ${st} 设置网卡失败 ${address}: ${(error as Error).message}`);
              continue;
            }
          }
          socket.send(packet, SSDP_PORT, SSDP_ADDRESS, (error) => {
            if (error) console.error(`[dlna] SSDP ${st} 发送失败: ${error.message}`);
          });
        }
        sent += 1;
        if (sent < 3) setTimeout(sendOne, 300);
      };
      sendOne();
    });
  });
}

function parseDeviceDescription(xml: string, location: string): DlnaDeviceInfo | null {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true, processEntities: false });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }
  const root = asRecord(asRecord(parsed).root);
  const device = asRecord(root.device);
  const udn = String(device.UDN ?? "").trim().slice(0, 256);
  if (!udn) return null;
  const services = asArray(asRecord(device.serviceList).service).map(asRecord);
  const avTransport = services.find((service) =>
    String(service.serviceType ?? "").includes(":service:AVTransport:")
  );
  if (!avTransport) return null;
  const controlRaw = String(avTransport.controlURL ?? "").trim().slice(0, 2048);
  if (!controlRaw) return null;
  let controlURL: string;
  try {
    controlURL = new URL(controlRaw, location).toString();
  } catch {
    return null;
  }
  // RenderingControl 与 AVTransport 是两个独立服务、两个 controlURL，不能复用。
  const renderingControl = services.find((service) =>
    String(service.serviceType ?? "").includes(":service:RenderingControl:")
  );
  let renderingControlURL: string | null = null;
  if (renderingControl) {
    const renderingRaw = String(renderingControl.controlURL ?? "").trim().slice(0, 2048);
    if (renderingRaw) {
      try {
        renderingControlURL = new URL(renderingRaw, location).toString();
      } catch {
        renderingControlURL = null;
      }
    }
  }
  return {
    id: udn,
    deviceName: String(device.friendlyName ?? "DLNA 电视").trim().slice(0, 64) || "DLNA 电视",
    address: location,
    controlURL,
    renderingControlURL
  };
}

export class DlnaService {
  private devices = new Map<string, DlnaRuntime>();
  private discoverTimer: NodeJS.Timeout | null = null;
  private discovering = false;
  private started = false;
  private disposed = false;
  private discoverPromise: Promise<DlnaDeviceInfo[]> | null = null;
  private activePolls = new Set<Promise<void>>();
  private allowLoopback: boolean;

  onDevicesChanged: (() => void) | null = null;
  onTvStatus: ((deviceId: string, status: TvStatusPayload) => void) | null = null;
  onDeviceError: ((deviceId: string, message: string) => void) | null = null;

  constructor(options: { allowLoopback?: boolean } = {}) {
    this.allowLoopback = options.allowLoopback ?? process.env.DLNA_ALLOW_LOOPBACK === "1";
  }

  list(): DeviceView[] {
    return Array.from(this.devices.values()).map((runtime) => ({
      id: runtime.info.id,
      address: runtime.info.address,
      online: runtime.online,
      type: "dlna" as const,
      deviceName: runtime.info.deviceName,
      volume: runtime.volume
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
    this.disposed = false;
    this.runDiscoveryCycle();
  }

  private runDiscoveryCycle(): void {
    if (this.disposed) return;
    const first = this.discover();
    this.discoverPromise = first;
    void first.finally(() => {
      if (this.discoverPromise === first) this.discoverPromise = null;
      this.scheduleNextDiscovery();
    });
  }

  private scheduleNextDiscovery(): void {
    if (this.disposed) return;
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    const delay = this.devices.size > 0 ? DISCOVER_INTERVAL_MS : DISCOVER_RETRY_MS;
    this.discoverTimer = setTimeout(() => {
      this.discoverTimer = null;
      this.runDiscoveryCycle();
    }, delay);
  }

  async discover(): Promise<DlnaDeviceInfo[]> {
    if (this.disposed || this.discovering) return [];
    this.discovering = true;
    const found: DlnaDeviceInfo[] = [];
    const seenIds = new Set<string>();
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
            seenIds.add(info.id);
            this.upsert(info, "DLNA_SEED");
          }
        }
        if (this.disposed) return found;
        this.pruneStale(seenIds);
        return found;
      }

      const responses = await Promise.all([
        ssdpSearch(MEDIA_RENDERER, this.allowLoopback),
        ssdpSearch("ssdp:all", this.allowLoopback)
      ]);
      const locations = Array.from(new Set(responses.flat())).slice(0, MAX_SSDP_LOCATIONS);
      for (const location of locations) {
        const info = await this.loadDevice(location);
        if (!info) continue;
        found.push(info);
        seenIds.add(info.id);
        this.upsert(info, "DLNA_DISCOVERED");
      }
      if (this.disposed) return found;
      if (found.length === 0) console.log("[dlna] SSDP 扫描完成，未发现 MediaRenderer");
      this.pruneStale(seenIds);
      return found;
    } catch (error) {
      console.error(`[dlna] 发现失败: ${(error as Error).message}`);
      return found;
    } finally {
      this.discovering = false;
    }
  }

  async play(id: string, url: string, title: string, mimeType: string, resumePositionMs?: number | null): Promise<void> {
    if (this.disposed) throw new Error("DLNA 服务已关闭");
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
    runtime.lastSeenAt = Date.now();
    runtime.lastStatus = {
      state: "buffering",
      positionMs: 0,
      durationMs: runtime.lastStatus?.durationMs ?? 0,
      volume: runtime.volume
    };
    this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    this.startPolling(runtime);
    this.emitDevices();
    if (typeof resumePositionMs === "number" && Number.isFinite(resumePositionMs) && resumePositionMs > 0) {
      // DLNA 电视在 Play 后需要稳定时间才能接受 Seek：共等 1s（500ms × 2）。
      await new Promise((resolve) => setTimeout(resolve, 500));
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await this.control(runtime.info.id, "seek", resumePositionMs);
      } catch (error) {
        this.onDeviceError?.(runtime.info.id, `SEEK_FAILED: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  async control(
    id: string,
    action: "pause" | "resume" | "stop" | "seek" | "volume",
    positionMs?: number,
    value?: number
  ): Promise<boolean> {
    if (this.disposed) return false;
    const runtime = this.devices.get(id);
    if (!runtime) return false;
    if (action === "volume") {
      if (!runtime.info.renderingControlURL) return false;
      if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 100) return false;
      const volume = Math.round(value as number);
      await this.soap(
        runtime,
        "SetVolume",
        "<InstanceID>0</InstanceID><Channel>Master</Channel>" +
          `<DesiredVolume>${volume}</DesiredVolume>`,
        RENDERING_CONTROL,
        runtime.info.renderingControlURL
      );
      this.applyVolume(runtime, volume);
      return true;
    }
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
        durationMs: runtime.lastStatus?.durationMs ?? 0,
        volume: runtime.volume
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
        durationMs: runtime.lastStatus?.durationMs ?? 0,
        volume: runtime.volume
      };
      this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.started = false;
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    this.discoverTimer = null;
    for (const runtime of this.devices.values()) {
      if (runtime.pollTimer) clearInterval(runtime.pollTimer);
      runtime.pollTimer = null;
      if (runtime.volumeTimer) clearInterval(runtime.volumeTimer);
      runtime.volumeTimer = null;
    }
    const pendingDiscover = this.discoverPromise;
    if (pendingDiscover) await Promise.allSettled([pendingDiscover]);
    await Promise.allSettled(Array.from(this.activePolls));
    this.devices.clear();
  }

  private async loadDevice(location: string): Promise<DlnaDeviceInfo | null> {
    let safeLocation: URL;
    try {
      safeLocation = await assertSafeUrl(location, this.allowLoopback);
    } catch (error) {
      console.error(`[dlna] 拒绝设备地址 ${location}: ${(error as Error).message}`);
      return null;
    }
    try {
      const response = await fetch(safeLocation, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (!response.ok) {
        console.error(`[dlna] device.xml HTTP ${response.status}: ${safeLocation.toString()}`);
        return null;
      }
      const xml = await readLimitedText(response, MAX_XML_BYTES);
      return parseDeviceDescription(xml, safeLocation.toString());
    } catch (error) {
      console.error(`[dlna] 读取 device.xml 失败 ${safeLocation.toString()}: ${(error as Error).message}`);
      return null;
    }
  }

  private pruneStale(seenIds: Set<string>): void {
    const now = Date.now();
    for (const [id, runtime] of this.devices) {
      if (!seenIds.has(id) && !runtime.online && now - runtime.lastSeenAt > STALE_DEVICE_MS) {
        if (runtime.pollTimer) clearInterval(runtime.pollTimer);
        if (runtime.volumeTimer) clearInterval(runtime.volumeTimer);
        this.devices.delete(id);
        console.log(`[dlna] 清理离线设备 ${runtime.info.deviceName}`);
      }
    }
  }

  private upsert(info: DlnaDeviceInfo, source: "DLNA_DISCOVERED" | "DLNA_SEED"): void {
    if (this.disposed) return;
    const existing = this.devices.get(info.id);
    if (existing) {
      existing.info = info;
      existing.lastSeenAt = Date.now();
      if (!existing.online) {
        existing.online = true;
        this.emitDevices();
      }
      this.startVolumePolling(existing);
      return;
    }
    if (this.devices.size >= MAX_DEVICES) {
      console.warn(`[dlna] 设备数量达到上限 ${MAX_DEVICES}，忽略 ${info.deviceName}`);
      return;
    }
    this.devices.set(info.id, {
      info,
      online: true,
      failures: 0,
      pollTimer: null,
      polling: false,
      volumeTimer: null,
      volumePolling: false,
      volume: null,
      lastStatus: null,
      lastSeenAt: Date.now()
    });
    console.log(`${source} ${info.deviceName} ${info.controlURL}`);
    this.emitDevices();
    this.startVolumePolling(this.devices.get(info.id) as DlnaRuntime);
  }

  private async soap(
    runtime: DlnaRuntime,
    action: string,
    inner: string,
    serviceType: string = AV_TRANSPORT,
    controlURL: string = runtime.info.controlURL
  ): Promise<string> {
    const controlUrl = await assertSafeUrl(controlURL, this.allowLoopback);
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${action} xmlns:u="${serviceType}">${inner}</u:${action}>` +
      "</s:Body></s:Envelope>";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(controlUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${action}"`
        },
        body,
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`SOAP ${action} HTTP ${response.status}`);
      }
      return await readLimitedText(response, MAX_SOAP_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  private startVolumePolling(runtime: DlnaRuntime): void {
    if (this.disposed || !runtime.info.renderingControlURL || runtime.volumeTimer) return;
    // 发现设备后先立即 GetVolume 一次，之后独立 2s 轮询，与 1s 播放轮询分开。
    this.runVolumePoll(runtime, true);
    runtime.volumeTimer = setInterval(() => this.runVolumePoll(runtime), VOLUME_POLL_INTERVAL_MS);
  }

  private runVolumePoll(runtime: DlnaRuntime, initial = false): void {
    const promise = this.refreshVolume(runtime, initial).finally(() => {
      this.activePolls.delete(promise);
    });
    this.activePolls.add(promise);
  }

  private async refreshVolume(runtime: DlnaRuntime, initial = false): Promise<void> {
    if (this.disposed || !runtime.info.renderingControlURL || runtime.volumePolling) return;
    runtime.volumePolling = true;
    try {
      const xml = await this.soap(
        runtime,
        "GetVolume",
        "<InstanceID>0</InstanceID><Channel>Master</Channel>",
        RENDERING_CONTROL,
        runtime.info.renderingControlURL
      );
      const parsed = Number.parseInt(localValue(xml, "CurrentVolume"), 10);
      this.applyVolume(runtime, Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null);
    } catch {
      // 音量不可用不等于设备离线；仅首次探测失败把 volume 标为 null。
      if (initial) this.applyVolume(runtime, null);
    } finally {
      runtime.volumePolling = false;
    }
  }

  private applyVolume(runtime: DlnaRuntime, volume: number | null): void {
    if (runtime.volume === volume) return;
    runtime.volume = volume;
    if (runtime.lastStatus) {
      runtime.lastStatus = { ...runtime.lastStatus, volume };
      this.onTvStatus?.(runtime.info.id, runtime.lastStatus);
    }
    this.emitDevices();
  }

  private startPolling(runtime: DlnaRuntime): void {
    if (this.disposed || runtime.pollTimer) return;
    runtime.pollTimer = setInterval(() => this.runPoll(runtime), POLL_INTERVAL_MS);
    this.runPoll(runtime);
  }

  private runPoll(runtime: DlnaRuntime): void {
    const promise = this.poll(runtime).finally(() => {
      this.activePolls.delete(promise);
    });
    this.activePolls.add(promise);
  }

  private async poll(runtime: DlnaRuntime): Promise<void> {
    if (this.disposed || runtime.polling || this.devices.get(runtime.info.id) !== runtime) return;
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
      runtime.lastSeenAt = Date.now();
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
        durationMs: duration,
        volume: runtime.volume
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
