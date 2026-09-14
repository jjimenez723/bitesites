// Twilio REST list parameters use repeated form keys. Space-separated lists
// are only valid in TwiML attributes, and silently disable REST callbacks.
export function twilioForm(params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
  }
  return form.toString();
}
