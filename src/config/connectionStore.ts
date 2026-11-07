import * as vscode from "vscode";
import { ReviactylApiClient } from "../api/client";

export class ConnectionStore {
	private apiClient: ReviactylApiClient | undefined;
	private connectionKey = "";
	private serverIdentifier = "";

	private static readonly apiKeySecret = "reviactyl-vsc.apiKey";

	public constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly log: (message: string) => void
	) {}

	public async restore(): Promise<ReviactylApiClient | undefined> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		const panelUrl = configuration.get<string>("panelUrl")?.trim().replace(/\/+$/, "") ?? "";
		let apiKey = await this.secrets.get(ConnectionStore.apiKeySecret);
		const legacyApiKey = configuration.get<string>("apiKey")?.trim() ?? "";
		if (!apiKey) {
			apiKey = legacyApiKey;
			if (apiKey) {
				await this.secrets.store(ConnectionStore.apiKeySecret, apiKey);
				this.log("Migrated the saved API key into VS Code SecretStorage");
			}
		}
		if (legacyApiKey) {await this.removeLegacyApiKey(configuration);}
		const serverId = configuration.get<string>("serverId")?.trim() ?? "";
		const proxyUrl = configuration.get<string>("proxyUrl")?.trim() ?? "";
		if (!panelUrl || !apiKey || !serverId) {
			this.apiClient = undefined;
			this.serverIdentifier = "";
			this.connectionKey = "";
			this.log("No saved panel URL, server identifier, or API key configured");
			return undefined;
		}

		const key = JSON.stringify([panelUrl, apiKey, proxyUrl]);
		this.serverIdentifier = serverId;
		if (key !== this.connectionKey) {
			this.apiClient = new ReviactylApiClient({
				panelUrl,
				apiKey,
				proxyUrl,
				onRequest: (method, url, status) => this.log(method + " " + new URL(url).pathname + " -> " + status)
			});
			this.connectionKey = key;
			this.log("Restored server API URL: " + panelUrl + "/api/client/servers/" + serverId + "/files");
		}
		return this.apiClient;
	}

	public get client(): ReviactylApiClient | undefined {
		return this.apiClient;
	}

	public get serverId(): string {
		return this.serverIdentifier;
	}

	public async save(panelUrl: string, apiKey: string, serverId: string): Promise<void> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		await this.secrets.store(ConnectionStore.apiKeySecret, apiKey);
		await Promise.all([
			configuration.update("panelUrl", panelUrl, vscode.ConfigurationTarget.Global),
			configuration.update("serverId", serverId, vscode.ConfigurationTarget.Global),
			this.removeLegacyApiKey(configuration)
		]);
		await this.restore();
	}

	public async selectServer(serverId: string): Promise<void> {
		await vscode.workspace.getConfiguration("reviactyl-vsc").update("serverId", serverId, vscode.ConfigurationTarget.Global);
		await this.restore();
	}

	public async reset(): Promise<void> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		await this.secrets.delete(ConnectionStore.apiKeySecret);
		await Promise.all([
			this.removeLegacyApiKey(configuration),
			configuration.update("panelUrl", undefined, vscode.ConfigurationTarget.Global),
			configuration.update("serverId", undefined, vscode.ConfigurationTarget.Global)
		]);
		await this.restore();
	}

	private async removeLegacyApiKey(configuration: vscode.WorkspaceConfiguration): Promise<void> {
		await configuration.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
	}
}
