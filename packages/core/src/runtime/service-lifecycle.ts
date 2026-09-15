/** Coordinates service start deduplication and stop-during-start settlement using the original runtime and its shared registries. */

import { ElizaError } from "../errors";
import type {
	IAgentRuntime,
	Service,
	ServiceClass,
	ServiceTypeName,
} from "../types";
import { EventType } from "../types/events";

export type ServiceResolver = (service: Service) => void;

export type ServiceRejecter = (reason: Error | string) => void;

export type ServicePromiseHandler = {
	resolve: ServiceResolver;
	reject: ServiceRejecter;
};

export interface RuntimeServiceLifecycleHost {
	stopRequested(): boolean;
	isNativeFeatureServiceEnabled(serviceType: ServiceTypeName | string): boolean;
	resolveServiceTypeAlias(serviceType: ServiceTypeName | string): string;
	initResolver(): ((value?: void | PromiseLike<void>) => void) | undefined;
	serviceTypes(): Map<ServiceTypeName, ServiceClass[]>;
	serviceInstancesByClass(): Map<ServiceClass, Service>;
	startingServiceClasses(): Map<ServiceClass, Promise<Service>>;
	failedServiceClasses(): Set<ServiceClass>;
	startingServices(): Map<string, Promise<Service | null>>;
	serviceRegistrationStatus(): Map<
		ServiceTypeName,
		"pending" | "registering" | "registered" | "failed"
	>;
	servicePromiseHandlers(): Map<string, ServicePromiseHandler>;
	servicePromises(): Map<string, Promise<Service>>;
	stopped(): boolean;
}

/** Backoff between eager service-start attempts after a failed boot-time start. */
const EAGER_SERVICE_START_RETRY_DELAYS_MS: readonly number[] = [
	2_000, 5_000, 10_000,
];

