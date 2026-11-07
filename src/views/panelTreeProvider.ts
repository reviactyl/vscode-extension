import * as vscode from "vscode";
import type { ServerSummary } from "../api/client";
import type { ConfiguredPanel, ConnectionStore } from "../config/connectionStore";

type PanelNode = { readonly kind: "panel"; readonly panel: ConfiguredPanel };
type ServerNode = { readonly kind: "server"; readonly panel: ConfiguredPanel; readonly server: ServerSummary; readonly status: string };
type TreeNode = PanelNode | ServerNode;

export class PanelTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly changed = new vscode.EventEmitter<TreeNode | undefined | null | void>();
	private readonly serverCache = new Map<string, { expiresAt: number; nodes: ServerNode[] }>();
	public readonly onDidChangeTreeData = this.changed.event;

	public constructor(private readonly connection: ConnectionStore, private readonly log: (message: string) => void) {}

	public refresh(): void { this.serverCache.clear(); this.changed.fire(); }

	public getTreeItem(node: TreeNode): vscode.TreeItem {
		if (node.kind === "panel") {
			const item = new vscode.TreeItem(node.panel.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.description = new URL(node.panel.panelUrl).host;
			item.id = node.panel.id;
			item.contextValue = "reviactylPanel";
			item.iconPath = new vscode.ThemeIcon(node.panel.id === this.connection.activePanelId ? "vm-active" : "server-environment");
			return item;
		}
		const item = new vscode.TreeItem(node.server.attributes.name, vscode.TreeItemCollapsibleState.None);
		item.description = node.status;
		item.tooltip = node.server.attributes.description || node.server.attributes.identifier;
		item.contextValue = "reviactylServer";
		item.iconPath = new vscode.ThemeIcon(node.status === "running" ? "circle-filled" : node.status === "offline" ? "circle-outline" : "question");
		item.command = {
			command: "reviactyl-vsc.openPanelServer",
			title: "Open Server",
			arguments: [node.panel.id, node.server.attributes.identifier, node.server.attributes.name]
		};
		return item;
	}

	public async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (!node) { return (await this.connection.listPanels()).map(panel => ({ kind: "panel", panel })); }
		if (node.kind !== "panel") { return []; }
		const cached = this.serverCache.get(node.panel.id);
		if (cached && cached.expiresAt > Date.now()) { return cached.nodes; }
		const client = await this.connection.clientForPanel(node.panel.id);
		if (!client) { return []; }
		try {
			const servers = await client.listServers();
			const nodes = await Promise.all(servers.map(async server => {
				let status = "unknown";
				try {
					const resources = await client.getServerResources(server.attributes.identifier);
					status = resources.attributes.is_suspended ? "suspended" : String(resources.attributes.current_state || "unknown");
				} catch (error) {
					status = "status unavailable";
					this.log("Could not get status for " + server.attributes.name + ": " + (error instanceof Error ? error.message : String(error)));
				}
				return { kind: "server", panel: node.panel, server, status } satisfies ServerNode;
			}));
			this.serverCache.set(node.panel.id, { nodes, expiresAt: Date.now() + 20_000 });
			return nodes;
		} catch (error) {
			this.log("Could not list servers for panel " + node.panel.name + ": " + (error instanceof Error ? error.message : String(error)));
			return [];
		}
	}
}
