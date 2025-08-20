// Edge function – ger URL + client_secret + grundinstruktioner
export const config = { runtime: 'edge' };

export default async function handler() {
  const url = 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const client_secret = process.env.OPENAI_API_KEY1; // OBS: använder OPENAI_API_KEY1

  const instructions = `Du är Coach Assistant för burklinje 65.`; // detaljpolicy sätts i session.update

  return new Response(JSON.stringify({ url, client_secret, instructions }), {
    headers:{ 'Content-Type':'application/json' }
  });
}
