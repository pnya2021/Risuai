import type { PluginPermissionId } from './permissions'

export const CAPABILITY_IDS = [
    'context.current.v1',
    'context.assets.v1',
    'context.modules-installed.v1',
    'context.cards-catalog.v1',
    'secrets.write-only.v1',
    'chat.message-events.v1',
    'chat.message-query.v1',
    'chat.message-patch.v1',
    'inlay.create.v1',
    'inlay.read.v1',
    'inlay.delete-own.v1',
    'inlay.atomic-attach.v1',
    'local-model.pixai-v0.9.v1',
    'storage.device-cache.v1',
    'plugin-jobs.v1',
] as const

export type PluginCapabilityId = typeof CAPABILITY_IDS[number]

export interface CapabilityContractEntry {
    version: 1
    permission?: PluginPermissionId
    additionalPermissions: PluginPermissionId[]
    limits: Record<string, number | string | boolean>
    requiresCurrentContext?: boolean
}

export const STUDIO_CARD_API_METHODS = [
    'listStudioCards',
    'releaseStudioCardCatalogue',
    'captureStudioCardSource',
    'releaseStudioCardTarget',
    'listStudioCardAssets',
    'resolveStudioCardAssetHandles',
    'releaseStudioCardAssetAccess',
    'releaseStudioCardSource',
] as const

export const studioCardCapabilityIdsForApi = (api: unknown): PluginCapabilityId[] => {
    if (typeof api !== 'object' || api === null) return []
    return STUDIO_CARD_API_METHODS.every((method) => typeof (api as Record<string, unknown>)[method] === 'function')
        ? ['context.cards-catalog.v1']
        : []
}

