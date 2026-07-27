import {
    getPixaiArtifact,
    getPixaiProfile,
    PIXAI_PROFILE_ID,
} from "./pixaiRegistry"

export const PIXAI_WIDTH = 448
export const PIXAI_HEIGHT = 448
export const PIXAI_LABEL_COUNT = 13_461
export const PIXAI_MAX_IMAGE_BYTES = 33_554_432
export const PIXAI_MAX_IMAGE_PIXELS = 64_000_000
export const PIXAI_MAX_RESULTS = 500

export type PixaiMediaType = "image/jpeg" | "image/png" | "image/webp"
export type PixaiTagCategory = "general" | "character"

export interface PixaiTagDefinition {
    readonly index: number
    readonly name: string
    readonly category: PixaiTagCategory
}

export interface PixaiRunOptions {
    readonly categories?: readonly PixaiTagCategory[]
    readonly thresholds?: Readonly<Partial<Record<PixaiTagCategory, number>>>
    readonly maxResults?: number
}

export interface NormalizedPixaiRunOptions {
    readonly categories: readonly PixaiTagCategory[]
    readonly thresholds: Readonly<Record<PixaiTagCategory, number>>
    readonly maxResults: number
}

export interface PixaiTagResult extends PixaiTagDefinition {
    readonly score: number
}

export type PixaiInferenceCoreErrorCode =
    | "INVALID_ARGUMENT"
    | "MODEL_CONFIG_FAILED"
    | "IMAGE_DECODE_FAILED"
    | "INFERENCE_FAILED"

const CORE_MESSAGES: Record<PixaiInferenceCoreErrorCode, string> = {
    INVALID_ARGUMENT: "PixAI inference argument is invalid",
    MODEL_CONFIG_FAILED: "PixAI model configuration is invalid",
    IMAGE_DECODE_FAILED: "PixAI image could not be decoded",
    INFERENCE_FAILED: "PixAI inference output is invalid",
}

export class PixaiInferenceCoreError extends Error {
    readonly code: PixaiInferenceCoreErrorCode

    constructor(code: PixaiInferenceCoreErrorCode) {
        super(CORE_MESSAGES[code])
        this.name = "PixaiInferenceCoreError"
        this.code = code
    }
}

const fail = (code: PixaiInferenceCoreErrorCode): never => {
    throw new PixaiInferenceCoreError(code)
}

const plainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const ownData = (value: unknown, keys: readonly string[]) => {
    if (!plainRecord(value)) fail("MODEL_CONFIG_FAILED")
    const found = Reflect.ownKeys(value as Record<string, unknown>)
    if (
        found.length !== keys.length ||
        found.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
        fail("MODEL_CONFIG_FAILED")
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
            fail("MODEL_CONFIG_FAILED")
        }
        result[key] = descriptor.value
    }
    return result
}

const exactArray = (value: unknown, expected: readonly unknown[]) => {
    if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length !== expected.length ||
        value.some((entry, index) => entry !== expected[index])
    ) {
        fail("MODEL_CONFIG_FAILED")
    }
}

const decodeUtf8 = (bytes: Uint8Array) => {
    if (
        !(bytes instanceof Uint8Array) ||
        Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
        bytes.byteLength < 1
    ) {
        fail("MODEL_CONFIG_FAILED")
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
        fail("MODEL_CONFIG_FAILED")
    }
}

