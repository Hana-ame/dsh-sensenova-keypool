import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReasoningEffort, toChatRequest } from '../src/messages.js'

test('projects system, user, reasoning, tool calls and tool results', async () => {
  const { body, modelId, alias } = await toChatRequest({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite@k2',
    system: 'global system',
    maxTokens: 512,
    temperature: 0.2,
    stop: ['END'],
    reasoningEffort: 'high',
    tools: [
      {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'session system' }] },
      { role: 'developer', content: [{ type: 'tool-removal', toolName: 'old' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', attachment: {} }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
    ],
  })

  assert.equal(modelId, 'sensenova-6.8-flash-lite')
  assert.equal(alias, 'k2')
  assert.equal(body.model, 'sensenova-6.8-flash-lite')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 512)
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools[0].function.name, 'read_file')

  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /global system/)
  assert.match(body.messages[0].content, /session system/)
  assert.equal(body.messages[1].role, 'user')
  assert.match(body.messages[1].content, /hello/)
  assert.match(body.messages[1].content, /image omitted/)
  assert.equal(body.messages[2].role, 'assistant')
  // reasoning_content is a response-only field: SenseNova rejects requests
  // that replay it with HTTP 400 "inference request is invalid", so assistant
  // reasoning is dropped from the projection (verified live, see adapter.js).
  assert.equal(body.messages[2].reasoning_content, undefined)
  assert.equal(body.messages[2].content, 'calling')
  assert.equal(body.messages[2].tool_calls[0].id, 'call_1')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.messages[3].tool_call_id, 'call_1')
  assert.equal(body.messages[3].content, 'file body')
})

test('image blocks become OpenAI image_url parts with a data URL', async () => {
  const attachments = {
    readImageRequest: async (ref, target, signal) => ({
      attachment: ref,
      mediaType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71]),
      bytes: 4,
      width: 1,
      height: 1,
    }),
  }
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'img-1' } }] },
      ],
    },
    { attachments },
  )

  const content = body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look')
  assert.equal(content[1].type, 'image_url')
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
})

test('offloaded images fall back to placeholder text', async () => {
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: {}, offloaded: true }] },
      ],
    },
    { attachments: { readImageRequest: async () => { throw new Error('must not be called') } } },
  )
  assert.equal(typeof body.messages[0].content, 'string')
  assert.match(body.messages[0].content, /offloaded/)
})

const imageAttachments = {
  readImageRequest: async (ref, target, signal) => ({
    attachment: ref,
    mediaType: 'image/png',
    data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    bytes: 8,
    width: 1,
    height: 1,
  }),
}

test('assistant tool call without text sends null content', async () => {
  const { body } = await toChatRequest({
    model: 'sensenova-6.8-flash-lite',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }],
      },
    ],
  })
  assert.equal(body.messages[0].content, null)
  assert.equal(body.messages[0].tool_calls.length, 1)
})

test('unknown model ids are passed through unchanged', async () => {
  const { body, modelId } = await toChatRequest({
    model: 'some-new-model',
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(modelId, 'some-new-model')
  assert.equal(body.model, 'some-new-model')
})

test('nameless assistant tool calls are dropped from replay', async () => {
  const { body } = await toChatRequest({
    model: 'sensenova-6.8-flash-lite',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'trying' },
          { type: 'tool-call', id: 'call-1', name: '', arguments: '' },
        ],
      },
    ],
  })
  const row = body.messages[0]
  assert.equal(row.role, 'assistant')
  assert.equal(row.content, 'trying')
  assert.equal(row.tool_calls, undefined)
})

test('orphaned tool results are not replayed', async () => {
  const { body } = await toChatRequest({
    model: 'sensenova-6.8-flash-lite',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call-1', name: '', arguments: '' },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Error: unknown tool \"\"' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call_ok', name: 'read_file', arguments: '{"path":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_ok', content: [{ type: 'text', text: 'file body' }] },
    ],
  })
  // The nameless call and its orphaned result are gone; the valid call survives.
  const roles = body.messages.map(m => m.role)
  assert.deepEqual(roles, ['assistant', 'assistant', 'tool'])
  const assistant = body.messages[0]
  assert.equal(assistant.tool_calls, undefined)
  const valid = body.messages[1]
  assert.equal(valid.tool_calls.length, 1)
  assert.equal(valid.tool_calls[0].function.name, 'read_file')
  assert.equal(body.messages[2].tool_call_id, 'call_ok')
})

