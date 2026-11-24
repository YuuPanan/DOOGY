export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); this.name = 'ApiError'; }
}
export type Session = { access_token: string; refresh_token: string; expires_at?: string };
export type TokenStore = { read(): Promise<string | null>; write(token: string | null): Promise<void> };
export type RequestOptions = { method?: string; body?: any; key?: string; signal?: AbortSignal; responseType?: 'json' | 'response'; fingerprint?: string };
const publicAuth = new Set(['/health', '/auth/login', '/auth/register', '/auth/password-recovery', '/auth/password-reset']);
const key = () => `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export class ApiClient {
  readonly origin: string;
  readonly baseUrl: string;
  accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshing: Promise<void> | null = null;
  private generation = 0;
  private writing: Promise<void> = Promise.resolve();
  private pending = new Map<string, string>();
  constructor(origin: string, private store: TokenStore, private expired: () => void = () => {}, private transport: typeof fetch = (input, init) => fetch(input, init)) {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)) throw new Error('请输入服务器根地址，不含账号、路径或查询参数');
    this.origin = url.origin; this.baseUrl = `${this.origin}/api/v1`;
  }
  url(path: string) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) throw new Error('无效接口地址');
    return this.baseUrl + (path.startsWith('/api/v1/') ? path.slice(7) : path);
  }
  private persist(token: string | null) { const write = this.writing.then(() => this.store.write(token)); this.writing = write.catch(() => {}); return write; }
  async setSession(session: Session) {
    if (!session.access_token || !session.refresh_token) throw new ApiError(502, 'INVALID_SESSION', '服务器未返回有效会话');
    this.generation++; this.pending.clear(); this.accessToken = session.access_token; this.refreshToken = session.refresh_token; await this.persist(session.refresh_token);
  }
  async restore() {
    const epoch = this.generation, token = await this.store.read();
    if (epoch !== this.generation) throw new ApiError(401, 'SESSION_CHANGED', '会话已变更，请重新读取');
    if (!token) return false;
    this.refreshToken = token;
    try { await this.refreshAccess(); return true; }
    catch (error) { if (error instanceof ApiError && error.status === 401) return false; throw error; }
  }
  async clear() { this.generation++; this.accessToken = null; this.refreshToken = null; this.pending.clear(); await this.persist(null); }
  private async expireSession() {
    const clearing = this.clear(), epoch = this.generation;
    try { await clearing; } finally { if (epoch === this.generation) this.expired(); }
  }
  get sessionEpoch() { return this.generation; }
  protected requireEpoch(epoch: number) { if (epoch !== this.generation || !this.accessToken) throw new ApiError(401, 'SESSION_CHANGED', '会话已变更，请重新读取'); }
  private async send(url: string, options: RequestInit, milliseconds = 20000) {
    if (options.signal) return this.transport(url, options);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), milliseconds);
    try { return await this.transport(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
  }
  private async parse(response: Response) {
    const text = await response.text(); let value: any;
    try { value = text ? JSON.parse(text) : {}; } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器未返回有效业务响应'); }
    if (!response.ok) throw new ApiError(response.status, value.code ?? `HTTP_${response.status}`, `${Array.isArray(value.message) ? value.message.join('；') : value.message ?? '请求未完成'}${value.code ? ` (${value.code})` : ''}`, value.request_id);
    return value;
  }
  private refreshAccess(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const epoch = this.generation;
    this.refreshing = (async () => {
      try {
        if (!this.refreshToken) throw new ApiError(401, 'LOGIN_REQUIRED', '请重新登录');
        const response = await this.send(`${this.baseUrl}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: this.refreshToken }) }, 15000);
        const value = await this.parse(response);
        if (epoch !== this.generation) throw new ApiError(401, 'SESSION_CHANGED', '会话已更改，请重新登录');
        if (!value.access_token || !value.refresh_token) throw new ApiError(502, 'INVALID_SESSION', '刷新会话响应无效，请稍后重试');
        this.accessToken = value.access_token; this.refreshToken = value.refresh_token; await this.persist(value.refresh_token);
      } catch (error) { if (epoch === this.generation && error instanceof ApiError && error.status === 401) await this.expireSession(); throw error; }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    const epoch = this.generation;
    const method = options.method ?? 'GET', form = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const mutation = !['GET', 'HEAD'].includes(method), isPublic = publicAuth.has(path.split('?')[0]);
    const fingerprint = `${method} ${path} ${options.fingerprint ?? (form ? 'multipart' : JSON.stringify(options.body ?? null))}`;
    const ownedKey = mutation && !isPublic && !options.key;
    const requestKey = mutation && !isPublic ? options.key ?? this.pending.get(fingerprint) ?? key() : undefined;
    if (ownedKey) { if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!); this.pending.set(fingerprint, requestKey!); }
    const execute = async (token: string | null) => { if (!isPublic) this.requireEpoch(epoch); return this.send(this.url(path), { method, headers: {
      ...(!form && options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(!isPublic && token ? { Authorization: `Bearer ${token}` } : {}), ...(requestKey ? { 'Idempotency-Key': requestKey } : {})
    }, body: options.body === undefined ? undefined : form ? options.body : JSON.stringify(options.body), signal: options.signal }); };
    try {
      const usedToken = this.accessToken; let response = await execute(usedToken);
      if (response.status === 401 && !isPublic) {
        this.requireEpoch(epoch);
        if (this.accessToken === usedToken) await this.refreshAccess();
        response = await execute(this.accessToken);
        if (response.status === 401) { this.requireEpoch(epoch); await this.expireSession(); }
      }
      if (options.responseType === 'response' && response.ok) { if (!isPublic) this.requireEpoch(epoch); if (ownedKey) this.pending.delete(fingerprint); return response as T; }
      const value = await this.parse(response); if (!isPublic) this.requireEpoch(epoch); if (ownedKey) this.pending.delete(fingerprint); return value as T;
    } catch (error) {
      if (error instanceof ApiError) { if (ownedKey && error.status < 500) this.pending.delete(fingerprint); throw error; }
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器；未确认保存。恢复网络后可重试同一内容。');
    }
  }
  get<T = any>(path: string) { return this.request<T>(path); }
  post<T = any>(path: string, body?: any, key?: string) { return this.request<T>(path, { method: 'POST', body, key }); }
  patch<T = any>(path: string, body?: any, key?: string) { return this.request<T>(path, { method: 'PATCH', body, key }); }
  put<T = any>(path: string, body?: any, key?: string) { return this.request<T>(path, { method: 'PUT', body, key }); }
  delete<T = any>(path: string, body?: any, key?: string) { return this.request<T>(path, { method: 'DELETE', body, key }); }
  async upload(path: string, file: { uri: string; name: string; mimeType?: string }, key?: string, options: { method?: 'POST' | 'PUT'; fields?: Record<string, string> } = {}) {
    const body = new FormData();
    if (typeof document !== 'undefined') body.append('file', await (await fetch(file.uri)).blob(), file.name);
    else body.append('file', { uri: file.uri, name: file.name, type: file.mimeType ?? 'application/octet-stream' } as any);
    for (const [name, value] of Object.entries(options.fields ?? {})) body.append(name, value);
    return this.request(path, { method: options.method ?? 'POST', body, key, fingerprint: `${file.uri}|${file.name}|${JSON.stringify(options.fields ?? {})}` });
  }
  async logout() {
    const token = this.accessToken;
    await this.clear();
    if (token) await this.parse(await this.send(this.url('/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }));
  }
}
