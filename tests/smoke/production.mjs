import assert from "node:assert/strict";

const base = process.env.SMOKE_APP_URL ?? "http://127.0.0.1:3000";
const mailpit = "http://127.0.0.1:8025/api/v1";
const email = "smoke@example.com";
const password = "SmokeTestPassword42!";
const newPassword = "NewSmokePassword42!";

async function request(url, expectedStatus = 200, payload) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    ...(payload && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  });
  assert.equal(response.status, expectedStatus, new URL(url).pathname);
  return response;
}

async function emailLink(subject, pattern) {
  const { messages } = await (await request(`${mailpit}/messages`)).json();
  const summary = messages.find((message) => message.Subject === subject);
  assert.ok(summary, `Expected SMTP delivery for "${subject}"`);
  const { Text } = await (await request(`${mailpit}/message/${summary.ID}`)).json();
  const link = Text.match(pattern)?.[0];
  assert.ok(link, `Expected an HTTPS link in "${subject}"`);
  return new URL(link);
}

const health = await (await request(`${base}/api/health`)).json();
assert.equal(health.capabilities.ml, true, "Shipped model must load");
const home = await (await request(base)).text();
assert.match(home, /data-analysis-endpoint="\/api\/analyze"/);
const analysis = await (await request(`${base}/api/analyze`, 200, {
  type: "text",
  content: "Your delivery is on hold. Pay a redelivery fee at http://parcel-fee.example",
})).json();
assert.equal(analysis.mlPrediction.status, "used");
assert.match(await (await request(`${base}/api/articles`)).text(), /"slug":/);

await request(`${base}/api/auth/register`, 202, { email, password });
const verify = await emailLink("Verify your ScamShield email", /https:\/\/scamshield\.example\.com\/api\/auth\/verify-email\?token=\S+/);
await request(`${base}${verify.pathname}${verify.search}`);
await request(`${base}/api/auth/login`, 200, { email, password });

await request(`${base}/api/auth/password-reset/request`, 202, { email });
const reset = await emailLink("Reset your ScamShield password", /https:\/\/scamshield\.example\.com\/reset-password\?token=\S+/);
const page = await request(`${base}${reset.pathname}${reset.search}`);
assert.equal(page.headers.get("Cache-Control"), "no-store");
assert.match(await page.text(), /id="reset-form"/);
await request(`${base}/reset-password.js`);
await request(`${base}/api/auth/password-reset/confirm`, 200, { token: reset.searchParams.get("token"), newPassword });
await request(`${base}/api/auth/login`, 401, { email, password });
await request(`${base}/api/auth/login`, 200, { email, password: newPassword });
