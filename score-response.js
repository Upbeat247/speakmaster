// Netlify Function: /.netlify/functions/score-response
// Proxies OpenRouter for AI-powered scoring of a SpeakMaster practice response.
// The OpenRouter API key lives ONLY as a Netlify environment variable —
// it's never exposed to the browser.
//
// Environment variables required (set in Netlify dashboard):
//   OPENROUTER_API_KEY  — your OpenRouter key (starts with sk-or-...)
//   OPENROUTER_MODEL    — optional, defaults to a cheap+capable model
//   ALLOWED_ORIGIN      — optional, your site origin (for strict CORS).
//                         If unset, accepts any origin (simpler for personal use).

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

exports.handler = async (event) => {
  // ----- CORS / Preflight -----
  const origin = event.headers.origin || event.headers.Origin || '*';
  const allowed = process.env.ALLOWED_ORIGIN;
  const corsOrigin = allowed
    ? (origin === allowed ? origin : allowed)
    : '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // ----- Env sanity -----
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Server not configured: OPENROUTER_API_KEY env var is missing.'
      })
    };
  }
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  // ----- Parse input -----
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const {
    prompt,            // The user was asked this
    response,          // The user's actual response text
    lessonTitle,       // e.g. "PREP Framework"
    framework,         // The framework sequence, e.g. ["Point","Reason","Example","Point"]
    elementDescriptions, // Array of { name, description } for each element
    expertTip,         // The lesson's expert tip
    passMark = 70,     // User's pass threshold
    timeLimit,         // Target time in seconds
    timeSpent,         // Actual time spent
    inputMode = 'typing', // 'typing' or 'speaking'
    wordCount,
    wpm,
    heuristicScore     // Optional: { structure, clarity, depth, completion, total, signals }
                       // The scores the heuristic engine already awarded. AI acts as a
                       // complementary second opinion, not an independent rescorer.
  } = payload;

  // Basic validation
  if (!prompt || !response || !Array.isArray(framework) || framework.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Missing required fields: prompt, response, framework'
      })
    };
  }
  if (typeof response !== 'string' || response.length > 10000) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Response too long (max 10000 chars)' })
    };
  }

  // ----- Build the evaluator prompt -----
  // The AI is a COMPLEMENTARY reviewer, not an independent re-scorer. It sees the
  // heuristic's results and either confirms them (default) or adjusts with specific
  // evidence. This prevents the frustrating "app said structure was great, AI said it
  // was weak" contradiction.
  const systemPrompt = `You are an expert communication coach providing a deeper second opinion on a response that has ALREADY been scored by an automated heuristic engine. You are NOT an independent rescorer. Your job is to confirm, nuance, and enrich — not to contradict without cause.

ROLE AND CONSTRAINTS:
1. The heuristic scores are the baseline. You may CONFIRM them, ADD nuance the heuristic can't detect, or CATCH specific things the heuristic missed.
2. You may only score LOWER than the heuristic when you can point to a specific problem the heuristic was blind to (e.g. the response hit framework keywords but the logic was incoherent, or a claim was misleading).
3. When the heuristic awarded full or near-full credit for a category, default to agreeing unless you have concrete reason to disagree. Do NOT deduct points just to appear rigorous.
4. When the heuristic missed something (e.g. a point was weak even though the word patterns matched), you may score lower AND must explain WHY in your signals.
5. Where you agree with the heuristic, use your signals to ENRICH (add depth) rather than repeat what the heuristic already said.
6. Your total score should be within 10 points of the heuristic total unless there is a clear substantive issue.

CATEGORIES:
- Structure (0-40): does the response follow the framework? Does each element do its job?
- Clarity (0-30): pacing, coherence, filler words, time adherence.
- Depth (0-20): specificity — numbers, names, concrete examples, stakes, consequences.
- Completion (10): always 10.

SPEECH MODE:
- For speech-mode responses, do NOT penalize missing punctuation — transcripts lack it by design. Judge sentence structure by the flow of ideas.

EVIDENCE RULES:
- Every signal must include a direct quote from the user (or empty if truly not applicable).
- Every "miss" or "partial" must include a concrete, actionable suggestion.
- Never invent quotes.

OUTPUT FORMAT — return ONLY this JSON (no prose, no markdown):
{
  "structure": <integer 0-40>,
  "clarity": <integer 0-30>,
  "depth": <integer 0-20>,
  "completion": 10,
  "total": <integer 0-100>,
  "verdict": "<one sentence overall — frame as 'Building on the heuristic review...' or similar when you agree>",
  "agreement": "<confirm|enrich|adjust>",
  "agreementNote": "<one short sentence describing how your review relates to the heuristic's: confirming, adding depth, or specific adjustment>",
  "signals": [
    { "category": "structure"|"clarity"|"depth", "type": "hit"|"partial"|"miss",
      "msg": "<short specific observation that ADDS to the heuristic (not duplicates it)>",
      "quote": "<direct quote from user or empty>",
      "suggestion": "<concrete rewrite/fix or empty>" }
  ],
  "rewrite": "<your one-paragraph improved version of the user's response, using the same framework>",
  "frameworkCoverage": [
    { "element": "<element name>", "covered": true|false,
      "evidence": "<short quote from response or explanation>" }
  ]
}`;

  const elementsLines = framework.map((name, i) => {
    const desc = (elementDescriptions && elementDescriptions[i] && elementDescriptions[i].description) || '';
    return `${i + 1}. ${name}${desc ? ' — ' + desc : ''}`;
  }).join('\n');

  const timeAdherence = (timeLimit && timeSpent)
    ? `Time target: ${timeLimit}s. User took ${timeSpent}s (${Math.round((timeSpent / timeLimit) * 100)}% of target).`
    : '';
  const paceInfo = (wpm && wordCount) ? `Pace: ${wpm} wpm, ${wordCount} words.` : '';

  // Serialize the heuristic engine's findings so the AI can see what's already been assessed.
  // This is what makes the AI COMPLEMENTARY instead of contradictory.
  let heuristicBlock = '';
  if (heuristicScore && typeof heuristicScore === 'object') {
    const h = heuristicScore;
    const sigLines = Array.isArray(h.signals)
      ? h.signals.slice(0, 10).map(s => {
          const tag = s.type === 'hit' ? '✓' : s.type === 'partial' ? '~' : '✗';
          return `  ${tag} [${s.category || 'general'}] ${s.msg || ''}${s.quote ? ` (quoted: "${s.quote}")` : ''}`;
        }).join('\n')
      : '  (no signals recorded)';
    heuristicBlock = `\n\nHEURISTIC ENGINE ALREADY SCORED THIS RESPONSE:
- Structure: ${h.structure ?? '?'}/40
- Clarity: ${h.clarity ?? '?'}/30
- Depth: ${h.depth ?? '?'}/20
- Completion: ${h.completion ?? 10}/10
- TOTAL: ${h.total ?? '?'}/100

Heuristic signals (what it found):
${sigLines}

YOUR JOB: confirm/enrich/adjust these findings. Do NOT score meaningfully lower unless you can point to a specific thing the heuristic missed. When you agree, use your signals to add DEPTH the heuristic can't detect (coherence, logical flow, persuasive impact, missing context).`;
  } else {
    heuristicBlock = '\n\n(No heuristic baseline provided — score independently.)';
  }

  const userPrompt = `LESSON: ${lessonTitle || 'Unknown'}
FRAMEWORK (in order):
${elementsLines}

EXPERT TIP FOR THIS FRAMEWORK:
${expertTip || '(none provided)'}

THE PROMPT THE USER WAS ASKED:
"${prompt}"

THE USER'S RESPONSE (${inputMode} mode):
"${response}"

EVALUATION CONTEXT:
${timeAdherence}
${paceInfo}
User's pass mark: ${passMark}/100${heuristicBlock}

Now evaluate as a complementary reviewer. Return the JSON described in the system prompt. No surrounding prose.`;

  // ----- Call OpenRouter -----
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
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (!openrouterRes.ok) {
      const errText = await openrouterRes.text();
      console.error('OpenRouter error:', openrouterRes.status, errText);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'AI provider error',
          detail: errText.slice(0, 500)
        })
      };
    }

    const data = await openrouterRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';

    // Try to extract the JSON the model returned
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Some models wrap in markdown fences — strip and retry
      const stripped = content.replace(/```json\s*|```\s*$/gim, '').trim();
      try {
        parsed = JSON.parse(stripped);
      } catch (e2) {
        return {
          statusCode: 502,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'AI returned unparseable output',
            detail: content.slice(0, 500)
          })
        };
      }
    }

    // Normalize / clamp scores defensively
    const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
    const scored = {
      structure: clamp(parsed.structure, 0, 40),
      clarity: clamp(parsed.clarity, 0, 30),
      depth: clamp(parsed.depth, 0, 20),
      completion: 10
    };
    scored.total = Math.min(100, scored.structure + scored.clarity + scored.depth + scored.completion);

    const normalized = {
      ...scored,
      verdict: typeof parsed.verdict === 'string' ? parsed.verdict : '',
      // Agreement relationship with the heuristic score: 'confirm' | 'enrich' | 'adjust'
      agreement: typeof parsed.agreement === 'string' ? parsed.agreement : 'enrich',
      agreementNote: typeof parsed.agreementNote === 'string' ? parsed.agreementNote : '',
      signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 12) : [],
      rewrite: typeof parsed.rewrite === 'string' ? parsed.rewrite : '',
      frameworkCoverage: Array.isArray(parsed.frameworkCoverage) ? parsed.frameworkCoverage : [],
      heuristicTotal: heuristicScore && typeof heuristicScore.total === 'number' ? heuristicScore.total : null,
      model: model,
      usage: data.usage || null
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(normalized)
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Internal error',
        detail: String(err && err.message ? err.message : err).slice(0, 500)
      })
    };
  }
};