export const CAPABILITY_CONTRACT: Record<PluginCapabilityId, CapabilityContractEntry> = {
    'context.current.v1': {
        version: 1, permission: 'contextAssets', additionalPermissions: [], requiresCurrentContext: true,
        limits: { maxSnapshotJsonBytes: 2097152, maxJsonDepth: 32, maxTextFieldUtf8Bytes: 524288 },
    },
    'context.assets.v1': {
        version: 1, permission: 'contextAssets', additionalPermissions: ['installedModulesRead'], requiresCurrentContext: true,
        limits: { maxSnapshotJsonBytes: 2097152, maxJsonDepth: 32, maxTextFieldUtf8Bytes: 524288, defaultPageSize: 50, maxPageSize: 100, cursorTtlMs: 300000, maxActiveCursorsPerPrincipal: 64, maxActiveModules: 100, defaultAssetReadBytes: 16777216, maxAssetReadBytes: 33554432, assetReadPolicy: 'backpressure', maxConcurrentAssetReadsPerPrincipal: 4, maxConcurrentOriginalAssetReadsPerPrincipal: 1, maxQueuedAssetReadsPerPrincipal: 128, assetReadCancellation: true, thumbnailLongEdge: 512, maxThumbnailPixels: 262144, maxThumbnailOutputBytes: 1048576, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728, moduleIdsFilter: true, maxModuleIdsPerAssetList: 100, captureFence: 'query-collection-v1', maxCapturedQueryItemsPerPrincipal: 20000, maxCapturedQueryMetadataBytesPerPrincipal: 16777216 },
    },
    'context.modules-installed.v1': {
        version: 1, permission: 'installedModulesRead', additionalPermissions: [],
        limits: { maxSnapshotJsonBytes: 2097152, maxJsonDepth: 32, maxTextFieldUtf8Bytes: 524288, defaultPageSize: 50, maxPageSize: 100, cursorTtlMs: 300000, maxActiveCursorsPerPrincipal: 64, moduleAssetCount: true, moduleAssetCollectionRevision: true, captureFence: 'query-collection-v1', maxCapturedQueryItemsPerPrincipal: 20000, maxCapturedQueryMetadataBytesPerPrincipal: 16777216 },
    },
    'context.cards-catalog.v1': {
        version: 1, permission: 'cardCatalogRead', additionalPermissions: [],
        limits: {
            defaultPageSize: 24,
            maxPageSize: 100,
            searchMaxUtf8Bytes: 256,
            cursorTtlMs: 300000,
            sourceCaptureTtlMs: 300000,
            assetAccessTtlMs: 300000,
            maxActiveCursorsPerPrincipal: 64,
            maxConcurrentAssetReadsPerPrincipal: 4,
            maxQueuedAssetReadsPerPrincipal: 128,
            maxActiveCataloguesPerPrincipal: 4,
            maxActiveTargetsPerPrincipal: 4,
            maxActiveCapturesPerPrincipal: 4,
            targetTtlMs: 1800000,
            maxCandidateAccessIds: 24,
            maxSelectedAccessIds: 3,
            maxLogicalAssetIdUtf8Bytes: 256,
            maxAccessBatchUtf8Bytes: 6144,
            maxCandidateAccessBatchesPerCapture: 2,
            maxSelectedAccessBatchesPerCapture: 1,
            maxCatalogueMetadataBytesPerPrincipal: 4194304,
            maxCapturedItemsPerPrincipal: 20000,
            maxCapturedMetadataBytesPerPrincipal: 16777216,
            maxGroupMembersPerCapture: 100,
            maxAggregateCaptureBytes: 16777216,
        },
    },
    'secrets.write-only.v1': {
        version: 1, permission: 'secrets', additionalPermissions: [],
        limits: { maxSecretsPerPrincipal: 32, maxSecretIdUtf8Bytes: 128, maxSecretValueBytes: 16384, maxSecretOrigins: 8, maxSecretUses: 16, maxJsonPointerUtf8Bytes: 512, maxSecretPrefixUtf8Bytes: 256, maxSecretRedirects: 5, maxJsonBodyBytes: 2097152, maxJsonDepth: 32, maxNativeFetchBodyBytes: 67108864, maxNativeFetchResponseBytes: 67108864, secretFetchesPerMinute: 60, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728 },
    },
    'chat.message-events.v1': {
        version: 1, permission: 'chatObserve', additionalPermissions: ['chatObserveAll'], requiresCurrentContext: true,
        limits: { maxQueuedEventsPerSubscription: 32, maxActiveCallbacksPerSubscription: 1, callbackTimeoutMs: 30000, maxSubscriptionsPerInstance: 16, maxMessageSnapshotUtf16: 262144, maxMessageSnapshotJsonBytes: 2097152, maxCallerAttachmentsPerSnapshot: 256 },
    },
    'chat.message-query.v1': {
        version: 1, permission: 'chatObserve', additionalPermissions: ['chatObserveAll'], requiresCurrentContext: true,
        limits: { defaultRecentMessageLimit: 8, maxRecentMessageLimit: 32, defaultRecentUtf16: 12000, maxRecentUtf16: 65536, maxMessageSnapshotUtf16: 262144, maxMessageSnapshotJsonBytes: 2097152, maxCallerAttachmentsPerSnapshot: 256 },
    },
    'chat.message-patch.v1': {
        version: 1, permission: 'chatWrite', additionalPermissions: ['chatWriteAll', 'inlayWrite', 'inlayRead', 'inlayManage'], requiresCurrentContext: true,
        limits: { maxMessagePatchTextUtf8Bytes: 262144, maxCallerMetadataJsonBytes: 65536, maxMessageMetadataKeys: 16, maxIdempotencyKeyUtf8Bytes: 256, messageMutationsPerMinute: 30 },
    },
    'inlay.create.v1': {
        version: 1, permission: 'inlayWrite', additionalPermissions: [],
        limits: { maxInlayInputBytes: 33554432, maxDecodedPixels: 64000000, maxNormalizedImagePixels: 1048576, maxInlayNameUtf8Bytes: 255, maxIdempotencyKeyUtf8Bytes: 256, maxOwnedInlayBytesPerPrincipal: 1073741824, maxOwnedInlaysPerPrincipal: 2048, inlayCreatesPerMinute: 30, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728 },
    },
    'inlay.read.v1': {
        version: 1, permission: 'inlayWrite', additionalPermissions: ['inlayRead'],
        limits: { maxInlayOutputBytes: 33554432, inlayReadsPerMinute: 60, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728 },
    },
    'inlay.delete-own.v1': {
        version: 1, permission: 'inlayWrite', additionalPermissions: ['chatWrite', 'chatWriteAll', 'chatObserve', 'chatObserveAll'],
        limits: { maxDeleteReferenceDetails: 16 },
    },
    'inlay.atomic-attach.v1': {
        version: 1, permission: 'chatWrite', additionalPermissions: ['chatWriteAll', 'inlayWrite'], requiresCurrentContext: true,
        limits: { maxInlayInputBytes: 33554432, maxDecodedPixels: 64000000, maxNormalizedImagePixels: 1048576, maxInlayNameUtf8Bytes: 255, maxCallerMetadataJsonBytes: 65536, maxMessageMetadataKeys: 16, maxIdempotencyKeyUtf8Bytes: 256, maxOwnedInlayBytesPerPrincipal: 1073741824, maxOwnedInlaysPerPrincipal: 2048, messageMutationsPerMinute: 30, inlayCreatesPerMinute: 30, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728 },
    },
    'local-model.pixai-v0.9.v1': {
        version: 1, permission: 'localModelInference', additionalPermissions: ['contextAssets', 'inlayWrite', 'inlayRead'],
        limits: { maxUnderlyingInstallsPerProfileDigest: 1, maxHeavySessionsPerProfileProvider: 1, maxGlobalInference: 1, maxQueuedInferencePerPrincipal: 4, inferenceTimeoutMs: 300000, maxResultTags: 500, maxRetainedTerminalOperationsPerPrincipal: 100, terminalOperationTtlMs: 604800000 },
    },
    'storage.device-cache.v1': {
        version: 1, additionalPermissions: [],
        limits: { maxCacheBytesPerPrincipal: 134217728, maxCacheEntriesPerPrincipal: 1024, maxCacheEntryBytes: 33554432, maxCacheKeyUtf8Bytes: 256, defaultPageSize: 50, maxPageSize: 100, maxTtlMs: 2592000000, maxActiveCursorsPerPrincipal: 64, maxRpcBinaryValueBytes: 67108864, maxRpcAggregateBytes: 134217728 },
    },
    'plugin-jobs.v1': {
        version: 1, permission: 'pluginJobs', additionalPermissions: [],
        limits: { maxActiveJobsPerInstance: 8, maxJobTitleUtf8Bytes: 128, maxJobPhaseUtf8Bytes: 128, maxJobMessageUtf8Bytes: 1024, maxJobUpdatesPerSecond: 4, callbackTimeoutMs: 30000 },
    },
}
