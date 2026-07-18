export type PluginApiErrorCode =
  | "UNSUPPORTED" | "PERMISSION_DENIED" | "NOT_FOUND"
  | "INVALID_ARGUMENT" | "ABORTED" | "QUOTA_EXCEEDED"
  | "RESOURCE_LIMIT" | "CONFLICT" | "NETWORK"
  | "INTEGRITY_MISMATCH" | "DECODE_FAILED"
  | "PROVIDER_ERROR" | "INTERNAL";

export interface PluginApiErrorShape {
  name: "PluginApiError";
  code: PluginApiErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, string | number | boolean>;
}