const rejectDuplicateJsonKeys = (text: string) => {
    const whitespace = (start: number) => {
        let index = start
        while (index < text.length && /[\t\n\r ]/.test(text[index]!)) index += 1
        return index
    }
    const stringAt = (start: number): [string, number] => {
        if (text[start] !== '"') fail("MODEL_CONFIG_FAILED")
        let index = start + 1
        while (index < text.length) {
            const character = text[index]!
            if (character === "\\") {
                index += text[index + 1] === "u" ? 6 : 2
                continue
            }
            if (character === '"') {
                index += 1
                try {
                    return [JSON.parse(text.slice(start, index)) as string, index]
                } catch {
                    fail("MODEL_CONFIG_FAILED")
                }
            }
            if (text.charCodeAt(index) < 0x20) fail("MODEL_CONFIG_FAILED")
            index += 1
        }
        fail("MODEL_CONFIG_FAILED")
    }
    const valueAt = (start: number): number => {
        let index = whitespace(start)
        if (text[index] === "{") {
            const keys = new Set<string>()
            index = whitespace(index + 1)
            if (text[index] === "}") return index + 1
            while (true) {
                const [key, afterKey] = stringAt(index)
                if (keys.has(key)) fail("MODEL_CONFIG_FAILED")
                keys.add(key)
                index = whitespace(afterKey)
                if (text[index] !== ":") fail("MODEL_CONFIG_FAILED")
                index = whitespace(valueAt(index + 1))
                if (text[index] === "}") return index + 1
                if (text[index] !== ",") fail("MODEL_CONFIG_FAILED")
                index = whitespace(index + 1)
            }
        }
        if (text[index] === "[") {
            index = whitespace(index + 1)
            if (text[index] === "]") return index + 1
            while (true) {
                index = whitespace(valueAt(index))
                if (text[index] === "]") return index + 1
                if (text[index] !== ",") fail("MODEL_CONFIG_FAILED")
                index = whitespace(index + 1)
            }
        }
        if (text[index] === '"') return stringAt(index)[1]
        const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
            text.slice(index),
        )
        if (!primitive) fail("MODEL_CONFIG_FAILED")
        return index + primitive[0].length
    }
    if (whitespace(valueAt(0)) !== text.length) fail("MODEL_CONFIG_FAILED")
}

export function parsePixaiPreprocess(bytes: Uint8Array): Readonly<{
    width: 448
    height: 448
}> {
    const text = decodeUtf8(bytes)
    let parsed: unknown
    try {
        rejectDuplicateJsonKeys(text)
        parsed = JSON.parse(text)
    } catch (error) {
        if (error instanceof PixaiInferenceCoreError) throw error
        fail("MODEL_CONFIG_FAILED")
    }
    const top = ownData(parsed, ["stages"])
    if (
        !Array.isArray(top.stages) ||
        Object.getPrototypeOf(top.stages) !== Array.prototype ||
        top.stages.length !== 3
    ) {
        fail("MODEL_CONFIG_FAILED")
    }
    const resize = ownData(top.stages[0], [
        "type", "size", "interpolation", "antialias", "max_size",
    ])
    if (
        resize.type !== "resize" ||
        resize.interpolation !== "bilinear" ||
        resize.antialias !== null ||
        resize.max_size !== null
    ) {
        fail("MODEL_CONFIG_FAILED")
    }
    exactArray(resize.size, [PIXAI_WIDTH, PIXAI_HEIGHT])
    const tensor = ownData(top.stages[1], ["type"])
    if (tensor.type !== "to_tensor") fail("MODEL_CONFIG_FAILED")
    const normalize = ownData(top.stages[2], ["type", "mean", "std"])
    if (normalize.type !== "normalize") fail("MODEL_CONFIG_FAILED")
    exactArray(normalize.mean, [0.5, 0.5, 0.5])
    exactArray(normalize.std, [0.5, 0.5, 0.5])
    return Object.freeze({ width: PIXAI_WIDTH, height: PIXAI_HEIGHT })
}

