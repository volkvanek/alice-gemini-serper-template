export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Webhook is ready.');

  const { request, session, version } = req.body;
  const versionId = version || '1.0';
  const command = request?.command || request?.original_utterance || '';
  
  const userId = session?.user?.user_id || session?.application?.application_id;

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  let rawHistory = [];
  if (userId) {
    try {
      const dbRes = await fetch(`${SB_URL}/rest/v1/memory?user_id=eq.${userId}&select=history`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      const dbData = await dbRes.json();
      if (dbData && dbData.length > 0) rawHistory = dbData[0].history || [];
    } catch (e) { console.error('DB Read Error', e); }
  }

  if (session?.new) {
    return res.json({
      response: { text: 'Привет! Я загрузила нашу прошлую беседу. Что обсудим сегодня?', end_session: false },
      version: versionId
    });
  }

  if (!command.trim()) {
    return res.json({ response: { text: 'Я вас не услышала.', end_session: false }, version: versionId });
  }

  let contents = [];
  for (const msg of rawHistory) {
    contents.push({ role: 'user', parts: [{ text: msg.u }] });
    contents.push({ role: 'model', parts: [{ text: msg.m }] });
  }
  contents.push({ role: 'user', parts: [{ text: command }] });

  const payload = {
    system_instruction: { parts: [{ text: "Ты — голосовой помощник Алиса. Отвечай кратко, без сложного форматирования. Используй google_search для поиска свежих данных." }] },
    contents: contents,
    tools: [{
      function_declarations: [{
        name: "google_search",
        description: "Поиск в интернете для получения актуальной информации.",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] }
      }]
    }]
  };

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_KEY}`;
    let aiResponse = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let data = await aiResponse.json();
    console.log("Ответ от Gemini:", JSON.stringify(data));
    let messagePart = data.candidates?.[0]?.content?.parts?.[0];

    if (messagePart?.functionCall && messagePart.functionCall.name === 'google_search') {
      const sq = messagePart.functionCall.args.query;
      const serperRes = await fetch('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: sq })
      });
      const serperData = await serperRes.json();
      const searchResults = serperData.organic ? serperData.organic.slice(0, 3).map(r => r.snippet).join(' ') : 'Ничего не найдено.';

      contents.push({ role: 'model', parts: [{ functionCall: messagePart.functionCall }] });
      contents.push({ role: 'user', parts: [{ functionResponse: { name: 'google_search', response: { result: searchResults } } }] });

      let aiResponse2 = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_instruction: payload.system_instruction, contents: contents }) });
      let data2 = await aiResponse2.json();
      messagePart = data2.candidates?.[0]?.content?.parts?.[0];
    }

    const replyText = messagePart?.text || 'Ошибка генерации ответа.';
    
    rawHistory.push({ u: command, m: replyText });
    if (rawHistory.length > 10) rawHistory = rawHistory.slice(-10);

if (userId) {
  await fetch(`${SB_URL}/rest/v1/memory`, {
        method: 'POST',
        headers: {
          'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ user_id: userId, history: rawHistory })
      }).catch(e => console.error('DB Write Error', e));
    }

    return res.json({ response: { text: replyText, end_session: false }, version: versionId });

  } catch (error) {
    return res.json({ response: { text: 'Извините, ошибка соединения.', end_session: false }, version: versionId });
  }
}
