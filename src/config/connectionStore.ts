import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { ReviactylApiClient } from "../api/client";

export interface ConfiguredPanel {
	readonly id: string;
	readonly name: string;
	readonly panelUrl: string;
}

export class ConnectionStore {
	private apiClient: ReviactylApiClient | undefined;
	private connectionKey = "";
	private serverIdentifier = "";
	private activePanelIdentifier = "";
	private static readonly apiKeySecret = "reviactyl-vsc.apiKey";
	private static secretKey(panelId: string): string { return "reviactyl-vsc.panel." + panelId + ".apiKey"; }

	public constructor(private readonly secrets: vscode.SecretStorage, private readonly log: (message: string) => void) {}

	public async listPanels(): Promise<ConfiguredPanel[]> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		let panels = configuration.get<ConfiguredPanel[]>("panels", []);
		if (panels.length === 0) {
			const panelUrl = configuration.get<string>("panelUrl")?.trim().replace(/\/+$/, "") ?? "";
			let apiKey = await this.secrets.get(ConnectionStore.apiKeySecret);
			const legacyApiKey = configuration.get<string>("apiKey")?.trim() ?? "";
			apiKey ||= legacyApiKey;
			if (panelUrl && apiKey) {
				const id = randomUUID();
				panels = [{ id, name: new URL(panelUrl).hostname, panelUrl }];
				await Promise.all([
					this.secrets.store(ConnectionStore.secretKey(id), apiKey),
					configuration.update("panels", panels, vscode.ConfigurationTarget.Global),
					configuration.update("activePanelId", id, vscode.ConfigurationTarget.Global),
					this.removeLegacyApiKey(configuration)
				]);
				this.log("Migrated the saved connection into the named panels list");
			}
		}
		return panels;
	}

	public async addPanel(name: string, panelUrl: string, apiKey: string): Promise<ConfiguredPanel> {
		const panels = await this.listPanels();
		const panel = { id: randomUUID(), name: name.trim(), panelUrl: panelUrl.trim().replace(/\/+$/, "") };
		await this.secrets.store(ConnectionStore.secretKey(panel.id), apiKey);
		await vscode.workspace.getConfiguration("reviactyl-vsc").update("panels", [...panels, panel], vscode.ConfigurationTarget.Global);
		return panel;
	}

	public async removePanel(panelId: string): Promise<void> {
		const panels = await this.listPanels();
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		const isActivePanel = this.activePanelIdentifier === panelId || configuration.get<string>("activePanelId") === panelId;
		await configuration.update("panels", panels.filter(panel => panel.id !== panelId), vscode.ConfigurationTarget.Global);
		await this.secrets.delete(ConnectionStore.secretKey(panelId));
		if (isActivePanel) {
			await configuration.update("activePanelId", undefined, vscode.ConfigurationTarget.Global);
			await configuration.update("serverId", undefined, vscode.ConfigurationTarget.Global);
			this.apiClient = undefined;
			this.serverIdentifier = "";
			this.activePanelIdentifier = "";
			this.connectionKey = "";
		}
	}

	public async clientForPanel(panelId: string): Promise<ReviactylApiClient | undefined> {
		const panel = (await this.listPanels()).find(candidate => candidate.id === panelId);
		const apiKey = await this.secrets.get(ConnectionStore.secretKey(panelId));
		if (!panel || !apiKey) { return undefined; }
		const proxyUrl = vscode.workspace.getConfiguration("reviactyl-vsc").get<string>("proxyUrl")?.trim() ?? "";
		return new ReviactylApiClient({
			panelUrl: panel.panelUrl,
			apiKey,
			proxyUrl,
			onRequest: (method, url, status) => this.log(method + " " + new URL(url).pathname + " -> " + status)
		});
	}

	public async activatePanel(panelId: string, serverId: string): Promise<void> {
		const panel = (await this.listPanels()).find(candidate => candidate.id === panelId);
		if (!panel) { throw new Error("Configured panel could not be found."); }
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		await Promise.all([
			configuration.update("activePanelId", panelId, vscode.ConfigurationTarget.Global),
			configuration.update("panelUrl", panel.panelUrl, vscode.ConfigurationTarget.Global),
			configuration.update("serverId", serverId, vscode.ConfigurationTarget.Global)
		]);
		await this.restore();
	}

	public async restore(): Promise<ReviactylApiClient | undefined> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		const panels = await this.listPanels();
		const panelId = configuration.get<string>("activePanelId") ?? "";
		const panel = panels.find(candidate => candidate.id === panelId);
		const panelUrl = panel?.panelUrl ?? configuration.get<string>("panelUrl")?.trim().replace(/\/+$/, "") ?? "";
		let apiKey = panel ? await this.secrets.get(ConnectionStore.secretKey(panel.id)) : await this.secrets.get(ConnectionStore.apiKeySecret);
		const legacyApiKey = configuration.get<string>("apiKey")?.trim() ?? "";
		if (!apiKey) { apiKey = legacyApiKey; }
		if (legacyApiKey) { await this.removeLegacyApiKey(configuration); }
		const serverId = configuration.get<string>("serverId")?.trim() ?? "";
		const proxyUrl = configuration.get<string>("proxyUrl")?.trim() ?? "";
		if (!panelUrl || !apiKey || !serverId) {
			this.apiClient = undefined;
			this.serverIdentifier = "";
			this.activePanelIdentifier = panel?.id ?? "";
			this.connectionKey = "";
			this.log("No active panel or server configured");
			return undefined;
		}
		const key = JSON.stringify([panelUrl, apiKey, proxyUrl]);
		this.serverIdentifier = serverId;
		this.activePanelIdentifier = panel?.id ?? "";
		if (key !== this.connectionKey) {
			this.apiClient = new ReviactylApiClient({
				panelUrl, apiKey, proxyUrl,
				onRequest: (method, url, status) => this.log(method + " " + new URL(url).pathname + " -> " + status)
			});
			this.connectionKey = key;
		}
		return this.apiClient;
	}

	public get client(): ReviactylApiClient | undefined { return this.apiClient; }
	public get serverId(): string { return this.serverIdentifier; }
	public get activePanelId(): string { return this.activePanelIdentifier; }

	public async save(panelUrl: string, apiKey: string, serverId: string): Promise<void> {
		const panels = await this.listPanels();
		let panel = panels.find(candidate => candidate.panelUrl === panelUrl);
		if (!panel) { panel = await this.addPanel(new URL(panelUrl).hostname, panelUrl, apiKey); }
		else { await this.secrets.store(ConnectionStore.secretKey(panel.id), apiKey); }
		await this.activatePanel(panel.id, serverId);
	}

	public async selectServer(serverId: string): Promise<void> {
		await vscode.workspace.getConfiguration("reviactyl-vsc").update("serverId", serverId, vscode.ConfigurationTarget.Global);
		await this.restore();
	}

	public async reset(): Promise<void> {
		const configuration = vscode.workspace.getConfiguration("reviactyl-vsc");
		for (const panel of await this.listPanels()) { await this.secrets.delete(ConnectionStore.secretKey(panel.id)); }
		await this.secrets.delete(ConnectionStore.apiKeySecret);
		await Promise.all([
			this.removeLegacyApiKey(configuration),
			configuration.update("panels", undefined, vscode.ConfigurationTarget.Global),
			configuration.update("activePanelId", undefined, vscode.ConfigurationTarget.Global),
			configuration.update("panelUrl", undefined, vscode.ConfigurationTarget.Global),
			configuration.update("serverId", undefined, vscode.ConfigurationTarget.Global)
		]);
		await this.restore();
	}

	private async removeLegacyApiKey(configuration: vscode.WorkspaceConfiguration): Promise<void> {
		await configuration.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
	}
}
