import { ApiError, getApiErrorMessage, getRetryAfterMs } from "./errors";

export type PowerSignal = "start" | "stop" | "restart" | "kill"
export type WriteMode = "create" | "update"

export interface ServerSummary {
	readonly attributes: {
		readonly identifier: string
		readonly name: string
		readonly description?: string | null
	}
}

export interface FileEntry {
	readonly attributes: {
		readonly name: string
		readonly mode: string
		readonly size: number
		readonly is_file: boolean
		readonly is_symlink: boolean
		readonly created_at: string
		readonly modified_at: string
	}
}

export interface RenameFile {
	readonly from: string
	readonly to: string
}

export interface ApiClientOptions {
	readonly panelUrl: string
	readonly apiKey: string
	readonly proxyUrl?: string
	readonly fetchImplementation?: typeof fetch
	readonly onRequest?: (method: string, url: string, status: number) => void
}

interface ApiList<T> {
	readonly data: T[]
}

const withoutLeadingSlash = (path: string): string => path.replace(/^\/+/, "");

export class ReviactylApiClient {
	private readonly apiBaseUrl: string;
	private readonly apiKey: string;
	private readonly proxyUrl: string;
	private readonly fetchImplementation: typeof fetch;
	private readonly onRequest?: ApiClientOptions["onRequest"];
	private rateLimitedUntil = 0;

	public constructor(options: ApiClientOptions) {
		this.apiBaseUrl = options.panelUrl.trim().replace(/\/+$/, "") + "/api/client";
		this.apiKey = options.apiKey;
		this.proxyUrl = options.proxyUrl?.trim() ?? "";
		this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
		this.onRequest = options.onRequest;
	}

	public async listServers(): Promise<ServerSummary[]> {
		const result = await this.requestJson<ApiList<ServerSummary>>(this.apiBaseUrl + "/");
		if (!Array.isArray(result.data)) {throw new ApiError("The panel returned an invalid server list.", 200);}
		return result.data;
	}

	public async listFiles(serverId: string, directory: string): Promise<FileEntry[]> {
		const query = new URLSearchParams({ directory });
		const result = await this.requestJson<ApiList<FileEntry>>(
			this.serverUrl(serverId, "/files/list") + "?" + query.toString()
		);
		if (!Array.isArray(result.data)) {throw new ApiError("The panel returned an invalid directory listing.", 200);}
		return result.data;
	}

	public async readFile(serverId: string, path: string): Promise<Uint8Array> {
		const query = new URLSearchParams({ file: path });
		const response = await this.request(this.serverUrl(serverId, "/files/contents") + "?" + query.toString(), {
			headers: { Accept: "text/plain" }
		});
		return new Uint8Array(await response.arrayBuffer());
	}

	public async writeFile(serverId: string, path: string, content: Uint8Array, mode: WriteMode): Promise<void> {
		const query = new URLSearchParams({ file: withoutLeadingSlash(path) });
		await this.request(this.serverUrl(serverId, "/files/write") + "?" + query.toString(), {
			method: mode === "create" ? "POST" : "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: content
		});
	}

	public async createFolder(serverId: string, name: string): Promise<void> {
		await this.requestJson(this.serverUrl(serverId, "/files/create-folder"), {
			method: "POST",
			body: JSON.stringify({ root: "/", name })
		});
	}

	public async deleteFiles(serverId: string, paths: string[]): Promise<void> {
		await this.requestJson(this.serverUrl(serverId, "/files/delete"), {
			method: "POST",
			body: JSON.stringify({ root: "/", files: paths.map(withoutLeadingSlash) })
		});
	}

	public async copyFile(serverId: string, location: string): Promise<void> {
		await this.requestJson(this.serverUrl(serverId, "/files/copy"), {
			method: "POST",
			body: JSON.stringify({ location: withoutLeadingSlash(location) })
		});
	}

	public async renameFiles(serverId: string, files: RenameFile[]): Promise<void> {
		await this.requestJson(this.serverUrl(serverId, "/files/rename"), {
			method: "PUT",
			body: JSON.stringify({
				root: "/",
				files: files.map(file => ({ from: withoutLeadingSlash(file.from), to: withoutLeadingSlash(file.to) }))
			})
		});
	}

	public async sendPowerSignal(serverId: string, signal: PowerSignal): Promise<void> {
		await this.request(this.serverUrl(serverId, "/power"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ signal })
		});
	}

	private serverUrl(serverId: string, path: string): string {
		return this.apiBaseUrl + "/servers/" + encodeURIComponent(serverId) + path;
	}

	private async requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
		const headers = new Headers(options.headers);
		if (options.body !== undefined && !headers.has("Content-Type")) {headers.set("Content-Type", "application/json");}
		const response = await this.request(url, { ...options, headers });
		if (response.status === 204) {return undefined as T;}
		return await response.json() as T;
	}

	private async request(url: string, options: RequestInit = {}): Promise<Response> {
		if (Date.now() < this.rateLimitedUntil) {
			const retryInSeconds = Math.ceil((this.rateLimitedUntil - Date.now()) / 1000);
			throw new ApiError("Panel rate limit cooldown: retry in " + retryInSeconds + " seconds.", 429, this.rateLimitedUntil - Date.now());
		}

		const headers = new Headers(options.headers);
		headers.set("Accept", headers.get("Accept") ?? "application/json");
		headers.set("Authorization", "Bearer " + this.apiKey);
		const requestUrl = this.proxyUrl ? this.proxyUrl + encodeURIComponent(url) : url;
		const method = options.method ?? "GET";
		const response = await this.fetchImplementation(requestUrl, { ...options, method, headers });
		this.onRequest?.(method, url, response.status);

		if (response.status === 429) {
			const retryAfterMs = getRetryAfterMs(response.headers.get("Retry-After"));
			this.rateLimitedUntil = Date.now() + retryAfterMs;
			throw new ApiError("You have been rate limited by the Reviactyl panel.", 429, retryAfterMs);
		}

		if (!response.ok) {
			const body = await response.text();
			let payload: unknown;
			try { payload = JSON.parse(body); } catch { payload = undefined; }
			const detail = getApiErrorMessage(payload) ?? (body.slice(0, 300) || response.statusText);
			const code = payload && typeof payload === "object" && Array.isArray((payload as { errors?: unknown }).errors)
				? ((payload as { errors: Array<{ code?: string }> }).errors[0]?.code)
				: undefined;
			throw new ApiError(detail, response.status, undefined, code);
		}

		return response;
	}
}
