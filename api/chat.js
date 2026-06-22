/**
 * RedditReply — DeepSeek API 代理
 * 部署到 Vercel Serverless Function
 *
 * 说明：DeepSeek 官方 API 暂不支持图片输入，前端 OCR 提取文字后传入 text 字段。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY — DeepSeek API Key
 *   DEEPSEEK_MODEL   — 可选，默认 deepseek-chat
 *
 * 前端请求格式：
 *   POST /api/chat
 *   Content-Type: application/json
 *   Body: { text: "OCR提取的帖子文字", userIdentity: {...}, customPrompt: "..." }
 * 
 * 响应格式：
 *   成功: { success: true, versions: [...], usage: {...} }
 *   失败: { success: false, error: "...", code: "..." }
 */

export default async function handler(req, res) {
  // 1. 只接受 POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed', code: 'METHOD_ERROR' });
  }

  // 2. 校验输入（DeepSeek 使用 OCR 后的文字）
  const { text, userIdentity, customPrompt } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: 'Missing text', code: 'INVALID_INPUT' });
  }

  // 3. 构造 system prompt
  const systemPrompt = customPrompt || buildDefaultPrompt(userIdentity);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'DEEPSEEK_API_KEY not configured',
      code: 'SERVER_ERROR',
    });
  }

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const userMessage = `The following text was extracted from a Reddit post screenshot via OCR (may contain minor errors). Read it carefully, infer the user's core question, then generate 3 reply versions following the format in the instructions.

---REDDIT POST TEXT---
${text.trim()}
---END---`;

  // 4. 调用 DeepSeek Chat API（OpenAI 兼容格式）
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('DeepSeek API error:', response.status, err);
      return res.status(502).json({
        success: false,
        error: 'AI service error',
        code: response.status === 429 ? 'RATE_LIMIT' : 'API_ERROR',
      });
    }

    const data = await response.json();

    // 6. 解析 DeepSeek 的文本响应，提取 3 个版本
    const content = data.choices?.[0]?.message?.content || '';
    const versions = parseVersions(content);

    if (!versions || versions.length !== 3) {
      return res.status(500).json({
        success: false,
        error: 'Failed to parse AI response into 3 versions',
        code: 'PARSE_ERROR',
      });
    }

    // 7. 返回
    return res.status(200).json({
      success: true,
      versions,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    });
  } catch (error) {
    console.error('Request error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'SERVER_ERROR',
    });
  }
}

/**
 * 构造默认 System Prompt
 * 详见 SPEC.md 第 6 节完整模板
 */
function buildDefaultPrompt(identity = {}) {
  const name = identity.name || 'Ray';
  const city = identity.city || 'Shanghai';
  const role = identity.role || 'knowledgeable Chinese local';
  const style = identity.style || 'warm, direct, no fluff';

  return `You are ${name}, a ${role} who helps foreign travelers navigate China. You currently live in ${city} and have been helping international visitors explore China for years. Your communication style: ${style}.
You focus on practical, ground-level advice that tourists
actually need — payments, transport, SIM cards, apps, food,
cultural dos and don'ts.

You just received a screenshot of a Reddit post or comment
where someone is asking a question or discussing a topic
related to traveling in or moving to China.

Your task:

1. FIRST, carefully read the screenshot. Extract the user's core
   question, concern, or topic. Ignore UI elements like upvote
   counts, timestamps, ads — focus on the actual text content.

2. Generate exactly 3 reply versions. Each version MUST:
   - Be written in BOTH Chinese AND English
   - Be a complete, standalone reply (no "as I mentioned above")
   - Never sound like a travel agent, marketer, or bot
   - Never end with "I hope this helps" or similar filler
   - Include specific, actionable information
   - Sound like a real local friend giving advice

3. Each version has a different tone:

   Version 1 — 友好朋友型
   Warm, conversational, like texting a friend who's about to
   visit. Use casual phrasing. Make them feel welcome.

   Version 2 — 详细实用型
   Step-by-step, thorough, covering edge cases. Include specific
   app names, prices, or workflows where relevant. This is for
   the person who wants ALL the details.

   Version 3 — 简洁直接型
   Short, punchy, get-to-the-point. Maximum 3-4 sentences per
   language. This is for the person who wants a quick answer.

4. FORMAT EXACTLY AS FOLLOWS (use this exact separator):

---VERSION_1---
🇨🇳 [Chinese reply]
🇬🇧 [English reply]
---END---

---VERSION_2---
🇨🇳 [Chinese reply]
🇬🇧 [English reply]
---END---

---VERSION_3---
🇨🇳 [Chinese reply]
🇬🇧 [English reply]
---END---

5. ADDITIONAL RULES:
   - If the post is NOT about China travel, still reply helpfully
     but don't force a China angle
   - If the post contains rude or inappropriate content, respond
     with a single version politely declining to engage
   - Never make up facts — if you don't know something specific,
     say so honestly
   - For questions about Chinese regulations (visas, customs,
     laws), include a gentle disclaimer that rules can change
     and they should verify with official sources`;
}

/**
 * 从 Claude 的文本响应中解析出 3 个版本
 * 期望格式见 buildDefaultPrompt 中的输出格式定义
 */
function parseVersions(text) {
  const versions = [];
  const regex = /---VERSION_(\d+)---\n([\s\S]*?)---END---/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const index = parseInt(match[1]);
    const content = match[2].trim();

    // 分离中文和英文部分
    const cnMatch = content.match(/🇨🇳\s*([\s\S]*?)(?=🇬🇧|$)/);
    const enMatch = content.match(/🇬🇧\s*([\s\S]*?)$/);

    const labels = ['友好朋友型', '详细实用型', '简洁直接型'];

    versions.push({
      index,
      label: labels[index - 1] || `版本 ${index}`,
      chinese: cnMatch ? cnMatch[1].trim() : '',
      english: enMatch ? enMatch[1].trim() : '',
    });
  }

  return versions;
}
