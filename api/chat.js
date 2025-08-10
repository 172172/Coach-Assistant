// Förbättrad Coach Assistant - Digital kollega för Linje65

const { getOpenAIResponse } = require('./memory');
const { searchKnowledge } = require('./db');

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

FORMAT:
Svara alltid i JSON med denna struktur:
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
}`;

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
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId, history = [] } = req.body;
    
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    // Hämta/uppdatera användarsession
    const userSession = memory.getSession(userId);
    userSession.interaction.totalQuestions++;

    // PERSONLIGHETSANALYS (enkla heuristiker)
    if (userSession.interaction.totalQuestions <= 3) {
      // Första interaktionerna - lär känna användaren
      if (/namn|heter|kallas/i.test(message)) {
        const nameMatch = message.match(/(?:namn|heter|kallas)\s+(\w+)/i);
        if (nameMatch) {
          userSession.personality.preferredName = nameMatch[1];
        }
      }
      
      if (/nybörjare|ny|börjat nyligen/i.test(message)) {
        userSession.personality.experienceLevel = 'beginner';
      } else if (/erfaren|jobbat länge|expert/i.test(message)) {
        userSession.personality.experienceLevel = 'expert';
      }
      
      if (/kort|snabbt|bara svaret/i.test(message)) {
        userSession.interaction.preferredResponseLength = 'short';
      } else if (/detaljer|förklara ordentligt|grundligt/i.test(message)) {
        userSession.interaction.preferredResponseLength = 'detailed';
      }
    }

    // Sök kunskap i databasen
    const searchResults = await searchKnowledge(message);
    
    // Generera personlig systemprompt
    const systemPrompt = generateSystemPrompt(userSession, { searchResults });
    
    // Skapa konversationshistorik med personlighet
    let conversationHistory = `${systemPrompt}\n\nKONVERSATION:\n`;
    
    // Lägg till tidigare meddelanden med kontext
    history.slice(-6).forEach(h => {
      conversationHistory += `Användare: ${h.user}\nAlex: ${JSON.stringify(h.assistant)}\n`;
    });
    
    conversationHistory += `Användare: ${message}\nAlex: `;

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
        message, 
        userSession.personality.experienceLevel, 
        success
      );
    }

    // Uppdatera session baserat på resultatet
    const topic = aiReply.cards?.summary || "generell fråga";
    const success = aiReply.meta?.confidence > 0.7;
    memory.addToHistory(userId, topic, success);

    // Reset uppmuntran-flagga om vi gav ett bra svar
    if (success) {
      userSession.interaction.needsEncouragement = false;
    }

    res.json({ reply: aiReply });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      reply: {
        spoken: "Åh nej, jag fick lite tekniska problem! Men vi löser det här tillsammans. Kan du prova igen?",
        cards: { summary: "Systemfel - prova igen" },
        follow_up: "Är det något annat jag kan hjälpa dig med medan jag fixar det här?"
      }
    });
  }
};
