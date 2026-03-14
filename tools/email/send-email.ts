#!/usr/bin/env npx tsx
/**
 * Send Email Tool for NanoClaw
 * Usage: npx tsx tools/email/send-email.ts --to "email" --subject "subject" --body "body" [--html]
 *        [--template "path"] [--vars '{"key":"value"}'] [--attachments "a.pdf,b.pdf"]
 *        [--inline-images "hero.jpg,logo.png"]
 *
 * Environment variables (set in container .env or passed via secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import { createTransport } from 'nodemailer';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { checkAndIncrementSendCount } from '../shared/send-rate-limit.js';

interface EmailArgs {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  template?: string;
  vars?: string;
  attachments?: string;
  'inline-images'?: string;
}

function parseArgs(): EmailArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--html') {
      result.html = true;
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  // When --template is used, --body is not required
  if (!result.to || !result.subject || (!result.body && !result.template)) {
    console.error('Usage: send-email --to "email" --subject "subject" --body "body" [--html] [--cc "email"] [--bcc "email"] [--replyTo "email"] [--template "path"] [--vars \'{"key":"val"}\'] [--attachments "a.pdf,b.pdf"] [--inline-images "img1.jpg,img2.png"]');
    process.exit(1);
  }

  return result as unknown as EmailArgs;
}

function loadTemplate(templatePath: string, vars?: string): string {
  let html = readFileSync(templatePath, 'utf-8');

  if (vars) {
    const variables: Record<string, string> = JSON.parse(vars);
    for (const [key, value] of Object.entries(variables)) {
      // Replace all occurrences of {{key}} with value
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      html = html.replace(pattern, value);
    }
  }

  // Check for any unfilled template variables remaining after substitution
  const unfilled = html.match(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g);
  if (unfilled) {
    const unique = [...new Set(unfilled)];
    console.error(JSON.stringify({
      status: 'error',
      error: `Template has unfilled variables: ${unique.join(', ')}`,
      missing: unique,
    }));
    process.exit(1);
  }

  return html;
}

function buildAttachments(attachmentPaths?: string, inlineImagePaths?: string) {
  const attachments: Array<{ filename: string; path: string; cid?: string }> = [];

  if (attachmentPaths) {
    for (const filePath of attachmentPaths.split(',').map(p => p.trim()).filter(Boolean)) {
      attachments.push({
        filename: basename(filePath),
        path: filePath,
      });
    }
  }

  if (inlineImagePaths) {
    for (const filePath of inlineImagePaths.split(',').map(p => p.trim()).filter(Boolean)) {
      const filename = basename(filePath);
      attachments.push({
        filename,
        path: filePath,
        cid: filename,
      });
    }
  }

  return attachments;
}

async function main() {
  const args = parseArgs();

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing SMTP configuration. Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.',
    }));
    process.exit(1);
  }

  const transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const mailOptions: Record<string, unknown> = {
    from,
    to: args.to,
    subject: args.subject,
  };

  // Template mode: load HTML from file and apply variable substitution
  if (args.template) {
    mailOptions.html = loadTemplate(args.template, args.vars);
  } else if (args.html) {
    mailOptions.html = args.body;
  } else {
    mailOptions.text = args.body;
  }

  if (args.cc) mailOptions.cc = args.cc;
  if (args.bcc) mailOptions.bcc = args.bcc;
  if (args.replyTo) mailOptions.replyTo = args.replyTo;

  // Build attachments (file attachments + inline CID images)
  const attachments = buildAttachments(args.attachments, args['inline-images']);
  if (attachments.length > 0) {
    mailOptions.attachments = attachments;
  }

  try {
    checkAndIncrementSendCount();
    const info = await transporter.sendMail(mailOptions);
    console.log(JSON.stringify({
      status: 'success',
      messageId: info.messageId,
      to: args.to,
      subject: args.subject,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      to: args.to,
    }));
    process.exit(1);
  }
}

main();
