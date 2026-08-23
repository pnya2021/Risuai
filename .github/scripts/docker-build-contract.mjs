import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../workflows/docker-build.yml', import.meta.url),
  'utf8',
)
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')

function workflowBranches() {
  const tagCondition = 'if [[ "${{ github.ref }}" =~ ^refs/tags/ ]]; then'
  const tagStart = workflow.indexOf(tagCondition)
  const mainStart = workflow.indexOf('\n          else', tagStart)
  const end = workflow.indexOf('\n          fi', mainStart)

  assert.notEqual(tagStart, -1, 'tag publication condition must exist')
  assert.notEqual(mainStart, -1, 'main publication branch must exist')
  assert.notEqual(end, -1, 'publication condition must be closed')

  return {
    tag: workflow.slice(tagStart, mainStart),
    main: workflow.slice(mainStart, end),
  }
}

function buildCommand(block) {
  const commands = block.match(/docker buildx build[^\r\n]+/g) ?? []
  assert.equal(commands.length, 1, 'each publication route must run one buildx command')
  return commands[0]
}

function parseStages(source) {
  const stages = new Map()
  let current

  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^FROM\s+(.+?)\s+AS\s+(\S+)$/i)
    if (header) {
      current = { header: line, image: header[1], lines: [] }
      stages.set(header[2].toLowerCase(), current)
    } else if (current) {
      current.lines.push(line)
    }
  }

  return stages
}

test('workflow preserves official, downstream, and main publication routes', () => {
  assert.match(workflow, /branches:\s*\r?\n\s+- main/)
  assert.match(workflow, /tags:\s*\r?\n\s+- 'v\*'\s*\r?\n\s+- 'pnya-v\*'/)

  const branches = workflowBranches()
  const tagCommand = buildCommand(branches.tag)
  assert.match(tagCommand, /--platform linux\/amd64,linux\/arm64/)
  assert.match(tagCommand, /--push/)
  assert.match(tagCommand, /risuai:\$\{\{ github\.ref_name \}\}/)
  assert.match(tagCommand, /risuai:latest/)
  assert.equal((tagCommand.match(/(?:^|\s)-t\s/g) ?? []).length, 2)

  const mainCommand = buildCommand(branches.main)
  assert.match(branches.main, /SHORT_SHA=\$\(git rev-parse --short "\$GITHUB_SHA"\)/)
  assert.match(mainCommand, /--platform linux\/amd64,linux\/arm64/)
  assert.match(mainCommand, /--push/)
  assert.match(mainCommand, /risuai:\$SHORT_SHA/)
  assert.doesNotMatch(mainCommand, /risuai:latest|github\.ref_name/)
  assert.equal((mainCommand.match(/(?:^|\s)-t\s/g) ?? []).length, 1)
})

test('workflow bounds and exposes multi-platform builds', () => {
  assert.match(
    workflow,
    /- name: Build Docker images\s*\r?\n\s+shell: bash\s*\r?\n\s+timeout-minutes: 30\s*\r?\n\s+run: \|/,
  )

  const branches = workflowBranches()
  assert.match(buildCommand(branches.tag), /docker buildx build --progress=plain /)
  assert.match(buildCommand(branches.main), /docker buildx build --progress=plain /)
})

test('Docker build runs once on BUILDPLATFORM while runtime stays target-native', () => {
  const stages = parseStages(dockerfile)
  const base = stages.get('base')
  const builder = stages.get('builder')
  const deps = stages.get('deps')
  const runtime = stages.get('runtime')

  assert.ok(base, 'target-native base stage must exist')
  assert.ok(builder, 'builder stage must exist')
  assert.ok(deps, 'deps stage must exist')
  assert.ok(runtime, 'runtime stage must exist')
  assert.equal(base.header, 'FROM node:24-slim AS base')
  assert.equal(builder.header, 'FROM --platform=$BUILDPLATFORM node:24-slim AS builder')
  assert.equal(deps.header, 'FROM base AS deps')
  assert.equal(runtime.header, 'FROM base AS runtime')
  assert.doesNotMatch(deps.header, /BUILDPLATFORM/)
  assert.doesNotMatch(runtime.header, /BUILDPLATFORM/)
  assert.doesNotMatch(builder.lines.join('\n'), /TARGET(?:ARCH|PLATFORM)/)

  const buildLines = dockerfile.match(/^RUN .*\bpnpm build\s*$/gm) ?? []
  assert.equal(buildLines.length, 1, 'pnpm build must appear exactly once')
  assert.match(builder.lines.join('\n'), /^RUN .*\bpnpm build\s*$/m)
  assert.match(deps.lines.join('\n'), /pnpm install --prod --frozen-lockfile/)
  assert.match(runtime.lines.join('\n'), /COPY --from=deps \/app\/node_modules \/app\/node_modules/)
  assert.match(runtime.lines.join('\n'), /COPY --from=builder \/app\/server \.\/server/)
  assert.match(runtime.lines.join('\n'), /COPY --from=builder \/app\/dist \.\/dist/)
})

test('Docker dependency caches are scoped to their execution architecture', () => {
  const stages = parseStages(dockerfile)
  const builder = stages.get('builder').lines.join('\n')
  const deps = stages.get('deps').lines.join('\n')

  assert.match(builder, /^ARG BUILDARCH$/m)
  assert.match(builder, /id=pnpm-build-\$\{BUILDARCH\}/)
  assert.match(deps, /^ARG TARGETARCH$/m)
  assert.match(deps, /id=pnpm-prod-\$\{TARGETARCH\}/)
})

test('publication workflow runs the Docker contract before building images', () => {
  const contract = workflow.indexOf(
    'node --test .github/scripts/docker-build-contract.mjs',
  )
  const build = workflow.indexOf('- name: Build Docker images')

  assert.notEqual(contract, -1, 'publication workflow must run its contract test')
  assert.ok(contract < build, 'contract test must run before image publication')
})
