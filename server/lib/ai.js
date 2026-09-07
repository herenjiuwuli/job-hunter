export async function chatWithDeepSeek(messages) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured')

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`DeepSeek API error (${res.status}): ${err}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

/** 调 DeepSeek 并解析严格 JSON，解析失败时抛错 */
export async function chatJSON(messages) {
  const content = await chatWithDeepSeek(messages)
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(cleaned.trim())
  } catch {
    throw new Error('AI 返回内容不是合法 JSON：' + content.slice(0, 200))
  }
}
