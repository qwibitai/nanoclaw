// Audio transcription tool — converts voice messages to text using Groq Whisper.

/**
 * Transcribe audio from a Telegram voice message or file URL.
 * Uses Groq's whisper-large-v3-turbo model (free tier, pre-approved).
 * Returns transcript or error message.
 */
export async function transcribeAudio(
  audioUrl: string,
  telegramFileId?: string,
): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return 'Error: GROQ_API_KEY not configured. Set it in environment before using audio transcription.';
  }

  try {
    // If telegramFileId provided, construct Telegram file download URL
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    let downloadUrl = audioUrl;

    if (telegramFileId && telegramToken) {
      // Get file path from Telegram API
      const fileInfoUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${telegramFileId}`;
      const fileInfoResp = await fetch(fileInfoUrl);
      if (!fileInfoResp.ok) {
        return `Error: Could not fetch Telegram file info (${fileInfoResp.status})`;
      }
      const fileInfo = await fileInfoResp.json() as { ok: boolean; result?: { file_path: string } };
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        return 'Error: Telegram file path not found';
      }
      downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileInfo.result.file_path}`;
    }

    // Download audio file
    const audioResp = await fetch(downloadUrl);
    if (!audioResp.ok) {
      return `Error: Could not download audio file (${audioResp.status})`;
    }
    const audioBuffer = await audioResp.arrayBuffer();

    // Call Groq Whisper API
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en'); // Can be auto-detected if not specified

    const transcribeResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
      },
      body: formData,
    });

    if (!transcribeResp.ok) {
      const error = await transcribeResp.text();
      return `Error: Groq API failed (${transcribeResp.status}): ${error}`;
    }

    const result = await transcribeResp.json() as { text?: string };
    if (!result.text) {
      return 'Error: Groq returned no transcript text';
    }

    return result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Transcription failed: ${message}`;
  }
}
