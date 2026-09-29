"use client";

import { useRef, useState } from "react";

/**
 * Voice input's entire browser-side implementation — the browser's own
 * native SpeechRecognition API (the Web Speech API), running ENTIRELY
 * client-side. No audio is ever recorded, encoded, or sent to any
 * server for this; the transcription mechanism itself is UNCHANGED from
 * the previous phase. What changed here is everything AROUND it: a
 * live, audio-reactive waveform while recording, real-time interim text
 * as the user is still speaking, and a review-before-send step once
 * they stop — nothing reaches the chat until a human explicitly
 * confirms it.
 *
 * FOUR STATES, one more than before:
 *   idle       -> nothing happening.
 *   requesting -> the mic permission prompt is up.
 *   recording  -> actively listening; `liveText` updates continuously
 *                 (every final segment recognized so far, plus whatever
 *                 is still being recognized) and the waveform reacts to
 *                 real input level.
 *   reviewing  -> recording has stopped (the user asked it to, or the
 *                 engine ended the session on its own); `liveText` now
 *                 holds the settled transcript, still fully editable —
 *                 it's the SAME state a review textarea is bound to, so
 *                 editing it there IS editing what confirmReview() sends.
 *
 * WHY THIS HOOK ACQUIRES ITS OWN MIC STREAM (`getUserMedia`), SEPARATELY
 * FROM SpeechRecognition's own internal capture: SpeechRecognition is a
 * black box — it never exposes an audio level, a waveform, or anything
 * else about the raw signal, only recognized text and status events.
 * There is no way to build a real, audio-reactive visualization from it
 * alone. So this hook asks for the microphone itself too, purely to
 * hand a live AnalyserNode to the waveform component — the two
 * consumers (this hook's own stream, and whatever SpeechRecognition
 * does internally) run side by side against the same physical device,
 * which every supporting browser allows. Calling OUR OWN getUserMedia
 * FIRST is also what shows the one permission prompt: by the time
 * `recognition.start()` runs a moment later, the origin already has
 * microphone permission, so SpeechRecognition's own internal request
 * reuses it silently rather than prompting a second time.
 */

export type VoiceRecorderState = "idle" | "requesting" | "recording" | "reviewing";

type UseVoiceRecorderOptions = {
  onError: (message: string) => void;
};

/** A minimal, hand-written shape of the two real, still-non-standard
 *  constructor names shipping browsers actually expose — TypeScript's
 *  own DOM lib does not declare this API (it isn't a ratified,
 *  cross-browser standard yet), so this is declared locally rather than
 *  assumed to exist, and never as a `declare global` (avoids ever
 *  colliding with a future official lib.dom.d.ts definition). */
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** A plain support check. Deliberately NOT surfaced as component state
 *  to pre-emptively disable the mic button: a browser capability like
 *  this can only be trusted once actually running client-side, and
 *  computing it during render would either read `window` during SSR
 *  (a hard crash on the server) or disagree between the server's render
 *  and the client's hydration render (a mismatch warning) depending on
 *  how it's guarded. The mic button stays enabled either way and
 *  surfaces a friendly error the moment `start()` is actually clicked
 *  in an unsupported browser — see `start()` below. */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== undefined;
}

const UNSUPPORTED_MESSAGE = "Voice input isn't supported in this browser — try Chrome or Edge, or just type your message.";

