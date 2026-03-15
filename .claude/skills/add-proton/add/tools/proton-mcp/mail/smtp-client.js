/**
 * SMTP client for Proton Bridge
 * Handles send operations via nodemailer
 */

import nodemailer from 'nodemailer';

export async function sendMessage(config, { to, subject, body }) {
  const transporter = nodemailer.createTransport({
    host: config.smtp_host || '127.0.0.1',
    port: config.smtp_port || 1025,
    secure: false,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: { rejectUnauthorized: false },
  });

  const info = await transporter.sendMail({
    from: config.username,
    to,
    subject,
    text: body,
  });

  return { success: true, message_id: info.messageId };
}
