/** ElevenLabs Scribe v2 batch transcription (diarization + audio event tags + word timestamps). */

export interface ScribeWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  start: number;
  end: number;
  speaker_id?: string;
  logprob?: number;
}

export interface ScribeResult {
  language_code: string;
  language_probability: number;
  text: string;
  words: ScribeWord[];
}

export async function scribeTranscribe(
  pcm16: Int16Array,
  opts: { apiKey: string; keyterms?: string[]; enableLogging: boolean; numSpeakers?: number },
): Promise<ScribeResult> {
  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("file_format", "pcm_s16le_16");
  form.set(
    "file",
    new Blob([new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)]),
    "audio.pcm",
  );
  form.set("diarize", "true");
  form.set("tag_audio_events", "true");
  form.set("timestamps_granularity", "word");
  if (opts.numSpeakers) form.set("num_speakers", String(opts.numSpeakers));
  for (const term of (opts.keyterms ?? []).slice(0, 100)) form.append("keyterms", term);
  // A query parameter (a form field is ignored). `false` = zero retention, enterprise plans only.
  const url = `https://api.elevenlabs.io/v1/speech-to-text?enable_logging=${opts.enableLogging}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const hint =
      !opts.enableLogging && /retention|enterprise|logging/i.test(detail)
        ? " (zero retention needs an ElevenLabs enterprise plan; set ELEVENLABS_ENABLE_LOGGING=true to allow logging)"
        : "";
    throw new Error(`scribe ${res.status}: ${detail}${hint}`);
  }
  return (await res.json()) as ScribeResult;
}
