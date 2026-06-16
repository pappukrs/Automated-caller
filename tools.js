// Tools Claude can call during a call: check availability, book, send SMS confirmation.
import { getAvailability, bookAppointment } from './store.js';

// Tool schemas given to Claude (Anthropic tool-use format).
export const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check which appointment time slots are free on a given date. Call this before offering or booking a time.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment in a free slot. Only call after confirming the date, time, and the caller\'s name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Caller's full name" },
        phone: { type: 'string', description: "Caller's phone number" },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time: { type: 'string', description: 'Time in HH:MM 24-hour format' },
        reason: { type: 'string', description: 'Reason for the visit (optional)' },
      },
      required: ['name', 'date', 'time'],
    },
  },
  {
    name: 'send_sms_confirmation',
    description: 'Send the caller an SMS confirming their appointment. Call after a successful booking.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: "Caller's phone number (E.164, e.g. +9198...)" },
        message: { type: 'string', description: 'The confirmation text to send' },
      },
      required: ['phone', 'message'],
    },
  },
];

/**
 * Execute a tool call. Returns a plain string that goes back to Claude as the tool result.
 * @param {{phone?: string}} ctx - call context (e.g. caller's number)
 */
export async function executeTool(name, input, ctx = {}) {
  switch (name) {
    case 'check_availability': {
      const slots = getAvailability(input.date);
      return slots.length
        ? `Available on ${input.date}: ${slots.join(', ')}`
        : `No slots available on ${input.date}.`;
    }
    case 'book_appointment': {
      const phone = input.phone || ctx.phone || '';
      const result = bookAppointment({ ...input, phone });
      if (!result.ok) return `Could not book: ${input.time} on ${input.date} is unavailable. Offer another slot.`;
      return `Booked ${input.date} at ${input.time} for ${input.name} (id ${result.appt.id}).`;
    }
    case 'send_sms_confirmation': {
      const to = input.phone || ctx.phone;
      return await sendSms(to, input.message);
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/** Send an SMS via Plivo's REST API. No-ops gracefully if credentials are missing. */
async function sendSms(to, text) {
  const { PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_NUMBER } = process.env;
  if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !PLIVO_NUMBER) {
    return 'SMS skipped (Plivo SMS credentials not configured).';
  }
  try {
    const auth = Buffer.from(`${PLIVO_AUTH_ID}:${PLIVO_AUTH_TOKEN}`).toString('base64');
    const resp = await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Message/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: PLIVO_NUMBER, dst: to, text }),
    });
    return resp.ok ? 'SMS sent.' : `SMS failed (HTTP ${resp.status}).`;
  } catch (err) {
    return `SMS failed: ${err.message}`;
  }
}
