# RideMint Ledger Pro

Multi-user web app for Uber/DiDi/rideshare drivers with:
- Secure login (Supabase Auth)
- Cloud database sync (PostgreSQL)
- ATO-style logbook
- Fare/expense/toll tracking
- GST collected, GST credits, GST payable estimates
- BAS summary
- Monthly, quarterly, yearly tax summaries
- Printable ATO-ready reports
- Logbook CSV export

## 1) Create free and safe database (Supabase)
1. Create a free Supabase project: https://supabase.com
2. In Supabase SQL Editor, run [`supabase.sql`](/Users/jobitgeorge/Documents/Playground/ridemint-ledger/supabase.sql)
3. In `Authentication > Providers`, keep Email enabled.
4. Copy:
- Project URL
- Anon public key

## 2) Run locally
Open [`index.html`](/Users/jobitgeorge/Documents/Playground/ridemint-ledger/index.html) in browser.

In the app:
1. Paste Supabase URL + anon key
2. Save connection
3. Sign up and sign in
4. Start adding trips/fares/expenses/tolls

## 3) Host publicly (free)
### Netlify (recommended)
1. Push this folder to GitHub
2. In Netlify: New site from Git
3. Build command: none
4. Publish directory: `ridemint-ledger`
5. Deploy

### Cloudflare Pages
1. Push to GitHub
2. Create Pages project from repo
3. Build command: none
4. Output directory: `ridemint-ledger`

## 4) Security notes
- Database uses Row Level Security (RLS): each user can only access their own rows.
- Do not use service role key in frontend.
- Use only Supabase anon key in app config.

## 5) ATO report workflow
1. Keep logbook entries complete (date, odometer, route, purpose).
2. Attach receipts externally for expenses.
3. Generate monthly/quarterly/yearly summary in app.
4. Click print BAS or print tax summary for accountant/records.

## Disclaimer
Calculations are estimates. Confirm final BAS and tax lodgement with a registered tax professional.