const parseCsv = (text: string) => {
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let quoted = false
    let afterQuote = false
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]!
        if (character === "\0") fail("MODEL_CONFIG_FAILED")
        if (quoted) {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    field += '"'
                    index += 1
                } else {
                    quoted = false
                    afterQuote = true
                }
            } else {
                field += character
            }
            if (new TextEncoder().encode(field).byteLength > 512) {
                fail("MODEL_CONFIG_FAILED")
            }
            continue
        }
        if (afterQuote && character !== "," && character !== "\n" && character !== "\r") {
            fail("MODEL_CONFIG_FAILED")
        }
        if (character === ",") {
            row.push(field)
            field = ""
            afterQuote = false
            continue
        }
        if (character === "\n" || character === "\r") {
            if (character === "\r" && text[index + 1] === "\n") index += 1
            row.push(field)
            rows.push(row)
            if (rows.length > PIXAI_LABEL_COUNT + 1) fail("MODEL_CONFIG_FAILED")
            row = []
            field = ""
            afterQuote = false
            continue
        }
        if (character === '"') {
            if (field.length !== 0) fail("MODEL_CONFIG_FAILED")
            quoted = true
            continue
        }
        field += character
        if (field.length > 512) fail("MODEL_CONFIG_FAILED")
    }
    if (quoted) fail("MODEL_CONFIG_FAILED")
    if (field.length > 0 || row.length > 0 || afterQuote) {
        row.push(field)
        rows.push(row)
    }
    return rows
}

export function parsePixaiTags(bytes: Uint8Array): readonly Readonly<PixaiTagDefinition>[] {
    const rows = parseCsv(decodeUtf8(bytes))
    if (rows.length !== PIXAI_LABEL_COUNT + 1) fail("MODEL_CONFIG_FAILED")
    exactArray(rows[0], ["id", "tag_id", "name", "category", "count", "ips"])
    const tags: Readonly<PixaiTagDefinition>[] = new Array(PIXAI_LABEL_COUNT)
    let general = 0
    let character = 0
    for (let index = 0; index < PIXAI_LABEL_COUNT; index += 1) {
        const values = rows[index + 1]
        if (
            !values ||
            values.length !== 6 ||
            values[0] !== String(index) ||
            !/^\d+$/.test(values[1]!) ||
            !/^\d+$/.test(values[4]!)
        ) {
            fail("MODEL_CONFIG_FAILED")
        }
        const name = values[2]!
        if (
            name.length < 1 ||
            new TextEncoder().encode(name).byteLength > 512
        ) {
            fail("MODEL_CONFIG_FAILED")
        }
        let category: PixaiTagCategory
        if (values[3] === "0") {
            category = "general"
            general += 1
        } else if (values[3] === "4") {
            category = "character"
            character += 1
        } else {
            fail("MODEL_CONFIG_FAILED")
        }
        tags[index] = Object.freeze({ index, name, category })
    }
    if (general !== 9_741 || character !== 3_720) fail("MODEL_CONFIG_FAILED")
    return Object.freeze(tags)
}

const validImageDimensions = (width: number, height: number) => {
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width * height > PIXAI_MAX_IMAGE_PIXELS
    ) {
        fail("IMAGE_DECODE_FAILED")
    }
    return { width, height }
}

const pngDimensions = (bytes: Uint8Array) => {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (
        bytes.byteLength < 33 ||
        signature.some((value, index) => bytes[index] !== value) ||
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13 ||
        String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
    ) {
        fail("IMAGE_DECODE_FAILED")
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return validImageDimensions(view.getUint32(16), view.getUint32(20))
}

const jpegDimensions = (bytes: Uint8Array) => {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        fail("IMAGE_DECODE_FAILED")
    }
    let index = 2
    let found: { width: number; height: number } | undefined
    const sof = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ])
    while (index < bytes.byteLength) {
        if (bytes[index] !== 0xff) fail("IMAGE_DECODE_FAILED")
        while (bytes[index] === 0xff) index += 1
        if (index >= bytes.byteLength) fail("IMAGE_DECODE_FAILED")
        const marker = bytes[index++]!
        if (marker === 0xd9 || marker === 0xda) break
        if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            fail("IMAGE_DECODE_FAILED")
        }
        if (index + 2 > bytes.byteLength) fail("IMAGE_DECODE_FAILED")
        const length = (bytes[index]! << 8) | bytes[index + 1]!
        if (length < 2 || index + length > bytes.byteLength) fail("IMAGE_DECODE_FAILED")
        if (sof.has(marker)) {
            if (found || length < 8) fail("IMAGE_DECODE_FAILED")
            found = validImageDimensions(
                (bytes[index + 5]! << 8) | bytes[index + 6]!,
                (bytes[index + 3]! << 8) | bytes[index + 4]!,
            )
        }
        index += length
    }
    if (!found) fail("IMAGE_DECODE_FAILED")
    return found
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length))

