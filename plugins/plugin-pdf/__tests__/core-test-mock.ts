import { vi } from "vitest";

vi.mock("@elizaos/core", async () => {
	const logger = {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	};

	class Service {
		protected runtime: unknown;

		constructor(runtime?: unknown) {
			this.runtime = runtime;
		}
	}

	return {
		ElizaError: (await import("../../../packages/core/src/errors.ts")).ElizaError,
		ModelType: {
			IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
		},
		Service,
		ServiceType: {
			PDF: "pdf",
		},
		logger,
	};
});
