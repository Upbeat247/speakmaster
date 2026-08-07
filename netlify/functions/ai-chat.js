// Netlify Function: /.netlify/functions/ai-chat
// Unified AI endpoint that handles AI-powered interactive modes:
//   - generate-model-answer : produce a model answer for any prompt + framework
//   - conversation-turn     : AI asks follow-up questions, adaptive persona
//   - devils-advocate-turn  : AI pushes back with counter-arguments, adjustable intensity
//   - audience-round        : AI plays a specific audience + evaluates adaptation
//   - debate-turn           : AI takes opposing side in a structured 3-round debate (Stage 4A)
//   - debate-verdict        : AI judges a completed debate and names strongest/weakest (Stage 4A)
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
      case 'debate-turn':           request = buildDebateTurnRequest(payload); break;
      case 'debate-verdict':        request = buildDebateVerdictRequest(payload); break;
      case 'coach-turn':            request = buildCoachTurnRequest(payload); break;
      case 'coach-prep-turn':       request = buildCoachPrepTurnRequest(payload); break;
      case 'annotate-exemplar':     request = buildAnnotateExemplarRequest(payload); break;
      case 'faded-check':           request = buildFadedCheckRequest(payload); break;
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

function buildDebateTurnRequest(p) {
  const { topic, userSide, aiSide, round, totalRounds, userLastArgument, history } = p;
  if (!topic || !aiSide || !userLastArgument) {
    throw new Error('Missing topic, aiSide, or userLastArgument');
  }

  const totalR = totalRounds || 3;
  const currentR = round || 1;
  const isFinalRound = currentR >= totalR;
  const turnType = currentR === 1 ? 'opening' : (isFinalRound ? 'closing' : 'rebuttal');

  const turnGuidance = {
    opening: 'Open with your strongest single argument for your side. Be confident but not hostile. State your thesis and back it with reasoning in 60-80 words.',
    rebuttal: 'Directly engage with what the user just argued. Point out the weakest link and counter it with your own evidence or reasoning. Stay in character on YOUR side. 60-80 words.',
    closing: 'This is the final round. Deliver a closing statement: restate why your side wins, summarize why the user\'s argument falls short, and end with a memorable line. 70-100 words.'
  };

  const systemPrompt = `You are debating a structured formal debate. You have been assigned the "${aiSide.toUpperCase()}" side of this topic and must commit to it fully, even if you personally disagree.

TOPIC: "${topic}"
YOUR SIDE: ${aiSide.toUpperCase()}
USER'S SIDE: ${userSide.toUpperCase()} (you must argue the opposite)
ROUND: ${currentR} of ${totalR} (${turnType})

TURN GUIDANCE: ${turnGuidance[turnType]}

RULES:
- Never concede or switch sides mid-debate.
- Do NOT break character to give feedback on speaking technique.
- Do NOT say "good point" or validate the user excessively — this is adversarial.
- Stay on-topic. Attack the user's reasoning, not the user personally.
- Do not invent fake statistics. Use logic, common knowledge, and rhetorical technique.
- Keep it punchy — a real debater's turn, not an essay.

OUTPUT FORMAT — return ONLY this JSON:
{
  "rebuttal": "<your full debate turn, in character, 60-100 words>",
  "strongestPoint": "<one short phrase naming YOUR strongest point this round>",
  "targetedWeakness": "<one short phrase naming what you attacked in the user's argument, or 'n/a' for round 1>",
  "turnType": "${turnType}"
}`;

  const historyBlock = (history && history.length)
    ? '\n\nDEBATE SO FAR:\n' + history.map(t => `[${t.speaker.toUpperCase()}]: ${t.text}`).join('\n\n')
    : '';

  const userPrompt = `The debate is in progress.${historyBlock}

USER'S MOST RECENT ARGUMENT (Round ${currentR}):
"${userLastArgument}"

Deliver your ${turnType} for the ${aiSide.toUpperCase()} side. Return the JSON.`;

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

function buildDebateVerdictRequest(p) {
  const { topic, userSide, aiSide, history } = p;
  if (!topic || !userSide || !Array.isArray(history) || history.length === 0) {
    throw new Error('Missing topic, userSide, or history');
  }

  const systemPrompt = `You are an impartial debate judge. You will review a completed debate and render a fair, objective verdict focused on helping the user improve.

JUDGING CRITERIA:
- Argument strength: was each claim backed with evidence or reasoning?
- Engagement: did they directly address the opponent's points?
- Structure: was the argument organized and easy to follow?
- Rhetoric: were specific examples, analogies, or framing devices used effectively?

You are NOT picking a winner or loser. You are naming the user's strongest and weakest turns, and giving one concrete tip for next time.

OUTPUT FORMAT — return ONLY this JSON:
{
  "overallScore": <integer 0-100>,
  "summary": "<two sentences describing how the user performed overall>",
  "strongestTurn": { "round": <1|2|3>, "why": "<one sentence explaining what made it strong>" },
  "weakestTurn": { "round": <1|2|3>, "why": "<one sentence explaining what was weak>" },
  "keyInsight": "<one sentence of actionable coaching for next debate>"
}`;

  const historyBlock = history.map((t, i) => `[${t.speaker.toUpperCase()}] Round ${Math.ceil((i + 1) / 2)}:\n"${t.text}"`).join('\n\n');

  const userPrompt = `TOPIC: "${topic}"
USER DEBATED THE: ${userSide.toUpperCase()} side
OPPONENT DEBATED THE: ${aiSide.toUpperCase()} side

FULL DEBATE TRANSCRIPT:

${historyBlock}

Render your verdict focused ONLY on the user's performance. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 700
  };
}

// coach-turn : the coaching spine. Given a scored attempt + the coach's memory of
// the user, return ONE warm, high-leverage diagnosis (spoken aloud) and a decision
// about what to do next. This is the AI layer above the app's own scoring engine.
function buildCoachTurnRequest(p) {
  const {
    focus, focusLabel, goals, profileSummary, weaknesses,
    lessonTitle, framework, prompt, response,
    heuristicScore, passMark = 70, passed,
    masteryStreak = 0, masteryThreshold = 3,
    delivery, conversationHistory
  } = p;
  if (!prompt || !response) throw new Error('Missing prompt or response');

  const fw = Array.isArray(framework) ? framework.join(' → ') : (framework || 'standard');
  const goalsLine = Array.isArray(goals) && goals.length ? goals.join(', ') : 'become a more polished speaker';

  const h = heuristicScore || {};
  const sig = Array.isArray(h.signals)
    ? h.signals.slice(0, 8).map(s => {
        const tag = s.type === 'hit' ? '✓' : s.type === 'partial' ? '~' : '✗';
        return `  ${tag} [${s.category || 'general'}] ${s.msg || ''}${s.quote ? ` ("${s.quote}")` : ''}${s.suggestion ? ` → ${s.suggestion}` : ''}`;
      }).join('\n')
    : '  (no signals)';

  const deliveryBlock = deliveryBlockFor(delivery);

  const systemPrompt = `You are an elite, warm public-speaking coach — think a seasoned speaking teacher who is genuinely invested in this person's growth. You are coaching them one-on-one, out loud. Your "spoken" text will be read aloud by a voice, so it must sound like a real person talking: warm, direct, encouraging, concise.

YOUR METHOD:
- Give exactly ONE highest-leverage fix per turn — the single thing that would most improve them right now. Never dump a list.
- Prioritise the user's CURRENT FOCUS ("${focusLabel || focus}") unless something more important clearly stands out.
- Be specific and quote their own words when useful. Praise what genuinely worked in one short beat, then the one fix.
- Challenge them, but always in service of their progress. Never generic. Never harsh.
- Build on the heuristic scores you're given; don't re-litigate the number, coach the human.

DECISION (field "action"):
- "redo": the attempt is below the pass mark (${passMark}) or the focus skill clearly failed — have them try again.
- "advance": the attempt passed and the focus was handled — move on to a fresh drill.
- "promote": they've now shown mastery of the focus (streak ${masteryStreak + (passed ? 1 : 0)}/${masteryThreshold}) — celebrate and level them up.
- "chat": only if they asked a question rather than gave an answer.

OUTPUT — return ONLY this JSON:
{
  "spoken": "<what you say aloud: <=55 words, warm, one clear fix, natural spoken rhythm>",
  "diagnosis": "<the single fix in <=12 words, imperative>",
  "action": "redo|advance|promote|chat",
  "modelLine": "<optional: a short exemplar of THEIR point delivered the way it should sound — same content, better execution. Empty string if not useful.>",
  "profileSummaryUpdate": "<optional: a refreshed 1-2 sentence running note on this speaker's strengths + recurring flaws, for your own memory. Empty string if unchanged.>"
}`;

  const historyBlock = (Array.isArray(conversationHistory) && conversationHistory.length)
    ? '\n\nRECENT COACHING DIALOGUE:\n' + conversationHistory.map(t => `${t.role === 'coach' ? 'COACH' : 'THEM'}: ${t.text}`).join('\n')
    : '';

  const userPrompt = `WHO YOU'RE COACHING:
- Their goals: ${goalsLine}
- Your running notes on them: ${profileSummary || '(first impressions — no notes yet)'}
- Current focus skill: ${focusLabel || focus}
- Rolling strength (0-100, higher=stronger): ${weaknesses ? Object.entries(weaknesses).map(([k, v]) => `${k} ${v}`).join(', ') : 'unknown'}

THE DRILL:
- Framework: ${lessonTitle || 'practice'} (${fw})
- Prompt you gave them: "${prompt}"

THEIR ANSWER:
"${response}"

THE APP'S SCORING ENGINE ALREADY GRADED IT:
- Structure ${h.structure ?? '?'}/40 · Clarity ${h.clarity ?? '?'}/30 · Depth ${h.depth ?? '?'}/20 · TOTAL ${h.total ?? '?'}/100 (pass mark ${passMark})
- Result: ${passed ? 'PASS' : 'below pass'}
Signals it found:
${sig}${deliveryBlock}${historyBlock}

Coach them now. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 450
  };
}

