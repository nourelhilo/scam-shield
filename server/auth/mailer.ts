import nodemailer, { type Transporter } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory. Used by automated tests to read verification/reset links. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
  lastTo(to: string) {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase()) ?? null;
  }
}

/**
 * Development only: prints emails to the server console so links can be clicked locally.
 * loadConfig() refuses to start production with this transport.
 */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage) {
    console.warn(`\n[dev mailer] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`);
  }
}

/** SMTP delivery via nodemailer. Implemented but not exercised against a real SMTP server in tests. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(message: MailMessage) {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}

export function createMailer(config: { transport: "console" | "smtp" | "memory"; smtpUrl?: string | undefined; from: string }): Mailer {
  if (config.transport === "smtp" && config.smtpUrl) return new SmtpMailer(config.smtpUrl, config.from);
  if (config.transport === "memory") return new MemoryMailer();
  return new ConsoleMailer();
}