function getAudioContextConstructor(): typeof AudioContext | undefined {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function useVoiceRecorder({ onError }: UseVoiceRecorderOptions) {
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [liveText, setLiveText] = useState("");
  // The live node the Waveform component reads frequency data from —
  // null whenever nothing is being recorded, or if the Web Audio API
  // itself isn't available (the waveform is a visual enhancement, never
  // a requirement for transcription: recognition still proceeds without
  // one rather than failing the whole feature over it).
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // Mirrors `liveText` synchronously (state updates are not readable
  // until the next render) — settle() below needs the CURRENT value the
  // instant recognition ends, not whatever the last render captured.
  const liveTextRef = useRef("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // Guards settle() from running twice for the same session — stop(),
  // cancel(), and the engine's own onend/onerror can all race to call it.
  const settledRef = useRef(false);

  function setLiveTextBoth(text: string) {
    liveTextRef.current = text;
    setLiveText(text);
  }

  function teardownAudio() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    setAnalyser(null);
  }

  /** Called once, whenever a recording session ends for any reason —
   *  a manual stop, the engine finalizing on its own, or a fatal error.
   *  `hadRealSession` distinguishes "recognition genuinely ran and we
   *  should look at what it produced" from "recognition never really
   *  started" (e.g. permission denied) — only the former can fall back
   *  to a "didn't catch any speech" message rather than a permission
   *  one. */
  function settle(hadRealSession: boolean) {
    if (settledRef.current) return;
    settledRef.current = true;
    teardownAudio();
    const text = liveTextRef.current.trim();
    if (hadRealSession && text) {
      setState("reviewing");
    } else {
      setState("idle");
      setLiveTextBoth("");
      if (hadRealSession) onError("I didn't catch any speech. Please try again.");
    }
  }

  async function start() {
    if (state !== "idle") return;
    settledRef.current = false;
    setLiveTextBoth("");
    setState("requesting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState("idle");
      onError("Microphone access was denied or unavailable. You can still type or paste your request.");
      return;
    }

    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      stream.getTracks().forEach((track) => track.stop());
      setState("idle");
      onError(UNSUPPORTED_MESSAGE);
      return;
    }

    streamRef.current = stream;
    try {
      const AudioContextCtor = getAudioContextConstructor();
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 128;
        // Livelier than the default (0.8) — this is what makes the
        // waveform read as genuinely reactive rather than a smoothed-out
        // generic loop; see this file's own header.
        analyserNode.smoothingTimeConstant = 0.55;
        source.connect(analyserNode);
        audioContextRef.current = audioContext;
        setAnalyser(analyserNode);
      }
    } catch {
      // Web Audio being unavailable never blocks recognition itself —
      // see this function's own comment above.
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // Every result event carries the WHOLE results list so far, each
    // entry either settled (`isFinal`) or still being recognized. This
    // rebuilds "everything finalized, plus whatever's still in
    // progress" on every event — the exact string the review textarea
    // shows, updating live while the user is still speaking (never just
    // once they stop).
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }
      setLiveTextBoth(`${finalText}${interimText}`.trim());
    };

    recognition.onerror = (event) => {
      // Only a genuinely fatal error is handled here. Everything else
      // (no-speech, aborted, network hiccups) is always followed by the
      // engine's own onend, which settles state uniformly — handling it
      // twice would just risk two different outcomes racing.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        settle(false);
        onError("Microphone access was denied or unavailable. You can still type or paste your request.");
      }
    };

    recognition.onend = () => {
      settle(true);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setState("recording");
    } catch {
      teardownAudio();
      setState("idle");
      onError("Voice input couldn't start just now. Please try again, or type your request instead.");
    }
  }

  /** Stops listening and moves to review — the normal "I'm done
   *  talking" action. Whatever's been recognized so far (settled by the
   *  engine's own onend, which fires moments after stop()) becomes the
   *  editable review text. */
  function stop() {
    if (state !== "recording") return;
    recognitionRef.current?.stop();
  }

  /** Abandons the recording entirely — never reaches "reviewing", never
   *  shows anything as if it were about to be sent. `abort()` (not
   *  `stop()`) discards in-flight audio rather than trying to finalize
   *  a result from it. */
  function cancel() {
    if (state !== "recording") return;
    settledRef.current = true;
    recognitionRef.current?.abort();
    teardownAudio();
    setState("idle");
    setLiveTextBoth("");
  }

  /** The review textarea is a controlled input directly over `liveText`
   *  — editing there really does change what confirmReview() below will
   *  send, since it's the same value. */
  function updateLiveText(text: string) {
    setLiveTextBoth(text);
  }

  function discardReview() {
    setState("idle");
    setLiveTextBoth("");
  }

  /** Returns exactly what's currently in the review box (including any
   *  hand-edit) for the caller to send — never re-reads anything from
   *  the recognizer, which has already fully ended by this point. */
  function confirmReview(): string {
    const text = liveTextRef.current;
    setState("idle");
    setLiveTextBoth("");
    return text;
  }

  return { state, liveText, analyser, start, stop, cancel, updateLiveText, discardReview, confirmReview };
}
