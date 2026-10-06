# Testing Guide — AI Cost Control Tower OpenAPI Ingestion Layer

This walks you through testing everything that was built and fixed, in plain steps. No coding required — you'll copy-paste a few things and click buttons.

There are two parts:
- **Part A** — the things you can see and click in the browser (2 minutes).
- **Part B** — the things behind the scenes (the `/v1` API), tested with a small helper page I built for you (15-20 minutes).

You do not need to do these in one sitting. If something doesn't match what this guide says it should do, stop and send me the exact test number and what you saw — don't try to debug it yourself.

---

## Part A — Test the visible parts

### A1. The "API Documentation" button

1. Open Product Studio locally the way you normally do (your local address, usually something like `http://localhost:3000/ai-cost-tower.html`).
2. Log in if it asks you to.
3. Click your avatar (top right).
4. You should see an **"API Documentation"** item in the dropdown, between "Team Settings" and "Sign Out".
5. Click it.

**Expected result:** A new tab opens showing a proper documentation page — a sidebar listing "usage-events", "outcomes", "outcome-types", "company-apps", a "Getting started" section, and a working curl example. Not a blank page.

If it's blank: check that your local proxy (the backend, usually `http://localhost:3001`) is actually running. This page is served *by the proxy*, not by the same server as the rest of the app.

---

## Part B — Test the API itself

This is where the actual code-review fixes get exercised. You'll need two things first:

1. **Your local proxy running** — same as above, usually reachable at `http://localhost:3001`.
2. **A test API key** — a few SQL commands in Supabase (you've already done this kind of thing earlier in this project, so it'll look familiar).

### B1. Get a test API key

Open the Supabase SQL editor for your **dev** project (`pgt-dev`) — never do first-time testing against prod.

**Step 1 — find your company's ID.** Run:
```sql
SELECT id, name FROM mt_companies;
```
Find the row for your own company and copy its `id` value (a long string like `a1b2c3d4-...`). You'll paste this into the next query.

**Step 2 — register a throwaway test app.** Run this once:
```sql
INSERT INTO mt_apps (app_id, name, supports_enforcement)
VALUES ('test-app-review', 'Test App (code review verification)', false)
ON CONFLICT (app_id) DO NOTHING;
```

**Step 3 — issue yourself a test credential.** Replace `PASTE-YOUR-COMPANY-ID-HERE` with what you copied in Step 1, then run:
```sql
SELECT admin_issue_company_app_credential('PASTE-YOUR-COMPANY-ID-HERE', 'test-app-review');
```
The result will show one long value starting with `ct_`. **Copy the whole thing** — this is your test API key, and it's only ever shown this once.

> If you get an error saying a credential already exists (e.g. you ran this before), run this instead: `SELECT admin_rotate_company_app_credential('PASTE-YOUR-COMPANY-ID-HERE', 'test-app-review');` — same idea, just for re-issuing.

### B2. Open the test page

I've sent you a file called **`v1-api-test-page.html`**. Save it anywhere on your computer (your Desktop is fine), then just **double-click it** to open it in your browser. No installation, no server needed.

1. In the **"Proxy address"** box, leave it as `http://localhost:3001` (unless your local proxy runs on a different address — if you're not sure, it's whatever address the rest of Product Studio uses to talk to the backend).
2. In the **"Your test API key"** box, paste the `ct_...` value from Step 3 above.
3. Now work through the tests **in order, top to bottom**. Each one has a "Run Test" button and explains what it's checking right above the button.

### What each test proves

| Test | What it checks | What "passed" looks like |
|---|---|---|
| 1. Check my credential | Your key actually works | Green box showing your company/app |
| 2. Register a test outcome type | Basic registration works | Green box, "status: created" |
| 3. List my outcome types | You can read back what you registered | Green box showing your test type |
| 4. Fix a typo and re-register | **Fix #8** — re-registering used to silently ignore description updates | Green box confirming the description actually changed |
| 5. Create a test outcome | Sets up the next two tests | Green box with an outcome ID |
| 6. Usage event linked to a real outcome | Normal, valid usage still works | Green box, recorded successfully |
| 7. Usage event with a FAKE outcome ID | **Fix #2/#7** — this used to be silently accepted (a real bug: someone could plant a false reference to data that isn't theirs) | Green box saying it was correctly **rejected** |
| 8. Visit a page that doesn't exist | **Fix #4** — used to falsely say "200 OK" | Green box saying it correctly shows **404** |
| 9. Send a broken/garbled request | **Fix #5** — used to return a confusing raw web-page error | Green box saying it got a clean error message |
| 10. Rate-limit check (optional, ~15 sec) | **Fix #3** — there used to be no limit at all on how many requests could be sent | Green box saying some requests were correctly turned away |

If any test shows a **red box**, that's a real failure — copy the test number and the message shown (there's also a small technical detail box below the message, no need to understand it, just copy it) and send it to me.

### B3. Optional deeper check — the "two companies" scenario

One of the fixes (Fix #1) was specifically about two different companies sharing the same app and accidentally seeing each other's data. Testing this properly needs a *second* company and a *second* credential, which is more setup than the tests above. Skip this unless you specifically want to go this deep — the tests above already prove the basic registration/reading behavior works correctly for one company, and I've read through the fix carefully myself to confirm the multi-company case (documented in the code review findings).

---

## Cleaning up afterward

The test app/credential you created is harmless and isolated — it doesn't touch any real company's data. You can leave it as-is, or deactivate it when you're done:
```sql
UPDATE mt_company_apps SET is_active = false WHERE app_id = 'test-app-review';
```
Testing again later just needs a fresh credential (`admin_rotate_company_app_credential`, from Step 3 above).

---

## If something doesn't match this guide

Don't try to fix it yourself. Just tell me:
1. Which test number.
2. What color box you got and what it said.
3. The small technical detail text underneath it (copy-paste is fine, you don't need to understand it).

That's everything I need to dig in.
