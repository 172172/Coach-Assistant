 // Förbättrad Coach Assistant - Digital kollega för Linje65

import { getOpenAIResponse } from './memory.js';
import { searchKnowledge, q } from './db.js';

// PERSONLIGHET & KONTEXT
const COACH_PERSONALITY = {
  name: "Alex", // Din digitala kollega
  tone: "vänlig, uppmuntrande och lite rolig",
  traits: [
    "Använder mild humor för att göra lärandet roligt",
    "Känner igen när någon behöver extra stöd",
    "Firar framsteg och uppmuntrar vid misslyckanden",
    "Anpassar språket efter användarens erfarenhetsnivå",
    "Kommer ihåg vad vi pratat om tidigare"
  ]
};

// MINNESHANTERING
class ConversationMemory {
  constructor() {
    this.sessions = new Map(); // userId -> sessionData
  }

  getSession(userId) {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        personality: {
          preferredName: null,
          experienceLevel: 'beginner', // beginner, intermediate, expert
          learningStyle: null, // visual, hands-on, theoretical
          interests: [],
          lastActive: Date.now()
        },
        context: {
          recentTopics: [],
          currentTask: null,
          strugglingWith: [],
          masteredSkills: [],
          sessionGoals: []
        },
        interaction: {
          totalQuestions: 0,
          successfulTasks: 0,
          needsEncouragement: false,
          preferredResponseLength: 'medium' // short, medium, detailed
        }
      });
    }
    return this.sessions.get(userId);
  }

  updateSession(userId, updates) {
    const session = this.getSession(userId);
    Object.assign(session, updates);
    session.personality.lastActive = Date.now();
    return session;
  }

  addToHistory(userId, topic, success = true) {
    const session = this.getSession(userId);
    session.context.recentTopics.unshift(topic);
    if (session.context.recentTopics.length > 10) {
      session.context.recentTopics.pop();
    }
    
    if (success) {
      session.interaction.successfulTasks++;
    } else {
      session.interaction.needsEncouragement = true;
    }
  }
}

const memory = new ConversationMemory();

// ==================== PRAKTISKA FUNKTIONER ====================

// Normalisering och utilities
function normalize(text) {
  return text.toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/[ö]/g, 'o')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Status/nyheter queries
function isStatusQuery(text) {
  const n = normalize(text);
  return /\b(vad.*har.*hant|status|laget|nyheter|happenings|uppdatering|overlam|idag|igår|denna.*vecka|senaste.*veckan|i.*veckan)\b/i.test(n);
}

function parseStatusRange(text) {
  const n = normalize(text);
  if (/\b(idag|today)\b/.test(n)) return { key: "today", label: "idag" };
  if (/\b(igar|yesterday)\b/.test(n)) return { key: "yesterday", label: "igår" };
  if (/\b(denna.*vecka|this.*week)\b/.test(n)) return { key: "week", label: "denna vecka" };
  if (/\b(senaste.*veckan|last.*week|forra.*veckan)\b/.test(n)) return { key: "last_week", label: "senaste veckan" };
  return { key: "week", label: "denna vecka" };
}

// Hämta line_news för statusrapporter
async function fetchStatusData(rangeKey = "week") {
  let whereNews = "news_at >= now() - interval '7 days'";
  if (rangeKey === "today") {
    whereNews = "news_at >= date_trunc('day', now())";
  } else if (rangeKey === "yesterday") {
    whereNews = "news_at >= date_trunc('day', now()) - interval '1 day' AND news_at < date_trunc('day', now())";
  } else if (rangeKey === "last_week") {
    whereNews = "news_at >= date_trunc('week', now()) - interval '1 week' AND news_at < date_trunc('week', now())";
  }

  const newsSql = `
    select id, news_at, section, area, shift, title, body, tags
    from line_news
    where ${whereNews}
    order by news_at desc
    limit 300
  `;

  const n = await q(newsSql);
  return { news: n?.rows || [] };
}

// Normalisering av svar
function normalizeKeys(out) {
  if (out && !out.spoken && typeof out.svar === "string") out.spoken = out.svar;
  if (!out.need) out.need = { clarify: false, question: "" };
  if (!("clarify" in out.need)) out.need.clarify = false;
  if (!("question" in out.need)) out.need.question = "";
  if (!out.cards) out.cards = {};
  const defCards = { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] };
  out.cards = Object.assign(defCards, out.cards);
  if (!Array.isArray(out.cards.steps)) out.cards.steps = [];
  if (!Array.isArray(out.cards.matched_headings)) out.cards.matched_headings = [];
  if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) out.cards.coverage = 0;
  if (typeof out.follow_up !== "string") out.follow_up = out.cards.follow_up || "";
  
  // För status-svar: säkerställ att bara spoken läses upp
  if (out.meta?.speech_source === "status_summary") {
    out.meta.tts = Object.assign({}, out.meta.tts, {
      text: out.spoken,
      priority: "spoken_only",
      read_only_spoken: true,
      skip_steps: true,
      skip_cards: true,
      skip_all_except_spoken: true
    });
    out.tts_spoken_only = out.spoken;
    out.tts_skip_steps = true;
  }
  
  return out;
}

