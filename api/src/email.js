// Minimal Resend wrapper for sending transactional emails from the Worker.
// Docs: https://resend.com/docs/api-reference/emails/send-email

export async function sendEmail({ apiKey, from, to, replyTo, subject, text, html }) {
  const body = { from, to: Array.isArray(to) ? to : [to], subject };
  if (replyTo) body.reply_to = replyTo;
  if (text) body.text = text;
  if (html) body.html = html;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
  return res.json();
}

// Escape plain text for inclusion in a mailto: URL (subject or body).
// We use %0A for line breaks — this is what mail clients expect.
export function mailtoEncode(str) {
  return encodeURIComponent(str).replace(/%20/g, "%20");
}

export function buildMailtoLink(to, subject, body) {
  const params = `subject=${mailtoEncode(subject)}&body=${mailtoEncode(body)}`;
  return `mailto:${to}?${params}`;
}

// Formats the review-mode email that Dr Movahedifar receives in his inbox.
// Plain-text — plays nicely with Gmail, easy to copy/edit/forward, and no
// rendering surprises.
export function buildRezaReviewEmail({ service, serviceLabel, client, brief, draft, chatTranscript }) {
  const divider = "═".repeat(60);
  const subject = `[QUOTE DRAFT] ${serviceLabel} — ${client.name}`;

  const clientEmailBody =
    `Dear ${client.name.split(" ")[0]},\n\n` +
    draft.draftEmailToClient +
    `\n\n—\nDr Reza Movahedifar\nGeoMonix · geomonix.com`;

  const mailtoLink = buildMailtoLink(
    client.email,
    `Your GeoMonix enquiry — ${serviceLabel}`,
    clientEmailBody
  );

  const text =
`A new project intake has been completed. The AI has drafted an indicative quote for your review.

${divider}
CLIENT
${divider}
Name:    ${client.name}
Email:   ${client.email}
Service: ${serviceLabel}
Time:    ${new Date().toISOString()}

${divider}
AI-EXTRACTED BRIEF
${divider}
${brief.summary}

Tags: ${(brief.tags || []).join(", ")}

${divider}
INDICATIVE PRICE RANGE (AI DRAFT)
${divider}
${draft.priceRange}

${divider}
SCOPE SUMMARY (AI DRAFT)
${divider}
${(draft.scopeSummary || []).map((s) => `• ${s}`).join("\n")}

${divider}
INTERNAL NOTES — verify before sending
${divider}
${(draft.internalNotesForReza || []).map((s) => `• ${s}`).join("\n")}

${divider}
DRAFT EMAIL TO CLIENT — copy/edit/send from your inbox
${divider}
${clientEmailBody}

${divider}
ONE-CLICK REPLY
${divider}
Open a pre-filled compose in your default mail client:
${mailtoLink}

${divider}
ORIGINAL CHAT TRANSCRIPT
${divider}
${chatTranscript}
`;

  return { subject, text };
}

// Holding email sent immediately to the client for review-category services.
export function buildClientHoldingEmail({ client, serviceLabel, brief }) {
  const subject = `Your GeoMonix enquiry — preparing your quote`;
  const text =
`Dear ${client.name.split(" ")[0]},

Thank you for your enquiry regarding ${serviceLabel.toLowerCase()}.

Dr Movahedifar personally reviews every quote for this kind of work, so you will receive an indicative price range, scope summary, and a preview of the approach within 24 hours.

For reference, here is the brief I captured from our conversation:

${brief.summary}

If anything above is inaccurate or you want to add detail, reply to this email and it will reach Dr Movahedifar directly.

Best regards,
GeoMonix
geomonix.com
`;
  return { subject, text };
}
