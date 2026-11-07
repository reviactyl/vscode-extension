import * as vscode from "vscode";
import type { PowerSignal, ServerSummary } from "../api/client";
import { ReviactylApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { ConnectionStore } from "../config/connectionStore";
import type { ReviactylFileSystemProvider } from "../filesystem/provider";
import type { PanelTreeProvider } from "../views/panelTreeProvider";

type ServerQuickPickItem = vscode.QuickPickItem & { readonly server: ServerSummary }

const isValidApiKey = (value: string): boolean => /^rtlc_[a-zA-Z0-9]{43}$/.test(value);

const validatePanelUrl = (value: string): string | undefined => {
	if (!value.trim()) {return "Enter a panel URL";}
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") {return "Use an HTTP or HTTPS URL";}
		return url.hostname ? undefined : "Enter a valid panel URL";
	} catch {
		return "Enter a valid panel URL";
	}
};

const getErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const showApiError = (error: unknown): string => {
	if (error instanceof ApiError) {return error.message;}
	return getErrorMessage(error);
};

export const registerCommands = (
	context: vscode.ExtensionContext,
	connection: ConnectionStore,
	fileSystem: ReviactylFileSystemProvider,
	output: vscode.OutputChannel,
	log: (message: string) => void,
	panelTree?: PanelTreeProvider
): void => {
	let setupInProgress = false;

	const runSetup = async (): Promise<void> => {
		if (setupInProgress) {
			log("Setup is already in progress");
			return;
		}
		setupInProgress = true;
		try {
			log("Showing panel URL input");
			const panelName = await vscode.window.showInputBox({
				title: "Add Reviactyl panel (1/3)", prompt: "Name this panel", placeHolder: "Production", ignoreFocusOut: true
			});
			if (!panelName?.trim()) {return;}
			const panelUrlValue = await vscode.window.showInputBox({
				title: "Add Reviactyl panel (2/3)",
				prompt: "Enter the Reviactyl panel URL",
				placeHolder: "https://panel.example.com",
				value: vscode.workspace.getConfiguration("reviactyl-vsc").get<string>("panelUrl"),
				ignoreFocusOut: true,
				validateInput: validatePanelUrl
			});
			if (!panelUrlValue) {return;}

			const parsedPanelUrl = new URL(panelUrlValue.trim());
			log("Showing API key input");
			const apiKey = await vscode.window.showInputBox({
				title: "Add Reviactyl panel (3/3)",
				prompt: "Enter your Reviactyl client API key",
				placeHolder: "rtlc_…",
				ignoreFocusOut: true,
				password: true,
				validateInput: value => isValidApiKey(value) ? undefined : "Enter a valid Reviactyl client API key"
			});
			if (!apiKey) {return;}

			const config = vscode.workspace.getConfiguration("reviactyl-vsc");
			const client = new ReviactylApiClient({
				panelUrl: parsedPanelUrl.origin,
				apiKey,
				proxyUrl: config.get<string>("proxyUrl")
			});
			const servers = await client.listServers();
			if (servers.length === 0) {
				vscode.window.showInformationMessage("This Reviactyl account has no accessible servers.");
				return;
			}

			const selected = await vscode.window.showQuickPick(
				servers.map(server => ({
					label: server.attributes.name,
					description: server.attributes.identifier,
					detail: server.attributes.description ?? undefined,
					server
				} satisfies ServerQuickPickItem)),
				{ placeHolder: "Select a server to open in VS Code" }
			);
			if (!selected) {return;}

			const panel = await connection.addPanel(panelName.trim(), parsedPanelUrl.origin, apiKey);
			await connection.activatePanel(panel.id, selected.server.attributes.identifier);
			const workspaceFolder = {
				uri: vscode.Uri.parse("reviactyl:/"),
				name: "Reviactyl - " + selected.server.attributes.name
			};
			const existingIndex = vscode.workspace.workspaceFolders?.findIndex(folder => folder.uri.scheme === "reviactyl") ?? -1;
			if (existingIndex < 0) {vscode.workspace.updateWorkspaceFolders(0, 0, workspaceFolder);}
			else {vscode.workspace.updateWorkspaceFolders(existingIndex, 1, workspaceFolder);}
			await fileSystem.refresh();
			panelTree?.refresh();
		} catch (error) {
			log("Setup failed: " + showApiError(error));
			vscode.window.showErrorMessage("Reviactyl setup failed: " + showApiError(error));
		} finally {
			setupInProgress = false;
		}
	};

	const switchServer = async (): Promise<void> => {
		const client = await connection.restore();
		if (!client) {
			const choice = await vscode.window.showErrorMessage("No saved Reviactyl connection. Set up a panel first.", "Setup/Connect");
			if (choice === "Setup/Connect") {await runSetup();}
			return;
		}

		try {
			const servers = await client.listServers();
			const items = servers.map(server => ({
				label: server.attributes.name,
				description: server.attributes.identifier,
				detail: server.attributes.identifier === connection.serverId ? "Current server" : server.attributes.description ?? undefined,
				server
			} satisfies ServerQuickPickItem));
			const selected = await vscode.window.showQuickPick(items, { placeHolder: "Select a Reviactyl server to open" });
			if (!selected || selected.server.attributes.identifier === connection.serverId) {return;}

			await connection.selectServer(selected.server.attributes.identifier);
			fileSystem.clearCaches();
			const folder = {
				uri: vscode.Uri.parse("reviactyl:/"),
				name: "Reviactyl - " + selected.server.attributes.name
			};
			const existingIndex = vscode.workspace.workspaceFolders?.findIndex(item => item.uri.scheme === "reviactyl") ?? -1;
			if (existingIndex < 0) {vscode.workspace.updateWorkspaceFolders(0, 0, folder);}
			else {vscode.workspace.updateWorkspaceFolders(existingIndex, 1, folder);}
			await fileSystem.refresh();
			panelTree?.refresh();
		} catch (error) {
			log("Switch server failed: " + showApiError(error));
			vscode.window.showErrorMessage("Could not switch Reviactyl server: " + showApiError(error));
		}
	};

	const sendPowerSignal = async (signal: PowerSignal): Promise<void> => {
		const client = await connection.restore();
		if (!client) {throw new Error("No saved Reviactyl connection. Run Setup/Connect to server first.");}
		await client.sendPowerSignal(connection.serverId, signal);
		log("Sent server power signal: " + signal);
		vscode.window.setStatusBarMessage("Reviactyl: " + signal + " signal sent", 4000);
	};

	const register = (id: string, handler: (...args: never[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register("reviactyl-vsc.init", async () => {
		output.show(true);
		log("Setup command started");
		await runSetup();
	});
	register("reviactyl-vsc.switchServer", async () => {
		output.show(true);
		log("Switch server command started");
		await switchServer();
	});
	register("reviactyl-vsc.openPanelServer", async (panelId: string, serverId: string, serverName: string) => {
		try {
			await connection.activatePanel(panelId, serverId);
			fileSystem.clearCaches();
			const folder = { uri: vscode.Uri.parse("reviactyl:/"), name: "Reviactyl - " + serverName };
			const existingIndex = vscode.workspace.workspaceFolders?.findIndex(item => item.uri.scheme === "reviactyl") ?? -1;
			if (existingIndex < 0) {vscode.workspace.updateWorkspaceFolders(0, 0, folder);}
			else {vscode.workspace.updateWorkspaceFolders(existingIndex, 1, folder);}
			await fileSystem.refresh();
			panelTree?.refresh();
			log("Opened " + serverName + " from panel " + panelId);
		} catch (error) {
			vscode.window.showErrorMessage("Could not open Reviactyl server: " + showApiError(error));
		}
	});
	register("reviactyl-vsc.removePanel", async (node?: { id?: string } | string) => {
		const panelId = typeof node === "string" ? node : node?.id;
		if (!panelId) {return;}
		const panels = await connection.listPanels();
		const panel = panels.find(candidate => candidate.id === panelId);
		if (!panel) {return;}
		const choice = await vscode.window.showWarningMessage("Remove panel '" + panel.name + "' and its saved API key?", "Remove");
		if (choice !== "Remove") {return;}
		await connection.removePanel(panelId);
		panelTree?.refresh();
		if (!connection.client) {
			fileSystem.clearCaches();
			const index = vscode.workspace.workspaceFolders?.findIndex(folder => folder.uri.scheme === "reviactyl") ?? -1;
			if (index >= 0) {vscode.workspace.updateWorkspaceFolders(index, 1);}
		}
	});
	register("reviactyl-vsc.editConfig", async () => {
		await vscode.commands.executeCommand("workbench.action.openSettingsJson");
	});
	register("reviactyl-vsc.refresh", async () => {
		output.show();
		log("Refreshing workspace server files...");
		try {
			await fileSystem.refresh();
			panelTree?.refresh();
			await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		} catch (error) {
			log("Refresh failed: " + getErrorMessage(error));
			vscode.window.showErrorMessage("Could not refresh Reviactyl files: " + getErrorMessage(error));
		}
	});
	register("reviactyl-vsc.reset", async () => {
		output.show();
		await connection.reset();
		panelTree?.refresh();
		fileSystem.clearCaches();
		const folders = vscode.workspace.workspaceFolders ?? [];
		const remoteIndex = folders.findIndex(folder => folder.uri.scheme === "reviactyl");
		if (remoteIndex >= 0) {vscode.workspace.updateWorkspaceFolders(remoteIndex, 1);}
		log("Reset Reviactyl connection and workspace");
	});

	const powerCommands: ReadonlyArray<readonly [string, PowerSignal]> = [
		["reviactyl-vsc.powerStart", "start"],
		["reviactyl-vsc.powerStop", "stop"],
		["reviactyl-vsc.powerRestart", "restart"],
		["reviactyl-vsc.powerKill", "kill"]
	];
	for (const [command, signal] of powerCommands) {
		register(command, async () => {
			try {
				await sendPowerSignal(signal);
			} catch (error) {
				log("Power command " + signal + " failed: " + showApiError(error));
				vscode.window.showErrorMessage("Could not " + signal + " Reviactyl server: " + showApiError(error));
			}
		});
	}
};
