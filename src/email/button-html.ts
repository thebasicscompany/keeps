/**
 * Shared HTML email renderer for transactional emails that have a single tap moment.
 *
 * DESIGN POLICY (settled):
 *   - Plain-text is always the canonical part; this HTML is an enhancement.
 *   - Single column, max-width 520px, inline styles only (mail clients strip <style>).
 *   - System font stack — web fonts do not load reliably in email.
 *   - No images.
 *   - ONE square seafoam button: bg #C1F5DF, color #14140F, border 1px solid rgba(30,107,79,0.4),
 *     padding ~14px 26px, font-weight 700, border-radius 0.
 *   - Page bg #FAFAF8, text #14140F.
 *   - Secondary actions are small plain-text links (color #1E6B4F), not buttons.
 *
 * See `buildUnknownSenderReplyHtml` in inbound.ts for the original reference implementation.
 */

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ButtonEmailHtmlInput = {
  /** One or more body paragraphs rendered above the button. */
  paragraphs: string[];
  /** The single primary call-to-action button. */
  button: { label: string; url: string };
  /** Optional secondary actions rendered as small plain-text links below the button. */
  textLinks?: { label: string; url: string }[];
  /** Optional muted footnote rendered at the very bottom. */
  footnote?: string;
};

/**
 * Renders a minimal, inline-styled single-column HTML email body following the
 * settled design policy. Every interpolated value is HTML-escaped.
 */
export function renderButtonEmailHtml(input: ButtonEmailHtmlInput): string {
  const { paragraphs, button, textLinks = [], footnote } = input;

  const paragraphRows = paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 0 16px;color:#14140F;font-size:16px;line-height:24px;">${escapeHtml(p)}</td></tr>`,
    )
    .join("");

  const safeButtonLabel = escapeHtml(button.label);
  const safeButtonHref = escapeHtml(button.url);
  const buttonRow = [
    `<tr><td style="padding:0 0 4px;">`,
    `<a href="${safeButtonHref}" style="display:inline-block;background-color:#C1F5DF;color:#14140F;border:1px solid rgba(30,107,79,0.4);padding:14px 26px;font-size:16px;font-weight:700;text-decoration:none;border-radius:0;font-family:${FONT_STACK};">${safeButtonLabel}</a>`,
    `</td></tr>`,
  ].join("");

  const textLinkRows = textLinks
    .map(({ label, url }) => {
      const safeLabel = escapeHtml(label);
      const safeHref = escapeHtml(url);
      return `<tr><td style="padding:8px 0 0;"><a href="${safeHref}" style="color:#1E6B4F;font-size:14px;text-decoration:none;">${safeLabel}</a></td></tr>`;
    })
    .join("");

  const footnoteRow = footnote
    ? `<tr><td style="padding:24px 0 0;color:#6B6B65;font-size:13px;line-height:20px;">${escapeHtml(footnote)}</td></tr>`
    : "";

  return [
    `<div style="margin:0;padding:24px;background-color:#FAFAF8;font-family:${FONT_STACK};">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;">`,
    paragraphRows,
    buttonRow,
    textLinkRows,
    footnoteRow,
    `</table>`,
    `</div>`,
  ].join("");
}
