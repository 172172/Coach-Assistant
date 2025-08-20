// client.js – Hanterar WebSocket för Realtime API och tool calls
// Lägg till i index.html via <script src="/client.js"></script>

let ws = null;
let sessionId = null;

async function connectRealtime() {
  const response = await fetch('/api/rt-token.js');
  const { token, model } = await response.json();
  if (!token) {
    console.error('Failed to get token');
    document.getElementById('status').innerText = 'Misslyckades att hämta token';
    return;
  }

  ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, ['realtime', token]);
  ws.onopen = () => {
    console.log('WebSocket connected');
    document.getElementById('status').innerText = 'Ansluten';
    ws.send(JSON.stringify({
      type: 'session.update',
      session: { turn_detection: { type: 'server_vad' } }
    }));
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    console.log('WebSocket event:', data.type, data);

    if (data.type === 'input_audio_buffer.speech_stopped') {
      // Final transkript mottaget – prova direkt search_manual som workaround
      const transcript = data.transcript?.trim();
      if (transcript && !/^(hej|hello|tja)$/i.test(transcript)) {
        const searchResult = await fetch('/api/search-manual.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: transcript, k: 8, minSim: 0.35, isVoice: true })
        }).then(res => res.json());
        if (searchResult.ok) {
          ws.send(JSON.stringify({
            type: 'input_text',
            text: `Kontext: ${JSON.stringify(searchResult.snippets)}\nFråga: ${transcript}`
          }));
        }
      }
    }

    if (data.type === 'conversation.item.created' && data.item?.type === 'function_call') {
      const { name, parameters, id: toolCallId } = data.item;
      if (name === 'search_manual') {
        const params = JSON.parse(parameters);
        params.isVoice = true; // Markera som voice-input
        console.log('Executing tool call:', params);
        const searchResult = await fetch('/api/search-manual.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params)
        }).then(res => res.json());
        if (searchResult.ok) {
          ws.send(JSON.stringify({
            type: 'response.create',
            response: {
              type: 'tool_result',
              tool_call_id: toolCallId,
              output: JSON.stringify(searchResult.snippets)
            }
          }));
        } else {
          console.error('Tool call failed:', searchResult.error);
        }
      }
    }

    if (data.type === 'response.text.delta') {
      document.getElementById('output').innerText += data.delta;
    }
    if (data.type === 'response.audio.delta') {
      // Hantera audio output (t.ex. via AudioContext)
      console.log('Audio delta received');
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    document.getElementById('status').innerText = 'Inte ansluten';
    ws = null;
  };
}

function disconnectRealtime() {
  if (ws) {
    ws.close();
    ws = null;
    document.getElementById('status').innerText = 'Inte ansluten';
  }
}

function sendTextInput() {
  const input = document.getElementById('text-input').value.trim();
  if (ws && input) {
    ws.send(JSON.stringify({
      type: 'input_text',
      text: input
    }));
    document.getElementById('text-input').value = '';
  }
}

document.getElementById('connect-btn').addEventListener('click', connectRealtime);
document.getElementById('disconnect-btn').addEventListener('click', disconnectRealtime);
document.getElementById('send-btn').addEventListener('click', sendTextInput);

// Hantera audio-inmatning (t.ex. via getUserMedia)
let mediaRecorder = null;
async function startAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (event) => {
    if (ws && event.data.size > 0) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: event.data // Konvertera till base64 eller binary om krävs
      }));
    }
  };
  mediaRecorder.start();
}

document.getElementById('connect-btn').addEventListener('click', startAudio);
