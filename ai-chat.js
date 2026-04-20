// Netlify Function: /.netlify/functions/ai-chat
// Unified AI endpoint that handles all of Stage 3's interactive modes:
//   - generate-model-answer : produce a model answer for any prompt + framework
//   - conversation-turn     : AI asks follow-up questions, adaptive persona
//   - devils-advocate-turn  : AI pushes back with counter-arguments, adjustable intensity
//   - audience-round        : AI plays a specific audience + evaluates adaptation
//
// The OpenRouter API key lives ONLY as the Netlify env var OPENROUTER_API_KEY.

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '*';
  const allowed = process.env.ALLOWED_ORIGIN;
  const corsOrigin = allowed ? (origin === allowed ? origin : allowed) : '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Server not configured: OPENROUTER_API_KEY env var is missing.' }) };
  }
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { mode } = payload;
  if (!mode) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing "mode" field' }) };
  }

  // Dispatch to the right builder
  let request;
  try {
    switch (mode) {
      case 'generate-model-answer': request = buildModelAnswerRequest(payload); break;
      case 'conversation-turn':     request = buildConversationRequest(payload); break;
      case 'devils-advocate-turn':  request = buildDevilsAdvocateRequest(payload); break;
      case 'audience-round':        request = buildAudienceRoundRequest(payload); break;
      default:
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Unknown mode: ${mode}` }) };
    }
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }

  // Call OpenRouter
  try {
    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': corsOrigin !== '*' ? corsOrigin : 'https://speakmaster.app',
        'X-Title': 'SpeakMaster'
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        response_format: request.jsonMode ? { type: 'json_object' } : undefined,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 1200
      })
    });

    if (!openrouterRes.ok) {
      const errText = await openrouterRes.text();
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'AI provider error', detail: errText.slice(0, 500) }) };
    }

    const data = await openrouterRes.json();
    const content = data?.choices?.[0]?.message?.content || '';

    let output;
    if (request.jsonMode) {
      try { output = JSON.parse(content); }
      catch (e) {
        const stripped = content.replace(/```json\s*|```\s*$/gim, '').trim();
        try { output = JSON.parse(stripped); }
        catch (e2) {
          return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'AI returned unparseable JSON', detail: content.slice(0, 500) }) };
        }
      }
    } else {
      output = { text: content };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ...output, model, usage: data.usage || null })
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Internal error', detail: String(err?.message || err).slice(0, 500) }) };
  }
};

// ---------- REQUEST BUILDERS ----------

function buildModelAnswerRequest(p) {
  const { prompt, lessonTitle, framework, elementDescriptions, expertTip } = p;
  if (!prompt || !Array.isArray(framework)) throw new Error('Missing prompt or framework');

  const elementsList = framework.map((name, i) => {
    const desc = elementDescriptions?.[i]?.description || '';
    return `${i + 1}. ${name}${desc ? ' — ' + desc : ''}`;
  }).join('\n');

  const systemPrompt = `You are an expert communication coach who writes exemplary model answers. You will produce a response that cleanly demonstrates a specific framework. Your answer must be:
- Realistic (what a confident professional would actually say)
- Concrete (uses specific numbers, names, examples — never vague)
- Natural (sounds spoken, not written)
- Tight (no filler, lands each framework element in order)

OUTPUT FORMAT — return ONLY this JSON object:
{
  "response": [
    { "element": "<framework element name>", "text": "<2-4 sentences of body text>", "color": "<teal|orange|gold|blue|red|green>" }
  ],
  "expertNote": "<one sentence of coaching insight about why this answer works>"
}

The "response" array must have exactly ${framework.length} items, one per framework element, in order.`;

  const userPrompt = `LESSON: ${lessonTitle || 'Unknown'}
FRAMEWORK (in order): ${framework.join(' → ')}

FRAMEWORK ELEMENT DETAILS:
${elementsList}

${expertTip ? `EXPERT TIP:\n${expertTip}\n` : ''}

WRITE A MODEL ANSWER TO THIS PROMPT:
"${prompt}"

Return the JSON. No prose around it.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.6,
    maxTokens: 1200
  };
}