// coach-prep-turn : rehearsal against the user's REAL upcoming material (a meeting,
// presentation, Q&A). No framework score — the AI coach judges whether the message
// lands for the stated audience, escalates through pushback and audience reframes,
// and calls "done" when the delivery is fit-for-purpose.
function buildCoachPrepTurnRequest(p) {
  const { stage, brief, goals, profileSummary, response, wordCount, wpm, elapsed, delivery, conversationHistory } = p;
  if (!brief || !brief.title || !brief.message) throw new Error('Missing prep brief');
  if (!response) throw new Error('Missing response');
  const s = (stage || 'deliver').toLowerCase();

  const stageGuide = {
    deliver:  'FIRST DELIVERY. Give one warm, specific critique of what they just delivered — quote them if useful. Decide the next move: "redo" if the delivery clearly missed the message; otherwise "pushback" and pose ONE hard question a real stakeholder in that audience would fire back with.',
    pushback: 'PUSHBACK ROUND. They just handled a stakeholder challenge. If they defused it well, escalate to "audience" — pick a DIFFERENT stakeholder persona from this same audience and have them redeliver the core message for that person. If they fumbled, "redo" with a sharper pushback.',
    audience: 'AUDIENCE REFRAME. They just redelivered for a different persona. If it worked, call "done" and give a short, warm sign-off with one thing to keep in mind on the day. If it was weak, "redo" and coach the reframe.'
  };
  const guide = stageGuide[s] || stageGuide.deliver;

  const goalsLine = Array.isArray(goals) && goals.length ? goals.join(', ') : '(none noted)';

  const systemPrompt = `You are an elite, warm public-speaking coach helping someone rehearse a REAL upcoming talk. This is not a framework drill — your job is to make sure their MESSAGE LANDS with THEIR stated audience under realistic pressure. Your "spoken" text will be read aloud, so it must sound like a real person talking: warm, direct, concise.

METHOD:
- ${guide}
- Refer to what they actually said. Quote them when you praise or fix something.
- If DELIVERY metrics are provided, weave in a concrete observation about HOW they sounded (pace, pauses, monotone, flat energy) when it's the highest-leverage note — but never dump all of them.
- Never generic. Never harsh. Always in service of the real event.
- Your ENTIRE spoken turn must be <= 65 words and sound natural spoken aloud.

DECISION (field "action"):
- "redo": the delivery clearly didn't land at this stage — coach it and have them try again.
- "pushback": deliver was good enough; now hit them with a realistic stakeholder pushback (bake the pushback INTO your spoken line as a question).
- "audience": pushback handled; shift persona and have them redeliver for a different stakeholder (bake the new persona INTO your spoken line).
- "done": rehearsal is fit-for-purpose — sign off warmly with ONE thing to remember on the day.

OUTPUT — return ONLY this JSON:
{
  "spoken": "<what you say aloud, <=65 words, natural spoken rhythm>",
  "diagnosis": "<the single most important note in <=12 words>",
  "action": "redo|pushback|audience|done",
  "modelLine": "<optional: a short exemplar of THEIR message delivered how it should sound. Empty if not useful.>",
  "profileSummaryUpdate": "<optional: refreshed 1-2 sentence running note on this speaker. Empty if unchanged.>"
}`;

  const historyBlock = (Array.isArray(conversationHistory) && conversationHistory.length)
    ? '\n\nREHEARSAL SO FAR:\n' + conversationHistory.map(t => `${t.role === 'coach' ? 'COACH' : 'THEM'}: ${t.text}`).join('\n')
    : '';

  const userPrompt = `WHO YOU'RE COACHING:
- Their goals: ${goalsLine}
- Your notes on them: ${profileSummary || '(no notes yet)'}

THE REAL EVENT THEY'RE PREPARING FOR:
- Title: ${brief.title}
- Audience: ${brief.audience || '(unspecified)'}
- The message they need to land:
"""
${brief.message}
"""
- Their notes / constraints: ${brief.notes || '(none)'}

CURRENT STAGE: ${s}

WHAT THEY JUST DELIVERED (${wordCount || 0} words, ${wpm || 0} wpm, ${elapsed || 0}s):
"${response}"${deliveryBlockFor(delivery)}${historyBlock}

Coach them now. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 450
  };
}

// annotate-exemplar : the "Break it down" worked example. Show what a strong response
// sounds like AND explain it line by line — the technique, why it's there / worded that
// way, and how to deliver it. Teaches transferable reasoning, not a memorised script.
function buildAnnotateExemplarRequest(p) {
  const { promptText, lessonTitle, framework, expertTip, audience, segments, message, goals } = p;
  if (!promptText && !message) throw new Error('Missing scenario (promptText or message)');

  const fwList = (Array.isArray(framework) && framework.length)
    ? framework.map((e, i) => `${i + 1}. ${e.name}${e.description ? ' — ' + e.description : ''}`).join('\n')
    : '(no fixed framework — choose a clean shape that fits the situation)';
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  const segsBlock = hasSegments ? segments.map((s, i) => `${i + 1}. [${s.element}] ${s.text}`).join('\n') : '';
  const goalsLine = Array.isArray(goals) && goals.length ? goals.join(', ') : '';

  const systemPrompt = `You are an elite public-speaking coach delivering a WORKED EXAMPLE. You show the learner EXACTLY what you would say in this situation, then explain your thinking line by line so they internalise the REASONING — never a script to memorise.

For every line you must give:
- the exact line (verbatim),
- a short TECHNIQUE label, 2-4 words (e.g. "answer-first", "rule of three", "concrete number", "signpost", "contrast pair", "drop the hedge", "bookend", "name the stakes"),
- WHY this line is here AND why it's worded this way — the reasoning a learner should carry forward,
- HOW to deliver it — one short cue (pace, emphasis, pause).

RULES:
- Every explanation is tight, concrete, quote-worthy. No filler.
- ${hasSegments
      ? 'Annotate the GIVEN model answer line by line. Keep each line\'s text essentially as given (light polish only).'
      : 'First WRITE a strong, realistic model answer (3-6 lines) that lands the message for this audience, THEN annotate each line.'}
- Sound like a real expert teaching one-on-one.

OUTPUT — return ONLY this JSON:
{
  "strategy": "<1-2 sentences: the overall approach and why it fits THIS situation/audience>",
  "segments": [
    { "element": "<part name>", "text": "<the line>", "technique": "<2-4 word label>",
      "why": "<why it's here + why worded this way, <=32 words>", "howToSay": "<one delivery cue, <=12 words>" }
  ],
  "takeaway": "<one transferable principle to carry into similar situations, <=22 words>"
}`;

  const userPrompt = `SITUATION: ${lessonTitle || 'a speaking moment'}
${audience ? `AUDIENCE: ${audience}\n` : ''}${goalsLine ? `LEARNER'S GOALS: ${goalsLine}\n` : ''}THE PROMPT / MOMENT: "${promptText || message}"
${(message && !hasSegments) ? `\nTHE MESSAGE THEY NEED TO LAND:\n"""\n${message}\n"""\n` : ''}
FRAMEWORK:
${fwList}
${expertTip ? `\nEXPERT TIP FOR THIS FRAMEWORK: ${expertTip}\n` : ''}${hasSegments ? `\nMODEL ANSWER TO ANNOTATE (line by line):\n${segsBlock}\n` : ''}
Produce the worked example. Return the JSON.`;

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

// faded-check : the "now you try" step after a worked example. The learner attempts the
// SAME scenario; judge which of the TAUGHT MOVES they actually landed — honest but
// encouraging, formative, one next fix. This closes the worked-example → practice loop.
function buildFadedCheckRequest(p) {
  const { promptText, lessonTitle, audience, moves, response } = p;
  if (!response) throw new Error('Missing response');
  if (!Array.isArray(moves) || !moves.length) throw new Error('Missing taught moves');

  const movesList = moves.map((m, i) => `${i + 1}. ${m.technique}${m.line ? ` — demonstrated by: "${m.line}"` : ''}`).join('\n');

  const systemPrompt = `You are a warm public-speaking coach running a FADED-PRACTICE check. The learner just studied a worked example and is now attempting the SAME scenario in their own words. Judge which of the TAUGHT MOVES they actually landed in THEIR attempt — honest but encouraging. This is formative: celebrate real wins, name what's missing, give ONE next fix.

For each taught move, decide landed = "yes" | "partial" | "no", with a <=16 word note grounded in what they actually said (quote a few of their words when useful). Do NOT reward a move that isn't really there.

OUTPUT — return ONLY this JSON:
{
  "spoken": "<1-2 warm sentences summarising how they did, natural spoken rhythm>",
  "moves": [ { "technique": "<the move>", "landed": "yes|partial|no", "note": "<<=16 words>" } ],
  "encouragement": "<one genuine positive about their attempt, <=14 words>",
  "topFix": "<the single most useful next improvement, <=20 words>"
}
The "moves" array MUST have exactly one entry per taught move, in the same order given.`;

  const userPrompt = `SCENARIO: ${lessonTitle || 'a speaking moment'}
${audience ? `AUDIENCE: ${audience}\n` : ''}PROMPT / MOMENT: "${promptText || ''}"

TAUGHT MOVES (what the worked example demonstrated — judge each against their attempt):
${movesList}

THE LEARNER'S OWN ATTEMPT:
"${response}"

Judge which moves they landed. Return the JSON.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 700
  };
}

