export class ApiError extends Error {
	public constructor(
		message: string,
		public readonly status: number,
		public readonly retryAfterMs?: number,
		public readonly code?: string
	) {
		super(message);
		this.name = "ApiError";
	}
}

export const getApiErrorMessage = (body: unknown): string | undefined => {
	if (!body || typeof body !== "object") {return undefined;}

	const payload = body as { message?: unknown; errors?: unknown };
	const summary = typeof payload.message === "string" && payload.message.length > 0 ? payload.message : undefined;
	if (Array.isArray(payload.errors)) {
		const details = payload.errors
			.map((error: unknown) => {
				if (!error || typeof error !== "object") {return undefined;}
				const item = error as { detail?: unknown; message?: unknown };
				return typeof item.detail === "string" ? item.detail : typeof item.message === "string" ? item.message : undefined;
			})
			.filter((detail): detail is string => Boolean(detail));
		return details.length > 0 ? details.join("; ") : summary;
	}
	if (payload.errors && typeof payload.errors === "object") {
		const details = Object.values(payload.errors as Record<string, unknown>)
			.flatMap(value => Array.isArray(value) ? value : [value])
			.filter((value): value is string => typeof value === "string");
		return details.length > 0 ? details.join("; ") : summary;
	}
	return summary;
};

export const getRetryAfterMs = (header: string | null, now = Date.now()): number => {
	if (header === null) {return 15_000;}
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) {return seconds * 1000;}
	const date = Date.parse(header);
	return Number.isNaN(date) ? 15_000 : Math.max(0, date - now);
};
