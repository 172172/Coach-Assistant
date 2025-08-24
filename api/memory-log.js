import { q } from "./db.js";
export default async function handler(req, res) {
  try {
    const { conversation_id, role, content, modality, payload } = req.body || {};
    const question = (role === 'user') ? content : '';  // Sätt till content för user-frågor, annars tom för att undvika NULL
    const asked_at = new Date().toISOString();  // Lägg till aktuell tid som ISO-sträng (PostgreSQL hanterar det som timestamp)
    await q(
      `insert into messages (conversation_id, role, content, modality, raw, question, asked_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [conversation_id, role, content, modality || 'voice', payload ? JSON.stringify(payload) : null, question, asked_at]
    );
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
}
