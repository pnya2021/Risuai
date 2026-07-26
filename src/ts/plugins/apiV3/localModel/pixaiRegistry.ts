export const PIXAI_PROFILE_ID = "pixai-tagger-v0.9-onnx" as const

export type PixaiProfileId = typeof PIXAI_PROFILE_ID
export type PixaiArtifactName =
    | "model.onnx"
    | "selected_tags.csv"
    | "preprocess.json"

export interface RegisteredModelArtifact {
    readonly profileId: string
    readonly repository: string
    readonly revision: string
    readonly name: string
    readonly url: string
    readonly bytes: number
    readonly sha256: string
}

export interface PixaiProfile {
    readonly id: PixaiProfileId
    readonly repository: string
    readonly revision: string
    readonly sourceUrl: string
    readonly license: string
    readonly licenseUrl: string
    readonly preprocessing: Readonly<{
        version: string
        width: number
        height: number
        color: "rgb"
        resize: "bilinear"
        labelCount: number
    }>
    readonly thresholds: Readonly<{ general: number; character: number }>
    readonly totalBytes: number
    readonly artifacts: readonly Readonly<RegisteredModelArtifact>[]
}

const REPOSITORY = "deepghs/pixai-tagger-v0.9-onnx"
const REVISION = "d8cf666911a2c3d10d586d7823259192313c7eb7"
const RESOLVE_PREFIX = `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/`

const ARTIFACTS = [
    {
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: "model.onnx",
        url: `${RESOLVE_PREFIX}model.onnx`,
        bytes: 1_271_365_854,
        sha256: "a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657",
    },
    {
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: "selected_tags.csv",
        url: `${RESOLVE_PREFIX}selected_tags.csv`,
        bytes: 596_868,
        sha256: "76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a",
    },
    {
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: "preprocess.json",
        url: `${RESOLVE_PREFIX}preprocess.json`,
        bytes: 557,
        sha256: "5f8303626704053724fa7ac19cd269f57f5f843b6cca314276c8c4d48d335975",
    },
] as const satisfies readonly RegisteredModelArtifact[]

function cloneArtifact(
    artifact: Readonly<RegisteredModelArtifact>,
): Readonly<RegisteredModelArtifact> {
    return Object.freeze({ ...artifact })
}

function makeProfile(): Readonly<PixaiProfile> {
    const artifacts = Object.freeze(ARTIFACTS.map(cloneArtifact))
    return Object.freeze({
        id: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        sourceUrl: `https://huggingface.co/${REPOSITORY}`,
        license: "Apache-2.0",
        licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        preprocessing: Object.freeze({
            version: "pixai-v0.9-preprocess-448-rgb-bilinear-v1",
            width: 448,
            height: 448,
            color: "rgb" as const,
            resize: "bilinear" as const,
            labelCount: 13_461,
        }),
        thresholds: Object.freeze({ general: 0.3, character: 0.85 }),
        totalBytes: 1_271_963_279,
        artifacts,
    })
}

export function getPixaiProfile(profileId: string): Readonly<PixaiProfile> {
    if (profileId !== PIXAI_PROFILE_ID) {
        throw new Error(`Unknown profile: ${profileId}`)
    }
    return makeProfile()
}

export function getPixaiArtifact(
    profileId: string,
    name: string,
): Readonly<RegisteredModelArtifact> {
    const profile = getPixaiProfile(profileId)
    const artifact = profile.artifacts.find((entry) => entry.name === name)
    if (!artifact) throw new Error(`Unknown artifact: ${name}`)
    return cloneArtifact(artifact)
}

export function isRegisteredPixaiArtifact(
    candidate: Readonly<RegisteredModelArtifact>,
): boolean {
    const expected = ARTIFACTS.find(
        (artifact) =>
            artifact.profileId === candidate.profileId &&
            artifact.name === candidate.name,
    )
    return (
        expected !== undefined &&
        expected.repository === candidate.repository &&
        expected.revision === candidate.revision &&
        expected.url === candidate.url &&
        expected.bytes === candidate.bytes &&
        expected.sha256 === candidate.sha256
    )
}

export function assertRegisteredPixaiArtifact(
    candidate: Readonly<RegisteredModelArtifact>,
): void {
    if (!isRegisteredPixaiArtifact(candidate)) {
        throw new Error("Artifact is not in the fixed PixAI registry")
    }
}