const uint24le = (bytes: Uint8Array, start: number) =>
    bytes[start]! | (bytes[start + 1]! << 8) | (bytes[start + 2]! << 16)

const webpDimensions = (bytes: Uint8Array) => {
    if (
        bytes.byteLength < 20 ||
        ascii(bytes, 0, 4) !== "RIFF" ||
        ascii(bytes, 8, 4) !== "WEBP"
    ) {
        fail("IMAGE_DECODE_FAILED")
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
        fail("IMAGE_DECODE_FAILED")
    }
    let offset = 12
    let found: { width: number; height: number } | undefined
    let extended = false
    let payloads = 0
    while (offset < bytes.byteLength) {
        if (offset + 8 > bytes.byteLength) fail("IMAGE_DECODE_FAILED")
        const kind = ascii(bytes, offset, 4)
        const size = view.getUint32(offset + 4, true)
        const data = offset + 8
        const end = data + size
        if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
            fail("IMAGE_DECODE_FAILED")
        }
        if (kind === "VP8X" || kind === "VP8 " || kind === "VP8L") {
            if (kind === "VP8X") {
                if (size !== 10 || found || extended || payloads !== 0) {
                    fail("IMAGE_DECODE_FAILED")
                }
                found = validImageDimensions(
                    uint24le(bytes, data + 4) + 1,
                    uint24le(bytes, data + 7) + 1,
                )
                extended = true
            } else if (kind === "VP8 ") {
                if (
                    size < 10 ||
                    bytes[data + 3] !== 0x9d ||
                    bytes[data + 4] !== 0x01 ||
                    bytes[data + 5] !== 0x2a
                ) {
                    fail("IMAGE_DECODE_FAILED")
                }
                const dimensions = validImageDimensions(
                    (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff,
                    (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff,
                )
                if (payloads !== 0 || (found && !extended)) fail("IMAGE_DECODE_FAILED")
                if (found && (found.width !== dimensions.width || found.height !== dimensions.height)) {
                    fail("IMAGE_DECODE_FAILED")
                }
                found = dimensions
                payloads += 1
            } else {
                if (size < 5 || bytes[data] !== 0x2f) fail("IMAGE_DECODE_FAILED")
                const bits = view.getUint32(data + 1, true)
                const dimensions = validImageDimensions(
                    (bits & 0x3fff) + 1,
                    ((bits >>> 14) & 0x3fff) + 1,
                )
                if (payloads !== 0 || (found && !extended)) fail("IMAGE_DECODE_FAILED")
                if (found && (found.width !== dimensions.width || found.height !== dimensions.height)) {
                    fail("IMAGE_DECODE_FAILED")
                }
                found = dimensions
                payloads += 1
            }
        }
        offset = end + (size & 1)
    }
    if (!found || payloads !== 1 || offset !== bytes.byteLength) {
        fail("IMAGE_DECODE_FAILED")
    }
    return found
}

export function inspectPixaiEncodedImage(
    bytes: Uint8Array,
    mediaType: PixaiMediaType,
): Readonly<{ mediaType: PixaiMediaType; width: number; height: number }> {
    if (
        !(bytes instanceof Uint8Array) ||
        Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
        bytes.byteLength < 1 ||
        bytes.byteLength > PIXAI_MAX_IMAGE_BYTES ||
        !["image/jpeg", "image/png", "image/webp"].includes(mediaType)
    ) {
        fail("INVALID_ARGUMENT")
    }
    let detected: PixaiMediaType
    let dimensions: { width: number; height: number }
    if (bytes[0] === 137 && bytes[1] === 80) {
        detected = "image/png"
        dimensions = pngDimensions(bytes)
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        detected = "image/jpeg"
        dimensions = jpegDimensions(bytes)
    } else if (ascii(bytes, 0, 4) === "RIFF") {
        detected = "image/webp"
        dimensions = webpDimensions(bytes)
    } else {
        fail("IMAGE_DECODE_FAILED")
    }
    if (detected !== mediaType) fail("IMAGE_DECODE_FAILED")
    return Object.freeze({ mediaType: detected, ...dimensions })
}

export function rgbaToPixaiTensor(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
): Readonly<{ data: Float32Array; dimensions: readonly [1, 3, 448, 448] }> {
    validImageDimensions(width, height)
    if (
        !(rgba instanceof Uint8ClampedArray) ||
        Object.getPrototypeOf(rgba) !== Uint8ClampedArray.prototype ||
        rgba.byteLength !== width * height * 4
    ) {
        fail("IMAGE_DECODE_FAILED")
    }
    const target = new Float32Array(3 * PIXAI_WIDTH * PIXAI_HEIGHT)
    const plane = PIXAI_WIDTH * PIXAI_HEIGHT
    for (let y = 0; y < PIXAI_HEIGHT; y += 1) {
        const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) * height / PIXAI_HEIGHT - 0.5))
        const y0 = Math.floor(sourceY)
        const y1 = Math.min(height - 1, y0 + 1)
        const wy = sourceY - y0
        for (let x = 0; x < PIXAI_WIDTH; x += 1) {
            const sourceX = Math.max(0, Math.min(width - 1, (x + 0.5) * width / PIXAI_WIDTH - 0.5))
            const x0 = Math.floor(sourceX)
            const x1 = Math.min(width - 1, x0 + 1)
            const wx = sourceX - x0
            const outputIndex = y * PIXAI_WIDTH + x
            for (let channel = 0; channel < 3; channel += 1) {
                const a = rgba[(y0 * width + x0) * 4 + channel]!
                const b = rgba[(y0 * width + x1) * 4 + channel]!
                const c = rgba[(y1 * width + x0) * 4 + channel]!
                const d = rgba[(y1 * width + x1) * 4 + channel]!
                const value = a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) +
                    c * (1 - wx) * wy + d * wx * wy
                target[channel * plane + outputIndex] = value / 127.5 - 1
            }
        }
    }
    return Object.freeze({
        data: target,
        dimensions: Object.freeze([1, 3, PIXAI_HEIGHT, PIXAI_WIDTH]) as readonly [1, 3, 448, 448],
    })
}

