import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { EventType } from "../types/events";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

describe("service startup observers", () => {
	it("binds a late-registered service before its startup promise resolves", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		class LateService extends Service {
			static override serviceType = "late-transport-test";
			capabilityDescription = "late transport test";
			bound = false;
			static override async start(owner: IAgentRuntime) {
				return new LateService(owner);
			}
		}
		const seen: string[] = [];
		runtime.registerEvent(
			EventType.SERVICE_STARTED,
			async ({ serviceType }) => {
				if (serviceType !== LateService.serviceType) return;
				const service = runtime.getService<LateService>(serviceType);
				expect(service).toBeInstanceOf(LateService);
				await Promise.resolve();
				if (!service) throw new Error("Service not installed before event");
				service.bound = true;
				seen.push(serviceType);
			},
		);
		try {
			await runtime.registerService(LateService);
			const service = await runtime.getServiceLoadPromise<LateService>(
				LateService.serviceType,
			);
			expect(service.bound).toBe(true);
			expect(seen).toEqual([LateService.serviceType]);
			expect(await runtime.getServiceLoadPromise(LateService.serviceType)).toBe(
				service,
			);
			expect(seen).toHaveLength(1);
		} finally {
			await runtime.stop();
		}
	});

	it("reports observer failure without failing an already started service", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		class ObservedService extends Service {
			static override serviceType = "failed-observer-test";
			capabilityDescription = "observer failure test";
			static override async start(owner: IAgentRuntime) {
				return new ObservedService(owner);
			}
		}
		runtime.registerEvent(
			EventType.SERVICE_STARTED,
			async ({ serviceType }) => {
				if (serviceType === ObservedService.serviceType)
					throw new Error("observer failed");
			},
		);
		try {
			await runtime.registerService(ObservedService);
			expect(
				await runtime.getServiceLoadPromise(ObservedService.serviceType),
			).toBeInstanceOf(ObservedService);
			expect(runtime.getService(ObservedService.serviceType)).toBeInstanceOf(
				ObservedService,
			);
		} finally {
			await runtime.stop();
		}
	});
});
