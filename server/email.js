const sgMail = require('@sendgrid/mail');

const API_KEY = process.env.SENDGRID_API_KEY;
const FROM = process.env.EMAIL_FROM;
const configured = !!(API_KEY && FROM);

if (configured) sgMail.setApiKey(API_KEY);
else console.warn('Email notifications disabled: set SENDGRID_API_KEY and EMAIL_FROM to enable them.');

// Fire-and-forget — a notification failure should never break the request
// that triggered it (e.g. publishing a week still succeeds even if an
// employee's email bounces). Errors are logged, not thrown.
async function sendEmail(to, subject, text) {
  if (!configured || !to) return;
  try {
    await sgMail.send({ to, from: FROM, subject, text });
  } catch (err) {
    const detail = err.response && err.response.body ? JSON.stringify(err.response.body) : err.message;
    console.error(`Failed to send email to ${to}:`, detail);
  }
}

module.exports = { sendEmail, configured };