const optionalRecord = (value: unknown, keys: readonly string[]) => {
    if (!plainRecord(value)) fail("INVALID_ARGUMENT")
    const found = Reflect.ownKeys(value as Record<string, unknown>)
    if (found.some((key) => typeof key !== "string" || !keys.includes(key))) {
        fail("INVALID_ARGUMENT")
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const key of found as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
            fail("INVALID_ARGUMENT")
        }
        result[key] = descriptor.value
    }
    return result
}

export function normalizePixaiRunOptions(
    options?: PixaiRunOptions,
): Readonly<NormalizedPixaiRunOptions> {
    const input = options === undefined
        ? Object.create(null) as Record<string, unknown>
        : optionalRecord(options, ["categories", "thresholds", "maxResults"])
    const rawCategories = input.categories ?? ["general", "character"]
    if (
        !Array.isArray(rawCategories) ||
        Object.getPrototypeOf(rawCategories) !== Array.prototype ||
        rawCategories.length < 1 ||
        rawCategories.length > 2
    ) {
        fail("INVALID_ARGUMENT")
    }
    const categories: PixaiTagCategory[] = []
    for (const category of rawCategories as unknown[]) {
        if (
            (category !== "general" && category !== "character") ||
            categories.includes(category)
        ) {
            fail("INVALID_ARGUMENT")
        }
        categories.push(category as PixaiTagCategory)
    }
    const rawThresholds = input.thresholds === undefined
        ? Object.create(null) as Record<string, unknown>
        : optionalRecord(input.thresholds, ["general", "character"])
    const thresholds = {
        general: rawThresholds.general ?? 0.3,
        character: rawThresholds.character ?? 0.85,
    }
    if (
        !Number.isFinite(thresholds.general) ||
        !Number.isFinite(thresholds.character) ||
        (thresholds.general as number) < 0 ||
        (thresholds.general as number) > 1 ||
        (thresholds.character as number) < 0 ||
        (thresholds.character as number) > 1
    ) {
        fail("INVALID_ARGUMENT")
    }
    const maxResults = input.maxResults ?? PIXAI_MAX_RESULTS
    if (!Number.isSafeInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > PIXAI_MAX_RESULTS) {
        fail("INVALID_ARGUMENT")
    }
    return Object.freeze({
        categories: Object.freeze(categories),
        thresholds: Object.freeze({
            general: thresholds.general as number,
            character: thresholds.character as number,
        }),
        maxResults: maxResults as number,
    })
}

