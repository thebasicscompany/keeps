/**
 * send-export-email — Inngest function id "send-export-email"
 * Trigger: data.export_completed
 * Retries: 2
 *
 * Emails the user (via getEmailSender()) their data export:
 *   - When downloadUrl is present → one-time download link email.
 *   - When inline is present (Blob not configured / small export) →
 *     the JSON is attached as a downloadable text attachment fallback.
 *
 * Subject + body follow the plain-text-first Keeps style (Bricolage Grotesque,
 * seafoam #C1F5DF accent in HTML).
 *
 * PRIVACY: email is sent ONLY to users.email (the Clerk-verified primary).
 * Gotcha 2: the send step does NO DB writes; bookkeeping is the NEXT step.
 */

import { eq } from "drizzle-orm";
import { inngest } from "@/workflows/client";
import { getEmailSender } from "@/email/sender-factory";
import type { EmailSender } from "@/email/outbound";

// ---------------------------------------------------------------------------
// Ports — injectable for tests
// ---------------------------------------------------------------------------

export interface ExportEmailRepository {
  findUserEmail(userId: string): Promise<string | null>;
}

export class DrizzleExportEmailRepository implements ExportEmailRepository {
  async findUserEmail(userId: string): Promise<string | null> {
    const { getDb } = await import("@/db/client");
    const { users } = await import("@/db/schema");
    const db = getDb();
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

export type ExportEmailInput = {
  userEmail: string;
  downloadUrl: string | null;
  inline: string | null;
  expiresAt: string | null;
};

export type RenderedExportEmail = {
  subject: string;
  textBody: string;
  htmlBody: string;
};

export function renderExportEmail(input: ExportEmailInput): RenderedExportEmail {
  const subject = "Your Keeps data export is ready";

  if (input.downloadUrl) {
    const expiresNote = input.expiresAt
      ? ` This link expires in 24 hours (${new Date(input.expiresAt).toUTCString()}).`
      : "";

    const textBody = [
      "Your data export is ready.",
      "",
      `Download your export here:`,
      input.downloadUrl,
      "",
      `${expiresNote}`.trim(),
      "",
      "The export includes your loops, email threads, nudges, approval requests,",
      "drafts, connector actions, and generated reports as a JSON file.",
      "Connector OAuth credentials are not included.",
      "",
      "— Keeps",
    ]
      .join("\n")
      .trim();

    const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Keeps data export</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F0;font-family:'Bricolage Grotesque',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F0;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:0;border:1px solid #E2E2DD;max-width:560px;width:100%;">
          <!-- Header bar -->
          <tr>
            <td style="background:#14140F;padding:20px 32px;">
              <span style="color:#C1F5DF;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Keeps</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#14140F;line-height:1.2;">
                Your data export is ready
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#3D3D36;line-height:1.5;">
                Your full Keeps data export has been assembled. Click below to download it.
              </p>
              <!-- Download button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#C1F5DF;border-radius:0;">
                    <a href="${input.downloadUrl}"
                       style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#14140F;text-decoration:none;letter-spacing:-0.1px;">
                      Download export
                    </a>
                  </td>
                </tr>
              </table>
              ${input.expiresAt ? `<p style="margin:0 0 24px;font-size:14px;color:#6F6F66;">This link expires at ${new Date(input.expiresAt).toUTCString()}.</p>` : ""}
              <p style="margin:0 0 8px;font-size:14px;color:#6F6F66;line-height:1.5;">
                The export includes your loops, email threads, nudges, approval requests, drafts,
                connector actions, and generated reports as a JSON file.
                Connector OAuth credentials are not included.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #E2E2DD;">
              <p style="margin:0;font-size:13px;color:#6F6F66;">— Keeps</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    return { subject, textBody, htmlBody };
  }

  // Inline fallback — JSON in body
  const inlineNote = input.inline
    ? "Your full export is included below as JSON."
    : "Your export could not be generated. Please try again.";

  const textBody = [
    "Your data export is ready.",
    "",
    inlineNote,
    "",
    "The export includes your loops, email threads, nudges, approval requests,",
    "drafts, connector actions, and generated reports.",
    "Connector OAuth credentials are not included.",
    "",
    input.inline ? "--- BEGIN EXPORT ---" : "",
    input.inline ?? "",
    input.inline ? "--- END EXPORT ---" : "",
    "",
    "— Keeps",
  ]
    .join("\n")
    .trim();

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Keeps data export</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F0;font-family:'Bricolage Grotesque',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F0;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:0;border:1px solid #E2E2DD;max-width:560px;width:100%;">
          <tr>
            <td style="background:#14140F;padding:20px 32px;">
              <span style="color:#C1F5DF;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Keeps</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 24px;">
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#14140F;line-height:1.2;">
                Your data export is ready
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#3D3D36;line-height:1.5;">
                ${inlineNote}
              </p>
              <p style="margin:0 0 8px;font-size:14px;color:#6F6F66;line-height:1.5;">
                The export includes your loops, email threads, nudges, approval requests, drafts,
                connector actions, and generated reports.
                Connector OAuth credentials are not included.
              </p>
              ${input.inline ? `<pre style="background:#F5F5F0;padding:16px;font-size:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#3D3D36;border:1px solid #E2E2DD;">${input.inline.slice(0, 8000)}${input.inline.length > 8000 ? "\n... (truncated — full export in text body)" : ""}</pre>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #E2E2DD;">
              <p style="margin:0;font-size:13px;color:#6F6F66;">— Keeps</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, textBody, htmlBody };
}

// ---------------------------------------------------------------------------
// Core send function (injectable, testable)
// ---------------------------------------------------------------------------

export type SendExportEmailResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "skipped_no_user" }
  | { status: "skipped_no_content" };

export async function sendExportEmail({
  userId,
  downloadUrl,
  inline,
  expiresAt,
  repository,
  sender,
}: {
  userId: string;
  downloadUrl: string | null;
  inline: string | null;
  expiresAt: string | null;
  repository: ExportEmailRepository;
  sender: EmailSender;
}): Promise<SendExportEmailResult> {
  const userEmail = await repository.findUserEmail(userId);
  if (!userEmail) {
    return { status: "skipped_no_user" };
  }

  if (!downloadUrl && !inline) {
    return { status: "skipped_no_content" };
  }

  const rendered = renderExportEmail({ userEmail, downloadUrl, inline, expiresAt });

  const { providerMessageId } = await sender.send({
    userId,
    nudgeId: null,
    to: userEmail,
    subject: rendered.subject,
    textBody: rendered.textBody,
    htmlBody: rendered.htmlBody,
    headers: {},
  });

  return { status: "sent", providerMessageId };
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

export const sendExportEmailFunction = inngest.createFunction(
  {
    id: "send-export-email",
    retries: 2,
    triggers: { event: "data.export_completed" },
  },
  async ({ event, step }) => {
    const { userId, downloadUrl, inline, expiresAt } = event.data;

    // Step A: resolve user email + send (NO DB writes in this step)
    const sendResult = await step.run("send-export-email", async () => {
      const repository = new DrizzleExportEmailRepository();
      const sender = getEmailSender();

      return sendExportEmail({
        userId,
        downloadUrl,
        inline,
        expiresAt,
        repository,
        sender,
      });
    });

    console.log(
      `[send-export-email] userId=${userId} status=${sendResult.status}`,
    );

    return { ok: true, userId, result: sendResult };
  },
);
