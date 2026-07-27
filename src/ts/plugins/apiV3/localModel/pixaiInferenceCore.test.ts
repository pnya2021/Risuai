import { describe, expect, it } from "vitest"
import {
    inspectPixaiEncodedImage,
    normalizePixaiRunOptions,
    parsePixaiPreprocess,
    parsePixaiTags,
    postprocessPixaiScores,
    rgbaToPixaiTensor,
} from "./pixaiInferenceCore"

const LABEL_COUNT = 13_461

const preprocess = (extra = "") =>
    new TextEncoder().encode(`{
        "stages": [
            {"type":"resize","size":[448,448],"interpolation":"bilinear","antialias":null,"max_size":null},
            {"type":"to_tensor"},
            {"type":"normalize","mean":[0.5,0.5,0.5],"std":[0.5,0.5,0.5]}
        ]${extra}
    }`)

const tagsCsv = (
    mutate?: (row: string[], index: number) => void,
    newline = "\n",
) => {
    const rows = ["id,tag_id,name,category,count,ips"]
    for (let index = 0; index < LABEL_COUNT; index += 1) {
        const row = [
            String(index),
            String(index + 10),
            index === 0 ? '"comma, ""quote"""' : `tag_${index}`,
            index < 9_741 ? "0" : "4",
            "1",
            "0",
        ]
        mutate?.(row, index)
        rows.push(row.join(","))
    }
    return new TextEncoder().encode(rows.join(newline))
}

const pngHeader = (width: number, height: number) => {
    const bytes = new Uint8Array(33)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
    bytes.set([73, 72, 68, 82], 12)
    new DataView(bytes.buffer).setUint32(16, width)
    new DataView(bytes.buffer).setUint32(20, height)
    return bytes
}

const jpegHeader = (width: number, height: number) =>
    new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x02,
        0xff, 0xc0, 0x00, 0x08, 0x08,
        height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01,
        0xff, 0xd9,
    ])

const webpHeader = (width: number, height: number) => {
    const bytes = new Uint8Array(44)
    bytes.set(new TextEncoder().encode("RIFF"))
    new DataView(bytes.buffer).setUint32(4, 36, true)
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8)
    new DataView(bytes.buffer).setUint32(16, 10, true)
    const view = new DataView(bytes.buffer)
    view.setUint8(24, (width - 1) & 0xff)
    view.setUint8(25, ((width - 1) >> 8) & 0xff)
    view.setUint8(26, ((width - 1) >> 16) & 0xff)
    view.setUint8(27, (height - 1) & 0xff)
    view.setUint8(28, ((height - 1) >> 8) & 0xff)
    view.setUint8(29, ((height - 1) >> 16) & 0xff)
    bytes.set(new TextEncoder().encode("VP8L"), 30)
    view.setUint32(34, 5, true)
    view.setUint8(38, 0x2f)
    view.setUint32(39, (width - 1) | ((height - 1) << 14), true)
    return bytes
}

