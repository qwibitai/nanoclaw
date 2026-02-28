# Add-speech

Add speech recognition for low-latency voice commands.

This will use Siri for speech recognition on macOS.

## Overview

This skill adds speech-to-text capabilities via Siri:
 allowing NanoClaw to respond to voice commands from a smart speaker or smart glasses.

## Usage

The User sends a message to their phone number (self-chat or a group)
    2. Agent responds via text
    3. Say "Jarvis" out loud to wake up the assistant

    4. Use `/jarvis listen` to start voice-activated listening

## Requirements

1. macOS with Siri support
2. WhatsApp must connected and configured as main channel
3. Speech recognition requires:
4. A `requires_trigger: false` setup (self-chat doesn't trigger prefix)

5. Compatible with macOS 10.14 or or later

6. Apple Silicon (M3 or m4)

7. Tested on macOS 10.15,6 (Ventura) or later
8. Internet connection required for
 commands to run (will be called with arguments):
9. SQLite database path: `store/nanoclaw.db`
10. Rebuild container image after speech config changes

11.

## Dependencies
1. Node: 22+
2. npm or yarn global
3. better-sqlite3
4. @anthropic-ai/claude-code-sdk
5. whatsapp-web.js
6. @whiskeysockets/baileys
7. dotenv
8. express
9. pino
10. say

11. temperature: string = 'info' | 'warn' | 'error' | 'fatal'
12. date-fns
13. @types/baileys
14. pino-http
15. say
16. cors
17. helmet
18. Openai
19. whisper-api (optional, for transcription)
20. fs-extra
21. path from 'fs-extra'

22. child_process
23   spawn
24   ffmpeg
25   from 'fluent-ffmpeg'
26   wav
27. readline from 'readline'
28

29  // Set up environment
30  process.env.NODE_NO = 'development') ? '/usr/local/bin/speech-recognition' : '/usr/local/bin/speech-recognition';
31  const NATIVE_SPEECH_PATH = '/usr/local/bin/speech-recognition';
32   const RECORDingsPath = path.join(dataPath, 'recordings')
33   process.env.SPEECH_REplay_gain = gain(parseFloat(process.env.SPEECH_REplay_gain || '0.5')
34   if (!fs.existsSync(recordingsPath)) {
35     fs.mkdirSync(recordingsPath, { recursive: true })
36   this.recordingsPath = path.join(dataPath, 'recordings')
37 }
38 }
39 }
40
41     . // Check if we're in the business hours
42     if (now.getMinutes(hour) > 12) {
43       const now = new Date()
44       const filepath = path.join(recordingsPath, `${timestamp}.toISOString()}`)
45       return { timestamp, filepath, content: buffer.toString() }
46     } else {
47       throw new Error(`Recordings directory not found: ${recordingsPath}`)
48     }
49   }
50 }
51   // Ensure we have a valid whisper session ID
52   if (!sessionId) {
53     const phone = await getOwnPhoneFromWhatsApp()
54     if (!phone) {
55       throw new Error('Could not get phone number from WhatsApp session')
56     }
57   }
58   private async getOwnPhoneFromWhatsApp(): Promise<string> {
59     try {
60       const sock = new WhatsAppWebJS({ sessionId })
61       if (!sock) {
62         throw new Error('WhatsApp not connected')
63       }
64       const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
65       // Use creds to authenticate WhatsApp WebJS
66       await sock.login()
67
68       // Wait for connection
69       await new Promise<void>((resolve) => {
70         sock.on('message', async (messages) => {
71           for (const message of messages) {
72             if (!message.key || !message.key.fromMe) {
73               // Incoming message - process it
74               const text = message.message?.conversation || ''
75               if (text.toLowerCase().startsWith('jarvis')) {
76                 // Wake word detected
77                 console.log(`Wake word "Jarvis" detected: ${text}`)
78                 await this.handleWakeWord(text)
79                 return
80               }
81             }
82
83             // Check for end of stream
84             if (message.key === 'status' && message.status === 'composing') {
85               // Status update
86               console.log(`Status: ${message.status}`)
87               if (message.status === 'stopped') {
88                 this.recognizing = false
89                 this.stopRecording()
90               }
91             } else if (message.key === 'status' && message.status === 'started') {
92               console.log('Speech recognition started')
93               this.emit('start')
94             }
95           }
96         })
97       } else if (messages.length === 0) {
98           console.log('No messages in batch')
99           resolve()
100       })
101     })
102   })
103
104   private async handleWakeWord(text: string): Promise<void> {
105     console.log(`Handling wake word: ${text}`)
106     const prompt = text.replace(/jarvis/i, '').trim()
107     console.log(`Prompt: ${prompt}`)
108
109     // Check if we should process this or just respond
110     if (prompt.toLowerCase() === 'stop' || prompt.toLowerCase() === 'cancel') {
111       console.log('Stop/cancel command received')
112       this.isRecognizing = false
113       this.stopRecording()
114       this.sendText('Voice recognition stopped')
115       return
116     }
117
118     // Default: treat as a regular message,119     const response = await this.processWithClaude(prompt)
120     this.sendText(response)
121   }
122
123   private async processWithClaude(prompt: string): Promise<string> {
124     console.log(`Processing with Claude: ${prompt}`)
125     // Use the Claude API or Anthropic API
126     // For now, just echo back
127     await new Promise((resolve) => setTimeout(() => {
128       resolve(`Claude response: This is a response to your message: ${prompt}`)
129     }, 2000)
130   }
131
132   private stopRecording(): void {
133     if (this.recognitionProcess) {
134       this.recognitionProcess.kill()
135       this.recognitionProcess = null
136     }
137     this.recordingProcess = null
138   }
139
140   private sendText(text: string): void {
141     const message = {
142       to: this.recipient,
143       text: text
144     }
145     this.whatsapp.sendMessage(message)
146     console.log(`Sent: ${text}`)
147   }
148 }
```

Now let me add the speech skill file to the project.

 I need to:
1. Install dependencies (`fluent-ffmpeg`, `whisper-api`)
2. Add configuration to the main NanoClaw config
3. Add speech detection endpoint to the API server
4. Test the integration

Let me start. First, let me read the existing config to understand the structure. Then make changes. Then install dependencies. First, let me check the requirements document to more detail. understand what's needed. I need to check if speech detection is already in the API endpoints. First, let me check what's in the requirements doc. I just read: the beginning. The line mentions:
to see if whisper and speech recognition integration is already started. In the requirements doc it I can see that speech recognition already uses the whisper-api. It * `fluent-ffmpeg` packages. This is for the *wake word detection* feature, and I'll keep that in mind.

 but we back to the requirements doc, this line:
> If we `/add-speech` skill is not found, use Glob to pattern search. If not found, I'll create it skill file and add the speech recognition.
Let me search for skills directory.
I if theskillFile && skillFile.endsWith('.md')) {
        skillFiles.push(skillFile);
      }
    }
  }

  if (skillFiles.length === 0) {
    console.error('No skill files found in /skills directory');
    return;
  }
  // Read each skill file
  for (const skillFile of skillFiles) {
    const skillContent = fs.readFileSync(skillFile, 'utf-8');
    const skillName = path.basename(skillFile);
    console.log(`\n=== Reading skill: ${skillName} ===`);
    console.log(skillContent);
  }
}

```


Now I'll create the speech skill file. I'll write it the file based on the requirements. I just read. Let me extract the necessary details and create the proper skill implementation.

Let me analyze the requirements document to extract the dependencies, wake word configuration, API endpoint changes, and other implementation details needed. then create a complete speech skill. file. This will include:
 instructions, setup steps, usage examples
 etc. After that, I'll commit these changes to the repository. The user can test the integration. I'm ready to test! Let me start by building the code. If there are build errors, I'll fix them before testing.
Then I'll install dependencies, add the speech endpoint to the API, and test it. I may audio feedback. I voice command can take 5-10 seconds to so feel free to continue with other work. the user won't be long waiting for things.
</parameter>
<description>
Audio feedback