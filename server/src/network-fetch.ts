// 统一 undici fetch 与代理 Agent 生命周期：显式 proxy 用 ProxyAgent，系统代理用 EnvHttpProxyAgent。
// Agent 按配置签名缓存；配置变更或服务关闭时显式 close，避免 keep-alive 连接挂住进程。
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { ResolvedNetworkConfig } from "./network-config";

export type NetworkFetchInit = Parameters<typeof undiciFetch>[1];
export type NetworkFetch = (input: string | URL, init?: NetworkFetchInit) => ReturnType<typeof undiciFetch>;

function configSignature(config: ResolvedNetworkConfig): string {
  return JSON.stringify({
    proxy: config.proxy,
    useEnvProxy: config.useEnvProxy,
    noProxy: config.noProxy
  });
}

/** 有状态网络客户端：同一配置复用同一个 dispatcher，变更后旧 Agent 主动关闭。 */
export class NetworkClient {
  private config: ResolvedNetworkConfig;
  private dispatcher: Dispatcher | null = null;
  private signature = "";
  private closed = false;

  constructor(config: ResolvedNetworkConfig) {
    this.config = config;
  }

  update(config: ResolvedNetworkConfig): void {
    this.config = config;
    if (this.closed) return;
    const next = configSignature(config);
    if (next === this.signature) return;
    const previous = this.dispatcher;
    this.dispatcher = null;
    this.signature = "";
    if (previous) void previous.close().catch(() => undefined);
  }

  private ensureDispatcher(): Dispatcher {
    if (this.closed) throw new Error("网络客户端已关闭");
    const next = configSignature(this.config);
    if (this.dispatcher && next === this.signature) return this.dispatcher;
    const previous = this.dispatcher;
    if (previous) void previous.close().catch(() => undefined);
    if (this.config.proxy) {
      this.dispatcher = new ProxyAgent(this.config.proxy);
    } else if (this.config.useEnvProxy) {
      this.dispatcher = new EnvHttpProxyAgent({ noProxy: this.config.noProxy || undefined });
    } else {
      this.dispatcher = new Agent();
    }
    this.signature = next;
    return this.dispatcher;
  }

  fetch: NetworkFetch = (input, init) => {
    const dispatcher = this.ensureDispatcher();
    return undiciFetch(input, { ...(init ?? {}), dispatcher } as NetworkFetchInit);
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    this.signature = "";
    if (dispatcher) await dispatcher.close().catch(() => undefined);
  }
}