// ---------- HELPERS ----------

// Format on-device Web Audio delivery metrics into a short, human-readable block
// the coach model can weave into its critique. Returns '' if no metrics.
function deliveryBlockFor(d) {
  if (!d || typeof d !== 'object') return '';
  const bits = [];
  if (typeof d.speakingMs === 'number' && d.speakingMs > 0) {
    bits.push(`spoke for ${Math.round(d.speakingMs / 100) / 10}s of ${Math.round((d.totalMs || d.speakingMs) / 100) / 10}s total`);
  }
  if (typeof d.longPauseCount === 'number') {
    bits.push(`${d.longPauseCount} long pause${d.longPauseCount === 1 ? '' : 's'} (>700ms)` + (d.avgPauseMs ? `, avg pause ${d.avgPauseMs}ms` : ''));
  }
  if (d.pitchMedianHz) {
    bits.push(`pitch median ${d.pitchMedianHz}Hz, range ${d.pitchRangeHz}Hz${d.monotone ? ' — MONOTONE / flat' : ''}`);
  }
  if (typeof d.energyRangeDb === 'number' && d.energyRangeDb > 0) {
    bits.push(`vocal dynamics ${d.energyRangeDb}dB${d.flatEnergy ? ' — FLAT, no emphasis' : ''}`);
  }
  if (!bits.length) return '';
  return `\n\nDELIVERY (how they SOUNDED, on-device analysis):\n- ${bits.join('\n- ')}`;
}

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
