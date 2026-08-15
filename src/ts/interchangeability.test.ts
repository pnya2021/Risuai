import { describe, expect, it, vi } from 'vitest'
import {
  convertCharacterToModule,
  convertModuleToCharacter,
} from './interchangeability'
import type { RisuModule } from './process/modules'
import type { character } from './storage/database.svelte'

const { makeBlankCharacter } = vi.hoisted(() => ({
  makeBlankCharacter: (): character => ({
    name: '',
    firstMessage: '',
    desc: '',
    notes: '',
    chats: [
      {
        message: [],
        note: '',
        name: 'Chat 1',
        localLore: [],
      },
    ],
    chatFolders: [],
    chatPage: 0,
    emotionImages: [],
    bias: [],
    viewScreen: 'none',
    globalLore: [],
    chaId: 'blank-character-fixture',
    type: 'character',
    sdData: [
      ['always', 'solo, 1girl'],
      ['negative', ''],
      ["|character's appearance", ''],
      ['current situation', ''],
      ["$character's pose", ''],
      ["$character's emotion", ''],
      ['current location', ''],
    ],
    utilityBot: false,
    customscript: [],
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: -1,
    replaceGlobalNote: '',
    triggerscript: [
      {
        comment: '',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2Header',
            code: '',
            indent: 0,
          },
        ],
      },
      {
        comment: 'New Event',
        type: 'manual',
        conditions: [],
        effect: [],
      },
    ],
    additionalText: '',
  }),
}))

// The real characters module boots unrelated application effects. The converter
// only consumes this pure factory, so keep that boundary faithful and isolated.
vi.mock('src/ts/characters', () => ({
  createBlankChar: makeBlankCharacter,
}))

describe('character and module interchangeability', () => {
  it('preserves namespace, chat-icon visibility, and Global Note when converting a module to a character', () => {
    const source: RisuModule = {
      id: 'source-module',
      name: 'Source Module',
      description: 'conversion fixture',
      namespace: 'fixture.module.namespace',
      hideIcon: true,
      lorebook: [
        {
          key: '',
          secondkey: '',
          insertorder: 0,
          comment: 'Global Note fixture',
          content: '@@indicator replace_global_note\n\nKeep this literal Global Note.',
          mode: 'constant',
          alwaysActive: true,
          selective: false,
        },
      ],
    }

    const converted = convertModuleToCharacter(source)

    expect(converted.moduleNamespace).toBe('fixture.module.namespace')
    expect(converted.hideChatIcon).toBe(true)
    expect(converted.replaceGlobalNote).toBe('Keep this literal Global Note.')
    expect(converted.globalLore).toEqual([])
  })

  it('preserves namespace, chat-icon visibility, and Global Note when converting a character to a module', () => {
    const source = makeBlankCharacter()
    source.name = 'Source Character'
    source.moduleNamespace = 'fixture.character.namespace'
    source.hideChatIcon = true
    source.replaceGlobalNote = 'Keep this other literal Global Note.'

    const converted = convertCharacterToModule(source)

    expect(converted.namespace).toBe('fixture.character.namespace')
    expect(converted.hideIcon).toBe(true)
    expect(converted.lorebook).toContainEqual({
      key: '',
      secondkey: '',
      insertorder: 0,
      comment: 'From Global Note Replacement',
      content:
        '@@indicator replace_global_note\n\nKeep this other literal Global Note.',
      mode: 'constant',
      alwaysActive: true,
      selective: false,
    })
  })
})
