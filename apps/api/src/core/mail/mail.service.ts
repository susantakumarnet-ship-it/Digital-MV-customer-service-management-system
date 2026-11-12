import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../common/logger';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * Pluggable mail provider (D-09). `file` writes .eml files to MAIL_DIR for development/UAT inspection;
 * `smtp` sends through the configured SMTP server; `none` drops messages (tests).
 */
let transporter: Transporter | undefined;
const sentForTests: MailMessage[] = [];

function getTransporter() {
  if (transporter) return transporter;
  const e = env();
  if (e.MAIL_TRANSPORT === 'smtp') {
    transporter = nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT ?? 587,
      secure: e.SMTP_SECURE,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    });
  } else {
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  }
  return transporter;
}

export async function sendMail(msg: MailMessage): Promise<{ ok: boolean; error?: string }> {
  const e = env();
  if (e.MAIL_TRANSPORT === 'none') {
    sentForTests.push(msg);
    return { ok: true };
  }
  try {
    const info = await getTransporter().sendMail({ from: e.MAIL_FROM, ...msg });
    if (e.MAIL_TRANSPORT === 'file') {
      const dir = path.resolve(process.cwd(), e.MAIL_DIR);
      await mkdir(dir, { recursive: true });
      const safe = msg.subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.eml`);
      await writeFile(file, (info as unknown as { message: Buffer }).message);
      logger.info({ file, to: msg.to }, 'Email written to file transport');
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err, to: msg.to, subject: msg.subject }, 'Email delivery failed');
    return { ok: false, error: (err as Error).message };
  }
}

/** Test helper — messages captured when MAIL_TRANSPORT=none. */
export function capturedMail() {
  return sentForTests;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal branded layout. Notification templates (P9) will reuse it. */
export function renderEmail(opts: { title: string; paragraphs: string[]; action?: { label: string; url: string }; footer?: string }) {
  const text = [opts.title, '', ...opts.paragraphs, ...(opts.action ? ['', `${opts.action.label}: ${opts.action.url}`] : []), '', opts.footer ?? ''].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0b1f4b;color:#fff;padding:18px 24px;font-size:16px;font-weight:600">Digital MV Customer Service</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(opts.title)}</h1>
${opts.paragraphs.map((p) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`).join('')}
${opts.action ? `<p style="margin:20px 0"><a href="${escapeHtml(opts.action.url)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">${escapeHtml(opts.action.label)}</a></p>` : ''}
</td></tr><tr><td style="padding:12px 24px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">${escapeHtml(opts.footer ?? 'This is an automated message. Please do not reply.')}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
