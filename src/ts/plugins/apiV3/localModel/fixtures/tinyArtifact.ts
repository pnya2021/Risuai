import type { RegisteredModelArtifact } from "../pixaiRegistry"

export const TINY_ARTIFACT_SHA256 =
    "71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10"

const TINY_ARTIFACT_LITERAL = [
    8, 3, 18, 6, 99, 104, 101, 110, 116, 97, 58, 112, 10, 21, 10, 1, 88,
    10, 1, 87, 18, 1, 89, 26, 5, 109, 117, 108, 95, 49, 34, 3, 77, 117,
    108, 18, 8, 109, 117, 108, 32, 116, 101, 115, 116, 42, 35, 8, 3, 8,
    2, 16, 1, 34, 24, 0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0,
    128, 64, 0, 0, 160, 64, 0, 0, 192, 64, 66, 1, 87, 90, 19, 10, 1,
    88, 18, 14, 10, 12, 8, 1, 18, 8, 10, 2, 8, 3, 10, 2, 8, 2, 98, 19,
    10, 1, 89, 18, 14, 10, 12, 8, 1, 18, 8, 10, 2, 8, 3, 10, 2, 8, 2,
    66, 4, 10, 0, 16, 7,
] as const

export function tinyArtifactBytes(): Uint8Array {
    return new Uint8Array(TINY_ARTIFACT_LITERAL)
}

export const TINY_ARTIFACT: Readonly<RegisteredModelArtifact> = Object.freeze({
    profileId: "test-only-mul-1",
    repository: "microsoft/onnxruntime",
    revision: "967ffc03cc32c7867edd5d9633f382a878e119b3",
    name: "model.onnx",
    url: "https://raw.githubusercontent.com/microsoft/onnxruntime/967ffc03cc32c7867edd5d9633f382a878e119b3/onnxruntime/test/testdata/mul_1.onnx",
    bytes: 130,
    sha256: TINY_ARTIFACT_SHA256,
})
