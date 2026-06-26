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
 *   成功: { success: true, original: {...}, versions: [...], usage: {...} }
 *   失败: { success: false, error: "...", code: "..." }
 */

const ORIGINAL_FORMAT_APPENDIX = `

IMPORTANT — Before the 3 reply versions, you MUST output an original post block:

---ORIGINAL---
SUBREDDIT: [r/subreddit name if visible in the post, otherwise leave empty]
🇬🇧 [Cleaned English text of the core post/comment — remove UI noise like upvotes, timestamps, ads]
🇨🇳 [Accurate Chinese translation of the above English text]
---END---

Then output the 3 reply versions as specified.`;

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

  // 3. 构造 system prompt（自定义 prompt 也追加原帖输出格式要求）
  const systemPrompt = (customPrompt || buildDefaultPrompt(userIdentity)) + ORIGINAL_FORMAT_APPENDIX;

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

    // 6. 解析 DeepSeek 的文本响应，提取原帖与 3 个版本
    const content = data.choices?.[0]?.message?.content || '';
    const parsedOriginal = parseOriginal(content);
    const versions = parseVersions(content);

    if (!versions || versions.length !== 3) {
      return res.status(500).json({
        success: false,
        error: 'Failed to parse AI response into 3 versions',
        code: 'PARSE_ERROR',
      });
    }

    const original = parsedOriginal || {
      english: text.trim(),
      chinese: '',
      subreddit: '',
    };

    // 7. 返回
    return res.status(200).json({
      success: true,
      original,
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
   - Never end with "I hope this helps", "Feel free to ask", "Happy travels", or similar filler
   - Include specific, actionable information (app names, prices, places, workflows)
   - Sound like a real Reddit commenter — casual, personal, grounded

3. REDDIT ENGAGEMENT — English replies are pasted directly into Reddit. Structure each English reply as:

   HOOK (1 sentence): Mirror OP's situation or emotion. Open with "Yeah," "Honestly," "This tripped me up too when..." — never "As a local expert..." or "Great question!"
   VALUE (2-4 short paragraphs): One concrete tip per paragraph.
   SOFT CTA (optional, last sentence): A genuine question to spark replies, e.g. "Anyone else had luck with X?" or "Curious which city you're flying into — that changes a lot."

   LINE BREAKS ARE REQUIRED in every English reply:
   - Put a BLANK LINE (empty line) between the hook, each value paragraph, and the closing question
   - Never output the English reply as one long wall of text — Reddit readers skim on mobile
   - Each paragraph = 1-3 sentences max, then blank line, then next paragraph
   - Example shape (follow this spacing exactly):

   Yeah, this confused me too the first time I tried it.

   What worked: download Alipay first, then go to Settings > Payment Methods and add your foreign Visa or Mastercard. Verification usually takes a few minutes.

   One gotcha — some smaller shops still prefer cash or WeChat, so don't assume every place takes it.

   Which city are you landing in? Setup can differ a bit between Shanghai and Chengdu.

   Reddit tone rules:
   - Use "I" and small personal anecdotes ("Last time my friend visited, we...")
   - Mild humor or honest caveats beat perfect polish
   - Each paragraph ≤ 3 lines — mobile-friendly
   - At least one specific detail (app name, price range, neighborhood, date)

4. PLAIN TEXT ONLY — no markdown anywhere in reply body:
   - NO asterisks, bold, italic, headers (#), backticks, or horizontal rules
   - NO bullet points or numbered lists — separate tips into their own paragraphs with blank lines instead
   - NO emoji inside reply text (only 🇨🇳/🇬🇧 markers in the structured output format below)
   - Use actual newline characters for paragraph breaks (blank line between paragraphs), not markdown

5. Each version has a different tone:

   Version 1 — 共鸣故事型
   Relatable local vibe. Warm hook that validates OP's concern, a brief personal story or "been there" moment, then practical tips. Make them feel welcome.

   Version 2 — 深度指南型
   Deep-dive helper. Hook + thorough step-by-step advice in paragraph form (not lists), covering edge cases. Specific app names, prices, or workflows where relevant.

   Version 3 — 观点钩子型
   Punchy hot-take. Short hook + one killer insight or contrarian tip + a question that invites the thread to respond. Max 3-4 sentences per language.

6. OUTPUT ORDER — first the original post block, then 3 reply versions.

Original post block (REQUIRED, before any version):

---ORIGINAL---
SUBREDDIT: [r/subreddit if visible, else empty]
🇬🇧 [Cleaned English core post text]
🇨🇳 [Chinese translation]
---END---

Reply versions format (use this exact separator):

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

7. ADDITIONAL RULES:
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
 * 解析原帖中英文对照块
 */
function parseOriginal(text) {
  const match = text.match(/---ORIGINAL---\n([\s\S]*?)---END---/);
  if (!match) return null;

  let content = match[1].trim();
  let subreddit = '';

  const subMatch = content.match(/^SUBREDDIT:\s*(.*)$/m);
  if (subMatch) {
    subreddit = subMatch[1].trim();
    content = content.replace(/^SUBREDDIT:\s*.*\n?/m, '').trim();
  }

  const cnMatch = content.match(/🇨🇳\s*([\s\S]*?)$/);
  const enMatch = content.match(/🇬🇧\s*([\s\S]*?)(?=🇨🇳|$)/);

  const english = enMatch ? enMatch[1].trim() : '';
  const chinese = cnMatch ? cnMatch[1].trim() : '';

  if (!english && !chinese) return null;

  return { english, chinese, subreddit };
}

/**
 * 从 AI 文本响应中解析出 3 个版本
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

    const labels = ['共鸣故事型', '深度指南型', '观点钩子型'];

    versions.push({
      index,
      label: labels[index - 1] || `版本 ${index}`,
      chinese: cnMatch ? cnMatch[1].trim() : '',
      english: enMatch ? enMatch[1].trim() : '',
    });
  }

  return versions;
}
