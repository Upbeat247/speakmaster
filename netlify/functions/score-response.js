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
    wpm
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
  // We ask the model for a strict JSON object so the frontend can display it cleanly.
  const systemPrompt = `You are an expert communication coach scoring a user's practice response against a specific framework. You must be rigorous but fair, evidence-based, and genuinely helpful.

SCORING RULES:
- Structure (0-40 pts): how well the response follows the framework elements.
- Clarity (0-30 pts): pacing, coherence, filler words, time adherence.
- Depth (0-20 pts): specificity — numbers, names, concrete examples, stakes.
- Completion (10 pts): always awarded for submitting a response.

IMPORTANT:
- For speech-mode responses, do NOT penalize missing punctuation — transcripts lack it by design. Judge sentence structure by the flow of ideas, not punctuation.
- For typing-mode responses, normal sentence/punctuation standards apply.
- Always ground feedback in actual QUOTES from the user's response. Don't invent.
- Be specific and actionable. "Make it stronger" is useless; "Replace 'stuff' with '3 specific examples' at line 2" is useful.

OUTPUT FORMAT:
Return ONLY a JSON object (no prose, no markdown) with this exact shape:
{
  "structure": <integer 0-40>,
  "clarity": <integer 0-30>,
  "depth": <integer 0-20>,
  "completion": 10,
  "total": <integer 0-100>,
  "verdict": "<one short sentence overall>",
  "signals": [
    { "category": "structure"|"clarity"|"depth", "type": "hit"|"partial"|"miss",
      "msg": "<short specific observation>",
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
User's pass mark: ${passMark}/100

Now evaluate. Return the JSON object described in the system prompt. No surrounding prose.`;

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
      signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 12) : [],
      rewrite: typeof parsed.rewrite === 'string' ? parsed.rewrite : '',
      frameworkCoverage: Array.isArray(parsed.frameworkCoverage) ? parsed.frameworkCoverage : [],
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
