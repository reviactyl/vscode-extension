import * as vscode from "vscode";
import type { FileEntry, ReviactylApiClient, WriteMode } from "../api/client";
import { ApiError } from "../api/errors";
import type { ConnectionStore } from "../config/connectionStore";

interface DirectoryCacheEntry {
	readonly expiresAt: number
	readonly entries: FileEntry[]
}

const DIRECTORY_CACHE_TTL_MS = 5_000;
const STAT_CACHE_TTL_MS = 10_000;
const NOT_FOUND_CACHE_TTL_MS = 5_000;

export class ReviactylFileSystemProvider implements vscode.FileSystemProvider {
	private readonly eventEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private readonly directoryCache = new Map<string, DirectoryCacheEntry>();
	private readonly directoryRequests = new Map<string, Promise<FileEntry[]>>();
	private readonly directoryFailures = new Map<string, { expiresAt: number; error: unknown }>();
	private readonly statCache = new Map<string, { expiresAt: number; stat?: vscode.FileStat; notFound?: true }>();

	public readonly onDidChangeFile = this.eventEmitter.event;

	public constructor(
		private readonly connection: ConnectionStore,
		private readonly log: (message: string) => void
	) {}

	public clearCaches(): void {
		this.directoryCache.clear();
		this.directoryFailures.clear();
		this.statCache.clear();
	}