function buildConversationRequest(p) {
  const { prompt, response, lessonTitle, framework, personaHint, conversationHistory } = p;
  if (!prompt || !response) throw new Error('Missing prompt or response');

  // Auto-pick an adaptive persona based on the lesson title
  const persona = inferPersona(lessonTitle, personaHint);

  const systemPrompt = `You are playing the role of: ${persona.role}.
Your goal is to have a realistic follow-up conversation with someone practicing public speaking. The user has just responded to a prompt. Your job:

1. Briefly acknowledge what they said (one short sentence, sincere).
2. Ask ONE probing follow-up question that a real ${persona.role.toLowerCase()} would ask — something that:
   - Tests the substance of what they said (not a gotcha)
   - Goes deeper into the specifics they mentioned
   - Challenges a weak point in their response if there is one
   - Or explores a natural next angle

Do NOT:
- Be verbose (keep your whole turn under 60 words)
- Give feedback on their speaking technique
- Ask multiple questions in one turn
- Break character

OUTPUT FORMAT — return ONLY this JSON:
{
  "acknowledgment": "<one short sincere sentence>",
  "question": "<your single follow-up question>",
  "questionType": "<depth|specifics|pushback|next-angle>"
}`;

  const historyBlock = (conversationHistory && conversationHistory.length)
    ? '\n\nCONVERSATION SO FAR:\n' + conversationHistory.map((t, i) => `Turn ${i + 1} - ${t.speaker}: ${t.text}`).join('\n')
    : '';

  const userPrompt = `SCENARIO: Practicing ${lessonTitle || 'public speaking'} using the ${framework?.join(' → ') || 'standard'} framework.

ORIGINAL PROMPT: "${prompt}"

USER'S MOST RECENT RESPONSE: "${response}"${historyBlock}

As the ${persona.role}, ask your next question. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.8,
    maxTokens: 400
  };
}

function buildDevilsAdvocateRequest(p) {
  const { prompt, response, lessonTitle, intensity = 3, conversationHistory } = p;
  if (!prompt || !response) throw new Error('Missing prompt or response');

  const intensityLevels = {
    1: { label: 'Gentle Skeptic', style: 'Polite but probing. Raise concerns kindly; frame counterpoints as questions ("Have you considered…?"). End with an open invitation to respond.' },
    2: { label: 'Thoughtful Challenger', style: 'Direct and analytical. State your counter-argument clearly with reasoning. Professional but firm.' },
    3: { label: 'Tough Critic', style: 'Sharp, confident, unafraid to disagree strongly. Expose weak logic or missing evidence. Still respectful.' },
    4: { label: 'Hostile Opponent', style: 'Combative. Use pointed language. Dismiss weak parts of the argument openly. Push hard on contradictions.' },
    5: { label: 'Ruthless Interrogator', style: 'Relentless. Tear apart the reasoning point by point. No sugarcoating. Cross-examination-style pressure.' }
  };
  const level = intensityLevels[intensity] || intensityLevels[3];

  const systemPrompt = `You are playing a "${level.label}" — a devil's advocate challenging the user's argument.

TONE: ${level.style}

Your job in each turn:
1. Identify the WEAKEST part of the user's most recent argument.
2. Construct the strongest possible counter-argument to that weak point.
3. Force the user to defend their position or concede.

Constraints:
- Keep each turn under 80 words.
- One clear counter-argument per turn (not a list).
- Stay in character. Don't break to give feedback or praise.
- Don't invent facts. Attack logic, assumptions, or missing evidence.

OUTPUT FORMAT — return ONLY this JSON:
{
  "counterArgument": "<your challenge, in character>",
  "weakPointAttacked": "<what specifically you're targeting — 1 phrase>",
  "escalation": "<new|intensifying|same>"
}`;

  const historyBlock = (conversationHistory && conversationHistory.length)
    ? '\n\nDEBATE SO FAR:\n' + conversationHistory.map((t, i) => `${t.speaker}: ${t.text}`).join('\n\n')
    : '';

  const userPrompt = `ORIGINAL PROMPT (the position the user is defending):
"${prompt}"

USER'S MOST RECENT ARGUMENT:
"${response}"${historyBlock}

As the "${level.label}", deliver your counter-argument. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.8,
    maxTokens: 500
  };
}

