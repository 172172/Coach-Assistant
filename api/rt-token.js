// Vercel Edge Function (eller Node) – ger Realtime-offer-URL + client_secret.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const client_secret = process.env.OPENAI_API_KEY; // server-säker

  // Hård policy: vänta på tool_result
  const instructions = `Du är Coach Assistant för Linje 65.\nREGLER:\n- Använd verktyget search_manual för alla sakfrågor om linjer/maskiner/procedurer.\n- Vänta alltid på tool_result innan du svarar.\n- Om manual_context saknas: säg "Oklar information – behöver uppdaterad manual."\n- Var kort och saklig. Svara på svenska.`;

  return new Response(JSON.stringify({ url, client_secret, instructions }), {
    headers: { 'Content-Type':'application/json' }
  });
}
