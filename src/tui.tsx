import React, { useState, useCallback, useEffect } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';

import { ASSISTANT_NAME } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  isAssistant: boolean;
}

export interface TuiCallbacks {
  onSendMessage: (content: string) => Promise<string | null>;
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function formatMessage(sender: string, content: string, time: string, isAssistant: boolean): string {
  const color = isAssistant ? CYAN : GREEN;
  const header = `${color}${BOLD}${sender}${RESET} ${DIM}${time}${RESET}`;
  const indented = content
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `${header}\n${indented}\n\n`;
}

// ─── TextInput Component (inline, no external dep) ──────────────────────────

function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  placeholder?: string;
}) {
  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    // Ignore control characters
    if (key.ctrl || key.meta || key.escape) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (key.tab) return;

    if (input) {
      onChange(value + input);
    }
  });

  return (
    <Text>
      {value.length > 0 ? (
        <Text>{value}</Text>
      ) : (
        <Text dimColor>{placeholder || ''}</Text>
      )}
      <Text inverse> </Text>
    </Text>
  );
}

// ─── Spinner Component ───────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color="yellow">
      {SPINNER_FRAMES[frame]} {label}
    </Text>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

function App({ callbacks }: { callbacks: TuiCallbacks }) {
  const { exit } = useApp();
  const { write } = useStdout();
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isProcessing) return;

      setInputValue('');
      setIsProcessing(true);

      const time = () =>
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });

      // Write messages via Ink's write() so it correctly manages cursor
      write(formatMessage('You', trimmed, time(), false));

      try {
        const response = await callbacks.onSendMessage(trimmed);
        if (response) {
          write(formatMessage(ASSISTANT_NAME, response, time(), true));
        }
      } catch (err) {
        write(formatMessage('System', `Error: ${err instanceof Error ? err.message : String(err)}`, time(), false));
      } finally {
        setIsProcessing(false);
      }
    },
    [isProcessing, callbacks, write],
  );

  useInput((_input, key) => {
    if (key.escape) {
      exit();
    }
  });

  const cols = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" marginTop={1}>
      {isProcessing ? (
        <Spinner label={`${ASSISTANT_NAME} is thinking...`} />
      ) : (
        <Text dimColor>
          Press Enter to send · Esc to exit
        </Text>
      )}
      <Text>{' '}</Text>
      <Text color="gray">{'─'.repeat(cols)}</Text>
      <Box paddingX={1}>
        <Text color={isProcessing ? 'gray' : 'green'} bold>
          {'❯ '}
        </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      </Box>
      <Text color="gray">{'─'.repeat(cols)}</Text>
    </Box>
  );
}

// ─── Render entry ────────────────────────────────────────────────────────────

export function startTui(callbacks: TuiCallbacks): void {
  const title = `NanoClaw Terminal · ${ASSISTANT_NAME}`;
  console.log(`\n${CYAN}${BOLD}  ${title}${RESET}`);
  console.log(`${DIM}  Send a message to start chatting with ${ASSISTANT_NAME}${RESET}\n`);
  render(<App callbacks={callbacks} />);
}