describe("PixAI fixed inference core", () => {
    it("accepts only the exact duplicate-free preprocessing profile", () => {
        expect(parsePixaiPreprocess(preprocess())).toEqual({ width: 448, height: 448 })
        expect(() => parsePixaiPreprocess(preprocess(",\"extra\":true"))).toThrow()
        expect(() =>
            parsePixaiPreprocess(
                new TextEncoder().encode('{"stages":[],"stages":[]}'),
            ),
        ).toThrow()
        expect(() => parsePixaiPreprocess(new Uint8Array([0xff]))).toThrow()
    })

    it("parses quoted CRLF tags and enforces the fixed row/category contract", () => {
        const tags = parsePixaiTags(tagsCsv(undefined, "\r\n"))
        expect(tags).toHaveLength(LABEL_COUNT)
        expect(tags[0]).toEqual({ index: 0, name: 'comma, "quote"', category: "general" })
        expect(tags[9_740]?.category).toBe("general")
        expect(tags[9_741]?.category).toBe("character")
        expect(Object.isFrozen(tags)).toBe(true)
        expect(() => parsePixaiTags(tagsCsv((row, index) => {
            if (index === 20) row[0] = "19"
        }))).toThrow()
        expect(() => parsePixaiTags(tagsCsv((row, index) => {
            if (index === 20) row[3] = "1"
        }))).toThrow()
        expect(() => parsePixaiTags(tagsCsv((row, index) => {
            if (index === 20) row[2] = '""'
        }))).toThrow()
    })

    it("inspects strict PNG, JPEG and WebP dimensions before decode", () => {
        expect(inspectPixaiEncodedImage(pngHeader(20, 30), "image/png")).toEqual({
            mediaType: "image/png", width: 20, height: 30,
        })
        expect(inspectPixaiEncodedImage(jpegHeader(21, 31), "image/jpeg")).toEqual({
            mediaType: "image/jpeg", width: 21, height: 31,
        })
        expect(inspectPixaiEncodedImage(webpHeader(22, 32), "image/webp")).toEqual({
            mediaType: "image/webp", width: 22, height: 32,
        })
        expect(() => inspectPixaiEncodedImage(pngHeader(1, 1), "image/jpeg")).toThrow()
        expect(() => inspectPixaiEncodedImage(pngHeader(8_001, 8_000), "image/png")).toThrow()
        expect(() => inspectPixaiEncodedImage(new Uint8Array([0xff, 0xd8]), "image/jpeg")).toThrow()
        const multiple = new Uint8Array([...webpHeader(1, 1), ...webpHeader(1, 1).slice(12)])
        new DataView(multiple.buffer).setUint32(4, multiple.byteLength - 8, true)
        expect(() => inspectPixaiEncodedImage(multiple, "image/webp")).toThrow()
    })

    it("uses deterministic center-coordinate bilinear RGB NCHW normalization", () => {
        const tensor = rgbaToPixaiTensor(
            new Uint8ClampedArray([
                0, 10, 20, 1, 100, 110, 120, 2,
                200, 210, 220, 3, 255, 250, 240, 4,
            ]),
            2,
            2,
        )
        expect(tensor.dimensions).toEqual([1, 3, 448, 448])
        const plane = 448 * 448
        expect(tensor.data[0]).toBeCloseTo(-1, 6)
        expect(tensor.data[447]).toBeCloseTo(1 / 127.5 * 100 - 1, 6)
        expect(tensor.data[447 * 448]).toBeCloseTo(200 / 127.5 - 1, 6)
        expect(tensor.data[plane]).toBeCloseTo(10 / 127.5 - 1, 6)
        expect(tensor.data[plane * 2]).toBeCloseTo(20 / 127.5 - 1, 6)
        const center = 223 * 448 + 223
        const source = ((223.5 * 2) / 448) - 0.5
        const expected = 0 * (1 - source) ** 2 + 100 * source * (1 - source) +
            200 * (1 - source) * source + 255 * source ** 2
        expect(tensor.data[center]).toBeCloseTo(expected / 127.5 - 1, 5)
    })

    it("normalizes options and postprocesses by category, inclusive threshold and stable tie", () => {
        expect(normalizePixaiRunOptions()).toMatchObject({
            categories: ["general", "character"],
            thresholds: { general: 0.3, character: 0.85 },
            maxResults: 500,
        })
        expect(() => normalizePixaiRunOptions({ categories: [] })).toThrow()
        expect(() => normalizePixaiRunOptions({ categories: ["general", "general"] })).toThrow()
        expect(() => normalizePixaiRunOptions({ thresholds: { general: Number.NaN } })).toThrow()
        expect(() => normalizePixaiRunOptions({ maxResults: 501 })).toThrow()

        const tags = parsePixaiTags(tagsCsv())
        const scores = new Float32Array(LABEL_COUNT)
        scores[1] = 0.3
        scores[2] = 0.3
        scores[9_741] = 0.99
        const result = postprocessPixaiScores(scores, [1, LABEL_COUNT], tags, {
            categories: ["general"], maxResults: 1,
        })
        expect(result.tags).toEqual([
            { index: 1, name: "tag_1", score: expect.any(Number), category: "general" },
        ])
        expect(result.truncated).toBe(true)
        expect(result).not.toHaveProperty("scores")
        expect(() => postprocessPixaiScores(scores, [LABEL_COUNT], tags)).toThrow()
        scores[3] = Number.NaN
        expect(() => postprocessPixaiScores(scores, [1, LABEL_COUNT], tags)).toThrow()
    })
})
