import { describe, expect, it } from "vitest"
import {
    getPixaiArtifact,
    getPixaiProfile,
    isRegisteredPixaiArtifact,
} from "./pixaiRegistry"

describe("PixAI artifact registry", () => {
    it("returns the reviewed immutable profile literally", () => {
        expect(getPixaiProfile("pixai-tagger-v0.9-onnx")).toEqual({
            id: "pixai-tagger-v0.9-onnx",
            repository: "deepghs/pixai-tagger-v0.9-onnx",
            revision: "d8cf666911a2c3d10d586d7823259192313c7eb7",
            sourceUrl: "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx",
            license: "Apache-2.0",
            licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
            preprocessing: {
                version: "pixai-v0.9-preprocess-448-rgb-bilinear-v1",
                width: 448,
                height: 448,
                color: "rgb",
                resize: "bilinear",
                labelCount: 13_461,
            },
            thresholds: { general: 0.3, character: 0.85 },
            totalBytes: 1_271_963_279,
            artifacts: [
                {
                    profileId: "pixai-tagger-v0.9-onnx",
                    repository: "deepghs/pixai-tagger-v0.9-onnx",
                    revision: "d8cf666911a2c3d10d586d7823259192313c7eb7",
                    name: "model.onnx",
                    url: "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx",
                    bytes: 1_271_365_854,
                    sha256:
                        "a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657",
                },
                {
                    profileId: "pixai-tagger-v0.9-onnx",
                    repository: "deepghs/pixai-tagger-v0.9-onnx",
                    revision: "d8cf666911a2c3d10d586d7823259192313c7eb7",
                    name: "selected_tags.csv",
                    url: "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv",
                    bytes: 596_868,
                    sha256:
                        "76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a",
                },
                {
                    profileId: "pixai-tagger-v0.9-onnx",
                    repository: "deepghs/pixai-tagger-v0.9-onnx",
                    revision: "d8cf666911a2c3d10d586d7823259192313c7eb7",
                    name: "preprocess.json",
                    url: "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/preprocess.json",
                    bytes: 557,
                    sha256:
                        "5f8303626704053724fa7ac19cd269f57f5f843b6cca314276c8c4d48d335975",
                },
            ],
        })
    })

    it("returns deep-frozen copies so callers cannot alter the registry", () => {
        const first = getPixaiProfile("pixai-tagger-v0.9-onnx")
        const second = getPixaiProfile("pixai-tagger-v0.9-onnx")

        expect(first).not.toBe(second)
        expect(Object.isFrozen(first)).toBe(true)
        expect(Object.isFrozen(first.artifacts)).toBe(true)
        expect(Object.isFrozen(first.artifacts[0])).toBe(true)
        expect(() => {
            ;(first.artifacts[0] as { url: string }).url = "https://mutable.invalid/"
        }).toThrow()
        expect(second.artifacts[0].url).toContain("/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/")
    })

    it("rejects unknown profiles, artifacts, and altered registrations", () => {
        expect(() => getPixaiProfile("other-profile")).toThrow(/unknown profile/i)
        expect(() =>
            getPixaiArtifact("pixai-tagger-v0.9-onnx", "other.bin"),
        ).toThrow(/unknown artifact/i)

        const artifact = getPixaiArtifact(
            "pixai-tagger-v0.9-onnx",
            "model.onnx",
        )
        expect(isRegisteredPixaiArtifact(artifact)).toBe(true)
        expect(
            isRegisteredPixaiArtifact({ ...artifact, revision: "main" }),
        ).toBe(false)
        expect(
            isRegisteredPixaiArtifact({
                ...artifact,
                url: artifact.url.replace(artifact.revision, "main"),
            }),
        ).toBe(false)
    })
})