export class RuntimeServiceLifecycle {
	/** Retries eager startup after transient failures; shutdown terminates retries. */
	async startServiceEagerly(
		serviceType: ServiceTypeName | string,
		pluginName: string,
	): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await this._ensureServiceStarted(serviceType);
				return;
			} catch (err) {
				// error-policy:J5 eager startup is fire-and-forget; _runServiceStart
				// reports each failure and service-load callers observe the rejection.
				const delayMs = EAGER_SERVICE_START_RETRY_DELAYS_MS[attempt];
				const willRetry =
					delayMs !== undefined &&
					!this.host.stopRequested() &&
					!this.host.stopped();
				this.runtime.logger.error(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						plugin: pluginName,
						serviceType,
						attempt: attempt + 1,
						willRetry,
						error: err instanceof Error ? err.message : String(err),
					},
					willRetry ? "Service start failed; retrying" : "Service start failed",
				);
				if (!willRetry) return;
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				if (this.host.stopRequested() || this.host.stopped()) return;
			}
		}
	}

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly host: RuntimeServiceLifecycleHost,
	) {}

	async _stopServiceInstance(
		serviceType: string,
		service: Service | null | undefined,
		reason: string,
	): Promise<void> {
		const maybe = service as { stop?: () => Promise<void> | void } | null;
		if (maybe && typeof maybe.stop === "function") {
			try {
				await Promise.resolve().then(() => maybe.stop?.());
			} catch (err) {
				// error-policy:J6 Service shutdown is best-effort so every
				// registered service receives its teardown opportunity.
				this.runtime.logger.warn(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						serviceType,
						reason,
						error: err instanceof Error ? err.message : String(err),
					},
					"Service stop() threw; continuing",
				);
			}
		} else if (!maybe) {
			this.runtime.logger.warn(
				{ src: "agent", agentId: this.runtime.agentId, serviceType, reason },
				"Null service instance during stop; skipping",
			);
		} else {
			this.runtime.logger.warn(
				{ src: "agent", agentId: this.runtime.agentId, serviceType, reason },
				"Service instance is missing stop(); skipping",
			);
		}
	}

	/** Starts every pending implementation in parallel and waits for the full set. */
	async _ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null> {
		if (this.host.stopRequested()) return null;
		if (!this.host.isNativeFeatureServiceEnabled(serviceType)) return null;
		const key = this.host.resolveServiceTypeAlias(
			serviceType,
		) as ServiceTypeName;
		// Fast path: a service that is already registered and running is returned
		// immediately WITHOUT awaiting initPromise. Callers inside initialize()
		// (plugin init -> getFilteredActions) would otherwise deadlock on the
		// still-unresolved init barrier even though the instance is already up.
		const alreadyRunning = this.runtime.services.get(key)?.[0];
		if (alreadyRunning && this.host.initResolver()) return alreadyRunning;
		await this.runtime.initPromise;
		if (this.host.stopRequested()) return null;
		const classes = this.host.serviceTypes().get(key);
		if (!classes || classes.length === 0) {
			return null;
		}
		const startedImplementation = classes
			.map((serviceClass) =>
				this.host.serviceInstancesByClass().get(serviceClass),
			)
			.find((service): service is Service => service !== undefined);
		const starts = classes.map((serviceClass) => {
			const started = this.host.serviceInstancesByClass().get(serviceClass);
			if (started) return Promise.resolve(started);
			const pending = this.host.startingServiceClasses().get(serviceClass);
			if (pending) return pending;
			if (
				startedImplementation &&
				this.host.failedServiceClasses().has(serviceClass)
			) {
				return Promise.resolve(startedImplementation);
			}

			const start = this._runServiceStart(key, serviceType, serviceClass).then(
				(service) => {
					if (!service) {
						throw new Error(
							`Service implementation ${serviceClass.name || "<anonymous>"} did not start`,
						);
					}
					this.host.failedServiceClasses().delete(serviceClass);
					return service;
				},
				(error) => {
					this.host.failedServiceClasses().add(serviceClass);
					throw error;
				},
			);
			this.host.startingServiceClasses().set(serviceClass, start);
			void start.then(
				() => this.host.startingServiceClasses().delete(serviceClass),
				() => this.host.startingServiceClasses().delete(serviceClass),
			);
			return start;
		});

		const settlement = Promise.allSettled(starts);
		const allStarts = settlement.then((results) => {
			const firstSuccessful = results.find(
				(result): result is PromiseFulfilledResult<Service> =>
					result.status === "fulfilled",
			)?.value;
			return firstSuccessful ?? null;
		});
		this.host.startingServices().set(key, allStarts);
		void allStarts.then(() => {
			if (this.host.startingServices().get(key) === allStarts) {
				this.host.startingServices().delete(key);
			}
		});

		const settled = await settlement;
		const first = this.runtime.services.get(key)?.[0] ?? null;
		if (first) {
			this.host.serviceRegistrationStatus().set(key, "registered");
			const handler = this.host.servicePromiseHandlers().get(key);
			if (handler) {
				handler.resolve(first);
				this.host.servicePromiseHandlers().delete(key);
			}
			return first;
		}

		const cause = new AggregateError(
			settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			),
			`All implementations of service ${String(serviceType)} failed`,
		);
		const startupError = new ElizaError(
			`Service ${String(serviceType)} not found or failed to start`,
			{
				code: "SERVICE_START_FAILED",
				context: {
					serviceType: String(serviceType),
					implementationCount: classes.length,
				},
				cause,
			},
		);
		const handler = this.host.servicePromiseHandlers().get(key);
		if (handler) {
			handler.reject(startupError);
			this.host.servicePromiseHandlers().delete(key);
			this.host.servicePromises().delete(key);
		}
		this.host.serviceRegistrationStatus().set(key, "failed");
		throw startupError;
	}

	/** Runs one service start; used by _ensureServiceStarted with startingServices dedupe. */
	async _runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: ServiceClass,
	): Promise<Service | null> {
		if ((this.runtime.services.get(key)?.length ?? 0) === 0) {
			this.host.serviceRegistrationStatus().set(key, "registering");
		}
		if (typeof serviceDef.start !== "function") {
			this.host.serviceRegistrationStatus().set(key, "failed");
			throw new ElizaError("Service class has no static start method", {
				code: "SERVICE_START_METHOD_MISSING",
				context: { serviceType },
			});
		}
		try {
			if (this.host.stopped() || this.host.stopRequested()) {
				throw new Error(
					`Runtime stop requested before service ${String(serviceType)} could start`,
				);
			}
			const serviceInstance = await serviceDef.start(this.runtime);
			if (!serviceInstance) {
				this.host.serviceRegistrationStatus().set(key, "failed");
				throw new ElizaError("Service start returned no instance", {
					code: "SERVICE_START_RESULT_INVALID",
					context: { serviceType },
				});
			}
			if (this.host.stopped() || this.host.stopRequested()) {
				await this._stopServiceInstance(
					key,
					serviceInstance,
					"late service start after runtime stop",
				);
				throw new Error(
					`Runtime stop requested while service ${String(serviceType)} was starting`,
				);
			}
			this.host.serviceInstancesByClass().set(serviceDef, serviceInstance);
			const orderedInstances = (
				this.host.serviceTypes().get(key) ?? []
			).flatMap((serviceClass) => {
				const instance = this.host.serviceInstancesByClass().get(serviceClass);
				return instance ? [instance] : [];
			});
			this.runtime.services.set(key, orderedInstances);
			if (serviceDef.registerSendHandlers) {
				serviceDef.registerSendHandlers(this.runtime, serviceInstance);
			}
			// Hosts can attach transports to services loaded after API startup.
			// Observers must use getService(), not await the startup promise.
			try {
				await this.runtime.emitEvent(EventType.SERVICE_STARTED, {
					runtime: this.runtime,
					source: "runtime",
					serviceType,
				});
			} catch (error) {
				// error-policy:J7 observer failure must not invalidate a running service
				this.runtime.reportError("AgentRuntime.serviceStartedObserver", error, {
					serviceType,
				});
			}
			return serviceInstance;
		} catch (error) {
			// error-policy:J2 service startup adds service identity and preserves the cause
			this.runtime.reportError("AgentRuntime.serviceStart", error, {
				serviceType,
			});
			const handler = this.host.servicePromiseHandlers().get(serviceType);
			if (handler) {
				handler.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
				this.host.servicePromiseHandlers().delete(serviceType);
				this.host.servicePromises().delete(serviceType);
			}
			this.host.serviceRegistrationStatus().set(key, "failed");
			throw new ElizaError(`Service ${serviceType} failed to start`, {
				code: "SERVICE_START_FAILED",
				cause: error,
				context: { serviceType },
			});
		}
	}
}
