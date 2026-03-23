import { DAVClient } from 'tsdav';
import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';

let caldavClient: DAVClient | null = null;
let carddavClient: DAVClient | null = null;
let imapClient: ImapFlow | null = null;
let smtpTransport: Transporter | null = null;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

function getCredentials() {
  return {
    username: requireEnv('ICLOUD_EMAIL'),
    password: requireEnv('ICLOUD_APP_PASSWORD'),
  };
}

export async function getCaldavClient(): Promise<DAVClient> {
  if (!caldavClient) {
    const creds = getCredentials();
    caldavClient = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: creds,
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    await caldavClient.login();
  }
  return caldavClient;
}

export async function getCarddavClient(): Promise<DAVClient> {
  if (!carddavClient) {
    const creds = getCredentials();
    carddavClient = new DAVClient({
      serverUrl: 'https://contacts.icloud.com',
      credentials: creds,
      authMethod: 'Basic',
      defaultAccountType: 'carddav',
    });
    await carddavClient.login();
  }
  return carddavClient;
}

export async function getImapClient(): Promise<ImapFlow> {
  if (!imapClient) {
    const creds = getCredentials();
    imapClient = new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: { user: creds.username, pass: creds.password },
      logger: false,
    });
    await imapClient.connect();
  }
  return imapClient;
}

export function getSmtpTransport(): Transporter {
  if (!smtpTransport) {
    const creds = getCredentials();
    const senderEmail = process.env.ICLOUD_SENDER_EMAIL || creds.username;
    smtpTransport = createTransport(
      {
        host: 'smtp.mail.me.com',
        port: 587,
        secure: false,
        auth: { user: creds.username, pass: creds.password },
      },
      { from: senderEmail },
    );
  }
  return smtpTransport;
}

/** Gracefully close all open connections */
export async function closeAll(): Promise<void> {
  if (imapClient) {
    await imapClient.logout().catch(() => {});
    imapClient = null;
  }
  if (smtpTransport) {
    smtpTransport.close();
    smtpTransport = null;
  }
  caldavClient = null;
  carddavClient = null;
}
