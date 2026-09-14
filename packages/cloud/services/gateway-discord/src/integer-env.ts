/**
 * Re-exports the shared gateway integer parser so gateway-discord env helpers
 * and the shared KEDA cooldown resolver reject the same lexical shapes.
 */
export {
  invalidIntegerEnvError,
  parseIntegerEnvValue,
} from "@elizaos/cloud-services-common/integer-env";
