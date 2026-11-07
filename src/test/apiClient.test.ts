import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api/errors";
import { ReviactylApiClient } from "../api/client";

interface CapturedRequest {
	readonly input: string | URL | Request
	readonly init?: RequestInit
}

const createFetch = (response: (request: CapturedRequest) => Response | Promise<Response>) => {
	const requests: CapturedRequest[] = [];
	const fetchImplementation: typeof fetch = async (input, init) => {
		const request = { input, init };
		requests.push(request);
		return response(request);
	};
	return { fetchImplementation, requests };
};

test("listFiles uses the server short identifier and encodes the directory query", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(JSON.stringify({ data: [] }), {
		status: 200,
		headers: { "Content-Type": "application/json" }
	}));
	const client = new ReviactylApiClient({
		panelUrl: "https://panel.example.test/",
		apiKey: "secret",
		fetchImplementation
	});

	await client.listFiles("c8778132", "/");
	const request = requests[0];
	assert.equal(String(request.input), "https://panel.example.test/api/client/servers/c8778132/files/list?directory=%2F");
	assert.equal(new Headers(request.init?.headers).get("Authorization"), "Bearer secret");
	assert.equal(request.init?.method, "GET");
});

test("writeFile sends raw bytes and includes the file path in the query", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(null, { status: 204 }));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await client.writeFile("c8778132", "/config.yml", new TextEncoder().encode("s\ns\ns"), "update");
	const request = requests[0];
	assert.equal(String(request.input), "https://panel.example.test/api/client/servers/c8778132/files/write?file=config.yml");
	assert.equal(request.init?.method, "PUT");
	assert.equal(new Headers(request.init?.headers).get("Content-Type"), "application/octet-stream");
	assert.equal(await new Response(request.init?.body).text(), "s\ns\ns");
});

test("writeFile uses POST when creating a file", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(null, { status: 204 }));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await client.writeFile("c8778132", "new.yml", new TextEncoder().encode("new"), "create");
	assert.equal(requests[0].init?.method, "POST");
});

test("createFolder serializes its JSON body and accepts a no-content response", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(null, { status: 204 }));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await client.createFolder("c8778132", "/plugins/new");
	assert.equal(String(requests[0].input), "https://panel.example.test/api/client/servers/c8778132/files/create-folder");
	assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { root: "/", name: "/plugins/new" });
});

test("renameFiles strips leading slashes in API root-relative paths", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(null, { status: 204 }));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await client.renameFiles("c8778132", [{ from: "/old.yml", to: "/new.yml" }]);
	assert.equal(requests[0].init?.method, "PUT");
	assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { root: "/", files: [{ from: "old.yml", to: "new.yml" }] });
});

test("proxy URLs receive an encoded target URL", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
	const client = new ReviactylApiClient({
		panelUrl: "https://panel.example.test",
		apiKey: "secret",
		proxyUrl: "https://proxy.example.test/",
		fetchImplementation
	});

	await client.listServers();
	assert.equal(String(requests[0].input), "https://proxy.example.test/https%3A%2F%2Fpanel.example.test%2Fapi%2Fclient%2F");
});

test("sendPowerSignal posts all documented signal payloads to the selected server", async () => {
	for (const signal of ["start", "stop", "restart", "kill"] as const) {
		const { fetchImplementation, requests } = createFetch(() => new Response(null, { status: 204 }));
		const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

		await client.sendPowerSignal("c8778132", signal);
		const request = requests[0];
		assert.equal(String(request.input), "https://panel.example.test/api/client/servers/c8778132/power");
		assert.equal(request.init?.method, "POST");
		assert.equal(new Headers(request.init?.headers).get("Content-Type"), "application/json");
		assert.deepEqual(JSON.parse(String(request.init?.body)), { signal });
	}
});

test("rate limits honor Retry-After and suppress follow-up requests during cooldown", async () => {
	const { fetchImplementation, requests } = createFetch(() => new Response("{}", {
		status: 429,
		headers: { "Retry-After": "30", "Content-Type": "application/json" }
	}));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await assert.rejects(client.listServers(), (error: unknown) => error instanceof ApiError && error.status === 429);
	await assert.rejects(client.listServers(), (error: unknown) => error instanceof ApiError && error.message.includes("cooldown"));
	assert.equal(requests.length, 1);
});

test("API errors use the response message", async () => {
	const { fetchImplementation } = createFetch(() => new Response(JSON.stringify({ message: "Invalid file body" }), {
		status: 400,
		headers: { "Content-Type": "application/json" }
	}));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await assert.rejects(client.listServers(), (error: unknown) =>
		error instanceof ApiError && error.status === 400 && error.message === "Invalid file body"
	);
});

test("validation errors accept field-keyed error arrays", async () => {
	const { fetchImplementation } = createFetch(() => new Response(JSON.stringify({
		message: "The given data was invalid.",
		errors: { file: ["The file field is required."] }
	}), { status: 422 }));
	const client = new ReviactylApiClient({ panelUrl: "https://panel.example.test", apiKey: "secret", fetchImplementation });

	await assert.rejects(client.listServers(), (error: unknown) =>
		error instanceof ApiError && error.status === 422 && error.message === "The file field is required."
	);
});