function buildAudienceRoundRequest(p) {
  const { prompt, response, audience, lessonTitle, framework } = p;
  if (!prompt || !response || !audience) throw new Error('Missing prompt, response, or audience');

  const systemPrompt = `You are evaluating how well someone adapted their communication for a specific audience.

AUDIENCE CONTEXT:
- Role: ${audience.role}
- Priorities: ${audience.priorities}
- Vocabulary expectations: ${audience.vocabulary}
- What they'd find off-putting: ${audience.redFlags}

Your job:
1. Evaluate the response SPECIFICALLY through this audience's lens.
2. Give a score out of 100 for audience-fit.
3. Quote one thing that worked well for this audience.
4. Quote one thing that missed the mark (if any).
5. Suggest one specific tweak for this audience.

OUTPUT FORMAT — return ONLY this JSON:
{
  "audienceFit": <integer 0-100>,
  "verdict": "<one short sentence>",
  "worked": { "quote": "<direct quote from user>", "why": "<why it landed with this audience>" },
  "missed": { "quote": "<direct quote or empty>", "why": "<why it fell flat or empty>" },
  "tweak": "<one specific suggestion tailored to this audience>"
}`;

  const userPrompt = `SCENARIO: ${lessonTitle || 'Practice'} using the ${framework?.join(' → ') || 'standard'} framework.

THE PROMPT: "${prompt}"

THE RESPONSE: "${response}"

THE AUDIENCE: ${audience.label} — ${audience.description}

Evaluate audience-fit. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.5,
    maxTokens: 800
  };
}

// ---------- HELPERS ----------

function inferPersona(lessonTitle, hint) {
  const title = (lessonTitle || '').toLowerCase();
  if (hint) return { role: hint };

  // Adaptive persona based on lesson type
  if (title.includes('interview') || title.includes('star')) {
    return { role: 'seasoned hiring manager doing a behavioral interview' };
  }
  if (title.includes('meeting') || title.includes('stakeholder')) {
    return { role: 'experienced stakeholder in a project review meeting' };
  }
  if (title.includes('pitch') || title.includes('aida') || title.includes('proposal')) {
    return { role: 'skeptical investor or decision-maker listening to your pitch' };
  }
  if (title.includes('self-introduction') || title.includes('introduce')) {
    return { role: 'curious networking contact at a professional event' };
  }
  if (title.includes('bad news') || title.includes('delivering')) {
    return { role: 'affected team member processing the news you just shared' };
  }
  if (title.includes('q&a') || title.includes('handling')) {
    return { role: 'sharp audience member asking probing questions after your talk' };
  }
  if (title.includes('teach') || title.includes('explain') || title.includes('simplify')) {
    return { role: 'intelligent but non-expert learner trying to understand' };
  }
  if (title.includes('presentation') || title.includes('keynote') || title.includes('10-min')) {
    return { role: 'engaged audience member at your presentation with a genuine follow-up' };
  }
  if (title.includes('technical') || title.includes('briefing')) {
    return { role: 'senior technical leader probing the details of your briefing' };
  }
  if (title.includes('leadership') || title.includes('influencing') || title.includes('executive')) {
    return { role: 'experienced executive evaluating your thinking' };
  }
  if (title.includes('impromptu') || title.includes('pause') || title.includes('bridging') || title.includes('abt')) {
    return { role: 'curious colleague who asked you an unexpected question' };
  }

  return { role: 'attentive listener with a genuine follow-up question' };
}
