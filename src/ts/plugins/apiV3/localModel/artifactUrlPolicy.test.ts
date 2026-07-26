import { describe, expect, it } from "vitest"
import { getPixaiArtifact } from "./pixaiRegistry"
import {
    assertRegisteredArtifactInitialUrl,
    resolveRegisteredArtifactRedirect,
} from "./artifactUrlPolicy"

const artifact = getPixaiArtifact(
    "pixai-tagger-v0.9-onnx",
    "model.onnx",
)

describe("registered artifact URL policy", () => {
    it("accepts only the artifact's exact immutable initial URL", () => {
        expect(assertRegisteredArtifactInitialUrl(artifact, artifact.url)).toBe(
            artifact.url,
        )

        for (const url of [
            artifact.url.replace(artifact.revision, "main"),
            artifact.url.replace("https://", "http://"),
            artifact.url.replace("huggingface.co", "user@huggingface.co"),
            `${artifact.url}#fragment`,
            `${artifact.url}?download=1`,
            artifact.url.replace("/resolve/", "/resolve/../"),
            artifact.url.replace("huggingface.co", "huggingface.co:444"),
        ]) {
            expect(() =>
                assertRegisteredArtifactInitialUrl(artifact, url),
            ).toThrow()
        }
    })

    it("accepts reviewed one-hop Host and Xet redirect shapes", () => {
        expect(
            resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location:
                    "https://chat.example/api/resolve-cache/deepghs/pixai-tagger-v0.9-onnx/model.onnx",
                currentHostOrigin: "https://chat.example",
                redirectsFollowed: 0,
            }),
        ).toBe(
            "https://chat.example/api/resolve-cache/deepghs/pixai-tagger-v0.9-onnx/model.onnx",
        )

        const xet =
            "https://us.aws.cdn.hf.co/xet-bridge-us/abc/model.onnx?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260726T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc&X-Amz-SignedHeaders=host"
        expect(
            resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location: xet,
                currentHostOrigin: "https://chat.example",
                redirectsFollowed: 0,
            }),
        ).toBe(xet)
    })

    it.each([
        ["insecure", "http://us.aws.cdn.hf.co/xet-bridge-us/a"],
        ["credentials", "https://u:p@us.aws.cdn.hf.co/xet-bridge-us/a"],
        ["fragment", "https://us.aws.cdn.hf.co/xet-bridge-us/a#x"],
        ["wrong host", "https://cdn.example/xet-bridge-us/a"],
        ["wrong port", "https://us.aws.cdn.hf.co:444/xet-bridge-us/a"],
        ["wrong path", "https://us.aws.cdn.hf.co/not-xet/a"],
        ["encoded traversal", "https://us.aws.cdn.hf.co/xet-bridge-us/%2e%2e/a"],
        ["query widening", "https://us.aws.cdn.hf.co/xet-bridge-us/a?redirect=https://evil.example"],
        ["host query", "https://chat.example/api/resolve-cache/a?download=1"],
    ])("rejects %s redirects", (_name, location) => {
        expect(() =>
            resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location,
                currentHostOrigin: "https://chat.example",
                redirectsFollowed: 0,
            }),
        ).toThrow()
    })

    it("rejects a second redirect and non-canonical Host origins", () => {
        expect(() =>
            resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location: "https://chat.example/api/resolve-cache/a",
                currentHostOrigin: "https://chat.example",
                redirectsFollowed: 1,
            }),
        ).toThrow(/redirect limit/i)
        expect(() =>
            resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location: "https://chat.example/api/resolve-cache/a",
                currentHostOrigin: "https://chat.example/path",
                redirectsFollowed: 0,
            }),
        ).toThrow(/origin/i)
    })
})