export function postprocessPixaiScores(
    scores: Float32Array,
    dimensions: readonly number[],
    tags: readonly Readonly<PixaiTagDefinition>[],
    options?: PixaiRunOptions,
): Readonly<{
    tags: readonly Readonly<PixaiTagResult>[]
    thresholds: Readonly<Record<PixaiTagCategory, number>>
    truncated: boolean
}> {
    if (
        !(scores instanceof Float32Array) ||
        Object.getPrototypeOf(scores) !== Float32Array.prototype ||
        !Array.isArray(dimensions) ||
        dimensions.length !== 2 ||
        dimensions[0] !== 1 ||
        dimensions[1] !== PIXAI_LABEL_COUNT ||
        scores.length !== PIXAI_LABEL_COUNT ||
        !Array.isArray(tags) ||
        tags.length !== PIXAI_LABEL_COUNT
    ) {
        fail("INFERENCE_FAILED")
    }
    const normalized = normalizePixaiRunOptions(options)
    const categories = new Set(normalized.categories)
    const qualified: PixaiTagResult[] = []
    for (let index = 0; index < PIXAI_LABEL_COUNT; index += 1) {
        const score = scores[index]!
        const tag = tags[index]
        if (
            !Number.isFinite(score) ||
            !tag ||
            tag.index !== index ||
            typeof tag.name !== "string" ||
            (tag.category !== "general" && tag.category !== "character")
        ) {
            fail("INFERENCE_FAILED")
        }
        if (categories.has(tag.category) && score >= normalized.thresholds[tag.category]) {
            qualified.push({ index, name: tag.name, score, category: tag.category })
        }
    }
    qualified.sort((left, right) => right.score - left.score || left.index - right.index)
    const truncated = qualified.length > normalized.maxResults
    const output = qualified.slice(0, normalized.maxResults).map((tag) => Object.freeze(tag))
    return Object.freeze({
        tags: Object.freeze(output),
        thresholds: normalized.thresholds,
        truncated,
    })
}

const profile = getPixaiProfile(PIXAI_PROFILE_ID)
const model = getPixaiArtifact(PIXAI_PROFILE_ID, "model.onnx")

export const PIXAI_RESULT_METADATA = Object.freeze({
    modelProfileId: profile.id,
    modelRevision: profile.revision,
    modelSha256: model.sha256,
    preprocessVersion: profile.preprocessing.version,
    provider: "wasm" as const,
})
