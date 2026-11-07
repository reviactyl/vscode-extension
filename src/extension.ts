"use strict";

import * as vscode from "vscode";
import { ConnectionStore } from "./config/connectionStore";
import { ReviactylFileSystemProvider } from "./filesystem/provider";
import { registerCommands } from "./commands/registerCommands";
import { PanelTreeProvider } from "./views/panelTreeProvider";

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
	const output = vscode.window.createOutputChannel("Reviactyl file system");
	const log = (message: string): void => output.appendLine(message);
	context.subscriptions.push(output);
	log("[reviactyl] Extension loading..");

	const connection = new ConnectionStore(context.secrets, log);
	const fileSystem = new ReviactylFileSystemProvider(connection, log);
	const panelTree = new PanelTreeProvider(connection, log);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider("reviactyl", fileSystem, { isCaseSensitive: true }),
		vscode.window.registerTreeDataProvider("reviactyl.panels", panelTree),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration("reviactyl-vsc.panels") ||
				event.affectsConfiguration("reviactyl-vsc.activePanelId") ||
				event.affectsConfiguration("reviactyl-vsc.panelUrl") ||
				event.affectsConfiguration("reviactyl-vsc.serverId") ||
				event.affectsConfiguration("reviactyl-vsc.apiKey") ||
				event.affectsConfiguration("reviactyl-vsc.proxyUrl")
			) {
				log("Connection configuration changed");
				void connection.restore().catch(error => log("Could not restore connection: " + String(error)));
				fileSystem.clearCaches();
				panelTree.refresh();
			}
		})
	);

	await connection.restore().catch(error => log("Could not restore connection: " + String(error)));
	registerCommands(context, connection, fileSystem, output, log, panelTree);
};

export const deactivate = (): void => undefined;
