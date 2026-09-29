"use client";

import { useEffect, useState } from "react";

/**
 * Speaks the assistant's own opening greeting aloud via the browser's
 * native SpeechSynthesis API (the Web Speech API's synthesis half) —
 * the same "free, browser-built-in, no server round-trip, no cost"
 * mechanism already used for voice INPUT (use-voice-recorder.ts).
 *
 * BROWSER SUPPORT, CHECKED (not assumed) BEFORE BUILDING THIS: unlike
 * SpeechRecognition (Chrome/Edge only), SpeechSynthesis has broad,
 * long-standing support across Chrome, Edge, Firefox, AND Safari —
 * every `speak()` call below still feature-detects `window.speechSynthesis`
 * regardless, and is a silent no-op (never an error) wherever it's
 * missing, exactly like every other progressive-enhancement voice
 * feature in this app.
 *
 * TWO CALLERS NOW, ONE MECHANISM: the automatic opening greeting, and a
 * manual per-message "speak" button on the assistant's own plain-text
 * replies (assistant-launcher.tsx's own AssistantBubble). Both go
 * through the exact same `speak()` below — there is still only one
 * speechSynthesis mechanism in this app, never a second one built for
 * the per-message case. `speak()` itself has NO opinion on whether the
 * mute toggle should apply — that decision belongs to each CALLER: the
 * automatic greeting checks `voiceEnabled` itself before calling
 * speak() at all (see greetAnew() in assistant-launcher.tsx), while the
 * manual per-message button deliberately does not, matching this
 * feature's own explicit rule that clicking "speak" on a specific
 * message is a direct request that must work regardless of the
 * separate auto-greeting mute setting. This hook still has no idea what
 * a lead, a task, or a deal value even is — it only ever receives a
 * plain string to speak, decided entirely by its callers. Reading a
 * phone number or a confirmation CARD aloud automatically remains
 * deliberately out of scope; only plain-text assistant messages ever
 * get a speak button at all.
 *
 * NO DATABASE CHANGE OF ANY KIND. The mute/voice preference is a
 * per-browser UI nicety, not app data — persisted in localStorage,
 * the exact same mechanism and the exact same hydration-safe pattern
 * (read back in an effect, never during the initial render, since
 * localStorage doesn't exist during SSR) AppShell's own sidebar-collapse
 * preference already uses. A user who clears storage or opens a
 * different browser simply gets the default again — never a schema
 * change to avoid that.
 */

const VOICE_ENABLED_STORAGE_KEY = "pipeway-assistant-voice-enabled";

export function useGreetingVoice() {
  // Defaults to ON: muting is the opt-out, not the opt-in, so the
  // greeting is actually heard at least once before anyone has to go
  // find the toggle — see the header's own speaker button.
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VOICE_ENABLED_STORAGE_KEY);
      if (stored !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- window/localStorage don't exist during SSR; syncing a persisted UI preference once on mount is the same hydration-safe pattern AppShell's own sidebar-collapse preference already uses
        setVoiceEnabled(stored === "true");
      }
    } catch {
      // Private mode / disabled storage — stays enabled-by-default,
      // simply won't persist across reloads.
    }
  }, []);

  function toggleVoiceEnabled() {
    setVoiceEnabled((current) => {
      const next = !current;
      if (!next && typeof window !== "undefined" && "speechSynthesis" in window) {
        // Muting mid-sentence should actually go quiet immediately,
        // not just suppress the NEXT greeting.
        window.speechSynthesis.cancel();
      }
      try {
        window.localStorage.setItem(VOICE_ENABLED_STORAGE_KEY, String(next));
      } catch {
        // Preference just won't persist across reloads — not worth
        // surfacing an error for a non-critical UI nicety.
      }
      return next;
    });
  }

  /**
   * Speaks `text` aloud immediately — ALWAYS, regardless of
   * `voiceEnabled`. Whether the mute preference should suppress a given
   * call is each CALLER's own decision (see this function's own header
   * above); baking it in here would make the manual per-message button
   * un-mutable-around, which is the opposite of what that button is for.
   *
   * CALL THIS DIRECTLY FROM THE SAME CLICK HANDLER that opens the panel,
   * starts a new chat, or clicks a message's own speak button — never
   * from a useEffect reacting to state a render later. Browsers gate
   * audio/speech playback on a direct user gesture; calling speak()
   * synchronously inside the onClick that already fired is what keeps
   * this inside that gesture. A no-op when the API isn't available in
   * this browser. Cancels whatever is currently speaking first, so two
   * messages can never talk over each other.
   */
  function speak(text: string) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    // Never let a fast double-open (or New chat right after opening)
    // stack two greetings talking over each other.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  /** Lets a caller stop playback WITHOUT starting anything new — the
   *  per-message speak button's own "click again to stop" behavior
   *  (assistant-launcher.tsx's handleSpeakMessage) needs this; simply
   *  calling speak() again would restart the same text instead. Kept
   *  here rather than having callers reach into window.speechSynthesis
   *  directly, so this hook stays the one place that touches it. */
  function stopSpeaking() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }

  return { voiceEnabled, toggleVoiceEnabled, isSpeaking, speak, stopSpeaking };
}