// AI-anrop via callLLM (för statusrapporter)
async function callLLM(system, user, temperature = 0.7, maxTokens = 800, history = []) {
  try {
    const fullPrompt = `${system}\n\nUser: ${user}\nAssistant:`;
    const response = await getOpenAIResponse(fullPrompt, temperature, maxTokens);
    
    try {
      return JSON.parse(response);
    } catch {
      return {
        spoken: response || "Jag hade lite tekniska problem med svaret.",
        cards: { summary: "Tekniskt fel" },
        follow_up: "Kan du försöka igen?"
      };
    }
  } catch (error) {
    console.error('callLLM error:', error);
    return {
      spoken: "Det blev ett tekniskt fel. Kan du prova igen?",
      cards: { summary: "Systemfel" },
      follow_up: "Är det något annat jag kan hjälpa dig med?"
    };
  }
}

// Bygg statusrapport (förbättrad version)
async function buildStatusReply({ news = [], label = "senaste veckan", history = [], userSession }) {
  if (!news || news.length === 0) {
    const empty = {
      spoken: `Lugnt läge ${label} – inget särskilt att rapportera! Ibland är det skönt när allt bara rullar på. 😊`,
      need: { clarify: false, question: "" },
      cards: { summary: `Inget registrerat ${label}.`, steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
      follow_up: "Vill du att vi börjar logga vad som händer?"
    };
    return normalizeKeys(empty);
  }

  // Förbättrad datumformatering med rätt veckodag
  const fmt = (d) => {
    const date = new Date(d);
    const weekdays = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
    const weekday = weekdays[date.getDay()];
    const dateStr = date.toLocaleDateString("sv-SE", { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString("sv-SE", { hour: '2-digit', minute: '2-digit' });
    return `${weekday} ${dateStr} kl ${timeStr}`;
  };
  
  const newsData = news.map(n => ({
    when: fmt(n.news_at),
    area: n.area || n.section || "Okänt område",
    shift: n.shift || "",
    title: n.title || "",
    body: n.body || "",
    tags: Array.isArray(n.tags) ? n.tags : []
  }));

  // Personaliserad systemprompt baserat på användarsession
  const userLevel = userSession?.personality?.experienceLevel || 'intermediate';
  const preferredLength = userSession?.interaction?.preferredResponseLength || 'medium';
  const userName = userSession?.personality?.preferredName ? `, ${userSession.personality.preferredName}` : '';

  const system = `
Du är Alex, en erfaren operatör som berättar för en kollega${userName} vad som hänt ${label}.

ANVÄNDARENS PREFERENSER:
- Erfarenhetsnivå: ${userLevel}
- Föredragen detaljnivå: ${preferredLength}

STIL & TON:
- Vardagligt svenskt språk, som mellan kollegor
- Använd "vi", "det", naturligt
- Omformulera slang till bättre språk men behåll vardaglig ton
- Berätta UTFÖRLIGT och SPECIFIKT vad som hänt

VIKTIGT - OMFORMULERING AV SPRÅK:
- "allt gick åt skogen" → "det blev problem"
- "annat skit" → "andra komponenter"
- "krånglade" → "hade problem"
- "strulade" → "fungerade inte"

INNEHÅLL:
- Börja med övergripande läge
- Gå in på specifika händelser per område/skift
- Nämn alltid VILKET område och skift
- Inkludera relevanta tekniska detaljer

Returnera strikt JSON med vårt schema.`;

  const user = `
Omformulera och berätta utförligt vad som hänt ${label}:

RÅDATA (${newsData.length} st):
${newsData.map(n => `${n.when} | ${n.area}${n.shift ? ` (Skift ${n.shift})` : ""} | ${n.title || "Uppdatering"}: ${n.body}`).join("\n")}

Omformulera ENDAST språket - lägg inte till information som inte finns. Nämn alltid område och skift.`;

  let out = await callLLM(system, user, 0.2, 1000, history);
  out = normalizeKeys(out);

  // Förbättrad failsafe
  if (!out.spoken || out.spoken.trim().length < 20) {
    if (newsData.length === 1) {
      const item = newsData[0];
      let body = item.body || item.title || "";
      body = body.replace(/allt gick åt skogen/gi, "det blev problem")
                 .replace(/annat skit/gi, "andra komponenter")
                 .replace(/krånglade/gi, "hade problem")
                 .replace(/strulade/gi, "fungerade inte");
      
      const locationInfo = `${item.area}${item.shift ? ` under skift ${item.shift}` : ""}`;
      out.spoken = `${label}: Det hände på ${locationInfo} - ${body}.`;
    } else {
      const areas = [...new Set(newsData.map(n => n.area))];
      out.spoken = `${newsData.length} händelser ${label} på ${areas.slice(0,2).join(" och ")}.`;
    }
  }

  // TTS-inställningar för statusrapporter
  out.meta = Object.assign({}, out.meta, {
    speech: out.spoken,
    speech_source: "status_summary",
    speech_only: true,
    tts: { 
      text: out.spoken, 
      priority: "spoken_only",
      read_only_spoken: true,
      skip_steps: true,
      skip_cards: true,
      skip_all_except_spoken: true
    }
  });

  return out;
}

// DYNAMISK PROMPT GENERATION
function generateSystemPrompt(userSession, context = {}) {
  const { personality, interaction } = userSession;
  
  let prompt = `Du är Alex, en vänlig och kunnig digital kollega som jobbar på Linje65. 

PERSONLIGHET:
- Du är ${COACH_PERSONALITY.tone}
- Du använder mild humor och positiv energi för att göra lärandet roligt
- Du kommer ihåg tidigare samtal och bygger vidare på dem
- Du anpassar ditt språk efter användarens erfarenhetsnivå (${personality.experienceLevel})

ANVÄNDARKONTEXT:
- Erfarenhetsnivå: ${personality.experienceLevel}
- Föredragen svarslängd: ${interaction.preferredResponseLength}
- Antal lyckade uppgifter denna session: ${interaction.successfulTasks}
- Behöver uppmuntran: ${interaction.needsEncouragement ? 'Ja - var extra stöttande!' : 'Nej'}`;

  if (personality.preferredName) {
    prompt += `\n- Användarens namn: ${personality.preferredName}`;
  }

  if (userSession.context.recentTopics.length > 0) {
    prompt += `\n- Senaste ämnen vi pratat om: ${userSession.context.recentTopics.slice(0, 3).join(', ')}`;
  }

  if (context.searchResults) {
    prompt += `\n\nTILLGÄNGLIG KUNSKAP:\n${context.searchResults}`;
  }

  prompt += `

SVARSSTIL:
- Börja med personlig hälsning eller referens till tidigare samtal
- Använd "vi" istället för "du" för att skapa teamkänsla
- Lägg till uppmuntrande kommentarer när det passar
- Avsluta med en relevant uppföljningsfråga eller förslag

EXEMPEL FRASER:
- "Kul att vi får fortsätta där vi slutade!"
- "Du blir verkligen bättre på det här!"
- "Låt oss ta det steg för steg tillsammans"
- "Bra fråga! Det undrar många operatörer över"

VIKTIGT: Du MÅSTE svara i giltigt JSON-format med exakt denna struktur:
{
  "spoken": "Vad du säger högt (naturligt och personligt)",
  "cards": {
    "summary": "Kort sammanfattning",
    "steps": ["steg1", "steg2"],
    "pitfalls": ["fallgrop1"],
    "explanation": "Djupare förklaring vid behov",
    "matched_headings": ["källa1"]
  },
  "follow_up": "Förslag på nästa steg eller fråga",
  "need": null,
  "meta": {
    "confidence": 0.9,
    "experience_needed": "${personality.experienceLevel}",
    "encouragement_added": ${interaction.needsEncouragement}
  }
}

Svara ENDAST med giltigt JSON, inget annat text.`;

  return prompt;
}

// INTELLIGENTA UPPFÖLJNINGAR
function generateFollowUp(topic, userLevel, success) {
  const followUps = {
    beginner: {
      success: [
        "Vill du att vi går igenom ett liknande scenario?",
        "Känner du dig redo att prova nästa nivå?",
        "Finns det något annat du undrar över inom det här området?"
      ],
      struggle: [
        "Ska vi börja med grunderna istället?",
        "Vill du att jag förklarar det på ett annat sätt?",
        "Vilken del känns mest förvirrande?"
      ]
    },
    intermediate: {
      success: [
        "Redo för en mer avancerad variant?",
        "Vill du lära dig några pro-tips?",
        "Hur skulle du hantera det om X inträffade?"
      ],
      struggle: [
        "Låt oss bryta ner det i mindre delar",
        "Vilket steg känns svårast?",
        "Har du stött på det här problemet tidigare?"
      ]
    },
    expert: {
      success: [
        "Intressant! Hur skulle du optimera processen?",
        "Vilka edge cases borde vi tänka på?",
        "Kan du se några förbättringsmöjligheter?"
      ],
      struggle: [
        "Vill vi diskutera alternativa approaches?",
        "Vilka faktorer spelar in här?",
        "Hur balanserar vi olika krav här?"
      ]
    }
  };

  const level = followUps[userLevel] || followUps.beginner;
  const options = success ? level.success : level.struggle;
  return options[Math.floor(Math.random() * options.length)];
}

// HUVUD-ENDPOINT
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId, history = [], prev } = req.body;
    
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    const userText = message.trim();

    // Hämta/uppdatera användarsession
    const userSession = memory.getSession(userId);
    userSession.interaction.totalQuestions++;

    // PERSONLIGHETSANALYS (enkla heuristiker) - bara första gångerna
    if (userSession.interaction.totalQuestions <= 3) {
      if (/namn|heter|kallas/i.test(userText)) {
        const nameMatch = userText.match(/(?:namn|heter|kallas)\s+(\w+)/i);
        if (nameMatch) {
          userSession.personality.preferredName = nameMatch[1];
        }
      }
      
      if (/nybörjare|ny|börjat nyligen/i.test(userText)) {
        userSession.personality.experienceLevel = 'beginner';
      } else if (/erfaren|jobbat länge|expert/i.test(userText)) {
        userSession.personality.experienceLevel = 'expert';
      }
      
      if (/kort|snabbt|bara svaret/i.test(userText)) {
        userSession.interaction.preferredResponseLength = 'short';
      } else if (/detaljer|förklara ordentligt|grundligt/i.test(userText)) {
        userSession.interaction.preferredResponseLength = 'detailed';
      }
    }

    // ========== HANTERA STATUSFRÅGOR ==========
    if (isStatusQuery(userText)) {
      const range = parseStatusRange(userText);
      const { news } = await fetchStatusData(range.key);
      const reply = await buildStatusReply({ 
        news, 
        label: range.label, 
        history,
        userSession 
      });

      // Uppdatera memory
      memory.addToHistory(userId, `status_${range.key}`, true);

      return res.status(200).json({ reply });
    }

    // ========== HANTERA VANLIGA FRÅGOR ==========
    
    // Sök kunskap i databasen
    const searchResults = await searchKnowledge(userText);
    
    // Generera personlig systemprompt
    const systemPrompt = generateSystemPrompt(userSession, { searchResults });
    
    // Skapa konversationshistorik med personlighet
    let conversationHistory = `${systemPrompt}\n\nKUNSKAP:\n${searchResults}\n\nKONVERSATION:\n`;
    
    // Lägg till tidigare meddelanden med kontext
    history.slice(-6).forEach(h => {
      conversationHistory += `Användare: ${h.user}\nAlex: ${JSON.stringify(h.assistant)}\n`;
    });
    
    conversationHistory += `Användare: ${userText}\nAlex: `;

    // Hämta AI-svar
    const response = await getOpenAIResponse(conversationHistory);
    
    let aiReply;
    try {
      aiReply = JSON.parse(response);
    } catch (e) {
      // Fallback om JSON parsning misslyckas
      aiReply = {
        spoken: response || "Ursäkta, jag hade lite tekniska problem. Kan du upprepa frågan?",
        cards: { summary: "Tekniskt fel uppstod" },
        follow_up: generateFollowUp("general", userSession.personality.experienceLevel, false),
        meta: { confidence: 0.1 }
      };
    }

    // Lägg till intelligent uppföljning om den saknas
    if (!aiReply.follow_up) {
      const success = aiReply.meta?.confidence > 0.7;
      aiReply.follow_up = generateFollowUp(
        userText, 
        userSession.personality.experienceLevel, 
        success
      );
    }

    // Lägg till personlig touch baserat på session
    if (userSession.personality.preferredName && Math.random() < 0.3) {
      aiReply.spoken = aiReply.spoken.replace(/^/, `${userSession.personality.preferredName}, `);
    }

    // Uppdatera session baserat på resultatet
    const topic = aiReply.cards?.summary || "generell fråga";
    const success = aiReply.meta?.confidence > 0.7;
    memory.addToHistory(userId, topic, success);

    // Reset uppmuntran-flagga om vi gav ett bra svar
    if (success) {
      userSession.interaction.needsEncouragement = false;
    }

    // Normalisera svaret
    aiReply = normalizeKeys(aiReply);

    res.json({ reply: aiReply });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      reply: {
        spoken: "Åh nej, jag fick lite tekniska problem! Men vi löser det här tillsammans. Kan du prova igen?",
        cards: { summary: "Systemfel - prova igen" },
        follow_up: "Är det något annat jag kan hjälpa dig med medan jag fixar det här?",
        meta: { confidence: 0.1 }
      }
    });
  }
};
