export interface ProviderProxyRuntime<TProxy> {
  baseUrl: string;
  proxy: TProxy;
}

export class ProviderProxyRuntimeRegistry<TOptions, TProxy extends { close(): Promise<void> }> {
  constructor(
    startRuntime: (
      key: string,
      options: TOptions,
      retain: (runtime: ProviderProxyRuntime<TProxy>) => void,
    ) => Promise<ProviderProxyRuntime<TProxy>>,
  );
  ensure(
    key: string,
    options: TOptions,
  ): Promise<ProviderProxyRuntime<TProxy>>;
  get(key: string): ProviderProxyRuntime<TProxy> | undefined;
  addUser(key: string, user: string): void;
  removeUser(key: string, user: string): void;
  hasUsers(key: string): boolean;
  close(proxy: TProxy): Promise<void>;
  values(): ProviderProxyRuntime<TProxy>[];
}