test('tool-result image is hoisted into a follow-up user image message', async () => {
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_shot', name: 'read_image', arguments: '{"path":"a.png"}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call_shot',
          content: [
            { type: 'text', text: 'image/png 1600x1024 px' },
            { type: 'image', attachment: { attachmentId: 'sha256:shot' } },
          ],
        },
      ],
    },
    { attachments: imageAttachments },
  )

  assert.deepEqual(body.messages.map(row => row.role), ['assistant', 'tool', 'user'])
  const tool = body.messages[1]
  assert.equal(tool.content, 'image/png 1600x1024 px')
  assert.equal(tool.tool_call_id, 'call_shot')
  const user = body.messages[2]
  assert.equal(user.content[0].type, 'text')
  assert.match(user.content[0].text, /Attached image\(s\) from tool result/)
  assert.equal(user.content[1].type, 'image_url')
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/)
})

test('image-only tool result keeps a placeholder text on the tool row', async () => {
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_shot', name: 'read_image', arguments: '{}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call_shot',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:shot' } }],
        },
      ],
    },
    { attachments: imageAttachments },
  )
  const tool = body.messages[1]
  assert.equal(tool.content, '(see attached image)')
  assert.equal(body.messages[2].role, 'user')
  assert.equal(body.messages[2].content.filter(part => part.type === 'image_url').length, 1)
})

test('consecutive tool results share one hoisted image message', async () => {
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_a', name: 'read_image', arguments: '{}' },
            { type: 'tool-call', id: 'call_b', name: 'read_image', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_a', content: [{ type: 'image', attachment: { attachmentId: 'sha256:a' } }] },
        { role: 'tool', toolCallId: 'call_b', content: [{ type: 'image', attachment: { attachmentId: 'sha256:b' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'I can see both.' }] },
      ],
    },
    { attachments: imageAttachments },
  )
  assert.deepEqual(body.messages.map(row => row.role), ['assistant', 'tool', 'tool', 'user', 'assistant'])
  const images = body.messages[3].content.filter(part => part.type === 'image_url')
  assert.equal(images.length, 2)
})

test('offloaded tool-result image stays a placeholder with no hoisted message', async () => {
  const { body } = await toChatRequest(
    {
      model: 'sensenova-6.8-flash-lite',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_shot', name: 'read_image', arguments: '{}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call_shot',
          content: [{ type: 'image', attachment: {}, offloaded: true }],
        },
      ],
    },
    { attachments: { readImageRequest: async () => { throw new Error('must not be called') } } },
  )
  assert.deepEqual(body.messages.map(row => row.role), ['assistant', 'tool'])
  assert.match(body.messages[1].content, /offloaded/)
})

test('reasoning effort is normalized to SenseNova\'s accepted enum', async () => {
  // SenseNova rejects any other spelling with HTTP 400 "field ReasoningEffort
  // invalid" (param: reasoning_effort). The harness/OpenAI clients use their
  // own vocabulary, so the wire body must carry the enum or omit the field.
  const cases = [
    ['on', 'high'],
    ['off', 'none'],
    ['balanced', 'medium'],
    ['high', 'high'],
    ['max', 'max'],
    ['minimal', 'minimal'],
    ['xhigh', 'xhigh'],
    [true, 'high'],
    [false, 'none'],
    ['garbage', undefined],
    ['', undefined],
    [undefined, undefined],
  ]
  for (const [input, expected] of cases) {
    const { body } = await toChatRequest({
      model: 'sensenova-6.8-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: input,
    })
    assert.equal(body.reasoning_effort, expected, `effort ${String(input)}`)
  }
})

test('normalizeReasoningEffort maps aliases and drops unknown values', () => {
  assert.equal(normalizeReasoningEffort('on'), 'high')
  assert.equal(normalizeReasoningEffort('off'), 'none')
  assert.equal(normalizeReasoningEffort('x-high'), 'xhigh')
  assert.equal(normalizeReasoningEffort('enabled'), 'high')
  assert.equal(normalizeReasoningEffort(' MEDIUM '), 'medium')
  assert.equal(normalizeReasoningEffort('bogus'), undefined)
})
