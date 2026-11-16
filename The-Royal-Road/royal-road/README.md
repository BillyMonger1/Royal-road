# The Royal Road

A dream engine in three parts:

- **Android app**: tap, speak the dream, read it back, add pictures if you like, and send it. Speech is turned into text by your phone, for free. The dream is encrypted on the phone before it leaves.
- **Cloud relay**: one Supabase table holds the sealed dream until your computer collects it, then deletes it.
- **Windows app**: the oscilloscope. Each dream is analysed into threads (themes, archetypes, characters, places and symbols) and linked to every earlier dream that shares them. Nodes grow as they gather links. It checks the cloud when it opens, when you come back to its window, and every three minutes while it's open.

---

## 1. Get the two apps (about 15 minutes, once)

The apps are built for you in the cloud, free, by GitHub.

1. Make a free account at **github.com**.
2. Press **+ › New repository**, name it `royal-road`, choose **Private**, and press **Create repository**.
3. On the new page, click **uploading an existing file**. Drag in **everything inside this folder**, including the hidden `.github` folder, then press **Commit changes**.
   On Windows, `.github` may be hidden. In File Explorer, turn on **View › Show › Hidden items** before dragging.
4. Open the **Actions** tab and press **I understand… enable them** if asked. Choose **Build the apps**, then **Run workflow › Run workflow**.
5. Wait about 10 minutes for the green tick. Then open **Releases** on the right of the repository's main page. You'll find:
   - `The-Royal-Road-Setup.exe`: the Windows app
   - `The-Royal-Road-Portable.exe`: the same app, without installing
   - `The-Royal-Road.apk`: the Android app

The build runs the tests first, and stops if any of them fail.

### Install on Windows

Run `The-Royal-Road-Setup.exe`. It installs for your account, adds Start menu and desktop shortcuts, and **starts with Windows**. When it starts with Windows it opens quietly on the taskbar. You can switch that off in Setup (the gear, top right).

Windows may say "Windows protected your PC" because the app isn't signed. Click **More info › Run anyway**.

### Install on Android

Open the Releases page on your phone, or send yourself the `.apk`, and tap it. The first time, Android asks you to allow installs from your browser or Files app; allow it, then tap **Install**.

Later builds install over the top and keep your dreams, because each build is signed with the same key (`android/app/royal.keystore`).

## 2. Make the cloud relay (Supabase, free)

1. Sign up at **supabase.com** and create a new project. Any name, and any region near you.
2. In the project, open **SQL Editor**, paste the whole of `cloud/setup.sql`, and press **Run**.
3. Open **Project Settings › API Keys** and copy two things: the **Project URL** (`https://xxxx.supabase.co`) and the **publishable** (or **anon**) key.
4. In the Windows app open Setup, paste both into **Cloud relay**, and press **Test the relay**. It should say *Connected*.

The publishable key is meant to be public. It can only call the relay's functions, and only someone holding your pairing code can read or delete your dreams. Dream text and pictures are encrypted on the phone with a key the cloud never sees.

Free Supabase projects pause after a week with no activity. If sending starts failing after a long break, open supabase.com and press **Restore** on the project.

## 3. Pair the phone

1. Windows app › Setup › **Phone** shows a QR code.
2. On the phone, open Royal Road and tap the line at the bottom, which reads *Not paired…*. Then tap **Scan code** and point it at the screen.

No scanner? Press **Copy pairing link** on the computer, send it to yourself, and paste it in the phone's **Pair** screen.

Treat the pairing code like a password: anyone with it can add dreams to your journal. **Make a new code** in Setup replaces it. The phone then needs to pair again, and dreams sent with the old code still arrive for 60 days.

## 4. Connect services (optional)

All of these are in Setup. Each key is encrypted with your Windows account and only ever sent to the service it belongs to.

**AI.** It names each dream's threads and powers Chat. Without it, the built-in analyzer still files and links every dream.

