# SubCaption — Setup Guide

This app now has real accounts, credits, an admin panel, and PayPal payments.
It deploys to **Vercel** (free) with **Vercel Postgres** (free) for the database.

Follow these steps in order. Should take ~15-20 minutes.

---

## 1. Push this project to GitHub

1. Create a new GitHub repo (e.g. `subcaption`)
2. Upload ALL these files/folders, keeping the structure:
   ```
   /api/...
   /lib/...
   /public/index.html
   /public/admin.html
   /package.json
   /vercel.json
   ```

---

## 2. Deploy to Vercel

1. Go to https://vercel.com → Sign up / log in with GitHub
2. "Add New Project" → import your `subcaption` repo
3. Framework preset: "Other" (it's plain Node + static files)
4. Click **Deploy** (it will fail or partially work — that's expected, we need env vars + database first)

---

## 3. Add Vercel Postgres

1. In your Vercel project → **Storage** tab → **Create Database** → **Postgres**
2. Follow prompts, accept defaults, connect it to your project
3. Vercel automatically adds `POSTGRES_URL` and related env vars — no action needed

---

## 4. Get PayPal API credentials

1. Go to https://developer.paypal.com → log in with your PayPal account
2. **Apps & Credentials** → make sure you're in **Sandbox** mode (top toggle) for testing first
3. Click **Create App**, name it anything (e.g. "SubCaption")
4. Copy the **Client ID** and **Secret**

(Sandbox = fake money, for testing. When ready for real payments, switch the toggle to **Live**, create a Live app, and get Live credentials — then update the env vars below.)

---

## 5. Set environment variables in Vercel

In your Vercel project → **Settings** → **Environment Variables**, add:

| Name | Value |
|---|---|
| `ADMIN_EMAIL` | `ekanshmcdelet@gmail.com` |
| `PAYPAL_CLIENT_ID` | (from step 4) |
| `PAYPAL_CLIENT_SECRET` | (from step 4) |
| `PAYPAL_ENV` | `sandbox` (change to `live` when ready for real money) |

Then go to **Deployments** → click the latest one → **Redeploy**.

---

## 5b. Set up "Continue with Google" (optional but added to UI)

1. Go to https://console.cloud.google.com → create a new project (any name)
2. Left menu → **APIs & Services** → **OAuth consent screen**
   - User type: External → fill app name, your email → save through the steps (test mode is fine)
3. Left menu → **Credentials** → **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - **Authorized redirect URI**: `https://YOUR-VERCEL-DOMAIN.vercel.app/api/auth/google-callback`
     (use your actual Vercel URL; you can add more later for custom domains)
4. Copy the **Client ID** and **Client Secret**
5. Add to Vercel env vars:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | (from step above) |
| `GOOGLE_CLIENT_SECRET` | (from step above) |

6. Redeploy.

If you skip this, the "Continue with Google" button will show an error — email/password login still works fine without it.

---

## 6. Create your admin account

1. Visit your deployed site (e.g. `https://subcaption.vercel.app`)
2. Click **Sign up**, use the email you put in `ADMIN_EMAIL` above, and the password:
   ```
   1mineletmc1
   ```
   (or any password you want — just sign up with that exact email)
3. This account is automatically marked as admin with infinite credits.
4. Visit `/admin.html` to see the admin panel — Account dropdown → "Admin Panel" link also works.

---

## 7. Test a payment (sandbox)

1. Go to https://developer.paypal.com → **Sandbox** → **Accounts** → create a "Personal" test buyer account if you don't have one (gives you fake PayPal login + fake money)
2. On your site, log in as a normal (non-admin) user, click **+ Buy Credits**, pick a pack
3. You'll be redirected to PayPal sandbox — log in with the test buyer account, approve payment
4. You'll be redirected back, credits should be added automatically

---

## 8. Go live (real payments)

1. In PayPal developer dashboard, toggle to **Live**, create a Live app, get Live Client ID/Secret
2. Update `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_ENV=live` in Vercel env vars
3. Redeploy

---

## How credits work

- New users get 5 free credits
- 1 credit = 1 minute of exported video (rounded up)
- Admin can set any user's credits to a custom number or to infinite (∞) via `/admin.html`
- Credit packs (edit in `/lib/packs.js`):
  - Starter: $2 → 10 credits
  - Popular: $5 → 35 credits
  - Pro: $10 → 100 credits
  - Bulk: $20 → 250 credits

## Notes

- Passwords are hashed (PBKDF2), sessions are secure HTTP-only cookies — works across devices.
- Database tables auto-create on first request (`ensureSchema()`), no manual SQL needed.
- To change the admin email/password later, just sign up with a different email and manually set `is_admin = true` for that user via Vercel's database query console (Storage → your DB → Query).