	public async refresh(): Promise<number> {
		this.clearCaches();
		const root = vscode.Uri.parse("reviactyl:/");
		const entries = await this.readDirectory(root);
		this.eventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: root }]);
		this.log("Remote root listing returned " + entries.length + " entries");
		return entries.length;
	}

	public async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean } = { overwrite: false }): Promise<void> {
		if (options.overwrite) {await this.delete(destination);}

		const { client, serverId } = this.requireConnection();
		await this.withApiErrors(() => client.copyFile(serverId, source.path));

		const oldName = source.path.split("/").pop() ?? "";
		const extensionIndex = oldName.lastIndexOf(".");
		const copiedName = extensionIndex > 0
			? oldName.slice(0, extensionIndex) + " copy" + oldName.slice(extensionIndex)
			: oldName + " copy";
		const copiedPath = source.path.split("/").slice(0, -1).concat(copiedName).join("/");
		if (copiedPath !== destination.path) {
			await this.withApiErrors(() => client.renameFiles(serverId, [{ from: copiedPath, to: destination.path }]));
		}
		this.changed({ type: vscode.FileChangeType.Created, uri: destination });
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		const { client, serverId } = this.requireConnection();
		await this.withApiErrors(() => client.createFolder(serverId, uri.path));
		this.changed({ type: vscode.FileChangeType.Created, uri });
	}

	public async delete(uri: vscode.Uri, options: { recursive: boolean } = { recursive: true }): Promise<void> {
		if (!options.recursive) {
			const entries = await this.readDirectory(uri);
			if (entries.length > 0) {throw vscode.FileSystemError.Unavailable("Directory not empty");}
		}

		const { client, serverId } = this.requireConnection();
		await this.withApiErrors(() => client.deleteFiles(serverId, [uri.path]));
		this.changed({ type: vscode.FileChangeType.Deleted, uri });
	}

	public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const entries = await this.getDirectoryEntries(uri.path);
		return entries.map(({ attributes }) => [
			attributes.name,
			attributes.is_file
				? (attributes.is_symlink ? vscode.FileType.File | vscode.FileType.SymbolicLink : vscode.FileType.File)
				: (attributes.is_symlink ? vscode.FileType.Directory | vscode.FileType.SymbolicLink : vscode.FileType.Directory)
		]);
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const { client, serverId } = this.requireConnection();
		return this.withApiErrors(() => client.readFile(serverId, uri.path));
	}

	public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean } = { overwrite: false }): Promise<void> {
		if (options.overwrite) {await this.delete(newUri);}
		const { client, serverId } = this.requireConnection();
		await this.withApiErrors(() => client.renameFiles(serverId, [{ from: oldUri.path, to: newUri.path }]));
		this.changed(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		);
	}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		if (uri.path === "/") {return { ctime: 0, mtime: 0, size: 0, type: vscode.FileType.Directory };}

		const cacheKey = this.serverId + ":" + uri.toString();
		const cached = this.statCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			if (cached.notFound) {throw vscode.FileSystemError.FileNotFound(uri);}
			if (cached.stat) {return cached.stat;}
		} else {
			this.statCache.delete(cacheKey);
		}

		const parent = uri.path.split("/").slice(0, -1).join("/") || "/";
		const entries = await this.getDirectoryEntries(parent);
		const fileName = uri.path.split("/").pop();
		const file = entries.find(entry => entry.attributes.name === fileName)?.attributes;
		if (!file) {
			this.statCache.set(cacheKey, { expiresAt: Date.now() + NOT_FOUND_CACHE_TTL_MS, notFound: true });
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		const stat: vscode.FileStat = {
			ctime: Date.parse(file.created_at),
			mtime: Date.parse(file.modified_at),
			permissions: file.mode[2] === "w" ? undefined : vscode.FilePermission.Readonly,
			size: file.size,
			type: file.is_file
				? (file.is_symlink ? vscode.FileType.File | vscode.FileType.SymbolicLink : vscode.FileType.File)
				: (file.is_symlink ? vscode.FileType.Directory | vscode.FileType.SymbolicLink : vscode.FileType.Directory)
		};
		this.statCache.set(cacheKey, { expiresAt: Date.now() + STAT_CACHE_TTL_MS, stat });
		return stat;
	}

	public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		let exists = true;
		try {
			const existing = await this.stat(uri);
			if (existing.type === vscode.FileType.Directory) {throw vscode.FileSystemError.FileIsADirectory(uri);}
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {exists = false;}
			else {throw error;}
		}
		if (exists && !options.overwrite) {throw vscode.FileSystemError.FileExists(uri);}
		if (!exists && !options.create) {throw vscode.FileSystemError.FileNotFound(uri);}

		const mode: WriteMode = exists ? "update" : "create";
		const { client, serverId } = this.requireConnection();
		await this.withApiErrors(() => client.writeFile(serverId, uri.path, content, mode));
		this.changed({ type: mode === "create" ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri });
	}

	public watch(): vscode.Disposable {
		return { dispose: () => undefined };
	}

	private async getDirectoryEntries(directory: string): Promise<FileEntry[]> {
		const { client, serverId } = this.requireConnection();
		const key = serverId + ":" + (directory || "/");
		const failed = this.directoryFailures.get(key);
		if (failed && failed.expiresAt > Date.now()) {throw failed.error;}
		this.directoryFailures.delete(key);
		const cached = this.directoryCache.get(key);
		if (cached && cached.expiresAt > Date.now()) {return cached.entries;}
		this.directoryCache.delete(key);

		const pending = this.directoryRequests.get(key);
		if (pending) {return pending;}

		const request = this.withApiErrors(() => client.listFiles(serverId, directory || "/"))
			.then(entries => {
				this.directoryCache.set(key, { entries, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS });
				return entries;
			})
			.catch(error => {
				this.directoryFailures.set(key, { error, expiresAt: Date.now() + NOT_FOUND_CACHE_TTL_MS });
				throw error;
			})
			.finally(() => this.directoryRequests.delete(key));
		this.directoryRequests.set(key, request);
		return request;
	}

	private requireConnection(): { client: ReviactylApiClient; serverId: string } {
		const client = this.connection.client;
		const serverId = this.connection.serverId;
		if (!client || !serverId) {throw vscode.FileSystemError.Unavailable("No saved Reviactyl connection. Run Setup/Connect to server first.");}
		return { client, serverId };
	}

	private get serverId(): string {
		return this.requireConnection().serverId;
	}

	private async withApiErrors<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof ApiError)) {throw error;}
			if (error.status === 401 || error.status === 403) {throw vscode.FileSystemError.NoPermissions(error.message);}
			if (error.status === 404) {throw vscode.FileSystemError.FileNotFound(error.message);}
			throw vscode.FileSystemError.Unavailable(error.message);
		}
	}

	private changed(...events: vscode.FileChangeEvent[]): void {
		this.clearCaches();
		this.eventEmitter.fire(events);
	}
}