| Provider | What to paste |
|---|---|
| Claude (Anthropic) | An API key from console.anthropic.com. The model name is filled in for you. |
| OpenAI | An API key from platform.openai.com, and a model name from your account. |
| Ollama on this computer | Just a model name, e.g. `llama3.1`. Free and private. Install it from ollama.com and run `ollama pull llama3.1`. |
| Other OpenAI-compatible | The service's address (ending `/v1`), its key and model name. |

**Transcription (the Windows app).** It turns what you say into text when you press **Transcribe**. Without a service, you type dreams on the computer. The phone needs no service, because it uses Android's own speech recognition.

| Service | What to paste |
|---|---|
| Groq | A free key from console.groq.com. The fastest and cheapest. |
| OpenAI | Leave the key empty to reuse the OpenAI AI key. |
| Other | Any OpenAI-compatible speech-to-text service. |

**Pictures.** The AI can create a picture for a dream. Choose **OpenAI** (the key can be shared with the AI section; the model is `gpt-image-2` unless you change it) or another compatible service. Uploading your own pictures needs nothing.

---

## Using it

**Phone**
- Tap the button and speak. The little screen inside moves when it hears you. Pauses are fine, because it keeps listening until you tap again.
- Read it back, fix anything, add pictures from your gallery, then **Send to desktop**.
- With no signal, dreams wait on the phone and send themselves later.
- **Past dreams** shows each one as *Waiting to send*, *In the cloud* or *On your desktop*. **Remove dreams your desktop already has** frees space and never removes anything not yet collected.
- The Back button steps back through the app.

**Windows app: adding dreams**
- **Transcribe** (top) opens a new dream and starts recording, while the little screen draws your voice. Press it again to stop; the words appear a moment later. You can also type, or do both.
- **Add pictures** before filing, or drop or paste pictures onto any dream later.
- **File this dream** analyses it, links it and puts it on the screen.

**Windows app: the journal**
- **Search** at the top of the journal matches names, words and threads.
- The **pencil** beside a dream's name, or **Edit**, lets you rename it, change the night or fix the words. A name you give is kept even when the dream is analysed again. Changed words are analysed again.
- **Threads**: × removes one from that dream, and **Add a thread** adds one. Pick an existing name and the dreams link up.
- **Pictures**: add your own or **Create one with AI**, which suggests a description you can edit. Click a picture to see it large, and use the arrow keys to move between them.
- **Chat** talks about the open dream and the whole journal.

**Windows app: the screen**
- Drag to turn it, right-drag or Shift-drag to move it, and scroll to zoom where you point. Double-click straightens it.
- Click a dream or thread to open it, or click empty space to go back.
- The gold trace along the bottom is your journal over time: one pulse per dream.
- The buttons below show and hide each kind of node. The knobs set **Scale**, **Intensity** and **Depth**.

**Keeping your dreams safe**
- **Save a backup** (Setup) writes one file with every dream and picture. **Restore a backup** brings it all back.
- **Export to Obsidian** writes a note for every dream and every thread, linked with `[[ ]]`, into a folder you choose, such as your vault. Obsidian's graph view then shows the same web.
- Everything lives in `%APPDATA%\The Royal Road`.

## How dreams are linked

Each dream becomes a set of threads, each with a weight from 0.15 to 1 for how central it is. Names are matched loosely, so *The Dragons* and *dragon* are one node. The AI is shown the journal's existing threads and asked to reuse them, so recurring material links up instead of splitting.

- **Node size** grows with the square root of a node's total link weight.
- **Shares the most with** ranks other dreams by the threads they share. A rare shared thread counts for more than one that appears everywhere.
- The journal stores only dreams, threads and weighted links. Sizes and similarities are worked out when the app opens.

## Files

```
desktop/            the Windows app (Electron)
  main.js             window, files, settings, AI, transcription, pictures, Obsidian export
  ui/engine.js        analysis and linking
  ui/scope.js         the oscilloscope screen
  ui/dictation.js     recording and transcription
  ui/relay.js         encryption and cloud calls (shared with the phone)
android/            the Android app: a native shell with speech, code scanner and picture picker
mobile/             the phone interface (built into the Android app; also works as a web app)
cloud/setup.sql     the relay (paste into Supabase)
tools/test.js       tests: node tools/test.js
.github/workflows/  the cloud build
```
