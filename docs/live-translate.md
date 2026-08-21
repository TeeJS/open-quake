# Live Translate

Real-time speech **translation captions on the panel**. Point the mic at a conversation, a film, or
a meeting and watch it translated into your language, live — word by word, as it's spoken, not after
a pause. Add a **Live Translate** page in the [editor](editor.md) and tap the mic (or the knob, or a
[hotkey](#hotkey)).

Two providers sit behind the page:

| Provider | Captions | Needs | Cost |
|---|---|---|---|
| **Soniox** (recommended) | Word-by-word, streaming | An API key | ~$0.18/hr while translating |
| **AI translate** | Per phrase, a beat behind | Your own AI key **+** a local Whisper STT server | e.g. DeepSeek ≈ $0.10/hr |

## Soniox (recommended)

1. Sign up at [soniox.com](https://soniox.com) and create an API key (there's a free trial credit).
2. In the Live Translate page's editor settings: **Provider = Soniox**, paste the **API key**, and set
   a **target language** (e.g. `en`, `es`, `de` — [browse codes](https://soniox.com/docs/stt/concepts/supported-languages)).
3. Optionally set a **source hint** (the language you expect) — it removes the couple-second warm-up
   Soniox otherwise spends auto-detecting the language.

Your real key never reaches the panel page: open-quake mints a short-lived **temporary key** and the
page authenticates with that. The key is stored encrypted at rest.

## AI translate — bring your own key

Uses your **Settings → TTS/STT** Whisper server to transcribe each spoken phrase locally, then
translates it through any **OpenAI-compatible** chat endpoint — DeepSeek, OpenAI, a local
Open WebUI / Ollama, anything with the same API — with recent lines as context (so pronouns
resolve across sentences). Captions arrive per phrase, a beat or two behind speech.

1. Your STT server (e.g. [tts-sst](https://github.com/TeeJS/tts-stt-windows)) must run a
   **multilingual Whisper model** — the English-only Parakeet default can't transcribe foreign speech.
2. In the page's editor settings: **Provider = AI translate**, pick an **endpoint preset**
   (DeepSeek / OpenAI / custom URL), paste the **API key**, confirm the **model**
   (`deepseek-v4-flash` is fast and costs roughly $0.10/hr of speech), set the **target language**.
3. The on-panel **Settings** gains a **voice pause tolerance** control — how long a mid-sentence
   pause can be before the phrase is sent for translation.

The key is stored encrypted and used only from the main process — it never reaches the panel page.

## Extras

- **Save to file** — toggle it on to write the translation to a text file; choose the folder in the
  editor (default `Documents\OpenQuake Translations`).
- **Microphone** — pick the capture device in the page's editor or the on-panel Settings.
- <a id="hotkey"></a>**Toggle hotkey** — set a global key combo in the editor that starts/stops
  translation from any app (it switches to the page and toggles the mic). The **knob** does the same
  when the page is on-screen.
