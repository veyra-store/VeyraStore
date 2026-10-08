# VEYRA v2 — Live-ready fashion store

## Included
- Customer signup/login with hashed passwords
- Product catalog, search, cart and stock checks
- COD orders
- Razorpay online checkout + server-side signature verification + webhook endpoint
- PostgreSQL database
- Admin product and order management
- Order history
- Secure HTTP-only auth cookie

## Local setup
1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database.
3. Copy `.env.example` to `.env` and fill in values.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000`.
7. Admin: `http://localhost:3000/admin.html` using `ADMIN_USER` and `ADMIN_PASSWORD`.

## Production notes
- Set a long random `JWT_SECRET`.
- Use a managed PostgreSQL database.
- Set `NODE_ENV=production` and a real `APP_URL`.
- Configure Razorpay keys in the hosting provider's environment variables, never in frontend code or GitHub.
- Configure the Razorpay webhook URL as `https://YOUR-DOMAIN/api/payments/webhook` and use the same webhook secret in `RAZORPAY_WEBHOOK_SECRET`.
- Configure your payment account according to the provider's eligibility/verification requirements. Do not share secret keys in chat.
- Use HTTPS at the hosting layer.
