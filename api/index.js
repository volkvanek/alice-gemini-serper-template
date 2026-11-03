const DEFAULT_MODEL = "gemini-3.8-flash"; // Или "gemini-3.8-flash" для максимальной производительности
const MAX_HISTORY_MESSAGES = 6; // Уменьшили историю для ускорения запроса
const MAX_HISTORY_MESSAGE_CHARS = 800; 
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 2800; // Укладываемся в жесткий лимит Яндекса
const SERPER_TIMEOUT_MS = 400;
const GEMINI_TIMEOUT_MS = 1800;

const SYSTEM_PROMPT = [
  "Ты — дерзкий, саркастичный и ехидный голосовой помощник.",
  "Отвечай по-русски, с легкой долей цинизма, едко, но без мата и прямых оскорблений. Не сюсюкай.",
  "Строго используй мужской род от первого лица (например: я нашел, я сделал, я подумал).",
  "Отвечай кратко, строго 1–2 предложения, чтобы уложиться в лимит времени.",
  "Если пользователь задает глупый вопрос, слегка подшути над ним, но всё равно дай ответ по делу.",
  "Не используй Markdown, таблицы или списки."
].join(" ");

function aliceResponse(text, endSession = false) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: [] } 
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Я тут.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 200) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 100 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 2 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) return "";

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 2)
      .map((item, i) => `${i + 1}. ${String(item.title || "")}: ${String(item.snippet || "")}`.trim());

    return items.length ? items.join("\n") : "";
  } catch (error) {
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nДанные из сети:\n${searchContext}`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 150 // Уменьшено для мгновенного ответа
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    if (status === 404) throw new Error("GEMINI_MODEL_NOT_FOUND");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Ключ API не настроен.";
    case "GEMINI_KEY_REJECTED":
      return "Ошибка ключа нейросети.";
    case "GEMINI_QUOTA":
      return "Лимит запросов исчерпан, подожди.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Сеть тупит, повтори."; // Заменили раздражающую фразу на более мягкую
    default:
      return "Чего тебе?";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "Ready." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  
  const userId = body?.session?.user?.user_id || body?.session?.application?.application_id;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  let oldHistory = [];

  // Быстрое чтение базы с жестким лимитом в 600мс
  if (userId && SB_URL && SB_KEY) {
    try {
      const { response, data } = await fetchJson(
        `${SB_URL}/rest/v1/memory?user_id=eq.${userId}&select=history`,
        { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } },
        600 
      );
      if (response?.ok && Array.isArray(data) && data.length > 0) {
        oldHistory = safeHistory(data[0].history);
      }
    } catch (e) {
      // Игнорируем задержки БД, чтобы не ронять навык
    }
  }

  if (!text) {
    return res.status(200).json(aliceResponse("Чего надо?", false));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, remainingMs()));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(200, remainingMs())
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    // Асинхронная запись в базу (не блокируем основной ответ Яндекс.Диалогам)
    if (userId && SB_URL && SB_KEY) {
      fetch(`${SB_URL}/rest/v1/memory?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'apikey': SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ user_id: userId, history })
      }).catch(() => {});
    }

    return res.status(200).json(aliceResponse(answer, false));
  } catch (error) {
    const safeError = (error?.name === "AbortError" || error?.message?.includes("aborted")) ? {message: "TIME_BUDGET_EXHAUSTED"} : error;
    return res.status(200).json(aliceResponse(errorForUser(safeError), false));
  }
}
